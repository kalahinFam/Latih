/**
 * Meal assembly: turning what the model chose into what the user is shown.
 *
 * ## The division of labour, and why it is drawn here
 *
 * The model chooses foods and portions. That is a judgement — which Indonesian
 * foods go together at breakfast, what suits a training day — and judgement is
 * what it is for.
 *
 * Everything numeric happens here. Not because the model *cannot* multiply, but
 * because when it multiplies wrongly there is no signal: each ingredient is a
 * real TKPI row, every component figure traces to the table, and the grounding
 * verifier passes an answer whose total is 200 kcal out. A check that asks
 * "does this number appear in the source" cannot catch a derived number, and
 * the total is derived. So the total is never taken from the model.
 *
 * ## What this module refuses
 *
 * A returned option is rejected, not repaired, when it names a food outside the
 * pantry, gives an implausible portion, or lands far from the calorie budget.
 * Repairing would mean this module quietly inventing the meal, which is the one
 * thing the split above exists to prevent.
 */

import {
  MAX_PORTION_G,
  MIN_PORTION_G,
  pantryEntries,
  type PantryCategory,
} from './pantry.ts';
import { scaleToPortion, sumPortions, type Nutrients, type Portion, type TkpiTable } from './tkpi.ts';

/** What the model returns for one item. */
export interface ChosenItem {
  code: string;
  grams: number;
}

/** What the model returns for one option. */
export interface ChosenOption {
  nama: string;
  items: ChosenItem[];
  catatan?: string;
}

export interface MealItem {
  code: string;
  name: string;
  grams: number;
  nutrients: Nutrients;
}

export interface MealOption {
  name: string;
  items: MealItem[];
  total: Nutrients;
  note?: string;
  /** How far the total lands from the budget, kcal. Signed. */
  budgetDeltaKcal: number;
}

/**
 * How far a meal may land from its budget and still be offered.
 *
 * Generous on purpose. Portions come in real units — one egg, one bowl of rice
 * — so hitting a budget to the calorie would require absurd quantities like
 * "63 g of tempe". A quarter of the budget is close enough for the number to
 * mean something while leaving the suggestion cookable.
 */
export const BUDGET_TOLERANCE = 0.25;

export class MealRejectedError extends Error {}

/**
 * Validate one option and compute its figures.
 *
 * @throws MealRejectedError when the option cannot be trusted.
 */
export function buildOption(
  chosen: ChosenOption,
  table: TkpiTable,
  budgetKcal: number,
): MealOption {
  const allowed = new Map(pantryEntries(table).map((entry) => [entry.food.code, entry.food]));

  if (!Array.isArray(chosen.items) || chosen.items.length === 0) {
    throw new MealRejectedError('Opsi tidak berisi bahan apa pun.');
  }

  const portions: Portion[] = [];
  for (const item of chosen.items) {
    const food = allowed.get(item.code);
    if (!food) {
      // The model named something outside the list it was given. Substituting
      // a lookalike here would put a food in the menu that nothing verified.
      throw new MealRejectedError(`Bahan di luar daftar: ${item.code}`);
    }
    if (!Number.isFinite(item.grams) || item.grams < MIN_PORTION_G || item.grams > MAX_PORTION_G) {
      throw new MealRejectedError(`Porsi tidak masuk akal untuk ${food.name}: ${item.grams} g`);
    }
    portions.push({ food, grams: Math.round(item.grams) });
  }

  const total = sumPortions(portions);
  const delta = total.energyKcal - budgetKcal;

  if (budgetKcal > 0 && Math.abs(delta) > budgetKcal * BUDGET_TOLERANCE) {
    throw new MealRejectedError(
      `Total ${total.energyKcal} kkal terlalu jauh dari target ${budgetKcal} kkal.`,
    );
  }

  return {
    name: chosen.nama,
    items: portions.map((portion) => ({
      code: portion.food.code,
      name: portion.food.name,
      grams: portion.grams,
      nutrients: scaleToPortion(portion.food, portion.grams),
    })),
    total,
    note: chosen.catatan,
    budgetDeltaKcal: Math.round(delta),
  };
}

/**
 * Build every option that survives validation.
 *
 * Partial success is the right outcome: two workable options are useful, and
 * discarding them because a third was malformed would trade the whole answer
 * for consistency the user does not benefit from.
 */
export function buildOptions(
  chosen: ChosenOption[],
  table: TkpiTable,
  budgetKcal: number,
): { options: MealOption[]; rejected: string[] } {
  const options: MealOption[] = [];
  const rejected: string[] = [];

  for (const candidate of chosen) {
    try {
      options.push(buildOption(candidate, table, budgetKcal));
    } catch (error) {
      rejected.push(error instanceof MealRejectedError ? error.message : String(error));
    }
  }

  return { options, rejected };
}

/**
 * Does the day's menu cover the protein target?
 *
 * Reported rather than enforced. Protein is a target to aim at across a day,
 * not a constraint on any one meal, and rejecting a perfectly good breakfast
 * for being short of a third of it would be nonsense.
 */
export function proteinCoverage(options: MealOption[], targetG: number): number {
  if (targetG <= 0) return 1;
  const total = options.reduce((sum, option) => sum + option.total.proteinG, 0);
  return Number((total / targetG).toFixed(2));
}

/** Categories a balanced meal would normally draw on, for the prompt. */
export const PREFERRED_CATEGORIES: PantryCategory[] = [
  'pokok',
  'protein-hewani',
  'protein-nabati',
  'sayur',
];
