/**
 * Numeric grounding verifier.
 *
 * ## What this is for
 *
 * The paper claims every number in a nutrition answer comes from the TKPI
 * table rather than the model's own memory. Prompting for that is an assertion;
 * this module turns it into a check. Each nutrition figure the model writes is
 * matched against the rows it was given, and an answer with an unmatched number
 * is refused rather than shown.
 *
 * It also produces the grounding metric the Results section reports, from the
 * same code path the product runs — not a separate offline script that might
 * measure something else.
 *
 * ## Why only numbers carrying units are checked
 *
 * A nutrition claim always has a unit: "20,8 gram protein", "201 kkal". Bare
 * numbers are counts and ordinals — "dua bahan", "porsi ke-3" — and are not
 * claims about composition. Verifying those too would reject correct answers
 * for saying "dua", which trains the team to disable the check. Narrowing to
 * unit-bearing numbers keeps every actual claim covered while leaving prose
 * alone.
 *
 * ## Indonesian number formatting
 *
 * Indonesian uses a comma for decimals and a period for thousands, the reverse
 * of English. "20,8" is twenty point eight; "1.200" is one thousand two
 * hundred. Reading these the English way would silently compare 208 against
 * 20.8 and fail every check.
 */

/** Units that mark a value as a nutrition claim. Order matters: longest first. */
const UNIT_PATTERN = 'kkal|kilokalori|kalori|kal|mg|miligram|gram|gr|g';

/**
 * A number followed by a unit, allowing an optional space.
 * The negative lookahead on the unit stops "g" matching the "g" in "gula".
 */
const CLAIM_RE = new RegExp(String.raw`(\d[\d.,]*)\s*(${UNIT_PATTERN})\b(?![a-z])`, 'gi');

export interface NumericClaim {
  /** As written in the answer, e.g. "20,8". */
  raw: string;
  value: number;
  unit: string;
  /** Value converted to the unit family's base (kcal or gram). */
  normalized: number;
}

/**
 * Parse an Indonesian-formatted number.
 *
 * A period is a thousands separator only when followed by exactly three digits
 * and not the last separator before a comma; otherwise it is a decimal point,
 * since sources are not always consistent.
 */
export function parseIndonesianNumber(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  const hasComma = cleaned.includes(',');
  let normalized: string;

  if (hasComma) {
    // Comma present: periods must be thousands separators.
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // Period groups of exactly three: thousands separators.
    normalized = cleaned.replace(/\./g, '');
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeUnit(unit: string): 'kcal' | 'g' | null {
  const u = unit.toLowerCase();
  if (u === 'kkal' || u === 'kilokalori' || u === 'kalori' || u === 'kal') return 'kcal';
  if (u === 'mg' || u === 'miligram') return 'g';
  if (u === 'g' || u === 'gr' || u === 'gram') return 'g';
  return null;
}

/** Extract every nutrition claim from an answer. */
export function extractClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  for (const match of text.matchAll(CLAIM_RE)) {
    const value = parseIndonesianNumber(match[1]);
    const family = normalizeUnit(match[2]);
    if (value === null || family === null) continue;

    const isMilligram = /^m/i.test(match[2]);
    claims.push({
      raw: match[1],
      value,
      unit: match[2].toLowerCase(),
      normalized: isMilligram ? value / 1000 : value,
    });
  }
  return claims;
}

export interface VerificationResult {
  passed: boolean;
  claims: NumericClaim[];
  /** Claims with no supporting value in the retrieved rows. */
  unmatched: NumericClaim[];
  /** Share of claims that matched, 1 when there were none to check. */
  groundedRatio: number;
}

/**
 * Tolerance for a match.
 *
 * Half a unit absolute covers the model rounding 20.8 to 21, which is a fair
 * way to state a figure. The relative term keeps large values (a 1.200 kcal
 * total) from needing implausible precision.
 */
function matches(claim: number, allowed: number): boolean {
  return Math.abs(claim - allowed) <= Math.max(0.5, Math.abs(allowed) * 0.01);
}

/**
 * Verify an answer against the numbers it was allowed to use.
 *
 * @param answer Model output.
 * @param allowedValues Every numeric value from the retrieved TKPI rows.
 * @param questionValues Numbers the user themselves wrote. A question about
 *   "150 gram tempe" makes 150 a legitimate figure to repeat, and rejecting it
 *   would fail answers that are entirely correct.
 */
export function verifyGrounding(
  answer: string,
  allowedValues: number[],
  questionValues: number[] = [],
): VerificationResult {
  const claims = extractClaims(answer);
  const allowed = [...allowedValues, ...questionValues];

  const unmatched = claims.filter((claim) => !allowed.some((value) => matches(claim.normalized, value)));

  return {
    passed: unmatched.length === 0,
    claims,
    unmatched,
    // No claims means nothing was asserted, which is grounded by default —
    // an answer that cites no figures cannot cite a wrong one.
    groundedRatio: claims.length === 0 ? 1 : (claims.length - unmatched.length) / claims.length,
  };
}

/** Numbers a user wrote, so an answer may legitimately repeat them. */
export function numbersInQuestion(question: string): number[] {
  const values: number[] = [];
  for (const match of question.matchAll(/\d[\d.,]*/g)) {
    const value = parseIndonesianNumber(match[0]);
    if (value !== null) values.push(value);
  }
  return values;
}
