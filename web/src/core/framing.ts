/**
 * Framing check — is the camera actually seeing what the model needs?
 *
 * ## Why this is worth a module
 *
 * MediaPipe solves the whole skeleton as one system. Cropping the feet does not
 * merely lose the ankles: it destabilises the entire fit, and the error shows
 * up in joints that *are* in frame. Field testing surfaced this as "the legs
 * look wrong in push-ups and it breaks the rep count" — one cause, two
 * symptoms.
 *
 * Detecting it is therefore not a UX nicety. It is the difference between
 * telling the user to step back and silently reporting a wrong rep count.
 *
 * Works on **image-space** landmarks, not world landmarks: the question here is
 * literally "is this inside the picture", which world coordinates cannot answer.
 */

import { LM, type ExerciseKind, type Landmark } from './types.ts';

/** Landmarks that must be present for the whole-body solve to be trustworthy. */
const REQUIRED: Record<ExerciseKind, number[]> = {
  // The full kinetic chain. Ankles matter even though no push-up rule reads
  // them, because their absence degrades the shoulders and elbows.
  pushup: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_ELBOW,
    LM.RIGHT_ELBOW,
    LM.LEFT_WRIST,
    LM.RIGHT_WRIST,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_ANKLE,
    LM.RIGHT_ANKLE,
  ],
  squat: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_KNEE,
    LM.RIGHT_KNEE,
    LM.LEFT_ANKLE,
    LM.RIGHT_ANKLE,
  ],
};

/** Below this, treat the landmark as not meaningfully observed. */
const MIN_VISIBILITY = 0.5;

/**
 * Margin, in normalised units, inside which a landmark counts as "at the edge".
 * MediaPipe extrapolates landmarks beyond the frame rather than omitting them,
 * so a joint reported just outside 0..1 is a guess, not a measurement.
 */
const EDGE_MARGIN = 0.02;

export type FramingIssue =
  | { kind: 'no-pose' }
  | { kind: 'out-of-frame'; missing: 'feet' | 'hands' | 'body' }
  | { kind: 'too-small' };

export interface FramingStatus {
  ok: boolean;
  issue: FramingIssue | null;
  /** Height of the detected body as a fraction of frame height. */
  bodyFill: number;
}

/**
 * Below this fraction of frame height, the person is far enough away that
 * landmark precision degrades noticeably.
 */
const MIN_BODY_FILL = 0.25;

function isUsable(lm: Landmark | undefined): boolean {
  if (!lm) return false;
  if (lm.visibility < MIN_VISIBILITY) return false;
  return (
    lm.x >= -EDGE_MARGIN && lm.x <= 1 + EDGE_MARGIN && lm.y >= -EDGE_MARGIN && lm.y <= 1 + EDGE_MARGIN
  );
}

/**
 * Which body region is missing, chosen for the most actionable message.
 *
 * Feet are checked first because cropping them is by far the most common
 * mistake and the one that most degrades the whole-body solve.
 */
function classifyMissing(missing: number[]): 'feet' | 'hands' | 'body' {
  const feet: number[] = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
  const hands: number[] = [LM.LEFT_WRIST, LM.RIGHT_WRIST];
  if (missing.some((i) => feet.includes(i))) return 'feet';
  if (missing.some((i) => hands.includes(i))) return 'hands';
  return 'body';
}

export function checkFraming(
  landmarks: Landmark[] | null,
  exercise: ExerciseKind,
): FramingStatus {
  if (!landmarks || landmarks.length === 0) {
    return { ok: false, issue: { kind: 'no-pose' }, bodyFill: 0 };
  }

  const missing = REQUIRED[exercise].filter((i) => !isUsable(landmarks[i]));

  const ys = landmarks.filter((lm) => lm.visibility >= MIN_VISIBILITY).map((lm) => lm.y);
  const bodyFill = ys.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 0;

  if (missing.length > 0) {
    return { ok: false, issue: { kind: 'out-of-frame', missing: classifyMissing(missing) }, bodyFill };
  }
  if (bodyFill < MIN_BODY_FILL) {
    return { ok: false, issue: { kind: 'too-small' }, bodyFill };
  }

  return { ok: true, issue: null, bodyFill };
}

/** Actionable Indonesian message — what to do, not what is wrong internally. */
export function framingMessage(issue: FramingIssue, exercise: ExerciseKind): string {
  switch (issue.kind) {
    case 'no-pose':
      return 'Tidak ada orang terdeteksi. Pastikan kamera menghadap area latihan.';
    case 'too-small':
      return 'Terlalu jauh dari kamera. Maju sedikit.';
    case 'out-of-frame':
      switch (issue.missing) {
        case 'feet':
          return exercise === 'pushup'
            ? 'Telapak kaki terpotong. Geser kamera agar seluruh badan sampai kaki terlihat.'
            : 'Kaki terpotong. Mundur sampai seluruh badan terlihat.';
        case 'hands':
          return 'Tangan terpotong frame. Sesuaikan posisi kamera.';
        default:
          return 'Sebagian badan terpotong. Sesuaikan jarak dan sudut kamera.';
      }
  }
}

/** Setup guidance, shown before a set starts. */
export interface CameraGuidance {
  angle: string;
  height: string;
  distance: string;
  orientation: string;
  note: string;
}

/**
 * The rationale, for anyone tempted to "simplify" these to a front view:
 *
 * A joint's angle is only directly observable when it flexes in a plane facing
 * the camera. Flexion along the optical axis has to be inferred from depth,
 * which is the least reliable part of the estimate. A full 90-degree side view
 * maximises that visibility but hides the far limb completely, making
 * left-right asymmetry unmeasurable. 30-45 degrees keeps the flexion readable
 * while leaving both sides partly visible.
 */
export const CAMERA_GUIDANCE: Record<ExerciseKind, CameraGuidance> = {
  pushup: {
    angle: 'Serong 30–45° dari samping',
    height: 'Rendah, ±30–50 cm dari lantai',
    distance: '2–3 meter',
    orientation: 'Landscape (HP tidur)',
    note: 'Dari depan, tekukan siku bergerak mendekat-menjauh kamera — arah yang paling sulit diperkirakan. Pastikan telapak kaki masuk frame.',
  },
  squat: {
    angle: 'Serong 30–45° dari samping',
    height: 'Setinggi pinggul, ±1 meter',
    distance: '2–3 meter',
    orientation: 'Portrait (HP berdiri)',
    note: 'Kedalaman paling terbaca dari samping, tapi lutut yang masuk ke dalam hanya terlihat dari depan. Serong adalah kompromi terbaik.',
  },
};
