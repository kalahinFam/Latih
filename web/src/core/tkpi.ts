/**
 * TKPI food composition table: types, lookup, and the allowed-value set the
 * grounding verifier checks against.
 *
 * Pure logic, no I/O. The caller supplies the loaded table, so the same code
 * serves the API endpoint, the unit tests, and the evaluation harness.
 */

import { median } from './smoothing.ts';

/** One row of the composition table. All figures are per `basisG` grams. */
export interface TkpiFood {
  /** Official TKPI food code, when known. */
  code: string;
  name: string;
  /** Alternative spellings and common names, for lookup. */
  aliases?: string[];
  /** Reference quantity the figures are stated on. TKPI uses 100 g. */
  basisG: number;
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG?: number;
  /** Where this row came from. Carried into the answer as a citation. */
  source: string;
  /**
   * False until a human has checked the row against the official TKPI.
   * Answers built from unverified rows must say so.
   */
  verified: boolean;
}

export interface TkpiTable {
  meta: { source: string; note: string; retrievedAt: string };
  foods: TkpiFood[];
}

/** Fold accents, collapse punctuation, lowercase — for tolerant matching. */
export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words carrying no discriminating power in an Indonesian food question. */
const STOPWORDS = new Set([
  'berapa', 'kandungan', 'gizi', 'nutrisi', 'kalori', 'protein', 'lemak',
  'karbohidrat', 'serat', 'dalam', 'pada', 'untuk', 'dan', 'atau', 'yang',
  'per', 'gram', 'g', 'kkal', 'apa', 'itu', 'saja', 'dari', 'ada', 'di',
  'makan', 'makanan', 'porsi', 'butir', 'buah', 'potong',
]);

export function tokenize(text: string): string[] {
  return normalizeName(text)
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

export interface Match {
  food: TkpiFood;
  score: number;
}

/**
 * Score one food against the query tokens.
 *
 * Exact token hits dominate; a prefix hit counts for less so that "tempe"
 * finds "tempe kedelai murni" without "te" matching everything.
 */
function scoreFood(food: TkpiFood, queryTokens: string[]): number {
  const names = [food.name, ...(food.aliases ?? [])];
  let best = 0;

  for (const name of names) {
    const nameTokens = tokenize(name);
    if (nameTokens.length === 0) continue;

    let score = 0;
    for (const query of queryTokens) {
      if (nameTokens.includes(query)) {
        score += 1;
      } else if (nameTokens.some((token) => token.startsWith(query) && query.length >= 4)) {
        score += 0.5;
      }
    }
    // Normalise by name length so a long name does not win on breadth alone,
    // but keep some credit for matching more of the query.
    if (score > 0) {
      best = Math.max(best, score / Math.sqrt(nameTokens.length));
    }
  }

  return best;
}

/**
 * Find the foods a question is about.
 *
 * Returns at most `limit` rows. Fewer, better-matched rows beat a long list:
 * every extra row widens the set of numbers the verifier will accept, which
 * weakens exactly the guarantee this pipeline exists to provide.
 */
export function findFoods(table: TkpiTable, question: string, limit = 4): Match[] {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return [];

  return table.foods
    .map((food) => ({ food, score: scoreFood(food, queryTokens) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Every number the model is permitted to state, given these rows.
 *
 * Includes `basisG`, because each row is expressed per 100 g and an answer
 * saying "per 100 gram" is quoting the table rather than inventing a figure.
 * Building this here rather than at each call site means a caller cannot
 * forget a field and cause correct answers to be rejected.
 */
export function allowedValuesFor(foods: TkpiFood[]): number[] {
  const values: number[] = [];
  for (const food of foods) {
    values.push(food.basisG, food.energyKcal, food.proteinG, food.fatG, food.carbG);
    if (food.fiberG !== undefined) values.push(food.fiberG);
  }
  return values;
}

/** Compact rendering handed to the model — the only figures it may use. */
export function formatForPrompt(foods: TkpiFood[]): string {
  return foods
    .map(
      (food) =>
        `${food.name} (kode ${food.code}), per ${food.basisG} gram:\n` +
        `  energi ${food.energyKcal} kkal\n` +
        `  protein ${food.proteinG} gram\n` +
        `  lemak ${food.fatG} gram\n` +
        `  karbohidrat ${food.carbG} gram` +
        (food.fiberG !== undefined ? `\n  serat ${food.fiberG} gram` : ''),
    )
    .join('\n\n');
}

/** True when any row shown to the user has not been checked by a human. */
export function hasUnverified(foods: TkpiFood[]): boolean {
  return foods.some((food) => !food.verified);
}

/** Sanity report for the data file, used by the validation script. */
export function auditTable(table: TkpiTable): {
  total: number;
  verified: number;
  duplicateCodes: string[];
  implausible: { code: string; reason: string }[];
} {
  const seen = new Map<string, number>();
  const implausible: { code: string; reason: string }[] = [];

  for (const food of table.foods) {
    seen.set(food.code, (seen.get(food.code) ?? 0) + 1);

    // Atwater check: macronutrients should roughly reconstruct the energy
    // figure. A row that fails this badly is a transcription error, and
    // catching it here is far cheaper than discovering it in a judged answer.
    const derived = food.proteinG * 4 + food.carbG * 4 + food.fatG * 9;
    if (food.energyKcal > 0 && Math.abs(derived - food.energyKcal) > food.energyKcal * 0.35 + 25) {
      implausible.push({
        code: food.code,
        reason: `energi ${food.energyKcal} kkal vs perhitungan makro ${derived.toFixed(0)} kkal`,
      });
    }
    if (food.basisG !== 100) {
      implausible.push({ code: food.code, reason: `basis ${food.basisG} g, TKPI memakai 100 g` });
    }
  }

  return {
    total: table.foods.length,
    verified: table.foods.filter((f) => f.verified).length,
    duplicateCodes: [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code),
    implausible,
  };
}

/** Median energy across the table — a quick smell test for unit mix-ups. */
export function medianEnergy(table: TkpiTable): number | null {
  return median(table.foods.map((f) => f.energyKcal));
}
