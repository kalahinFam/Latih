/**
 * Is the body in the movement at all?
 *
 * ## The gap this closes
 *
 * The rep counter reads one joint angle. That is the right signal for grading a
 * repetition and a hopeless one for deciding whether a repetition is happening:
 * a knee bending and straightening looks identical whether the person is
 * standing under load or lying on their back moving their legs. Field testing
 * found exactly that — "kayak knee crunch dihitung asal kaki ditekuk trus
 * dilurusin" — and the same blind spot let arm movement register as push-ups
 * while actual push-ups did not.
 *
 * The missing constraint is orientation. A squat happens with the torso roughly
 * upright; a push-up happens with the torso roughly horizontal. Neither is
 * visible in the joint angle, both are cheap to measure, and requiring them
 * removes a whole class of phantom repetitions without touching the counting
 * logic itself.
 *
 * ## Why bands this wide
 *
 * The thresholds admit far more than good form does, on purpose. This is not a
 * form rule and must never reject a real repetition: a deep squat leans the
 * torso a long way forward, and a push-up seen obliquely does not measure as
 * flat as it looks. Anything genuinely ambiguous is allowed through and left to
 * the rules to grade. What it rejects is the unambiguous case — someone lying
 * down, sitting, or standing still.
 */

import { trunkLeanDeg } from './angles.ts';
import { LM, type Landmark, type MovementKind } from './types.ts';

/**
 * Trunk lean, in degrees from vertical, still acceptable for a squat.
 *
 * A competition-depth squat with a long femur can reach 50-55 degrees, and the
 * trunk-lean *rule* flags 55. This has to sit clear above that or a rep the
 * rules exist to criticise would never reach them.
 */
const SQUAT_MAX_TRUNK_LEAN = 75;

/** Above this, the squat is a form-invalid attempt rather than a rep. */
const SQUAT_COUNTABLE_TRUNK_LEAN = 55;
const SQUAT_REJECT_TRUNK_LEAN = 70;

/**
 * Trunk lean at or beyond which the body counts as horizontal for a push-up.
 *
 * 90 is flat. Well below it, because the torso is rarely level with the floor
 * in a real push-up and the camera is rarely square to it.
 */
const PUSHUP_MIN_TRUNK_LEAN = 55;

/**
 * Landmarks must be at least this visible for the check to run at all.
 *
 * Below it the posture is unknown rather than wrong, and an unknown posture
 * must not block counting — that would trade phantom reps for missing ones.
 */
const MIN_VISIBILITY = 0.4;

/** A hand this close to the foot plane is being used as support. */
const HAND_FLOOR_MARGIN_RATIO = 0.18;
const HAND_FLOOR_MARGIN_MIN = 0.08;

/** A lifted ankle separates from its toe by much more than a grounded foot. */
const MAX_ANKLE_LIFT_RATIO = 0.3;
const MIN_ANKLE_LIFT_METERS = 0.08;

/**
 * Squat stance tolerance around shoulder width.
 *
 * Warned about, never counted against — see `INVALIDATING`. Measured from
 * ankle separation over shoulder separation, both of which include the depth
 * axis, so this is the noisiest gate of the three.
 */
const MIN_STANCE_RATIO = 0.75;
const MAX_STANCE_RATIO = 1.5;

/**
 * Which gates reject the repetition rather than merely warning.
 *
 * Hands on the floor and a lifted heel are *cheats*: both make the movement
 * easier, so a rep performed with either is not the rep the count claims. A
 * narrow stance is not a cheat, it is a style — plenty of people squat inside
 * shoulder width on purpose. Rejecting the rep for it would punish a
 * preference as hard as cheating, and it is also the gate most likely to fire
 * on a good rep, since ankle separation depends on the depth coordinate the
 * tracker estimates worst.
 */
const INVALIDATING: ReadonlySet<PostureIssue> = new Set<PostureIssue>([
  'squat-hands-on-floor',
  'squat-feet-lifted',
]);

export type PostureIssue =
  | 'not-upright'
  | 'not-horizontal'
  | 'squat-hands-on-floor'
  | 'squat-feet-lifted'
  | 'squat-stance';

