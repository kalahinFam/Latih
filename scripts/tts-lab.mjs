/**
 * Render the same lines across several voices and delivery directions, so the
 * choice can be made by ear.
 *
 * Nobody can pick a voice from a description, and "sounds robotic" is not a
 * value in a config file — it is a judgement that has to be made by listening.
 * This renders the comparison and gets out of the way.
 *
 *   node scripts/tts-lab.mjs                 # every voice, every style
 *   node scripts/tts-lab.mjs coral sage      # only these voices
 *
 * Output lands in `tts-lab/` at the repo root, named
 * `<style>__<voice>__<line>.mp3` so sorting groups them the way you want to
 * listen: one voice at a time, or one style at a time.
 *
 * Once you have picked, put it in `.env`:
 *
 *   TTS_VOICE=sage
 *   TTS_INSTRUCTIONS="..."
 *
 * Both the runtime narration and the pre-rendered cues read those, so the same
 * coach speaks throughout.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'tts-lab');
const ENV_PATH = join(HERE, '..', '.env');

const MODEL = 'gpt-4o-mini-tts';

/** Every voice the model offers that is worth auditioning for a coach. */
const ALL_VOICES = ['coral', 'sage', 'ballad', 'verse', 'ash', 'nova', 'alloy', 'shimmer'];

/**
 * Two lines, because they are opposite jobs.
 *
 * A cue is a bark mid-repetition — it has to land in under a second and cut
 * through a room. Narration is spoken while the user is sitting on the floor
 * catching their breath. A voice that suits one can be wrong for the other.
 */
const LINES = {
  cue: 'Turunkan dada lebih dalam',
  narasi:
    'Dua belas repetisi terhitung penuh, dan kedalamannya lebih baik daripada set pertama. ' +
    'Tiga repetisi terakhir pinggulnya mulai turun — itu tanda lelah, bukan tanda tekniknya salah.',
};

/**
 * Delivery directions.
 *
 * `id-*` are written in Indonesian, `en-*` in English. Worth comparing
 * directly: the model follows instructions best in English, and it is an open
 * question whether that outweighs describing Indonesian prosody in Indonesian.
 * Guessing would be cheaper than testing and worth less.
 */
const STYLES = {
  'id-sekarang':
    'Bicara dalam Bahasa Indonesia yang hangat dan jelas, seperti pelatih ' +
    'kebugaran yang sedang memberi evaluasi singkat setelah satu set selesai. ' +
    'Tempo santai, nada mendukung.',

  'id-hangat':
    'Kamu pelatih kebugaran yang sudah kenal orang ini berbulan-bulan. Bicara ' +
    'seperti sedang ngobrol di sebelahnya, bukan membacakan laporan. Bahasa ' +
    'Indonesia sehari-hari. Beri jeda alami di koma dan titik, naikkan sedikit ' +
    'nada di bagian yang kamu maksud, dan turunkan di akhir kalimat. Hangat, ' +
    'santai, sedikit tersenyum saat memuji. Jangan terdengar seperti pengumuman.',

  'en-warm-coach':
    'You are a personal trainer speaking Indonesian to someone you have coached ' +
    'for months. Sound conversational and human, never like an announcement or a ' +
    'news reader. Vary your pitch across the sentence; let it fall naturally at ' +
    'the end. Breathe. Pause slightly at commas and dashes. Warm, relaxed, a ' +
    'little smile in the voice when the news is good. Do not over-enunciate.',

  'en-brisk-corner':
    'You are a boxing-corner coach speaking Indonesian between rounds. Close to ' +
    'the listener, low and direct, slightly quick. Confident and encouraging, ' +
    'never shouting. Clip the ends of phrases the way someone does when they are ' +
    'making a point rather than reading one.',
};

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = /^\s*OPENAI_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const apiKey = loadKey();
if (!apiKey) {
  console.error('OPENAI_API_KEY belum diset. Isi .env di root proyek lalu ulangi.');
  process.exit(1);
}

const voices = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL_VOICES;
const unknown = voices.filter((v) => !ALL_VOICES.includes(v));
if (unknown.length > 0) {
  console.error(`Suara tidak dikenal: ${unknown.join(', ')}`);
  console.error(`Pilihan: ${ALL_VOICES.join(', ')}`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

const total = voices.length * Object.keys(STYLES).length * Object.keys(LINES).length;
console.log(`Membuat ${total} contoh ke tts-lab/\n`);

let made = 0;
let failed = 0;

for (const [styleName, instructions] of Object.entries(STYLES)) {
  for (const voice of voices) {
    for (const [lineName, input] of Object.entries(LINES)) {
      const file = `${styleName}__${voice}__${lineName}.mp3`;

      try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: MODEL,
            voice,
            input,
            instructions,
            response_format: 'mp3',
          }),
        });

        if (!response.ok) {
          const detail = await response.text();
          console.log(`  gagal  ${file}  ${response.status} ${detail.slice(0, 90)}`);
          failed += 1;
          continue;
        }

        const audio = Buffer.from(await response.arrayBuffer());
        await writeFile(join(OUT_DIR, file), audio);
        made += 1;
        console.log(`  dibuat ${file.padEnd(46)} ${(audio.length / 1024).toFixed(0)} KB`);
      } catch (error) {
        console.log(`  gagal  ${file}  ${String(error).slice(0, 90)}`);
        failed += 1;
      }
    }
  }
}

console.log(`\n${made} dibuat, ${failed} gagal. Dengarkan tts-lab/, lalu isi di .env:`);
console.log('  TTS_VOICE=<suara pilihanmu>');
console.log('  TTS_STYLE=<nama style pilihanmu>   # id-hangat, en-warm-coach, ...');
console.log('\nSetelah itu jalankan `npm run gen:cues -- --force` supaya klip cue ikut berubah.');
