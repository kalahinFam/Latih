/**
 * Rep-counting accuracy harness.
 *
 * ## The point of this file
 *
 * It imports `web/src/core/*.ts` **directly** — the same modules the browser
 * runs, no build step, no reimplementation. That is what makes the accuracy
 * figures in the paper statements about the shipped product rather than about
 * a Python reimplementation that happens to live next to it.
 *
 * Node needs `--experimental-strip-types` on Node 22 (it is on by default from
 * 23.6). Every intra-`core` import carries an explicit `.ts` extension, because
 * Node ESM does not guess extensions the way a bundler does — and `core/`
 * contains no runtime-only TypeScript syntax, which `erasableSyntaxOnly` in
 * tsconfig enforces.
 *
 * Run:
 *   node --experimental-strip-types eval/eval_reps.mjs
 *   node --experimental-strip-types eval/eval_reps.mjs --input eval/data
 *
 * With no `--input`, it self-checks against synthetic sequences so the harness
 * is runnable — and provably correct — before any real data exists.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeJointAngles, primaryAngle } from '../web/src/core/angles.ts';
import { RepCounter } from '../web/src/core/repCounter.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

// ------------------------------------------------------------------ counting

/**
 * Replay one recorded session through the real fast loop.
 *
 * @param {{landmarks: object[], timestampMs: number}[]} frames
 * @param {'pushup'|'squat'} exercise
 */
export function countReps(frames, exercise) {
  const counter = new RepCounter(exercise);
  let reps = 0;
  let heldFrames = 0;

  for (const frame of frames) {
    const angles = computeJointAngles(frame.landmarks);
    const angle = primaryAngle(angles, exercise);
    if (angle === null) heldFrames++;
    if (counter.update(angle, frame.timestampMs)) reps++;
  }

  return { reps, heldFrames, trackingQuality: 1 - heldFrames / Math.max(1, frames.length) };
}

/** Same replay, but driven by a bare angle series (for synthetic self-checks). */
function countFromAngles(angleSeries, exercise, frameMs = 33) {
  const counter = new RepCounter(exercise);
  let reps = 0;
  angleSeries.forEach((angle, i) => {
    if (counter.update(angle, i * frameMs)) reps++;
  });
  return reps;
}

// ------------------------------------------------------------------- metrics

function summarize(rows) {
  if (rows.length === 0) return null;
  const errors = rows.map((r) => r.predicted - r.expected);
  const abs = errors.map(Math.abs);
  const exact = rows.filter((r) => r.predicted === r.expected).length;

  return {
    sessions: rows.length,
    totalExpectedReps: rows.reduce((s, r) => s + r.expected, 0),
    totalPredictedReps: rows.reduce((s, r) => s + r.predicted, 0),
    mae: abs.reduce((s, v) => s + v, 0) / rows.length,
    // Signed mean shows systematic bias, which MAE hides: consistently
    // over-counting by one is a very different bug from random scatter.
    meanSignedError: errors.reduce((s, v) => s + v, 0) / rows.length,
    exactMatchRate: exact / rows.length,
    worstAbsError: Math.max(...abs),
  };
}

// ------------------------------------------------------------- data loading

/**
 * Expected layout, one JSON per recorded session:
 *   { exercise: 'pushup', expectedReps: 12,
 *     frames: [{ timestampMs, landmarks: [{x,y,z,visibility} x33] }, ...] }
 *
 * Produced by `ml/extract_keypoints.py` once video annotation begins.
 */
async function loadSessions(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  const sessions = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (typeof raw.expectedReps !== 'number' || !Array.isArray(raw.frames)) {
      // Skip loudly. A malformed file silently contributing zero reps would
      // quietly drag the reported MAE in our favour.
      console.warn(`  ! ${file} dilewati: butuh field expectedReps dan frames`);
      continue;
    }
    sessions.push({ name: file, ...raw });
  }
  return sessions;
}

// --------------------------------------------------------------- self-check

function sweep(from, to, frames) {
  if (frames <= 1) return [to];
  return Array.from({ length: frames }, (_, i) => from + ((to - from) * i) / (frames - 1));
}

