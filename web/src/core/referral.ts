/**
 * When a pattern of complaints stops being this product's business.
 *
 * ## Why this is not left to the model
 *
 * The rest-chat prompt already asks the model to suggest seeing someone when a
 * sentence *sounds* serious. That catches "my knee gave out" and it will never
 * catch the case that actually matters: a knee that hurts a little, every
 * session, for two weeks. Each of those sentences is mild on its own, and the
 * model sees exactly one of them at a time — the complaint log is on the device
 * and is never sent, deliberately.
 *
 * So the pattern is judged here. Counting is not a thing a language model should
 * be asked to do with a health record, and the whole architecture already draws
 * this line: thresholds live in code, prose lives in the model. This is the same
 * decision as `directivesFor()` in the coach endpoint and the `SUBSTITUTIONS`
 * table in `restChat.ts`.
 *
 * ## What it deliberately does not do
 *
 * It does not diagnose, escalate, block training, or withhold the substitution.
 * A referral is a sentence added to an answer the user still gets. Refusing to
 * help with today's set because somebody mentioned a sore knee three times would
 * teach them to stop mentioning it.
 *
 * Pure, with the clock injected — the same shape as `activeSubstitutions(now)`,
 * and for the same reason: a rule about the last fourteen days is untestable if
 * it reads `Date.now()` itself.
 */

import type { BodyPart } from './restChat.ts';

/**
 * How far back a complaint still counts as part of the pattern.
 *
 * Two weeks is long enough to catch something recurring across a training week
 * and short enough that a knee which hurt in January is not still generating
 * advice in March.
 */
export const REFERRAL_WINDOW_DAYS = 14;

const WINDOW_MS = REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many complaints about one part make a pattern, counting the current one.
 *
 * Two is a coincidence — the same session mentioned twice, or a hard week. Three
 * inside a fortnight is something that is not going away on its own, which is
 * the only claim this rule makes.
 */
export const REFERRAL_THRESHOLD = 3;

/**
 * The sentence shown when the pattern is met.
 *
 * Fixed text, owned by code and never written by the model — this is the one
 * message in the product where an improvised phrasing could read as a diagnosis.
 * It echoes the disclaimer in the settings screen on purpose, so the app says the
 * same thing about itself in both places.
 */
export const REFERRAL_TEXT =
  'Bagian ini sudah kamu keluhkan beberapa kali dalam dua minggu terakhir. ' +
  'Sebaiknya diperiksakan ke tenaga kesehatan — LATIH bukan alat medis dan tidak memberi diagnosis.';

/** Just enough of a `ComplaintRecord` to count. */
export interface ComplaintLike {
  at: number;
  part: BodyPart;
}

/**
 * Whether this complaint completes a pattern worth mentioning.
 *
 * `history` is what was logged *before* the current complaint, so the current
 * one is added here rather than assumed to be present. Calling it after the
 * write would double-count on a re-render.
 *
 * Matching on `BodyPart` and not on side: a right knee and a left knee are two
 * knees, and somebody alternating between them over a fortnight is exactly the
 * case worth flagging. `BodyPart` is also as fine as this product's vocabulary
 * gets, for the reason `restChat.ts` gives — anything narrower would be asking a
 * fitness app to distinguish structures inside a joint.
 */
export function needsReferral(
  history: readonly ComplaintLike[],
  part: BodyPart,
  now: number,
): boolean {
  const cutoff = now - WINDOW_MS;
  // Future-dated entries are ignored rather than trusted: a device whose clock
  // was wrong, or moved, should not be able to manufacture a health message.
  const recent = history.filter(
    (entry) => entry.part === part && entry.at > cutoff && entry.at <= now,
  );
  return recent.length + 1 >= REFERRAL_THRESHOLD;
}
