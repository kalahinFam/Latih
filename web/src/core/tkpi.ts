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
  /**
   * The row's own macronutrients do not reconstruct its stated energy.
   *
   * Around 1% of the official TKPI database is internally inconsistent this
   * way — a leafy vegetable listed at 226 kcal whose macros give 29, a tuber
   * whose carbohydrates alone exceed its stated energy. Verified against the
   * source: these are errors in the published data, not in our extraction.
   *
   * Such rows are kept for provenance but excluded from retrieval. Quietly
   * deleting official data would be worse, and so would citing a figure we
   * already know contradicts itself.
   */
  suspect?: boolean;
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
  /** At least one matched word is specific enough to identify a food. */
  distinctive: boolean;
}

/**
 * A word appearing in more than this share of food names is too common to
 * identify anything on its own.
 *
 * With 1,133 foods, a single generic word carries a match by itself: "daging
 * unta" hits every "Sapi, daging …" row because "daging" matches, though camel
 * appears nowhere in the table. The answer stayed correct — the model said the
 * data was unavailable — but four unrelated meats were shown to the user as
 * its sources, reading as though the system had found something.
 *
 * Requiring one *distinctive* matched word fixes that without breaking
 * multi-food questions. An earlier attempt demanded the match explain most of
 * the query, which rejected "tempe tahu telur ayam" outright: four foods are
 * named, so no single row can account for most of it.
 */
const MAX_COMMON_TOKEN_SHARE = 0.03;

/**
 * Absolute floor, so the rule survives a small table.
 *
 * A share alone breaks down when there are few foods: in a four-row fixture a
 * word appearing in one food is 25% of the table and would be judged common,
 * rejecting every match. A word in three or fewer foods identifies something
 * regardless of how large the table is.
 */
const ALWAYS_DISTINCTIVE_BELOW = 3;

/**
 * Token -> how many foods contain it. Cached per table: recomputing it on every
 * request would tokenize a thousand names for each question.
 */
const frequencyCache = new WeakMap<TkpiTable, Map<string, number>>();

