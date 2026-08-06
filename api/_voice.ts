/**
 * One coach, one voice.
 *
 * Both audio paths read from here — the pre-rendered cues built by
 * `web/scripts/gen-cues.mjs` and the runtime narration from `api/tts.ts`. They
 * are generated months apart on different machines, and nothing makes a product
 * sound more synthetic than two different people delivering it.
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

export const STYLES: Record<string, { cue: string; narration: string }> = {
  'en-warm-coach': {
    cue:
      'You are a personal trainer calling a short correction across a room to ' +
      'someone mid-repetition. Speaking Indonesian. Close, low, direct, slightly ' +
      'quick. Confident and encouraging, never shouting, never clipped like a ' +
      'machine. Land the last word firmly.',
    narration:
      'You are a personal trainer speaking Indonesian to someone you have ' +
      'coached for months, sitting beside them while they catch their breath. ' +
      'Conversational and human — never an announcement, never a news reader. ' +
      'Vary your pitch across the sentence and let it fall naturally at the end. ' +
      'Breathe. Pause slightly at commas and dashes. Warm and relaxed, with a ' +
      'little smile in the voice when the news is good. Do not over-enunciate.',
  },

  'id-hangat': {
    cue:
      'Bicara Bahasa Indonesia yang tegas dan jelas, seperti pelatih yang ' +
      'memberi aba-aba singkat di tengah latihan. Dekat, cepat, memberi ' +
      'semangat, tidak membentak.',
    narration:
      'Kamu pelatih kebugaran yang sudah kenal orang ini berbulan-bulan. Bicara ' +
      'seperti sedang ngobrol di sebelahnya, bukan membacakan laporan. Beri jeda ' +
      'alami di koma dan titik, dan turunkan nada di akhir kalimat. Hangat, ' +
      'santai, sedikit tersenyum saat memuji.',
  },
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

export function ttsInstructions(kind: 'cue' | 'narration'): string {
  // A hand-written direction wins over the presets — the presets exist to be
  // starting points, not a menu nobody may leave.
  const custom = process.env.TTS_INSTRUCTIONS;
  if (custom) return custom;

  const style = STYLES[process.env.TTS_STYLE ?? ''] ?? STYLES[DEFAULT_STYLE];
  return style[kind];
}
