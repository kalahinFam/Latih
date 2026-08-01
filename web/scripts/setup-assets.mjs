/**
 * Fetches the on-device inference assets into `public/`.
 *
 * These ~48 MB are not checked into git: the WASM runtime is a byte-for-byte
 * copy of an already-declared npm dependency, and the pose models are public
 * downloads. Committing them would bloat every clone to carry files that are
 * fully reproducible from `package.json` and two URLs.
 *
 * Wired to `predev` and `prebuild`, so a fresh clone runs `npm install &&
 * npm run dev` and simply works. Idempotent and quiet when everything is
 * already in place, so it costs nothing on the hundredth run.
 *
 * Run directly: node scripts/setup-assets.mjs
 */

import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..');
const PUBLIC_DIR = join(WEB_ROOT, 'public');

const WASM_SRC = join(WEB_ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST = join(PUBLIC_DIR, 'mediapipe', 'wasm');
const MODEL_DIR = join(PUBLIC_DIR, 'models');

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const MODELS = [
  {
    file: 'pose_landmarker_lite.task',
    url: `${MODEL_BASE}/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
    // Guards against a truncated download being cached as "present".
    minBytes: 4_000_000,
  },
  {
    file: 'pose_landmarker_full.task',
    url: `${MODEL_BASE}/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
    minBytes: 7_000_000,
  },
];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function copyWasmRuntime() {
  if ((await sizeOf(join(WASM_DEST, 'vision_wasm_internal.wasm'))) > 1_000_000) {
    return 'sudah ada';
  }
  if ((await sizeOf(join(WASM_SRC, 'vision_wasm_internal.wasm'))) === 0) {
    throw new Error(
      'MediaPipe WASM tidak ditemukan di node_modules. Jalankan `npm install` lebih dulu.',
    );
  }
  await mkdir(WASM_DEST, { recursive: true });
  await cp(WASM_SRC, WASM_DEST, { recursive: true });
  return 'disalin dari node_modules';
}

async function downloadModel({ file, url, minBytes }) {
  const dest = join(MODEL_DIR, file);
  if ((await sizeOf(dest)) >= minBytes) return 'sudah ada';

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gagal mengunduh ${file}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < minBytes) {
    // Writing a short file would make the next run think the asset is ready
    // and fail much later, inside MediaPipe, with a far less obvious message.
    throw new Error(`${file} tampak terpotong (${bytes.length} byte)`);
  }
  await mkdir(MODEL_DIR, { recursive: true });
  await writeFile(dest, bytes);
  return `diunduh (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`;
}

console.log('Menyiapkan aset inferensi on-device…');
console.log(`  mediapipe wasm      ${await copyWasmRuntime()}`);
for (const model of MODELS) {
  console.log(`  ${model.file.padEnd(28)}${await downloadModel(model)}`);
}
console.log('Selesai.');
