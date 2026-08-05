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

export type PostureIssue = 'not-upright' | 'not-horizontal';

export interface PostureStatus {
  /** False only when the body is clearly not in this movement. */
  plausible: boolean;
  issue: PostureIssue | null;
  /** Trunk deviation from vertical, degrees, or null if unreadable. */
  trunkLeanDeg: number | null;
}

const UNKNOWN: PostureStatus = { plausible: true, issue: null, trunkLeanDeg: null };

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
  if (lean === null) return UNKNOWN;

  if (exercise === 'squat') {
    // Lying down reads near 90 and can produce a perfectly clean knee-angle
    // trace, which is the whole problem.
    const plausible = lean <= SQUAT_MAX_TRUNK_LEAN;
    return { plausible, issue: plausible ? null : 'not-upright', trunkLeanDeg: lean };
  }

  // Push-up and plank are the same question: is the body horizontal.
  const plausible = lean >= PUSHUP_MIN_TRUNK_LEAN;
  return { plausible, issue: plausible ? null : 'not-horizontal', trunkLeanDeg: lean };
}

/** What to do about it, in the user's terms. */
export function postureMessage(issue: PostureIssue): string {
  return issue === 'not-upright'
    ? 'Berdiri dulu — hitungan squat butuh badan tegak.'
    : 'Ambil posisi plank, badan lurus mendatar.';
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
