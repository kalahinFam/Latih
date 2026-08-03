/**
 * Body profile and plan preferences.
 *
 * ## Where this data lives, and why that matters more here than elsewhere
 *
 * `localStorage`, on the device, never uploaded — the same rule as camera
 * frames and training history. It matters more here because this is the only
 * genuinely personal data the product touches: weight, height, age, sex. The
 * calorie target derived from it is computed on-device too, in
 * `core/energy.ts`, so the numbers reach the meal endpoint without the body
 * measurements that produced them ever leaving the phone.
 *
 * That is a deliberate ordering. Sending the profile and letting the server do
 * the arithmetic would have been marginally simpler and would have turned a
 * privacy claim into a promise instead of a property.
 */

import {
  type ActivityLevel,
  type BodyProfile,
  type BodySex,
  type EnergyGoal,
} from '../core/energy.ts';
import {
  DEFAULT_PREFERENCES,
  MAX_DAYS_PER_WEEK,
  MIN_DAYS_PER_WEEK,
  type PlanPreferences,
} from '../core/plan.ts';
import type { ExerciseKind } from '../core/types.ts';

const PROFILE_KEY = 'latih.profile.v1';
const PREFERENCES_KEY = 'latih.preferences.v1';

const SEXES: BodySex[] = ['male', 'female'];
const ACTIVITIES: ActivityLevel[] = ['sedentary', 'light', 'moderate', 'active', 'very-active'];
const GOALS: EnergyGoal[] = ['lose', 'maintain', 'gain'];
const EXERCISES: ExerciseKind[] = ['pushup', 'squat'];

/**
 * Validate on read, not only on write.
 *
 * `localStorage` is editable by anyone with the console open, and these values
 * feed an equation that produces a calorie recommendation. A profile that has
 * been hand-edited to something the equation was never validated on should be
 * discarded, not honoured.
 */
function isBodyProfile(value: unknown): value is BodyProfile {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<BodyProfile>;
  return (
    Number.isFinite(p.weightKg) &&
    Number.isFinite(p.heightCm) &&
    Number.isFinite(p.ageYears) &&
    SEXES.includes(p.sex as BodySex) &&
    ACTIVITIES.includes(p.activity as ActivityLevel) &&
    GOALS.includes(p.goal as EnergyGoal)
  );
}

export function loadProfile(): BodyProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBodyProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: BodyProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Private browsing or a full quota. The plan still works; only the
    // calorie target goes missing, and the UI already handles its absence.
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Preferences fall back per-field rather than wholesale.
 *
 * A stored object missing one key — an older version, a partial write — should
 * lose that key's value, not the user's whole schedule.
 */
export function loadPreferences(): PlanPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const stored = JSON.parse(raw) as Partial<PlanPreferences>;

    const exercises = Array.isArray(stored.exercises)
      ? stored.exercises.filter((e): e is ExerciseKind => EXERCISES.includes(e))
      : [];

    return {
      daysPerWeek: clampInt(
        stored.daysPerWeek,
        MIN_DAYS_PER_WEEK,
        MAX_DAYS_PER_WEEK,
        DEFAULT_PREFERENCES.daysPerWeek,
      ),
      timeOfDay:
        typeof stored.timeOfDay === 'string' && /^\d{1,2}:\d{2}$/.test(stored.timeOfDay)
          ? stored.timeOfDay
          : DEFAULT_PREFERENCES.timeOfDay,
      // An empty list would produce a plan with training days and nothing to
      // do on them.
      exercises: exercises.length > 0 ? exercises : [...DEFAULT_PREFERENCES.exercises],
      setsPerExercise: clampInt(stored.setsPerExercise, 1, 6, DEFAULT_PREFERENCES.setsPerExercise),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: PlanPreferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    /* see saveProfile */
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
