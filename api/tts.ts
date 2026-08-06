/**
 * Text-to-speech for the between-set narration.
 *
 * ## Why only this half is generated at runtime
 *
 * Corrective cues are a closed set of seven phrases, pre-rendered at build time
 * (`web/scripts/gen-cues.mjs`) because a correction is worthless if it arrives
 * after the repetition it describes. The narration is the opposite: its text is
 * written fresh by the coach every set, so it cannot be pre-rendered — and it
 * plays while the user is resting, where a second of latency costs nothing.
 *
 * Same split, opposite constraint, which is why the two paths differ.
 */

import { errorResponse, json } from './_llm.ts';
import { TTS_MODEL, ttsInstructions, ttsVoice } from './_voice.ts';
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };

/**
 * Two or three sentences of coaching is comfortably under this. The cap exists
 * because the endpoint is unauthenticated and every call costs money: without
 * it, a single long request could run up a bill against the competition key.
 */
const MAX_CHARS = 600;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY belum diset. Salin .env.example ke .env lalu isi kuncinya.');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Gunakan POST.' }, 405);
  }

  let text: unknown;
  try {
    ({ text } = (await request.json()) as { text?: unknown });
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return json({ error: 'Field "text" wajib diisi.' }, 400);
  }
  if (text.length > MAX_CHARS) {
    return json({ error: `Teks maksimal ${MAX_CHARS} karakter.` }, 413);
  }

  try {
    const speech = await getClient().audio.speech.create({
      model: TTS_MODEL,
      // Shared with the pre-rendered cues, so one coach speaks throughout —
      // two different deliveries in one session sound more synthetic than
      // either would alone.
      voice: ttsVoice(),
      input: text,
      instructions: ttsInstructions('narration'),
      response_format: 'mp3',
    });

    // Hand the upstream stream straight through rather than buffering it, so
    // playback can begin before generation has finished.
    return new Response(speech.body, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        // The narration is unique to one set; caching it would only ever
        // serve a stale reading to a different set.
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error, 'Suara pelatih sedang tidak tersedia.');
  }
}
