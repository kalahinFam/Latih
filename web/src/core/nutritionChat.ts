/**
 * The conversation rules for the nutrition assistant.
 *
 * `/api/nutrition` already answers one question at a time, grounded in the TKPI
 * rows it retrieved and refused when a figure cannot be traced to them. Making
 * it a chat adds exactly two problems, and this module is both of them:
 *
 * ## 1. A follow-up has no nouns in it
 *
 * "Berapa protein tempe?" retrieves tempe. "Kalau tahu?" retrieves nothing at
 * all, and an endpoint that answers a question with no rows behind it is the
 * precise situation the grounding pipeline exists to prevent. So the previous
 * user turn is available as a second retrieval attempt — used only when the
 * question alone finds nothing, because every extra row widens the set of
 * numbers the verifier will accept and that set is the whole guarantee.
 *
 * ## 2. The user's own numbers are legitimate
 *
 * "Cukup nggak 100 gram tempe buat target proteinku?" is the question people
 * actually have, and it cannot be answered from the food table alone — it needs
 * the daily target. That number is computed on the device by `core/energy.ts`
 * from measurements which never leave it, so sending the *result* is the same
 * trade the meal planner already makes: the budget travels, the body does not.
 *
 * Those figures are then added to the verifier's allowed values, because they
 * are ours. A model quoting back a target this app computed is not inventing
 * anything; rejecting it would train the user to distrust a correct answer.
 *
 * Pure functions. No storage, no DOM, no Node — the endpoint and the browser
 * both import this, which is the point.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** As long as a question can be. Matches what the endpoint has always accepted. */
export const MAX_QUESTION_CHARS = 300;

/**
 * Turns of history carried into the prompt.
 *
 * Six is three exchanges: enough for "kalau tahu?" and "berapa kalau 150
 * gram?" to still make sense, short enough that the prompt cannot grow without
 * bound on a long afternoon of questions.
 */
export const MAX_HISTORY_TURNS = 6;

/**
 * What the device may tell the assistant about the person asking.
 *
 * Derived figures only. There is deliberately nowhere here to put a weight, a
 * height, an age or a sex — the same way `MealsRequest` has nowhere to put
 * them, so the privacy property is a property of the type rather than a rule
 * somebody has to remember.
 */
export interface ChatContext {
  /** Daily energy target, kcal. Computed on the device. */
  targetKcal?: number;
  /** Daily protein target, grams. */
  proteinG?: number;
  isTrainingDay?: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Accept a history from the network, or discard what cannot be trusted.
 *
 * Trims to the last `MAX_HISTORY_TURNS`, drops anything that is not a turn,
 * and truncates each message: this arrives over HTTP, so its size and shape
 * are somebody else's decision until this function has run.
 */
export function sanitizeHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];

  const turns: ChatTurn[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const turn = entry as Partial<ChatTurn>;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    if (typeof turn.content !== 'string') continue;

    const content = turn.content.trim().slice(0, MAX_QUESTION_CHARS);
    if (content.length === 0) continue;
    turns.push({ role: turn.role, content });
  }

  return turns.slice(-MAX_HISTORY_TURNS);
}

/** The last thing the user said, for retrieving a pronoun-shaped follow-up. */
export function lastUserMessage(history: readonly ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') return history[i].content;
  }
  return null;
}

export function isChatContext(value: unknown): value is ChatContext {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;

  const context = value as Partial<ChatContext>;
  return (
    (context.targetKcal === undefined || isFiniteNumber(context.targetKcal)) &&
    (context.proteinG === undefined || isFiniteNumber(context.proteinG)) &&
    (context.isTrainingDay === undefined || typeof context.isTrainingDay === 'boolean')
  );
}

/**
 * Numbers from the user's own plan that an answer may quote.
 *
 * These join the values read out of the retrieved TKPI rows. They are figures
 * this app computed and is already showing on the same screen; treating them
 * as ungrounded would refuse answers that are exactly right.
 */
export function contextValues(context: ChatContext | undefined): number[] {
  if (!context) return [];
  const values: number[] = [];
  if (isFiniteNumber(context.targetKcal)) values.push(context.targetKcal);
  if (isFiniteNumber(context.proteinG)) values.push(context.proteinG);
  return values;
}

/** The user's plan, as a line the model can read. Empty when nothing is known. */
export function formatContextForPrompt(context: ChatContext | undefined): string {
  if (!context) return '';

  const parts: string[] = [];
  if (isFiniteNumber(context.targetKcal)) {
    parts.push(`target energi harian ${Math.round(context.targetKcal)} kkal`);
  }
  if (isFiniteNumber(context.proteinG)) {
    parts.push(`target protein harian ${Math.round(context.proteinG)} gram`);
  }
  if (context.isTrainingDay !== undefined) {
    parts.push(context.isTrainingDay ? 'hari ini hari latihan' : 'hari ini hari istirahat');
  }

  return parts.length === 0 ? '' : `Data pengguna (dihitung di perangkatnya): ${parts.join(', ')}.`;
}

/** The conversation so far, for the prompt. */
export function formatTranscript(history: readonly ChatTurn[]): string {
  if (history.length === 0) return '';
  return history
    .map((turn) => `${turn.role === 'user' ? 'Pengguna' : 'Asisten'}: ${turn.content}`)
    .join('\n');
}