function documentFrequency(table: TkpiTable): Map<string, number> {
  const cached = frequencyCache.get(table);
  if (cached) return cached;

  const counts = new Map<string, number>();
  for (const food of table.foods) {
    const seen = new Set(tokenize([food.name, ...(food.aliases ?? [])].join(' ')));
    for (const token of seen) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  frequencyCache.set(table, counts);
  return counts;
}

function isDistinctive(token: string, frequency: Map<string, number>, total: number): boolean {
  const count = frequency.get(token) ?? 0;
  if (count === 0) return false;
  return count <= Math.max(ALWAYS_DISTINCTIVE_BELOW, total * MAX_COMMON_TOKEN_SHARE);
}

/**
 * Score one food against the query tokens.
 *
 * Exact token hits dominate; a prefix hit counts for less so that "tempe"
 * finds "tempe kedelai murni" without "te" matching everything.
 */
function scoreFood(
  food: TkpiFood,
  queryTokens: string[],
  frequency: Map<string, number>,
  total: number,
): { score: number; distinctive: boolean } {
  const names = [food.name, ...(food.aliases ?? [])];
  let best = { score: 0, distinctive: false };

  for (const name of names) {
    const nameTokens = tokenize(name);
    if (nameTokens.length === 0) continue;

    let score = 0;
    let distinctive = false;
    for (const query of queryTokens) {
      const exact = nameTokens.includes(query);
      const prefix =
        !exact && nameTokens.some((token) => token.startsWith(query) && query.length >= 4);
      if (!exact && !prefix) continue;

      score += exact ? 1 : 0.5;
      if (isDistinctive(query, frequency, total)) distinctive = true;
    }

    // Normalise by name length so a long name does not win on breadth alone,
    // but keep some credit for matching more of the query.
    if (score > 0) {
      const normalized = score / Math.sqrt(nameTokens.length);
      if (normalized > best.score) best = { score: normalized, distinctive };
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

  const frequency = documentFrequency(table);
  const total = table.foods.length;

  return table.foods
    // Rows whose own figures contradict each other are never cited. The
    // grounding guarantee is that a number traces to the table; it is worth
    // nothing if the table entry is self-inconsistent.
    .filter((food) => !food.suspect)
    .map((food) => ({ food, ...scoreFood(food, queryTokens, frequency, total) }))
    .filter((match) => match.score > 0 && match.distinctive)
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

/** A quantity of one food, as a meal suggestion states it. */
export interface Portion {
  food: TkpiFood;
  grams: number;
}

export interface Nutrients {
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/**
 * Scale a row to an actual serving.
 *
 * ## Why this is here and not in the prompt
 *
 * TKPI states everything per 100 g, and a meal is not 100 g of anything. Asking
 * the model to do the scaling looked reasonable and failed in exactly the way
 * arithmetic-by-language-model fails: the figures were confidently wrong, and
 * because each *component* number was traceable to a real row, the grounding
 * verifier passed them. A derived number is not covered by a check that only
 * asks whether a number appears in the source.
 *
 * So the model chooses foods and portions — a judgement call, which is what it
 * is good at — and every figure downstream is computed here.
 */
export function scaleToPortion(food: TkpiFood, grams: number): Nutrients {
  const factor = grams / food.basisG;
  return {
    energyKcal: round1(food.energyKcal * factor),
    proteinG: round1(food.proteinG * factor),
    fatG: round1(food.fatG * factor),
    carbG: round1(food.carbG * factor),
  };
}

export function sumPortions(portions: Portion[]): Nutrients {
  return portions.reduce<Nutrients>(
    (total, portion) => {
      const scaled = scaleToPortion(portion.food, portion.grams);
      return {
        energyKcal: round1(total.energyKcal + scaled.energyKcal),
        proteinG: round1(total.proteinG + scaled.proteinG),
        fatG: round1(total.fatG + scaled.fatG),
        carbG: round1(total.carbG + scaled.carbG),
      };
    },
    { energyKcal: 0, proteinG: 0, fatG: 0, carbG: 0 },
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Every figure a meal answer may legitimately state.
 *
 * Wider than `allowedValuesFor` because a meal has three layers of true
 * numbers: the per-100 g row, the scaled portion, and the meal total. All three
 * are computed here, so admitting them costs nothing — what would weaken the
 * check is admitting numbers the model produced, and none of these are.
 */
export function allowedValuesForPortions(portions: Portion[]): number[] {
  const values = allowedValuesFor(portions.map((p) => p.food));

  for (const portion of portions) {
    values.push(portion.grams);
    const scaled = scaleToPortion(portion.food, portion.grams);
    values.push(scaled.energyKcal, scaled.proteinG, scaled.fatG, scaled.carbG);
  }

  const total = sumPortions(portions);
  values.push(total.energyKcal, total.proteinG, total.fatG, total.carbG);

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
  usable: number;
  duplicateCodes: string[];
  /** Inconsistent rows already marked `suspect` — acknowledged, not new. */
  acknowledged: { code: string; reason: string }[];
  /** Inconsistent rows NOT yet marked. These fail the check. */
  implausible: { code: string; reason: string }[];
} {
  const seen = new Map<string, number>();
  const implausible: { code: string; reason: string }[] = [];
  const acknowledged: { code: string; reason: string }[] = [];

  for (const food of table.foods) {
    seen.set(food.code, (seen.get(food.code) ?? 0) + 1);

    // Atwater check: macronutrients should roughly reconstruct the energy
    // figure. Rows already marked `suspect` are reported separately — those
    // are known errors in the published TKPI, not regressions in our
    // extraction, and failing the build on them forever would only teach the
    // team to ignore the check.
    const derived = food.proteinG * 4 + food.carbG * 4 + food.fatG * 9;
    if (food.energyKcal > 0 && Math.abs(derived - food.energyKcal) > food.energyKcal * 0.35 + 25) {
      const finding = {
        code: food.code,
        reason: `energi ${food.energyKcal} kkal vs perhitungan makro ${derived.toFixed(0)} kkal`,
      };
      (food.suspect ? acknowledged : implausible).push(finding);
    }
    if (food.basisG !== 100) {
      implausible.push({ code: food.code, reason: `basis ${food.basisG} g, TKPI memakai 100 g` });
    }
  }

  return {
    total: table.foods.length,
    verified: table.foods.filter((f) => f.verified).length,
    // What retrieval can actually cite.
    usable: table.foods.filter((f) => !f.suspect).length,
    duplicateCodes: [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code),
    acknowledged,
    implausible,
  };
}

/**
 * Mark rows whose own figures contradict each other.
 *
 * Run after fetching, so the audit can separate known source errors from new
 * extraction bugs. Returns the codes marked.
 */
export function markSuspectRows(table: TkpiTable): string[] {
  const marked: string[] = [];
  for (const food of table.foods) {
    const derived = food.proteinG * 4 + food.carbG * 4 + food.fatG * 9;
    if (food.energyKcal > 0 && Math.abs(derived - food.energyKcal) > food.energyKcal * 0.35 + 25) {
      food.suspect = true;
      marked.push(food.code);
    }
  }
  return marked;
}

/** Median energy across the table — a quick smell test for unit mix-ups. */
export function medianEnergy(table: TkpiTable): number | null {
  return median(table.foods.map((f) => f.energyKcal));
}
