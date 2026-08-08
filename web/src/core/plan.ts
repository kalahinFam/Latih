/**
 * Weekly training plan.
 *
 * The session loop already decides *how many reps* to ask for. This decides
 * *when to ask*, and turns a number on the HUD into something that looks like
 * a plan a coach would write down.
 *
 * ## One progression axis, on purpose
 *
 * Sets stay fixed and only the rep target moves. Progressing sets and reps at
 * once makes the load change unpredictably — two sessions could differ by 30%
 * of total volume without either number looking unusual — and it makes the
 * adaptation impossible to explain to the user in one sentence. Reps are the
 * axis the fast loop actually measures, so reps are the axis that moves.
 *
 * Pure logic: no storage, no DOM, no clock beyond what is passed in.
 */

import { nextHoldTarget, nextTarget, type ExerciseTarget, type SetRecord } from './sessionLoop.ts';
// Type-only on purpose. `split.ts` reads this module's weekday labels and
// bounds; importing a value back would close the loop into a real circular
// import, and all this module needs is the shape of what the split produces.
import type { WorkoutSplit } from './split.ts';
import { isHold, type ExerciseKind, type MovementKind } from './types.ts';

export interface PlanPreferences {
  /** Training days per week, 2..6. */
  daysPerWeek: number;
  /**
   * The weekdays actually chosen, 0 = Monday.
   *
   * Empty means "no preference" and the even spread below decides. Kept
   * alongside `daysPerWeek` rather than replacing it because a count is still
   * what the progression rules and the copy talk about; when both are present
   * the explicit list wins, and `loadPreferences` makes the count agree with it
   * so the two can never tell the user different things.
   */
  trainingDays: number[];
  /** Preferred start time, "HH:MM" in the device's local zone. */
  timeOfDay: string;
  exercises: ExerciseKind[];
  setsPerExercise: number;
}

export const DEFAULT_PREFERENCES: PlanPreferences = {
  daysPerWeek: 3,
  trainingDays: [],
  timeOfDay: '18:00',
  exercises: ['pushup', 'squat'],
  setsPerExercise: 3,
};

/**
 * Bounds on frequency.
 *
 * Below two sessions a week there is not enough stimulus for the progression
 * rules to have anything to read; above six there is no rest day at all, which
 * is where bodyweight training stops producing adaptation and starts producing
 * niggles.
 */
export const MIN_DAYS_PER_WEEK = 2;
export const MAX_DAYS_PER_WEEK = 6;

/** Monday-first, matching Indonesian convention. */
export const WEEKDAY_LABELS = [
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
  'Minggu',
] as const;

/** The same days, short enough to fit seven side by side on a phone. */
export const WEEKDAY_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'] as const;

export interface PlannedExercise {
  movement: MovementKind;
  sets: number;
  /**
   * Repetitions for a counted movement, seconds for a held one.
   *
   * One field with `unit` beside it rather than two optional ones: every
   * consumer has to know which unit it is printing anyway, and an optional
   * `targetSeconds` would let a caller read reps off a plank and get `0`.
   */
  amount: number;
  unit: 'reps' | 'seconds';
  reason: ExerciseTarget['reason'];
}

export interface PlanDay {
  /** 0 = Monday. */
  weekday: number;
  label: string;
  isTraining: boolean;
  /** What the split puts on this day. Empty on a rest day. */
  exercises: PlannedExercise[];
  /** The session's name, e.g. "Seluruh tubuh". Empty on a rest day. */
  focusLabel: string;
  /** A set for this day already exists in history. */
  done: boolean;
  isToday: boolean;
}

export interface WeeklyPlan {
  /** Midnight local on the Monday this plan starts. */
  weekStart: number;
  days: PlanDay[];
  timeOfDay: string;
  /** Training days completed so far this week. */
  completedDays: number;
  plannedDays: number;
}

/**
 * Spread N training days as evenly as possible over seven.
 *
 * Even spacing is the whole point: three sessions on Friday, Saturday and
 * Sunday is nominally the same frequency as Monday, Wednesday, Friday and a
 * materially worse week, because recovery happens between sessions rather than
 * in a block at the end.
 */
export function trainingWeekdays(daysPerWeek: number): number[] {
  const n = clamp(daysPerWeek, MIN_DAYS_PER_WEEK, MAX_DAYS_PER_WEEK);
  const days = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    days.add(Math.min(6, Math.round((i * 7) / n)));
  }

  // Rounding can collide at high frequencies; fill forward so the count is
  // always what the user asked for.
  for (let day = 0; days.size < n && day < 7; day += 1) {
    days.add(day);
  }

  return [...days].sort((a, b) => a - b);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Weekdays as the rest of the app expects them: whole, 0..6, unique, sorted. */
