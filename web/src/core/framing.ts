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

import { LM, type Landmark, type MovementKind } from './types.ts';

/** Landmarks that must be present for the whole-body solve to be trustworthy. */
const REQUIRED: Record<MovementKind, number[]> = {
  /**
   * Arms and torso. Ankles were required here on the theory that losing them
   * destabilises the whole solve — plausible, and wrong in practice.
   *
   * In a real push-up the far leg is occluded by the near one essentially all
   * the time, so the requirement never held. It did not fail loudly; it failed
   * by leaving "telapak kaki terpotong" on screen through every set, until the
   * banner meant nothing and the genuine framing problems it also reports were
   * ignored with it.
   *
   * No push-up rule reads an ankle. Only one side of each arm chain is required
   * for the same reason: obliquely, the far arm is a guess, and demanding it be
   * visible is demanding a camera angle that makes the elbow unreadable.
   */
  pushup: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
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
    LM.LEFT_WRIST,
    LM.RIGHT_WRIST,
    LM.LEFT_FOOT_INDEX,
    LM.RIGHT_FOOT_INDEX,
  ],
  /**
   * The judged line is shoulder-hip-knee, so all three are required — a plank
   * with the knees out of shot cannot be scored at all, unlike a push-up where
   * the arms carry the measurement.
   */
  plank: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_KNEE,
    LM.RIGHT_KNEE,
  ],
};

/**
 * Groups where *one* member is enough.
 *
 * Bilateral joints under an oblique camera are the whole reason this exists:
 * the near arm is measured and the far one is inferred, so requiring both is
 * requiring a viewpoint that makes the joint itself unreadable.
 */
const ANY_OF: Record<MovementKind, number[][]> = {
  pushup: [
    [LM.LEFT_ELBOW, LM.RIGHT_ELBOW],
    [LM.LEFT_WRIST, LM.RIGHT_WRIST],
  ],
  squat: [[LM.LEFT_ANKLE, LM.RIGHT_ANKLE]],
  plank: [[LM.LEFT_ANKLE, LM.RIGHT_ANKLE]],
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
  exercise: MovementKind,
): FramingStatus {
  if (!landmarks || landmarks.length === 0) {
    return { ok: false, issue: { kind: 'no-pose' }, bodyFill: 0 };
  }

  const missing = REQUIRED[exercise].filter((i) => !isUsable(landmarks[i]));

  // A group counts as missing only when neither side is usable. Reported by its
  // first member, which is enough to classify the region.
  for (const group of ANY_OF[exercise]) {
    if (group.every((i) => !isUsable(landmarks[i]))) missing.push(group[0]);
  }

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

/**
 * A short spoken version of the framing problem.
 *
 * The written banner is unreadable in the situation that produces it: the
 * phone is propped several metres away and the user is face-down on the floor
 * or mid-squat. Reported directly — "harusnya juga ada cue kamera yang pake
 * suara, soalnya tulisan..." — and the sentence trailing off is the point.
 *
 * Deliberately terser than `framingMessage`. Spoken instructions are heard
 * once, cannot be re-read, and compete with the room.
 */
export function framingSpeech(issue: FramingIssue, exercise: MovementKind): string {
  switch (issue.kind) {
    case 'no-pose':
      return 'Kamu tidak terlihat kamera';
    case 'too-small':
      return 'Terlalu jauh, maju sedikit';
    case 'out-of-frame':
      switch (issue.missing) {
        case 'feet':
          return exercise === 'squat' ? 'Mundur, kaki terpotong' : 'Geser kamera, kaki terpotong';
        case 'hands':
          return 'Tangan terpotong frame';
        default:
          return 'Badan terpotong, atur ulang kamera';
      }
  }
}

/** Spoken when the camera has held a good view and the set may begin. */
export const READY_CUE = 'Posisi siap, mulai';

/** Spoken when the rep target is reached and the set closes itself. */
export const TARGET_CUE = 'Target tercapai, set selesai';

/**
 * Every non-rule phrase the app can speak, for the audio generator.
 *
 * Enumerated rather than derived from `framingSpeech` because the issue type is
 * a union of shapes, not a list — and a phrase without a pre-rendered clip
 * silently degrades to the browser's synthesiser, which is exactly the quality
 * drop the demo video would capture.
 */
export function allSetupSpeech(): string[] {
  const issues: FramingIssue[] = [
    { kind: 'no-pose' },
    { kind: 'too-small' },
    { kind: 'out-of-frame', missing: 'feet' },
    { kind: 'out-of-frame', missing: 'hands' },
    { kind: 'out-of-frame', missing: 'body' },
  ];

  const phrases = new Set<string>([READY_CUE, TARGET_CUE]);
  for (const exercise of ['pushup', 'squat', 'plank'] as MovementKind[]) {
    for (const issue of issues) phrases.add(framingSpeech(issue, exercise));
  }
  return [...phrases].sort();
}

/** Actionable Indonesian message — what to do, not what is wrong internally. */
export function framingMessage(issue: FramingIssue, exercise: MovementKind): string {
  switch (issue.kind) {
    case 'no-pose':
      return 'Tidak ada orang terdeteksi. Pastikan kamera menghadap area latihan.';
    case 'too-small':
      return 'Terlalu jauh dari kamera. Maju sedikit.';
    case 'out-of-frame':
      switch (issue.missing) {
        case 'feet':
          return exercise === 'squat'
            ? 'Kaki terpotong. Mundur sampai seluruh badan terlihat.'
            : 'Telapak kaki terpotong. Geser kamera agar seluruh badan sampai kaki terlihat.';
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
export const CAMERA_GUIDANCE: Record<MovementKind, CameraGuidance> = {
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
    note: 'Kedalaman paling terbaca dari samping, tapi lutut yang masuk ke dalam hanya terlihat dari depan. Serong adalah kompromi terbaik. Jaga tangan tidak menyentuh lantai, kaki selebar bahu, dan telapak tetap menempel.',
  },
  plank: {
    // Unlike the other two this really does want a side view. The only thing
    // measured is whether one line is straight, and a line is least readable
    // from the direction it points.
    angle: 'Dari samping, tegak lurus badan',
    height: 'Rendah, ±30–50 cm dari lantai',
    distance: '2–3 meter',
    orientation: 'Landscape (HP tidur)',
    note: 'Garis bahu–pinggul–lutut adalah satu-satunya yang dinilai, dan garis paling sulit dibaca dari arah ia menunjuk. Ambil dari samping penuh.',
  },
};