/** Spoken-only guidance for posture gates. These are not HUD corrections. */
export const POSTURE_CUE_TEXT: Record<PostureIssue, string> = {
  'not-upright': 'Jaga dada tetap tegak',
  'not-horizontal': 'Ambil posisi plank, badan lurus mendatar',
  'squat-hands-on-floor': 'Jangan bertumpu pada tangan',
  'squat-feet-lifted': 'Jaga telapak kaki tetap menempel',
  'squat-stance': 'Buka kaki selebar bahu',
};

export function postureCueFor(issue: PostureIssue): string {
  return POSTURE_CUE_TEXT[issue];
}

export function allPostureCueTexts(): string[] {
  return [...new Set(Object.values(POSTURE_CUE_TEXT))].sort();
}

export interface PostureStatus {
  /** False only when the body is clearly not in this movement. */
  plausible: boolean;
  /** False when the body is present but the attempt violates a count gate. */
  countable: boolean;
  /** True when the current repetition must be rejected, not merely warned. */
  invalidatesRep: boolean;
  issue: PostureIssue | null;
  /** Trunk deviation from vertical, degrees, or null if unreadable. */
  trunkLeanDeg: number | null;
}

const UNKNOWN: PostureStatus = {
  plausible: true,
  countable: true,
  invalidatesRep: false,
  issue: null,
  trunkLeanDeg: null,
};

/**
 * Does the body's orientation match the exercise?
 *
 * Returns `plausible: true` whenever it cannot tell. Silence is the safe
 * default here: a missed rep is the failure users notice and resent most.
 */
export function checkPosture(
  landmarks: Landmark[] | null,
  exercise: MovementKind,
): PostureStatus {
  if (!landmarks || landmarks.length === 0) return UNKNOWN;

  const lean = trunkLeanDeg(landmarks, MIN_VISIBILITY);

  if (exercise === 'squat') {
    // Lying down reads near 90 and can produce a perfectly clean knee-angle
    // trace, which is the whole problem.
    const plausible = lean === null || lean <= SQUAT_MAX_TRUNK_LEAN;

    // Concrete support cheats. Checked before the torso warning so a
    // hand-assisted squat is rejected even when the lean and the knee angle
    // look otherwise plausible.
    const constraint = squatConstraintIssue(landmarks);
    if (constraint !== null) {
      const rejects = INVALIDATING.has(constraint);
      return {
        plausible,
        // A warned-about stance still counts: the cue tells them, the number
        // does not argue with them.
        countable: !rejects,
        invalidatesRep: rejects,
        issue: constraint,
        trunkLeanDeg: lean,
      };
    }

    if (!plausible) {
      return {
        plausible,
        countable: false,
        invalidatesRep: true,
        issue: 'not-upright',
        trunkLeanDeg: lean,
      };
    }

    if (lean !== null && lean > SQUAT_REJECT_TRUNK_LEAN) {
      return {
        plausible: true,
        countable: false,
        invalidatesRep: true,
        issue: 'not-upright',
        trunkLeanDeg: lean,
      };
    }

    // A large forward lean is still recognisably a squat. Keep the knee angle
    // available so a valid deep squat is not lost to a transient lean, while
    // the live warning tells the user what to correct.
    if (lean !== null && lean > SQUAT_COUNTABLE_TRUNK_LEAN) {
      return {
        plausible: true,
        countable: false,
        invalidatesRep: false,
        issue: 'not-upright',
        trunkLeanDeg: lean,
      };
    }

    return {
      plausible: true,
      countable: true,
      invalidatesRep: false,
      issue: null,
      trunkLeanDeg: lean,
    };
  }

  // Push-up and plank are the same question: is the body horizontal. Kept
  // exactly as before — only the squat carries count gates, and push-up and
  // plank never reject a rep already in flight.
  const plausible = lean === null || lean >= PUSHUP_MIN_TRUNK_LEAN;
  return {
    plausible,
    countable: plausible,
    invalidatesRep: false,
    issue: plausible ? null : 'not-horizontal',
    trunkLeanDeg: lean,
  };
}

/** What to do about it, in the user's terms. */
export function postureMessage(issue: PostureIssue): string {
  switch (issue) {
    case 'not-upright':
      return 'Jaga dada tetap tegak — hitungan squat ditahan.';
    case 'not-horizontal':
      return 'Ambil posisi plank, badan lurus mendatar.';
    case 'squat-hands-on-floor':
      return 'Jangan bertumpu pada tangan. Biarkan tangan tetap melayang.';
    case 'squat-feet-lifted':
      return 'Jaga telapak kaki tetap menempel lantai.';
    case 'squat-stance':
      return 'Buka kaki selebar bahu.';
  }
}

