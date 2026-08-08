/**
 * What onboarding asks, and what each answer is actually used for.
 *
 * ## The rule the design sets, and this file enforces
 *
 * Every question exists because something downstream computes with the answer.
 * Name feeds the greeting; age, sex, height and weight feed Mifflin-St Jeor;
 * activity feeds its multiplier; goal sets the direction of the calorie
 * adjustment; experience sets the first session's rep target; restrictions
 * filter TKPI rows out of the pantry.
 *
 * A question with no consumer is a question that wastes the user's time and
 * then sits in storage looking like a feature. If an answer here stops being
 * read, delete the question.
 *
 * ## The promise that has to be kept
 *
 * The restrictions screen says *"Bahan yang dipilih tidak akan muncul di menu
 * mana pun."* That is a claim about behaviour, so `excludedCodes` is wired
 * through `core/pantry.ts` into the prompt the meal endpoint builds — the model
 * never sees an excluded row, rather than being asked nicely to avoid it.
 *
 * Pure data and pure functions. No storage, no DOM.
 */

import type { ExerciseKind, HoldKind } from './types.ts';
import { PANTRY_CODES } from './pantry.ts';

/* ----------------------------------------------------------- experience */

export type ExperienceLevel = 'baru' | 'pernah' | 'rutin';

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  baru: 'Baru mulai',
  pernah: 'Pernah rutin',
  rutin: 'Rutin',
};

/**
 * Where the first session starts.
 *
 * Only the first. After one set the session loop reads what actually happened
 * and takes over, which is why this is allowed to be a rough guess — being
 * wrong costs one session, and the screen says so.
 *
 * Deliberately conservative at every level: a first set that ends early is a
 * good session, and a first set that cannot be finished is a reason to stop
 * using the app.
 */
const BASELINE_REPS: Record<ExperienceLevel, Record<ExerciseKind, number>> = {
  baru: { pushup: 8, squat: 10 },
  pernah: { pushup: 12, squat: 15 },
  rutin: { pushup: 16, squat: 20 },
};

const BASELINE_HOLD_SECONDS: Record<ExperienceLevel, Record<HoldKind, number>> = {
  baru: { plank: 20 },
  pernah: { plank: 30 },
  rutin: { plank: 45 },
};

export function baselineReps(experience: ExperienceLevel, exercise: ExerciseKind): number {
  return BASELINE_REPS[experience][exercise];
}

export function baselineHoldSeconds(experience: ExperienceLevel, movement: HoldKind): number {
  return BASELINE_HOLD_SECONDS[experience][movement];
}

/* --------------------------------------------------------- restrictions */

export type DietaryRestriction =
  | 'babi'
  | 'seafood'
  | 'telur'
  | 'susu'
  | 'kacang'
  | 'gluten'
  | 'vegetarian';

export const RESTRICTION_LABELS: Record<DietaryRestriction, string> = {
  babi: 'Daging babi',
  seafood: 'Seafood',
  telur: 'Telur',
  susu: 'Susu sapi',
  kacang: 'Kacang tanah',
  gluten: 'Gluten',
  vegetarian: 'Vegetarian',
};

/**
 * TKPI codes each restriction removes from the pantry.
 *
 * Written as codes rather than as name matching, for the same reason the pantry
 * itself is: codes are stable and names are not, and a rule matched on the word
 * "ayam" would quietly drop fried-chicken rows it was never meant to touch.
 *
 * `babi` and `kacang` map to nothing today because the curated pantry contains
 * neither. They are still offered: the answer is stored, so the exclusion holds
 * the day either is added, and a restriction that currently removes nothing
 * still removes nothing — the promise is kept either way.
 *
 * `vegetarian` is read as lacto-ovo — no meat, poultry or fish. Eggs and milk
 * have their own chips, so folding them in here would take a choice away from
 * someone who made it deliberately.
 */
const EXCLUDED_BY_RESTRICTION: Record<DietaryRestriction, readonly string[]> = {
  babi: [],
  seafood: ['GR070', 'GR050', 'GR084'],
  telur: ['HR002'],
  susu: ['JR006'],
  kacang: [],
  gluten: ['AP024'],
  vegetarian: ['FR005', 'FR025', 'GR070', 'GR050', 'GR084'],
};

export function excludedCodes(restrictions: readonly DietaryRestriction[]): string[] {
  const codes = new Set<string>();
  for (const restriction of restrictions) {
    for (const code of EXCLUDED_BY_RESTRICTION[restriction] ?? []) codes.add(code);
  }
  return [...codes].sort();
}

/* --------------------------------------------------------- foods at home */

/**
 * Foods the user says they usually have.
 *
 * A preference, not a filter: everything stays available, these are simply
 * listed to the meal planner as what to reach for first. Turning it into a
 * filter would mean a menu that silently cannot be built when someone unticks
 * everything.
 *
 * The values are TKPI codes straight from `PANTRY_CODES`; names come from
 * `PANTRY_LABELS`, so a selection can never refer to a food the app does not
 * ship.
 */
export function preferredCodes(codes: readonly string[]): string[] {
  const known = new Set(Object.values(PANTRY_CODES).flat());
  return [...new Set(codes)].filter((code) => known.has(code)).sort();
}

/* ------------------------------------------------------------- profile */

/** Everything onboarding collects that is not already in `BodyProfile`. */
export interface OnboardingExtras {
  name: string;
  experience: ExperienceLevel;
  restrictions: DietaryRestriction[];
  /** TKPI codes of foods the user says they usually have. */
  homeFoods: string[];
}

export const DEFAULT_EXTRAS: OnboardingExtras = {
  name: '',
  experience: 'baru',
  restrictions: [],
  homeFoods: ['CP061', 'CP077', 'HR002'],
};

/**
 * Body Mass Index, for the weight card.
 *
 * Shown because it makes a typo visible — 178 kg entered for 78 reads as an
 * IMT of 59 and nobody misses that. It is deliberately not used for anything
 * else: BMI does not distinguish muscle from fat and has no business steering
 * a training plan.
 */
export function bmi(weightKg: number, heightCm: number): number | null {
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm) || heightCm <= 0) return null;
  const metres = heightCm / 100;
  return Number((weightKg / (metres * metres)).toFixed(1));
}

export function bmiLabel(value: number | null): string {
  if (value === null) return '';
  if (value < 18.5) return 'di bawah normal';
  if (value < 25) return 'normal';
  if (value < 30) return 'di atas normal';
  return 'jauh di atas normal';
}
