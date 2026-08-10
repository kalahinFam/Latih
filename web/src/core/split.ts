/**
 * The workout split — which movements land on which training day.
 *
 * `core/plan.ts` decides *when* to train and `core/sessionLoop.ts` decides *how
 * much*. This is the piece between them: given the days somebody picked and
 * what they told onboarding, it decides *what* each of those days contains.
 *
 * ## Why rules and not a model
 *
 * The catalogue is three movements — push-up, squat, plank — because those are
 * the three the camera can actually judge. A split over three movements is not
 * a search problem; it is two or three decisions with known reasons, and a
 * model asked to make them would be free to prescribe lunges the fast loop
 * cannot count. Rules also run offline, cost nothing, and can be unit-tested,
 * which matters for the one screen in the product that tells the user what to
 * do with their week.
 *
 * ## The rules, and what each is for
 *
 * - **Pattern.** Up to three well-spaced days, every session trains everything:
 *   with three movements that is a ~20 minute session and each movement gets
 *   trained two or three times a week, which is where the frequency literature
 *   sits. Four or more days — or three days stacked back to back — and the same
 *   choice would mean pushing on consecutive days, so push and legs alternate
 *   instead and each still lands two or three times.
 * - **Order.** Push-up, squat, then plank. The trunk goes last on purpose: the
 *   fast loop's most common push-up fault is a sagging hip line, and a trunk
 *   already fatigued by a plank is how that fault gets produced.
 * - **Sets.** From experience, plus one for someone training to gain mass,
 *   because volume is the lever there. Never for a beginner: the first weeks
 *   fail on soreness and on giving up, not on insufficient volume.
 * - **Rest.** Shorter when the goal is fat loss (density is the point), longer
 *   when it is mass (the next set should be a real set).
 *
 * Pure data and pure functions. No storage, no DOM, no clock.
 */

import type { EnergyGoal } from './energy.ts';
import type { ExperienceLevel } from './onboarding.ts';
import { MAX_DAYS_PER_WEEK, normaliseWeekdays } from './plan.ts';
import { MOVEMENT_NAMES, isHold, type MovementKind } from './types.ts';

/**
 * How the week is shaped.
 *
 * Two patterns, not a menu: with three movements, anything finer would be a
 * label change rather than a training change.
 */
export type SplitPattern = 'full-body' | 'upper-lower';

/** Which half of an alternating week a session belongs to. */
export type SessionFocus = 'full' | 'upper' | 'lower';

export interface SplitSession {
  /** 0 = Monday, matching `core/plan.ts`. */
  weekday: number;
  focus: SessionFocus;
  /** Shown as the session's name. */
  label: string;
  /** In the order they should be performed. */
  movements: MovementKind[];
}

export interface WorkoutSplit {
  pattern: SplitPattern;
  sessions: SplitSession[];
  /** Working sets per movement. */
  setsPerExercise: number;
  /** Rest between sets, seconds. */
  restSeconds: number;
  /** Times each movement is trained per week. */
  weeklyFrequency: Record<MovementKind, number>;
}

export interface SplitInput {
  /** Weekdays picked in onboarding, 0 = Monday. */
  trainingDays: readonly number[];
  experience: ExperienceLevel;
  goal: EnergyGoal;
}

/** Movements per session, by focus. Plank is in every one — see below. */
const MOVEMENTS_BY_FOCUS: Record<SessionFocus, MovementKind[]> = {
  full: ['pushup', 'squat', 'plank'],
  upper: ['pushup', 'plank'],
  lower: ['squat', 'plank'],
};

const FOCUS_LABELS: Record<SessionFocus, string> = {
  full: 'Seluruh tubuh',
  upper: 'Dorongan & inti',
  lower: 'Tungkai & inti',
};

/**
 * Starting sets per movement.
 *
 * Two for a beginner is not caution for its own sake: the first fortnight is
 * lost to soreness and to sessions that feel like a chore, and neither is
 * fixed by a third set.
 */
const SETS_BY_EXPERIENCE: Record<ExperienceLevel, number> = {
  baru: 2,
  pernah: 3,
  rutin: 3,
};

/**
 * Rest between sets, by what the training is for.
 *
 * Fat loss buys something from a short rest — more work in the same session.
 * Mass does not: a set started before the previous one has been paid for is a
 * shorter set, and the number of hard repetitions is the thing that drives the
 * adaptation.
 */
