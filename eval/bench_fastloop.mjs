/**
 * Cost of the fast loop's *computation*, separated from pose inference.
 *
 * ## What this measures, and what it deliberately does not
 *
 * The per-frame budget in the workout engine has two parts. One is MediaPipe
 * inference, which depends on the GPU, the thermal state, and the model
 * variant: it can only be measured on a real device, and `latih.engine.
 * performance` is what reports it. The other is everything `core/` does with
 * the landmarks once they exist, which is pure arithmetic over 33 points and
 * therefore measurable anywhere the same modules run.
 *
 * This script measures the second part only. It imports the same modules the
 * browser imports, in the same order the engine calls them, so the number
 * describes shipped code rather than a benchmark written to look fast. It is
 * NOT a device latency figure and must never be reported as one.
 *
 * Why it is worth measuring at all: the paper derives the fault-to-cue budget
 * as median-filter lag plus one frame period. That derivation is only honest if
 * the `core/` term is negligible against the frame period, and this is what
 * establishes whether it is.
 *
 * Run:
 *   node --experimental-strip-types eval/bench_fastloop.mjs
 *
 * The flag is required on Node 22 and is on by default from 23.6.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

import { computeJointAngles, primaryAngleForCounting } from '../web/src/core/angles.ts';
import { checkPosture } from '../web/src/core/posture.ts';
import { checkFraming } from '../web/src/core/framing.ts';
import { MedianFilter } from '../web/src/core/smoothing.ts';
import { RepCounter } from '../web/src/core/repCounter.ts';
import { evaluateRules } from '../web/src/core/rules.ts';
import { RepWindowBuilder } from '../web/src/core/repWindow.ts';
import { LANDMARK_COUNT, LM } from '../web/src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

/* ------------------------------------------------------------ body model */

// World landmarks are metric with y increasing downward, so a shoulder above a
// hip has the smaller y. Lengths are a roughly 1.7 m adult.
const THIGH = 0.45;
const TORSO = 0.50;

function point(x, y, z = 0, visibility = 0.95) {
  return { x, y, z, visibility };
}

/**
 * One squat pose at depth `s`, 0 standing and 1 at the bottom.
 *
 * Placed directly rather than by inverse kinematics: the benchmark needs a
 * trajectory that drives the counter through its whole state machine, not an
 * anatomically exact one. `main` asserts the reps actually count, which is what
 * proves the full path ran rather than an early return.
 */
function squatPose(s) {
  const body = Array.from({ length: LANDMARK_COUNT }, () => point(0, 0, 0));

  const hipY = 0.45 * s;
  const kneeX = 0.24 * s;
  const leanX = 0.12 * s;

  const set = (i, x, y, z = 0) => {
    body[i] = point(x, y, z);
  };

  // Hips, knees, ankles. The z offset gives the two sides different depth, the
  // way an oblique camera sees them, so `reliableMean` does real work.
  set(LM.LEFT_HIP, -0.09, hipY, 0.02);
  set(LM.RIGHT_HIP, 0.09, hipY, -0.02);
  set(LM.LEFT_KNEE, -0.10 + kneeX, 0.45, 0.03);
  set(LM.RIGHT_KNEE, 0.10 + kneeX, 0.45, -0.03);
  set(LM.LEFT_ANKLE, -0.10, 0.90, 0.02);
  set(LM.RIGHT_ANKLE, 0.10, 0.90, -0.02);
  set(LM.LEFT_FOOT_INDEX, -0.10, 0.95, 0.14);
  set(LM.RIGHT_FOOT_INDEX, 0.10, 0.95, 0.14);

  // Torso leans forward as the hips drop, which is what a real squat does and
  // what keeps `checkPosture` from reading it as lying down.
  const shY = hipY - TORSO;
  set(LM.LEFT_SHOULDER, -0.16 + leanX, shY, 0.02);
  set(LM.RIGHT_SHOULDER, 0.16 + leanX, shY, -0.02);
  set(LM.NOSE, leanX, shY - 0.22, 0.05);

  // Arms forward for balance, kept well clear of the floor so the support-cheat
  // check does not fire.
  set(LM.LEFT_ELBOW, -0.22 + leanX, shY + 0.24, 0.16);
  set(LM.RIGHT_ELBOW, 0.22 + leanX, shY + 0.24, 0.16);
  set(LM.LEFT_WRIST, -0.20 + leanX, shY + 0.30, 0.42);
  set(LM.RIGHT_WRIST, 0.20 + leanX, shY + 0.30, 0.42);

  return body;
}

