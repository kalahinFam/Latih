/**
 * Pre-renders every corrective cue to an MP3 at build time.
 *
 * ## Why these are not generated at runtime
 *
 * The cue set is closed — seven phrases, enumerated in `core/rules.ts`. Calling
 * a TTS API mid-set to say "turunkan dada lebih dalam" would add roughly a
 * second of network latency to a correction whose entire value is arriving
 * *during* the repetition it describes. It would also cost money on every rep
 * and fall silent the moment the venue wifi does.
 *
 * Pre-rendering trades a one-off build step for zero latency, zero runtime
 * cost, and audio that works offline.
 *
 * Idempotent: a phrase whose MP3 already exists is skipped, so this is cheap to
 * leave wired into the build. Filenames carry a hash of the text, so editing a
 * phrase produces a new name and the stale clip stops being referenced.
 *
 * Run: node --experimental-strip-types scripts/gen-cues.mjs
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { allCueTexts } from '../src/core/rules.ts';
import { cueFileName } from '../src/audio/cueId.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'cues');
const ENV_PATH = join(HERE, '..', '..', '.env');

const MODEL = 'gpt-4o-mini-tts';
/** Warm, clear, and holds up over a phone speaker in a noisy room. */
const VOICE = 'coral';
const INSTRUCTIONS =
  'Bicara dalam Bahasa Indonesia yang jelas dan tegas, seperti pelatih kebugaran ' +
  'yang memberi aba-aba singkat di tengah latihan. Nada memberi semangat, tidak ' +
  'membentak. Tempo agak cepat.';

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = /^\s*OPENAI_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through to the message below */
  }
  return null;
}

async function exists(path) {
  try {
    return (await stat(path)).size > 1000;
  } catch {
    return false;
  }
}

const texts = allCueTexts();
await mkdir(OUT_DIR, { recursive: true });

const wanted = new Map(texts.map((text) => [cueFileName(text), text]));
const missing = [];
for (const [file, text] of wanted) {
  if (!(await exists(join(OUT_DIR, file)))) missing.push({ file, text });
}

console.log(`Cue terdaftar: ${texts.length}, belum ada audio: ${missing.length}`);

if (missing.length > 0) {
  const apiKey = loadKey();
  if (!apiKey) {
    // Not fatal. The app falls back to the Web Speech API, and blocking a
    // teammate's build on a key they may not have would be worse than a
    // slightly less polished voice.
    console.warn(
      'OPENAI_API_KEY tidak ditemukan — melewati pembuatan audio.\n' +
        'Aplikasi akan memakai suara bawaan browser sebagai cadangan.',
    );
    process.exit(0);
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  for (const { file, text } of missing) {
    const response = await client.audio.speech.create({
      model: MODEL,
      voice: VOICE,
      input: text,
      instructions: INSTRUCTIONS,
      response_format: 'mp3',
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(join(OUT_DIR, file), buffer);
    console.log(`  dibuat  ${file.padEnd(48)} "${text}" (${(buffer.length / 1024).toFixed(0)} KB)`);
  }
}

// Report clips no longer referenced. Deleting them automatically would be
// surprising in a shared repo, but leaving them unmentioned means they linger
// forever after a phrase is reworded.
const present = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.mp3'));
const orphans = present.filter((f) => !wanted.has(f));
if (orphans.length > 0) {
  console.log(`\n${orphans.length} berkas tidak lagi dipakai (aman dihapus):`);
  for (const file of orphans) console.log(`  ${file}`);
}

console.log('\nSelesai.');
