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

import { LM, type JointAngles, type Landmark } from './types.ts';

/** Below this MediaPipe visibility, a joint is treated as unobserved. */
export const DEFAULT_MIN_VISIBILITY = 0.5;

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
  };
}

/**
 * Mean of the two sides, or the single visible side, or null if neither.
 *
 * Averaging when both sides are visible suppresses per-joint tracker jitter;
 * falling back to one side keeps the app usable when the camera sees the body
 * from an angle, which is the common case for a phone propped against a wall.
 */
export function bilateralMean(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) return (left + right) / 2;
  return left ?? right;
}

/**
 * The angle the rep-counting state machine tracks for a given exercise.
 *
 * Push-up is driven by the elbow, squat by the knee: in both cases that joint
 * has the largest, most reliable range of motion through the movement.
 */
export function primaryAngle(angles: JointAngles, exercise: 'pushup' | 'squat'): number | null {
  return exercise === 'pushup'
    ? bilateralMean(angles.elbowLeft, angles.elbowRight)
    : bilateralMean(angles.kneeLeft, angles.kneeRight);
}