export function normaliseWeekdays(days: readonly number[]): number[] {
  const chosen = new Set<number>();
  for (const day of days) {
    if (Number.isInteger(day) && day >= 0 && day <= 6) chosen.add(day);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * The weekdays this plan trains on.
 *
 * A chosen list is honoured as given — someone who trains Saturday and Sunday
 * because that is when they are free should get Saturday and Sunday, not the
 * evenly spaced week the app would have picked for them. It is ignored only
 * when it falls outside the frequency bounds, which is storage that has been
 * hand-edited or written by an older version, and the even spread is the safer
 * thing to fall back to than a week with one session or none.
 */
export function planWeekdays(preferences: PlanPreferences): number[] {
  const chosen = normaliseWeekdays(preferences.trainingDays ?? []);
  if (chosen.length >= MIN_DAYS_PER_WEEK && chosen.length <= MAX_DAYS_PER_WEEK) return chosen;
  return trainingWeekdays(preferences.daysPerWeek);
}

/** Midnight local on the Monday of the week containing `at`. */
export function startOfWeek(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  // getDay() is Sunday-first; shift so Monday is 0.
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date.getTime();
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/**
 * Build this week's plan.
 *
 * @param history Every set recorded, used both to set targets and to mark days
 *                already trained.
 * @param now Injected rather than read from the clock, so the tests are not
 *            hostage to the day they run on.
 * @param split What each training day contains. Omitted, every training day
 *              gets `preferences.exercises` — which is what this did before
 *              splits existed, and what a plan built for the meal target (which
 *              only asks *whether* today is a training day) still wants.
 */
export function buildWeeklyPlan(
  preferences: PlanPreferences,
  history: SetRecord[],
  now: number = Date.now(),
  split: WorkoutSplit | null = null,
): WeeklyPlan {
  const weekStart = startOfWeek(now);
  const trainingDays = new Set(split ? split.sessions.map((s) => s.weekday) : planWeekdays(preferences));
  // The split's recommendation is a recommendation; what the user set in
  // Pengaturan is a decision, so preferences win.
  const sets = clamp(preferences.setsPerExercise, 1, 6);

  // One decision per movement for the whole week. Recomputing per day would
  // show a target that changes on days the user has not trained yet.
  const targets = new Map<MovementKind, PlannedExercise>();
  const planFor = (movement: MovementKind): PlannedExercise => {
    const existing = targets.get(movement);
    if (existing) return existing;

    const planned: PlannedExercise = isHold(movement)
      ? (() => {
          const target = nextHoldTarget(movement, history);
          return {
            movement,
            sets,
            amount: target.targetSeconds,
            unit: 'seconds' as const,
            reason: target.reason,
          };
        })()
      : (() => {
          const target = nextTarget(movement, history);
          return {
            movement,
            sets,
            amount: target.targetReps,
            unit: 'reps' as const,
            reason: target.reason,
          };
        })();

    targets.set(movement, planned);
    return planned;
  };

  const days: PlanDay[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const dayStart = weekStart + weekday * 24 * 60 * 60 * 1000;
    const isTraining = trainingDays.has(weekday);
    const session = split?.sessions.find((s) => s.weekday === weekday) ?? null;
    const movements: MovementKind[] = isTraining
      ? (session?.movements ?? preferences.exercises)
      : [];

    days.push({
      weekday,
      label: WEEKDAY_LABELS[weekday],
      isTraining,
      exercises: movements.map(planFor),
      focusLabel: session?.label ?? '',
      done: history.some((set) => sameLocalDay(set.at, dayStart)),
      isToday: sameLocalDay(now, dayStart),
    });
  }

  const planned = days.filter((day) => day.isTraining);

  return {
    weekStart,
    days,
    timeOfDay: preferences.timeOfDay,
    completedDays: planned.filter((day) => day.done).length,
    plannedDays: planned.length,
  };
}

/** Is today a scheduled training day? Drives the meal target and the reminder. */
export function isTrainingDay(plan: WeeklyPlan): boolean {
  return plan.days.some((day) => day.isToday && day.isTraining);
}

export function todaysPlan(plan: WeeklyPlan): PlanDay | null {
  return plan.days.find((day) => day.isToday) ?? null;
}

/**
 * Next scheduled session at or after `now`, as a timestamp.
 *
 * Looks into next week when the current one is spent, so the reminder has
 * something to schedule on a Sunday evening.
 */
export function nextSessionAt(plan: WeeklyPlan, now: number = Date.now()): number | null {
  const [hours, minutes] = parseTime(plan.timeOfDay);

  for (let offset = 0; offset < 14; offset += 1) {
    const weekday = offset % 7;
    if (!plan.days[weekday].isTraining) continue;

    const date = new Date(plan.weekStart + offset * 24 * 60 * 60 * 1000);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() > now) return date.getTime();
  }

  return null;
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return [18, 0];
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return [hours, minutes];
}

/** One-line summary for the UI. */
export function explainPlan(plan: WeeklyPlan): string {
  const days = plan.days
    .filter((day) => day.isTraining)
    .map((day) => day.label)
    .join(', ');
  return `${plan.plannedDays}× seminggu — ${days} — pukul ${plan.timeOfDay}`;
}
