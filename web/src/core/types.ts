/**
 * Shared types for the fast loop.
 *
 * Everything in `core/` is pure: no DOM, no MediaPipe imports, no side effects.
 * The app and the Node-based eval scripts import these same modules, so the
 * numbers reported in the paper come from the code that actually runs on device.
 */

/** A single BlazePose landmark. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** MediaPipe confidence that the joint is present and not occluded, 0..1. */
  visibility: number;
}

/**
 * BlazePose 33-landmark indices.
 *
 * Only the joints the fast loop actually uses are named; the face and hand
 * landmarks are present in the array but never read.
 */
export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export const LANDMARK_COUNT = 33;

export type Side = 'left' | 'right';

/**
 * Movements measured in repetitions.
 *
 * Kept deliberately narrow. The rep counter, the rep rules, and the per-rep
 * feature window all only make sense for these, and widening this type to
 * include plank would force a meaningless entry into every one of their
 * threshold tables.
 */
export type ExerciseKind = 'pushup' | 'squat';

/**
 * Movements measured in held time.
 *
 * A plank has no repetitions to count — what is measured is how long the
 * position is held and whether the hip line stays straight. That is a
 * different engine (`core/holdTracker.ts`), not a different threshold.
 */
export type HoldKind = 'plank';

/** Anything the app can train. */
export type MovementKind = ExerciseKind | HoldKind;

const HOLDS: readonly MovementKind[] = ['plank'];

export function isHold(movement: MovementKind): movement is HoldKind {
  return HOLDS.includes(movement);
}

export function isExercise(movement: MovementKind): movement is ExerciseKind {
  return !isHold(movement);
}

/**
 * Joint angles for one frame, in degrees.
 *
 * A field is `null` when the landmarks it depends on were below the visibility
 * threshold. Null propagates deliberately: the rep counter holds rather than
 * guessing, because a wrong rep count is immediately visible to the user and
 * destroys trust in the whole product.
 */
export interface JointAngles {
  elbowLeft: number | null;
  elbowRight: number | null;
  shoulderLeft: number | null;
  shoulderRight: number | null;
  hipLeft: number | null;
  hipRight: number | null;
  /**
   * Signed deviation of the shoulder-hip-knee line from straight.
   * Positive means the hip is below the shoulder-knee line (sag); negative
   * means it is above it (pike). Optional for older synthetic fixtures.
   */
  hipLineLeft?: number | null;
  hipLineRight?: number | null;
  kneeLeft: number | null;
  kneeRight: number | null;
  /** Torso deviation from vertical, degrees. 0 = upright. */
  trunkLean: number | null;
  /**
   * How well each side was observed, 0..1.
   *
   * Carried alongside the angles because visibility is not a pass/fail gate:
   * an occluded limb is still *reported*, just badly, and combining it with a
   * well-seen one on equal terms corrupts the result. See `reliableMean`.
   */
  confidence: SideConfidence;
}

/** Mean landmark visibility for each side's joint chain. */
export interface SideConfidence {
  elbowLeft: number;
  elbowRight: number;
  hipLeft: number;
  hipRight: number;
  kneeLeft: number;
  kneeRight: number;
}

/** One frame of pose data plus its capture time. */
export interface PoseFrame {
  /** Metric world landmarks (metres, origin at hip midpoint). */
  landmarks: Landmark[];
  /** Milliseconds, monotonic. */
  timestampMs: number;
}