function syntheticSet(exercise, repCount, bottom) {
  const top = exercise === 'pushup' ? 170 : 175;
  const series = [...Array(10).fill(top)];
  for (let i = 0; i < repCount; i++) {
    series.push(...sweep(top, bottom, 10), ...Array(4).fill(bottom), ...sweep(bottom, top, 10));
    series.push(...Array(6).fill(top));
  }
  return series;
}

/**
 * Runs when no recorded data is present.
 *
 * This is a harness test, not an accuracy result — and it is labelled as such
 * in the output so a synthetic number can never be mistaken for a measured one
 * when the numbers are lifted into the paper.
 */
function selfCheck() {
  const cases = [
    { exercise: 'pushup', expected: 10, bottom: 80, label: 'push-up dalam' },
    { exercise: 'pushup', expected: 5, bottom: 120, label: 'push-up dangkal (tetap dihitung)' },
    { exercise: 'squat', expected: 8, bottom: 85, label: 'squat dalam' },
    { exercise: 'squat', expected: 6, bottom: 130, label: 'squat dangkal (tetap dihitung)' },
  ];

  return cases.map((c) => ({
    name: c.label,
    exercise: c.exercise,
    expected: c.expected,
    predicted: countFromAngles(syntheticSet(c.exercise, c.expected, c.bottom), c.exercise),
  }));
}

// -------------------------------------------------------------------- main

const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
const inputDir = inputIndex >= 0 ? resolve(args[inputIndex + 1]) : null;

const sessions = inputDir ? await loadSessions(inputDir) : null;
let rows;
let mode;

if (sessions && sessions.length > 0) {
  mode = 'recorded';
  console.log(`Mengevaluasi ${sessions.length} sesi terekam dari ${inputDir}\n`);
  rows = sessions.map((s) => {
    const { reps, trackingQuality } = countReps(s.frames, s.exercise);
    return {
      name: s.name,
      exercise: s.exercise,
      expected: s.expectedReps,
      predicted: reps,
      trackingQuality: Number(trackingQuality.toFixed(3)),
    };
  });
} else {
  mode = 'synthetic-self-check';
  if (inputDir) console.log(`Tidak ada data di ${inputDir}.`);
  console.log('Menjalankan self-check sintetis — INI BUKAN ANGKA AKURASI.\n');
  rows = selfCheck();
}

for (const row of rows) {
  const ok = row.predicted === row.expected ? 'OK  ' : 'BEDA';
  console.log(
    `  ${ok} ${String(row.name).padEnd(38)} harap ${row.expected}  dapat ${row.predicted}`,
  );
}

const overall = summarize(rows);
const byExercise = Object.fromEntries(
  ['pushup', 'squat']
    .map((ex) => [ex, summarize(rows.filter((r) => r.exercise === ex))])
    .filter(([, v]) => v !== null),
);

console.log('\nRingkasan');
console.log(`  mode                 ${mode}`);
console.log(`  sesi                 ${overall.sessions}`);
console.log(`  MAE                  ${overall.mae.toFixed(3)} rep`);
console.log(`  bias (signed mean)   ${overall.meanSignedError.toFixed(3)} rep`);
console.log(`  cocok persis         ${(overall.exactMatchRate * 100).toFixed(1)}%`);
console.log(`  error terburuk       ${overall.worstAbsError} rep`);

await mkdir(RESULTS_DIR, { recursive: true });
const outPath = join(RESULTS_DIR, 'rep_accuracy.json');
await writeFile(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), mode, overall, byExercise, rows },
    null,
    2,
  ),
);
console.log(`\nDitulis ke ${outPath}`);

// A harness that cannot reproduce known-correct synthetic counts is broken,
// and must fail rather than emit numbers nobody should trust.
if (mode === 'synthetic-self-check' && overall.exactMatchRate < 1) {
  console.error('\nSelf-check GAGAL: harness tidak mereproduksi hitungan sintetis.');
  process.exit(1);
}