const REST_BY_GOAL: Record<EnergyGoal, number> = {
  lose: 45,
  maintain: 60,
  gain: 90,
};

/** Seconds a set costs, before rest. Rough by nature, and only used for an estimate. */
const SET_SECONDS = 45;

export function recommendedSets(experience: ExperienceLevel, goal: EnergyGoal): number {
  const base = SETS_BY_EXPERIENCE[experience];
  // Volume is the lever for mass — but not for someone in their first weeks,
  // where the limit is recovery and habit rather than stimulus.
  return goal === 'gain' && experience !== 'baru' ? base + 1 : base;
}

/** Do any two training days sit next to each other, Sunday→Monday included? */
export function hasBackToBackDays(days: readonly number[]): boolean {
  const sorted = normaliseWeekdays(days);
  if (sorted.length < 2) return false;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) return true;
  }
  // The week wraps: Sunday and Monday are consecutive sessions even though
  // their indices are as far apart as indices get.
  return sorted[0] === 0 && sorted[sorted.length - 1] === 6;
}

/**
 * Full body, or alternating halves.
 *
 * The count alone is not enough. Three days on Friday, Saturday and Sunday is
 * the same frequency as Monday, Wednesday, Friday and a different training
 * problem: pushing on three consecutive days gives the shoulders no day off,
 * and alternating is what fixes it.
 */
export function choosePattern(trainingDays: readonly number[]): SplitPattern {
  const days = normaliseWeekdays(trainingDays);
  if (days.length >= 4) return 'upper-lower';
  if (days.length === 3 && hasBackToBackDays(days)) return 'upper-lower';
  return 'full-body';
}

/**
 * Build the week.
 *
 * Alternation starts on the first training day and simply alternates from
 * there; with an odd number of sessions the push day gets the extra one,
 * because bodyweight pushing is the slower of the two to progress and the one
 * the rep counter measures most reliably.
 */
export function recommendSplit(input: SplitInput): WorkoutSplit {
  const days = normaliseWeekdays(input.trainingDays).slice(0, MAX_DAYS_PER_WEEK);
  const pattern = choosePattern(days);

  const sessions: SplitSession[] = days.map((weekday, index) => {
    const focus: SessionFocus =
      pattern === 'full-body' ? 'full' : index % 2 === 0 ? 'upper' : 'lower';
    return {
      weekday,
      focus,
      label: FOCUS_LABELS[focus],
      movements: [...MOVEMENTS_BY_FOCUS[focus]],
    };
  });

  const weeklyFrequency: Record<MovementKind, number> = { pushup: 0, squat: 0, plank: 0 };
  for (const session of sessions) {
    for (const movement of session.movements) weeklyFrequency[movement] += 1;
  }

  const setsPerExercise = recommendedSets(input.experience, input.goal);
  const restSeconds = REST_BY_GOAL[input.goal];

  return {
    pattern,
    sessions,
    setsPerExercise,
    restSeconds,
    weeklyFrequency,
  };
}

/** Roughly how long one session takes, minutes. */
export function estimatedMinutes(split: WorkoutSplit, session: SplitSession): number {
  const sets = session.movements.length * split.setsPerExercise;
  // The last set of the session is not followed by a rest.
  const seconds = sets * SET_SECONDS + Math.max(0, sets - 1) * split.restSeconds;
  return Math.max(1, Math.round(seconds / 60));
}

/** The session scheduled for a weekday, or `null` on a rest day. */
export function sessionFor(split: WorkoutSplit, weekday: number): SplitSession | null {
  return split.sessions.find((session) => session.weekday === weekday) ?? null;
}

/** Movements the split puts on a weekday. Empty on a rest day. */
export function movementsOn(split: WorkoutSplit, weekday: number): MovementKind[] {
  return sessionFor(split, weekday)?.movements ?? [];
}

/** One line for a session card: "Push-up · Squat · Plank". */
export function describeSession(session: SplitSession): string {
  return session.movements.map((movement) => MOVEMENT_NAMES[movement]).join(' · ');
}

/** The dose for one movement, in its own unit. */
export function describeDose(movement: MovementKind, sets: number, amount: number): string {
  return isHold(movement) ? `${sets} set × ${amount} detik` : `${sets} set × ${amount} repetisi`;
}
