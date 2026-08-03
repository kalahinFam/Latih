/**
 * Daily energy needs — computed here, never by the language model.
 *
 * ## Why this is code and not a prompt
 *
 * The same reason `directivesFor()` evaluates thresholds in `api/coach.ts` and
 * the grounding verifier checks every cited number: a model asked to compute
 * a number will produce one that reads plausibly and is wrong, with no signal
 * that it is wrong. A calorie target that is 300 kcal off is not a wording
 * problem. So the arithmetic lives here, under test, and the model only ever
 * receives the result to phrase.
 *
 * ## The equation, and how far to trust it
 *
 * Mifflin-St Jeor (Mifflin et al., 1990), the equation the Academy of Nutrition
 * and Dietetics evidence review found most reliable for non-obese and obese
 * adults. It predicts resting energy expenditure within 10% of measured values
 * for roughly 70% of people — which is to say it is an estimate with a real
 * error bar, and the UI says so rather than presenting one confident number.
 *
 * Everything here is per-day kilocalories.
 */

/**
 * Biological sex, as the equation defines it.
 *
 * Mifflin-St Jeor was derived with exactly two constant terms and has no third
 * form. That is a limitation of the published equation, and stating it is more
 * honest than silently mapping everyone onto one of the two.
 */
export type BodySex = 'male' | 'female';

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very-active';

export type EnergyGoal = 'lose' | 'maintain' | 'gain';

export interface BodyProfile {
  /** Kilograms. */
  weightKg: number;
  /** Centimetres. */
  heightCm: number;
  /** Years. */
  ageYears: number;
  sex: BodySex;
  activity: ActivityLevel;
  goal: EnergyGoal;
}

/**
 * Multipliers applied to BMR for total daily expenditure.
 *
 * Conventional values paired with Mifflin-St Jeor. Note they describe daily
 * life as a whole, not the workout — three sessions a week is `light` to
 * `moderate` for most people, not `very-active`.
 */
const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  'very-active': 1.9,
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Jarang bergerak — kerja duduk, tanpa olahraga rutin',
  light: 'Ringan — olahraga 1–3 hari per minggu',
  moderate: 'Sedang — olahraga 3–5 hari per minggu',
  active: 'Aktif — olahraga 6–7 hari per minggu',
  'very-active': 'Sangat aktif — pekerjaan fisik berat atau latihan dua kali sehari',
};

/**
 * Share of maintenance added or removed for a goal.
 *
 * Deliberately modest. A 20% deficit is already at the aggressive end of what
 * is sustainable, and a bigger one mostly costs adherence and lean mass rather
 * than buying speed.
 */
const GOAL_ADJUSTMENT: Record<EnergyGoal, number> = {
  lose: -0.2,
  maintain: 0,
  gain: 0.1,
};

/**
 * Extra intake on a training day.
 *
 * Small on purpose: a bodyweight set of push-ups costs far less than people
 * assume, and an app that hands back 400 kcal for twenty minutes of training
 * quietly undoes the deficit it just recommended.
 */
const TRAINING_DAY_BONUS_KCAL = 120;

/**
 * Hard floors, applied after every other adjustment.
 *
 * Two of them, and the BMR floor is the one that matters. Eating below resting
 * expenditure is where a weight-loss target stops being a diet and starts being
 * a problem, and no combination of inputs a user can type should be able to
 * produce one. The absolute floors are a second line for extreme inputs.
 */
const ABSOLUTE_FLOOR_KCAL: Record<BodySex, number> = { male: 1500, female: 1200 };

/** Inputs outside these ranges are refused rather than extrapolated. */
export const INPUT_LIMITS = {
  weightKg: { min: 30, max: 250 },
  heightCm: { min: 120, max: 230 },
  ageYears: { min: 15, max: 100 },
} as const;

export interface EnergyTarget {
  /** Basal metabolic rate, kcal/day. */
  bmr: number;
  /** Total daily energy expenditure, kcal/day. */
  maintenance: number;
  /** Recommended intake for this day, kcal. */
  targetKcal: number;
  /** Plausible range, reflecting the equation's ~10% error. */
  range: { lowKcal: number; highKcal: number };
  /** True when a floor overrode the goal-based number. */
  floored: boolean;
  isTrainingDay: boolean;
  /** Protein target in grams. */
  proteinG: number;
}

