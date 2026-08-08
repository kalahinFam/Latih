/**
 * The split the app is currently working to.
 *
 * Derived on read, never stored. The inputs — the days picked, the experience
 * answer, the goal — are already saved, and `core/split.ts` is a pure function
 * of them; writing the result down as well would create a second copy that goes
 * stale the moment somebody changes a training day in Pengaturan, and the user
 * would be looking at a plan the app no longer believes in.
 *
 * The same reasoning as `isOnboarded()`: derive from what the answer actually
 * is rather than storing a flag that can disagree with it.
 */

import { planWeekdays } from '../core/plan.ts';
import { recommendSplit, type WorkoutSplit } from '../core/split.ts';
import type { MovementKind } from '../core/types.ts';
import { loadExtras, loadPreferences, loadProfile } from './profile.ts';

export function currentSplit(): WorkoutSplit {
  const preferences = loadPreferences();
  const recommended = recommendSplit({
    trainingDays: planWeekdays(preferences),
    experience: loadExtras().experience,
    // Onboarding skipped, so there is no goal to read. "Maintain" is the
    // neutral one: it neither adds the mass-building set nor shortens the rest.
    goal: loadProfile()?.goal ?? 'maintain',
  });

  // The stored sets win over the recommended ones. The recommendation is
  // written to preferences at the end of onboarding and can be changed in
  // Pengaturan afterwards; a split that kept advertising its own number would
  // put a different session-length estimate on screen than the one being run.
  return { ...recommended, setsPerExercise: preferences.setsPerExercise };
}

/** Weekday index of a timestamp, 0 = Monday, to match the split. */
export function weekdayOf(at: number): number {
  return (new Date(at).getDay() + 6) % 7;
}

/**
 * What today asks for, or an empty list on a rest day.
 *
 * Read by the home screen and by the movement picker, so the two cannot offer
 * different sessions for the same day.
 */
export function todaysMovements(split: WorkoutSplit, now: number = Date.now()): MovementKind[] {
  const weekday = weekdayOf(now);
  return split.sessions.find((session) => session.weekday === weekday)?.movements ?? [];
}
