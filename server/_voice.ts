/**
 * One coach, one voice.
 *
 * The pre-rendered cues built by `web/scripts/gen-cues.mjs` read their voice
 * and delivery from here, so every correction in a session is the same person.
 *
 * ## Why the delivery direction is this long
 *
 * `gpt-4o-mini-tts` is steerable, and a short instruction steers it barely at
 * all: "warm and clear" leaves it doing its default reading-aloud voice, which
 * is exactly what "robotic" means in practice. What moves it is describing the
 * *performance* — who is speaking, to whom, how close, where the pitch moves,
 * where the breaths go.
 *
 * ## Why English
 *
 * The input text is Indonesian; this direction is not. The model follows
 * instructions most reliably in English, and the instruction is about delivery
 * rather than about the language being spoken. `scripts/tts-lab.mjs` renders
 * both so the choice can be checked by ear rather than argued about.
 */

export const STYLES: Record<string, string> = {
  'en-warm-coach':
    'You are a personal trainer calling a short correction across a room to ' +
    'someone mid-repetition. Speaking Indonesian. Close, low, direct, slightly ' +
    'quick. Confident and encouraging, never shouting, never clipped like a ' +
    'machine. Land the last word firmly.',

  'id-hangat':
    'Bicara Bahasa Indonesia yang tegas dan jelas, seperti pelatih yang ' +
    'memberi aba-aba singkat di tengah latihan. Dekat, cepat, memberi ' +
    'semangat, tidak membentak.',
};

export const DEFAULT_STYLE = 'en-warm-coach';
export const DEFAULT_VOICE = 'coral';

export const TTS_MODEL = 'gpt-4o-mini-tts';

/**
 * The voice, overridable without touching code.
 *
 * Choosing a voice is a listening decision, so it belongs in configuration
 * rather than in a constant somebody has to edit and rebuild to try.
 */
export function ttsVoice(): string {
  return process.env.TTS_VOICE || DEFAULT_VOICE;
}

export function ttsInstructions(): string {
  // A hand-written direction wins over the presets — the presets exist to be
  // starting points, not a menu nobody may leave.
  const custom = process.env.TTS_INSTRUCTIONS;
  if (custom) return custom;

  const style = STYLES[process.env.TTS_STYLE ?? ''] ?? STYLES[DEFAULT_STYLE];
  return style;
}
