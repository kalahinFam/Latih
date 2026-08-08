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
  normaliseWeekdays,
  type PlanPreferences,
} from '../core/plan.ts';
import {
  DEFAULT_EXTRAS,
  EXPERIENCE_LABELS,
  RESTRICTION_LABELS,
  type DietaryRestriction,
  type ExperienceLevel,
  type OnboardingExtras,
} from '../core/onboarding.ts';
import { PANTRY_CODES } from '../core/pantry.ts';
import type { ExerciseKind } from '../core/types.ts';

// Exported because `backup.ts` needs the exact set of keys that make up a
// user's data. Naming them in two places is how a backup silently starts
// omitting a field nobody notices until a restore.
export const PROFILE_KEY = 'latih.profile.v1';
export const PREFERENCES_KEY = 'latih.preferences.v1';
export const EXTRAS_KEY = 'latih.onboarding.v1';
const LAUNCHED_KEY = 'latih.launched.v1';

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

    // Chosen weekdays are the stronger answer, so the count follows them
    // rather than being stored independently and drifting: a schedule that
    // says "3 hari" while the plan trains four days is a bug the user reads
    // as the app lying.
    const trainingDays = Array.isArray(stored.trainingDays)
      ? normaliseWeekdays(stored.trainingDays)
      : [];
    const chosenDays =
      trainingDays.length >= MIN_DAYS_PER_WEEK && trainingDays.length <= MAX_DAYS_PER_WEEK
        ? trainingDays
        : [];

    return {
      daysPerWeek:
        chosenDays.length > 0
          ? chosenDays.length
          : clampInt(
              stored.daysPerWeek,
              MIN_DAYS_PER_WEEK,
              MAX_DAYS_PER_WEEK,
              DEFAULT_PREFERENCES.daysPerWeek,
            ),
      trainingDays: chosenDays,
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


/* -------------------------------------------------------------- onboarding */

const EXPERIENCES = Object.keys(EXPERIENCE_LABELS) as ExperienceLevel[];
const RESTRICTIONS = Object.keys(RESTRICTION_LABELS) as DietaryRestriction[];
const PANTRY_CODE_SET = new Set(Object.values(PANTRY_CODES).flat());

/**
 * Everything onboarding collected beyond the body measurements.
 *
 * Validated field by field on read, like the preferences are: a partial write
 * or an older version should cost the one key it broke, not the whole answer
 * set and a repeat of onboarding.
 */
export function loadExtras(): OnboardingExtras {
  try {
    const raw = localStorage.getItem(EXTRAS_KEY);
    if (!raw) return { ...DEFAULT_EXTRAS };
    const stored = JSON.parse(raw) as Partial<OnboardingExtras>;

    return {
      name: typeof stored.name === 'string' ? stored.name.slice(0, 40).trim() : '',
      experience: EXPERIENCES.includes(stored.experience as ExperienceLevel)
        ? (stored.experience as ExperienceLevel)
        : DEFAULT_EXTRAS.experience,
      restrictions: Array.isArray(stored.restrictions)
        ? stored.restrictions.filter((r): r is DietaryRestriction =>
            RESTRICTIONS.includes(r as DietaryRestriction),
          )
        : [],
      homeFoods: Array.isArray(stored.homeFoods)
        ? stored.homeFoods.filter((code): code is string => PANTRY_CODE_SET.has(code))
        : [...DEFAULT_EXTRAS.homeFoods],
    };
  } catch {
    return { ...DEFAULT_EXTRAS };
  }
}

export function saveExtras(extras: OnboardingExtras): void {
  try {
    localStorage.setItem(EXTRAS_KEY, JSON.stringify(extras));
  } catch {
    /* see saveProfile */
  }
}

/**
 * Has onboarding been completed?
 *
 * Derived from the body profile rather than stored as its own flag. The
 * profile is what onboarding exists to collect, so its presence *is* the
 * answer — and a separate flag can disagree with it, which is how a user ends
 * up on a home screen with no calorie target and no way back to the questions.
 */
export function isOnboarded(): boolean {
  return loadProfile() !== null;
}

/**
 * Has the user been shown the opening screen?
 *
 * Separate from `isOnboarded` on purpose, and the distinction matters: the
 * router's job is to make sure a first-time user meets the app before landing
 * inside it, *not* to hold them hostage until they answer six questions. Gating
 * on completion would make the "lewati dulu" button navigate to a screen that
 * immediately bounces back — a control that visibly does nothing.
 *
 * Everything downstream already copes with a missing profile: the nutrition
 * screen offers to collect it, and targets fall back to the beginner baseline.
 */
export function hasLaunched(): boolean {
  try {
    return localStorage.getItem(LAUNCHED_KEY) === '1' || isOnboarded();
  } catch {
    // Storage unavailable — let them in rather than trapping them on a splash
    // screen that can never remember they saw it.
    return true;
  }
}

export function markLaunched(): void {
  try {
    localStorage.setItem(LAUNCHED_KEY, '1');
  } catch {
    /* see saveProfile */
  }
}

export function clearOnboarding(): void {
  try {
    localStorage.removeItem(LAUNCHED_KEY);
  } catch {
    /* nothing to do */
  }
  clearProfile();
  try {
    localStorage.removeItem(EXTRAS_KEY);
  } catch {
    /* nothing to do */
  }
}