/**
 * Protein per kilogram of body weight.
 *
 * 1.6 g/kg is around the point where further intake stops adding measurable
 * benefit for resistance training in the literature. Rounded to a single figure
 * because the precision beyond that is not real.
 */
const PROTEIN_G_PER_KG = 1.6;

export class InvalidProfileError extends Error {}

/** Basal metabolic rate. Mifflin-St Jeor (1990). */
export function basalMetabolicRate(profile: BodyProfile): number {
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.ageYears;
  return base + (profile.sex === 'male' ? 5 : -161);
}

function assertValid(profile: BodyProfile): void {
  const checks: [number, { min: number; max: number }, string][] = [
    [profile.weightKg, INPUT_LIMITS.weightKg, 'Berat badan'],
    [profile.heightCm, INPUT_LIMITS.heightCm, 'Tinggi badan'],
    [profile.ageYears, INPUT_LIMITS.ageYears, 'Usia'],
  ];

  for (const [value, limit, label] of checks) {
    if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
      // Refusing beats extrapolating. Outside these ranges the equation was
      // never validated, and a number returned anyway would look just as
      // authoritative as a correct one.
      throw new InvalidProfileError(
        `${label} harus antara ${limit.min} dan ${limit.max}.`,
      );
    }
  }
}

/**
 * Daily intake target.
 *
 * @param isTrainingDay Whether the plan schedules a session today.
 */
export function energyTarget(profile: BodyProfile, isTrainingDay: boolean): EnergyTarget {
  assertValid(profile);

  const bmr = basalMetabolicRate(profile);
  const maintenance = bmr * ACTIVITY_FACTORS[profile.activity];

  let target = maintenance * (1 + GOAL_ADJUSTMENT[profile.goal]);
  if (isTrainingDay) target += TRAINING_DAY_BONUS_KCAL;

  const floor = Math.max(bmr, ABSOLUTE_FLOOR_KCAL[profile.sex]);
  const floored = target < floor;
  if (floored) target = floor;

  return {
    bmr: Math.round(bmr),
    maintenance: Math.round(maintenance),
    targetKcal: round10(target),
    // The equation's own error, surfaced rather than hidden behind a single
    // number the user would otherwise read as exact.
    range: { lowKcal: round10(target * 0.9), highKcal: round10(target * 1.1) },
    floored,
    isTrainingDay,
    proteinG: Math.round(profile.weightKg * PROTEIN_G_PER_KG),
  };
}

function round10(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * Split a daily target across meals.
 *
 * Even-ish thirds with a slightly lighter dinner — the conventional shape, and
 * more importantly a shape the user can ignore. The point of the split is to
 * give the meal suggester a per-meal budget to hit, not to prescribe when to
 * eat.
 */
export const MEAL_SHARES = { pagi: 0.3, siang: 0.4, malam: 0.3 } as const;

export type MealSlot = keyof typeof MEAL_SHARES;

export function mealBudgets(targetKcal: number): Record<MealSlot, number> {
  return {
    pagi: round10(targetKcal * MEAL_SHARES.pagi),
    siang: round10(targetKcal * MEAL_SHARES.siang),
    malam: round10(targetKcal * MEAL_SHARES.malam),
  };
}

/** Short Indonesian explanation, for the UI and the coach prompt. */
export function explainTarget(target: EnergyTarget): string {
  const base = `Sekitar ${target.targetKcal} kkal hari ini (perkiraan ${target.range.lowKcal}–${target.range.highKcal} kkal)`;
  if (target.floored) {
    return `${base}. Angka ini sudah dinaikkan ke batas aman — target yang lebih rendah tidak disarankan tanpa pendampingan ahli gizi.`;
  }
  return target.isTrainingDay ? `${base}, termasuk tambahan untuk hari latihan.` : `${base}.`;
}
