/**
 * Landmarks -> joint angles.
 *
 * ## Why world landmarks, not image landmarks
 *
 * MediaPipe returns two coordinate sets. `landmarks` are normalised to [0,1]
 * independently over the frame width and height, so on a 640x480 video an equal
 * step in x and in y is a *different* physical distance. Computing an angle
 * from those coordinates directly is wrong, and the error changes with the
 * camera's aspect ratio — so a threshold tuned on one phone would not transfer
 * to another.
 *
 * `worldLandmarks` are metric (metres, origin at the hip midpoint) and carry no
 * aspect distortion, which is what joint angles need. The fast loop therefore
 * runs on world landmarks; the normalised set is only used to draw the skeleton
 * overlay, where per-pixel placement is exactly what we want.
 *
 * `toAspectCorrected` exists for the case where only image-space landmarks are
 * available (some recorded datasets ship them without the world set).
 */

import { LM, type JointAngles, type Landmark, type SideConfidence } from './types.ts';

/**
 * Below this MediaPipe visibility, a joint is treated as unobserved when
 * *judging* form. Criticising a lifter's depth from a joint we can barely see
 * produces corrections they cannot act on.
 */
export const DEFAULT_MIN_VISIBILITY = 0.5;

/**
 * The bar for *counting* a repetition, which is a different question.
 *
 * Counting asks "is this joint roughly where I think it is"; judging asks "am
 * I confident enough to criticise". Holding both to the judging bar loses reps
 * outright — and a missing rep is far more visible to the user than a slightly
 * noisy angle.
 *
 * This matters most for push-ups: viewed obliquely the far arm is partly
 * occluded, and MediaPipe's visibility for the elbow and wrist sits close to
 * 0.5. Field testing showed push-up counting that worked at first and then
 * almost stopped, which is what a threshold sitting right at the signal level
 * looks like. The median filter absorbs the extra noise this admits.
 */
export const COUNTING_MIN_VISIBILITY = 0.3;

/**
 * Angle at vertex `b` formed by the segments b->a and b->c, in degrees (0..180).
 *
 * Returns `null` when either segment has near-zero length, which happens when
 * the tracker collapses two joints onto the same point.
 */
export function jointAngleDeg(a: Landmark, b: Landmark, c: Landmark): number | null {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const abz = a.z - b.z;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const cbz = c.z - b.z;

  const abLen = Math.hypot(abx, aby, abz);
  const cbLen = Math.hypot(cbx, cby, cbz);
  if (abLen < 1e-6 || cbLen < 1e-6) return null;

  const dot = abx * cbx + aby * cby + abz * cbz;
  // Clamp guards against floating-point drift pushing the ratio outside acos's
  // domain, which would yield NaN and silently poison every downstream feature.
  const cosine = Math.min(1, Math.max(-1, dot / (abLen * cbLen)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Rescale image-space landmarks so x and y share a unit, making angles valid.
 * Only needed when world landmarks are unavailable.
 */
export function toAspectCorrected(landmarks: Landmark[], aspectRatio: number): Landmark[] {
  return landmarks.map((lm) => ({ ...lm, x: lm.x * aspectRatio }));
}

function visible(landmarks: Landmark[], minVisibility: number, ...indices: number[]): boolean {
  return indices.every((i) => {
    const lm = landmarks[i];
    return lm !== undefined && lm.visibility >= minVisibility;
  });
}

/** Angle at `b`, or null if any of the three joints is not confidently visible. */
function gatedAngle(
  landmarks: Landmark[],
  minVisibility: number,
  a: number,
  b: number,
  c: number,
): number | null {
  if (!visible(landmarks, minVisibility, a, b, c)) return null;
  return jointAngleDeg(landmarks[a], landmarks[b], landmarks[c]);
}

function midpoint(a: Landmark, b: Landmark): Landmark {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility, b.visibility),
  };
}

/**
 * Torso deviation from vertical, in degrees. 0 means upright.
 *
 * Uses the shoulder-midpoint to hip-midpoint vector. In world space, -y is up.
 */
export function trunkLeanDeg(
  landmarks: Landmark[],
  minVisibility = DEFAULT_MIN_VISIBILITY,
): number | null {
  if (
    !visible(
      landmarks,
      minVisibility,
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
    )
  ) {
    return null;
  }

  const shoulder = midpoint(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);
  const hip = midpoint(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);

  const dx = shoulder.x - hip.x;
  const dy = shoulder.y - hip.y;
  const dz = shoulder.z - hip.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return null;

  // Angle against the world up axis (0, -1, 0).
  const cosine = Math.min(1, Math.max(-1, -dy / len));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Torso length in metres — the scale reference that makes distance-based
 * features comparable across body sizes and camera distances.
 */
export function torsoLength(
  landmarks: Landmark[],
  minVisibility = DEFAULT_MIN_VISIBILITY,
): number | null {
  if (
    !visible(
      landmarks,
      minVisibility,
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
    )
  ) {
    return null;
  }
  const shoulder = midpoint(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);
  const hip = midpoint(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);
  const len = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y, shoulder.z - hip.z);
  return len < 1e-6 ? null : len;
}

/**
 * Confidence with both sides equal, so `reliableMean` averages them.
 *
 * For synthetic angle sequences — tests and the eval harness — where there is
 * no occlusion to model and side selection is not what is under test.
 */
export function equalConfidence(value = 1): SideConfidence {
  return {
    elbowLeft: value,
    elbowRight: value,
    hipLeft: value,
    hipRight: value,
    kneeLeft: value,
    kneeRight: value,
  };
}

/** Mean visibility across the three landmarks forming one side's angle. */
function chainConfidence(landmarks: Landmark[], a: number, b: number, c: number): number {
  const values = [a, b, c].map((i) => landmarks[i]?.visibility ?? 0);
  return (values[0] + values[1] + values[2]) / 3;
}

function confidenceOf(landmarks: Landmark[]): SideConfidence {
  return {
    elbowLeft: chainConfidence(landmarks, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST),
    elbowRight: chainConfidence(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST),
    hipLeft: chainConfidence(landmarks, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE),
    hipRight: chainConfidence(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE),
    kneeLeft: chainConfidence(landmarks, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE),
    kneeRight: chainConfidence(landmarks, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE),
  };
}

/** All joint angles the fast loop uses, for one frame. */
export function computeJointAngles(
  landmarks: Landmark[],
  minVisibility = DEFAULT_MIN_VISIBILITY,
): JointAngles {
  const g = (a: number, b: number, c: number) => gatedAngle(landmarks, minVisibility, a, b, c);
  return {
    elbowLeft: g(LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST),
    elbowRight: g(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST),
    shoulderLeft: g(LM.LEFT_ELBOW, LM.LEFT_SHOULDER, LM.LEFT_HIP),
    shoulderRight: g(LM.RIGHT_ELBOW, LM.RIGHT_SHOULDER, LM.RIGHT_HIP),
    hipLeft: g(LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE),
    hipRight: g(LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE),
    kneeLeft: g(LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE),
    kneeRight: g(LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE),
    trunkLean: trunkLeanDeg(landmarks, minVisibility),
    confidence: confidenceOf(landmarks),
  };
}

/**
 * Mean of the two sides, or the single visible side, or null if neither.
 *
 * Prefer `reliableMean` for anything the product depends on. This remains for
 * callers that genuinely have no confidence information.
 */
export function bilateralMean(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) return (left + right) / 2;
  return left ?? right;
}