/**
 * Are the hands planted, as a push-up needs?
 *
 * A secondary signal for the same question, and a cheap one: in a push-up the
 * wrists sit at or below the shoulders in world space, whichever way the camera
 * faces. Standing and bending the elbows puts them above.
 *
 * World space has -y up, so "below" means a larger y.
 */
export function handsPlanted(landmarks: Landmark[] | null): boolean {
  if (!landmarks) return true;

  const parts = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_WRIST, LM.RIGHT_WRIST].map(
    (i) => landmarks[i],
  );
  if (parts.some((lm) => !lm || lm.visibility < MIN_VISIBILITY)) return true;

  const shoulderY = (parts[0].y + parts[1].y) / 2;
  const wristY = (parts[2].y + parts[3].y) / 2;
  // A small allowance: at the top of a push-up the shoulders sit well above the
  // hands, at the bottom they are nearly level.
  return wristY >= shoulderY - 0.1;
}

/* ------------------------------------------------------ squat count gates */

function visible(landmarks: Landmark[], ...indices: number[]): boolean {
  return indices.every((index) => landmarks[index]?.visibility >= MIN_VISIBILITY);
}

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function horizontalDistance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function handOnFloor(
  landmarks: Landmark[],
  wristIndex: number,
  ankleIndex: number,
  footIndex: number,
  kneeIndex: number,
): boolean | null {
  if (!visible(landmarks, wristIndex, ankleIndex, footIndex, kneeIndex)) return null;

  const wrist = landmarks[wristIndex];
  const ankle = landmarks[ankleIndex];
  const foot = landmarks[footIndex];
  const knee = landmarks[kneeIndex];
  const lowerLeg = distance(knee, ankle);
  const margin = Math.max(HAND_FLOOR_MARGIN_MIN, lowerLeg * HAND_FLOOR_MARGIN_RATIO);
  const floorY = Math.max(ankle.y, foot.y);
  return wrist.y >= floorY - margin;
}

function ankleLifted(
  landmarks: Landmark[],
  ankleIndex: number,
  footIndex: number,
  kneeIndex: number,
): boolean | null {
  if (!visible(landmarks, ankleIndex, footIndex, kneeIndex)) return null;

  const lowerLeg = distance(landmarks[kneeIndex], landmarks[ankleIndex]);
  const ankleToToeRise = landmarks[footIndex].y - landmarks[ankleIndex].y;
  return ankleToToeRise > Math.max(MIN_ANKLE_LIFT_METERS, lowerLeg * MAX_ANKLE_LIFT_RATIO);
}

function stanceOutsideShoulderWidth(landmarks: Landmark[]): boolean | null {
  const required = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
  if (!visible(landmarks, ...required)) return null;

  const shoulders = horizontalDistance(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);
  const ankles = horizontalDistance(landmarks[LM.LEFT_ANKLE], landmarks[LM.RIGHT_ANKLE]);
  if (shoulders < 1e-6) return null;

  const ratio = ankles / shoulders;
  return ratio < MIN_STANCE_RATIO || ratio > MAX_STANCE_RATIO;
}

function squatConstraintIssue(landmarks: Landmark[]): PostureIssue | null {
  const leftHand = handOnFloor(
    landmarks,
    LM.LEFT_WRIST,
    LM.LEFT_ANKLE,
    LM.LEFT_FOOT_INDEX,
    LM.LEFT_KNEE,
  );
  const rightHand = handOnFloor(
    landmarks,
    LM.RIGHT_WRIST,
    LM.RIGHT_ANKLE,
    LM.RIGHT_FOOT_INDEX,
    LM.RIGHT_KNEE,
  );
  if (leftHand === true || rightHand === true) return 'squat-hands-on-floor';

  const leftLifted = ankleLifted(landmarks, LM.LEFT_ANKLE, LM.LEFT_FOOT_INDEX, LM.LEFT_KNEE);
  const rightLifted = ankleLifted(landmarks, LM.RIGHT_ANKLE, LM.RIGHT_FOOT_INDEX, LM.RIGHT_KNEE);
  if (leftLifted === true || rightLifted === true) return 'squat-feet-lifted';

  if (stanceOutsideShoulderWidth(landmarks) === true) return 'squat-stance';
  return null;
}