/** Image-space copy, which is what framing is judged on. */
function toNormalized(body) {
  return body.map((p) => point(0.5 + p.x * 0.55, 0.10 + p.y * 0.80, p.z, p.visibility));
}

/** A set of `reps` squats sampled at 30 FPS. */
function squatSession(reps, framesPerRep = 30) {
  const frames = [];
  for (let r = 0; r < reps; r++) {
    for (let f = 0; f < framesPerRep; f++) {
      // Triangle wave: down then up, which is the shape the counter expects.
      const phase = f / framesPerRep;
      const s = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const world = squatPose(s);
      frames.push({ world, normalized: toNormalized(world) });
    }
  }
  return frames;
}

/* -------------------------------------------------------------- the loop */

/**
 * Everything the engine does per frame between receiving landmarks and drawing.
 * Mirrors `workoutEngine.ts` around its `recordFastLoop` call.
 */
function runFrame(frame, state, timestampMs) {
  checkFraming(frame.normalized, 'squat');
  const angles = computeJointAngles(frame.world);
  checkPosture(frame.world, 'squat');

  const raw = primaryAngleForCounting(frame.world, 'squat');
  const smoothed = state.smoother.push(raw);
  state.window.push(timestampMs, angles);

  const event = state.counter.update(smoothed, timestampMs);
  if (event) {
    const window = state.window.take(event);
    evaluateRules('squat', window, {}, { bestLockoutDeg: state.bestLockout });
    state.reps += event.counted ? 1 : 0;
  }
  return state;
}

function freshState() {
  return {
    smoother: new MedianFilter(),
    counter: new RepCounter('squat'),
    window: new RepWindowBuilder(),
    reps: 0,
    bestLockout: undefined,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[i];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, v) => sum + v, 0);
  const round = (v) => Number(v.toFixed(4));
  return {
    frames: samples.length,
    meanMs: round(total / samples.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const frames = squatSession(12);

  // Warm-up, so the reported numbers are steady-state rather than a measurement
  // of the JIT compiling on its first pass.
  for (let pass = 0; pass < 3; pass++) {
    const state = freshState();
    frames.forEach((f, i) => runFrame(f, state, i * 33));
  }

  const samples = [];
  const state = freshState();
  frames.forEach((frame, i) => {
    const startedAt = process.hrtime.bigint();
    runFrame(frame, state, i * 33);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  });

  // The guard that makes the number meaningful: if the counter did not run, the
  // benchmark measured early returns rather than the fast loop.
  if (state.reps === 0) {
    console.error(
      'Counted 0 repetitions, so the rules and rep-window paths never executed.\n' +
        'The synthetic body is not passing the posture or depth gates; fix the\n' +
        'model in squatPose() before trusting any timing from this run.',
    );
    process.exitCode = 1;
    return;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    what: 'core/ fast-loop computation only, excluding MediaPipe inference',
    notDeviceLatency: true,
    runtime: `${process.release.name} ${process.version} on ${process.platform}/${process.arch}`,
    exercise: 'squat',
    repsCounted: state.reps,
    perFrame: summarize(samples),
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(join(RESULTS_DIR, 'fastloop_cost.json'), `${JSON.stringify(result, null, 2)}\n`);

  const p = result.perFrame;
  console.log(`runtime      ${result.runtime}`);
  console.log(`frames       ${p.frames} (${state.reps} reps counted)`);
  console.log(`mean         ${p.meanMs} ms`);
  console.log(`p50          ${p.p50Ms} ms`);
  console.log(`p95          ${p.p95Ms} ms`);
  console.log(`max          ${p.maxMs} ms`);
  console.log('\nThis is NOT a device latency figure. See the header of this file.');
}

await main();
