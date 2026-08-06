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

import { jointAngleDeg, reliableMean, signedHipLineDeviationDeg, trunkLeanDeg } from './angles.ts';
import { LM, type JointAngles, type Landmark, type MovementKind } from './types.ts';

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

/** Squat stance tolerance around shoulder width. */
const MIN_STANCE_RATIO = 0.75;
const MAX_STANCE_RATIO = 1.5;

/** Forearm support is bent, but not folded tightly under the body. */
const PLANK_ELBOW_MIN = 45;
const PLANK_ELBOW_MAX = 140;
const PLANK_MAX_HIP_DEVIATION = 12;

export type PostureIssue =
  | 'not-upright'
  | 'not-horizontal'
  | 'squat-hands-on-floor'
  | 'squat-feet-lifted'
  | 'squat-stance'
  | 'plank-body-not-straight'
  | 'plank-arms-too-straight'
  | 'plank-arms-too-folded'
  | 'plank-arms-unreadable';

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
  angles?: JointAngles,
): PostureStatus {
  if (!landmarks || landmarks.length === 0) return UNKNOWN;

  const lean = trunkLeanDeg(landmarks, MIN_VISIBILITY);

  if (exercise === 'squat') {
    // Lying down reads near 90 and can produce a perfectly clean knee-angle
    // trace, which is the whole problem.
    const plausible = lean === null || lean <= SQUAT_MAX_TRUNK_LEAN;

    // These are concrete support cheats. Check them before the torso warning so
    // a hand-assisted squat is rejected even when the lean and the knee angle
    // look otherwise plausible.
    const constraint = squatConstraintIssue(landmarks);
    if (constraint !== null) {
      return {
        plausible,
        countable: false,
        invalidatesRep: true,
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
      countable: constraint === null,
      invalidatesRep: false,
      issue: constraint,
      trunkLeanDeg: lean,
    };
  }

  // Push-up and plank are the same first question: is the body horizontal.
  const plausible = lean === null || lean >= PUSHUP_MIN_TRUNK_LEAN;
  if (!plausible) {
    return {
      plausible,
      countable: false,
      invalidatesRep: true,
      issue: 'not-horizontal',
      trunkLeanDeg: lean,
    };
  }

  if (exercise === 'plank') {
    const currentAngles = angles ?? computePostureAngles(landmarks);
    const deviation = hipDeviation(currentAngles);
    if (deviation !== null && Math.abs(deviation) > PLANK_MAX_HIP_DEVIATION) {
      return {
        plausible: true,
        countable: false,
        invalidatesRep: false,
        issue: 'plank-body-not-straight',
        trunkLeanDeg: lean,
      };
    }

    const armIssue = plankArmIssue(landmarks, currentAngles);
    if (armIssue !== null) {
      return {
        plausible: true,
        countable: false,
        invalidatesRep: false,
        issue: armIssue,
        trunkLeanDeg: lean,
      };
    }
  }

  return {
    plausible: true,
    countable: true,
    invalidatesRep: false,
    issue: null,
    trunkLeanDeg: lean,
  };
}

function computePostureAngles(landmarks: Landmark[]): JointAngles {
  const elbowLeft = visible(landmarks, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST)
    ? jointAngleDeg(landmarks[LM.LEFT_SHOULDER], landmarks[LM.LEFT_ELBOW], landmarks[LM.LEFT_WRIST])
    : null;
  const elbowRight = visible(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST)
    ? jointAngleDeg(landmarks[LM.RIGHT_SHOULDER], landmarks[LM.RIGHT_ELBOW], landmarks[LM.RIGHT_WRIST])
    : null;
  const hipLineLeft = visible(landmarks, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE)
    ? signedHipLineDeviationDeg(
        landmarks[LM.LEFT_SHOULDER],
        landmarks[LM.LEFT_HIP],
        landmarks[LM.LEFT_KNEE],
      )
    : null;
  const hipLineRight = visible(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE)
    ? signedHipLineDeviationDeg(
        landmarks[LM.RIGHT_SHOULDER],
        landmarks[LM.RIGHT_HIP],
        landmarks[LM.RIGHT_KNEE],
      )
    : null;

  return {
    elbowLeft,
    elbowRight,
    shoulderLeft: null,
    shoulderRight: null,
    hipLeft: null,
    hipRight: null,
    hipLineLeft,
    hipLineRight,
    kneeLeft: null,
    kneeRight: null,
    trunkLean: null,
    confidence: {
      elbowLeft: chainConfidence(landmarks, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST),
      elbowRight: chainConfidence(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST),
      hipLeft: chainConfidence(landmarks, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE),
      hipRight: chainConfidence(landmarks, LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE),
      kneeLeft: 0,
      kneeRight: 0,
    },
  };
}

function visible(landmarks: Landmark[], ...indices: number[]): boolean {
  return indices.every((index) => landmarks[index]?.visibility >= MIN_VISIBILITY);
}

function chainConfidence(landmarks: Landmark[], ...indices: number[]): number {
  const values = indices.map((index) => landmarks[index]?.visibility ?? 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function hipDeviation(angles: JointAngles): number | null {
  const confidence = angles.confidence;
  return reliableMean(
    angles.hipLineLeft ?? null,
    angles.hipLineRight ?? null,
    confidence.hipLeft,
    confidence.hipRight,
  );
}

function plankArmIssue(landmarks: Landmark[], angles: JointAngles): PostureIssue | null {
  const elbow = reliableMean(
    angles.elbowLeft,
    angles.elbowRight,
    angles.confidence.elbowLeft,
    angles.confidence.elbowRight,
  );
  if (elbow === null) return 'plank-arms-unreadable';
  if (elbow > PLANK_ELBOW_MAX) return 'plank-arms-too-straight';
  if (elbow < PLANK_ELBOW_MIN) return 'plank-arms-too-folded';
  if (!handsPlanted(landmarks)) return 'plank-arms-unreadable';
  return null;
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
    case 'plank-body-not-straight':
      return 'Jaga badan tetap sejajar lantai.';
    case 'plank-arms-too-straight':
      return 'Tekuk siku. Jangan bertumpu dengan tangan lurus.';
    case 'plank-arms-too-folded':
      return 'Buka siku sedikit dan tahan badan.';
    case 'plank-arms-unreadable':
      return 'Pastikan siku dan tangan terlihat kamera.';
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