/**
 * How far apart two sides' confidences may be before they stop being peers.
 *
 * Within the band, averaging still earns its keep: two comparable readings of
 * the same joint cancel each other's jitter. Beyond it, the sides are not two
 * measurements of one thing — one is a measurement and the other is a guess.
 */
export const CONFIDENCE_TIE_BAND = 0.15;

/**
 * Combine two sides, weighting by how well each was actually seen.
 *
 * ## The failure this exists to stop
 *
 * MediaPipe does not omit an occluded limb; it extrapolates one, and reports a
 * visibility that stays well above any threshold worth setting. Averaging that
 * guess with a good reading gives an answer worse than either.
 *
 * Field testing made the cost concrete. Viewed obliquely, a push-up at the
 * bottom has the far arm hidden behind the torso, and MediaPipe tends to guess
 * it near-straight. The near elbow reads ~95 degrees, the far one ~170, and the
 * mean lands around 132 — a hair under the 135 gate on a good frame and above
 * it on a bad one. The result is a rep counter that works while the arms are
 * apart and stops exactly when the movement gets interesting: reported as
 * push-ups "hampir gapernah" counting, while random arm waving counted fine.
 *
 * The same mechanism made squats read deeper than they were, so a partial rep
 * passed the depth rule and the user was told to stand up straighter instead of
 * to squat lower.
 */
export function reliableMean(
  left: number | null,
  right: number | null,
  confLeft: number,
  confRight: number,
  tieBand = CONFIDENCE_TIE_BAND,
): number | null {
  if (left === null) return right;
  if (right === null) return left;

  if (Math.abs(confLeft - confRight) <= tieBand) return (left + right) / 2;
  return confLeft > confRight ? left : right;
}

/**
 * The angle the rep-counting state machine tracks for a given exercise.
 *
 * Push-up is driven by the elbow, squat by the knee: in both cases that joint
 * has the largest, most reliable range of motion through the movement.
 */
export function primaryAngle(angles: JointAngles, exercise: 'pushup' | 'squat'): number | null {
  const c = angles.confidence;
  return exercise === 'pushup'
    ? reliableMean(angles.elbowLeft, angles.elbowRight, c.elbowLeft, c.elbowRight)
    : reliableMean(angles.kneeLeft, angles.kneeRight, c.kneeLeft, c.kneeRight);
}

/**
 * The primary angle computed straight from landmarks at the *counting*
 * visibility bar.
 *
 * Deliberately separate from `primaryAngle(computeJointAngles(...))`, which
 * inherits the stricter judging threshold. Computing only the two joints the
 * counter needs also avoids recomputing the whole set at a second threshold on
 * every frame.
 */
export function primaryAngleForCounting(
  landmarks: Landmark[],
  exercise: 'pushup' | 'squat',
  minVisibility = COUNTING_MIN_VISIBILITY,
): number | null {
  const g = (a: number, b: number, c: number) => gatedAngle(landmarks, minVisibility, a, b, c);
  const conf = (a: number, b: number, c: number) => chainConfidence(landmarks, a, b, c);

  return exercise === 'pushup'
    ? reliableMean(
        g(LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST),
        g(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST),
        conf(LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST),
        conf(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST),
      )
    : reliableMean(
        g(LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE),
        g(LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE),
        conf(LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE),
        conf(LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE),
      );
}
