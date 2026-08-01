/**
 * Per-repetition feature tensor — the classifier's input.
 *
 * ## Why angles and not coordinates
 *
 * Training on raw landmark coordinates would force the model to learn away
 * camera distance, body size, and framing before it could learn anything about
 * form. Joint angles are already invariant to all three, which cuts the data
 * requirement enormously — and with a dataset we have to annotate by hand in
 * two days, that is the difference between a model and a wish.
 *
 * ## Why the rep, not the frame
 *
 * A form error is a property of a repetition, not of a moment. "Hips sagged"
 * is only meaningful relative to the rest of the descent. So each rep is
 * resampled onto a fixed 32-step grid in *normalised time*, which also makes
 * fast and slow reps directly comparable — a fast rep is not a different shape,
 * only a shorter one.
 *
 * ## What this deliberately keeps that the rules cannot use
 *
 * Angular velocity and left-right asymmetry are in here precisely because no
 * single-frame threshold can express them. They are the classifier's reason to
 * exist, and the ablation study's reason to show a difference.
 */

import { bilateralMean } from './angles.ts';
import type { RepFrame, RepWindow } from './repWindow.ts';
import type { ExerciseKind, JointAngles } from './types.ts';

/** Resampling grid size. Powers of two keep the 1D-CNN's pooling clean. */
export const TIMESTEPS = 32;

/**
 * Feature order is part of the model's contract: the ONNX graph is compiled
 * against these indices, so reordering this array silently invalidates every
 * exported model. Append only.
 */
export const FEATURE_NAMES = [
  'elbow',
  'knee',
  'hip',
  'shoulder',
  'trunkLean',
  'primary',
  'primaryVelocity',
  'elbowAsymmetry',
  'kneeAsymmetry',
  'hipAsymmetry',
  'phase',
  'depthProgress',
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

export interface RepFeatures {
  exercise: ExerciseKind;
  /** Row-major, `TIMESTEPS * FEATURE_COUNT`. */
  data: Float32Array;
  /**
   * Fraction of frames each feature was actually observed, 0..1.
   *
   * Reported rather than hidden: a rep whose hips were never visible produces
   * an imputed hip channel, and training on it as if it were measured would
   * teach the model to trust a value that was invented. Downstream code can
   * weight or drop those reps.
   */
  coverage: Float32Array;
}

/** Angles are divided by this so every channel lands in roughly 0..1. */
const ANGLE_SCALE = 180;
/** Asymmetries are much smaller than raw angles; scaled separately. */
const ASYMMETRY_SCALE = 90;
/** Clip for angular velocity, deg/s. Beyond this is tracker noise, not motion. */
const VELOCITY_CLIP = 600;

function asymmetry(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.abs(left - right);
}

function primaryOf(angles: JointAngles, exercise: ExerciseKind): number | null {
  return exercise === 'pushup'
    ? bilateralMean(angles.elbowLeft, angles.elbowRight)
    : bilateralMean(angles.kneeLeft, angles.kneeRight);
}

/**
 * Per-frame channel values before resampling. `null` marks "not observed" and
 * is carried through so imputation happens once, in one place.
 */
function rawChannels(frame: RepFrame, exercise: ExerciseKind): (number | null)[] {
  const a = frame.angles;
  const elbow = bilateralMean(a.elbowLeft, a.elbowRight);
  const knee = bilateralMean(a.kneeLeft, a.kneeRight);
  const hip = bilateralMean(a.hipLeft, a.hipRight);
  const shoulder = bilateralMean(a.shoulderLeft, a.shoulderRight);

  return [
    elbow,
    knee,
    hip,
    shoulder,
    a.trunkLean,
    primaryOf(a, exercise),
    null, // velocity is derived after resampling, where the grid is uniform
    asymmetry(a.elbowLeft, a.elbowRight),
    asymmetry(a.kneeLeft, a.kneeRight),
    asymmetry(a.hipLeft, a.hipRight),
    null, // phase is a function of the grid position
    null, // depthProgress needs the rep's own min and max
  ];
}

/**
 * Fill gaps by linear interpolation between observed neighbours, extending the
 * nearest observation at the ends.
 *
 * Interpolating is right for a joint that flickers out for a few frames: the
 * limb did not teleport. Returns null when the channel was never observed at
 * all, which the caller records as zero coverage rather than inventing a value.
 */
function interpolateGaps(values: (number | null)[]): number[] | null {
  const known = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) return null;

  const filled = values.slice();
  // Extend the first and last observations outward.
  for (let i = 0; i < known[0]; i++) filled[i] = values[known[0]];
  for (let i = known[known.length - 1] + 1; i < filled.length; i++) {
    filled[i] = values[known[known.length - 1]];
  }

  for (let k = 0; k < known.length - 1; k++) {
    const start = known[k];
    const end = known[k + 1];
    if (end === start + 1) continue;
    const a = values[start] as number;
    const b = values[end] as number;
    for (let i = start + 1; i < end; i++) {
      filled[i] = a + ((b - a) * (i - start)) / (end - start);
    }
  }

  return filled as number[];
}

/** Sample a series defined on `positions` (0..1) at a uniform grid point. */
function sampleAt(series: number[], positions: number[], t: number): number {
  if (series.length === 1) return series[0];
  if (t <= positions[0]) return series[0];
  if (t >= positions[positions.length - 1]) return series[series.length - 1];

  let hi = 1;
  while (hi < positions.length - 1 && positions[hi] < t) hi++;
  const lo = hi - 1;
  const span = positions[hi] - positions[lo];
  if (span <= 0) return series[hi];
  const ratio = (t - positions[lo]) / span;
  return series[lo] + (series[hi] - series[lo]) * ratio;
}

/**
 * Build the fixed-size tensor for one repetition.
 *
 * Returns null for a rep with no usable frames — an abandoned rep, or one where
 * tracking was lost throughout. Silently emitting a zero tensor would put a
 * fabricated example into the training set.
 */
export function extractFeatures(exercise: ExerciseKind, window: RepWindow): RepFeatures | null {
  const frames = window.frames;
  if (frames.length === 0) return null;

  // Normalised time of each captured frame within the rep.
  const start = frames[0].timestampMs;
  const span = frames[frames.length - 1].timestampMs - start;
  const positions =
    span > 0
      ? frames.map((f) => (f.timestampMs - start) / span)
      : frames.map((_, i) => (frames.length === 1 ? 0 : i / (frames.length - 1)));

  const raw = frames.map((frame) => rawChannels(frame, exercise));
  const data = new Float32Array(TIMESTEPS * FEATURE_COUNT);
  const coverage = new Float32Array(FEATURE_COUNT);

  const PHASE = FEATURE_NAMES.indexOf('phase');
  const VELOCITY = FEATURE_NAMES.indexOf('primaryVelocity');
  const DEPTH = FEATURE_NAMES.indexOf('depthProgress');
  const PRIMARY = FEATURE_NAMES.indexOf('primary');

  // Resample every directly-measured channel onto the uniform grid.
  const grid: number[][] = [];
  for (let c = 0; c < FEATURE_COUNT; c++) {
    if (c === PHASE || c === VELOCITY || c === DEPTH) {
      grid.push([]);
      continue;
    }
    const column = raw.map((row) => row[c]);
    const observed = column.filter((v) => v !== null).length;
    coverage[c] = observed / column.length;

    const filled = interpolateGaps(column);
    if (filled === null) {
      grid.push(new Array(TIMESTEPS).fill(0));
      continue;
    }
    grid.push(
      Array.from({ length: TIMESTEPS }, (_, i) =>
        sampleAt(filled, positions, i / (TIMESTEPS - 1)),
      ),
    );
  }

  // Phase: position within the rep. Trivially complete by construction.
  grid[PHASE] = Array.from({ length: TIMESTEPS }, (_, i) => i / (TIMESTEPS - 1));
  coverage[PHASE] = 1;

  // Velocity: derivative of the primary angle on the uniform grid, in deg/s.
  const primarySeries = grid[PRIMARY];
  const stepMs = span > 0 ? span / (TIMESTEPS - 1) : 33;
  grid[VELOCITY] = primarySeries.map((_, i) => {
    if (i === 0) return 0;
    const delta = primarySeries[i] - primarySeries[i - 1];
    return (delta / stepMs) * 1000;
  });
  coverage[VELOCITY] = coverage[PRIMARY];

  // Depth progress: where this instant sits between the rep's own extremes.
  // Self-normalising, so a deep rep and a shallow one share a shape even
  // though their absolute angles differ.
  const min = Math.min(...primarySeries);
  const max = Math.max(...primarySeries);
  const range = max - min;
  grid[DEPTH] = primarySeries.map((v) => (range > 1e-6 ? (max - v) / range : 0));
  coverage[DEPTH] = coverage[PRIMARY];

  for (let i = 0; i < TIMESTEPS; i++) {
    for (let c = 0; c < FEATURE_COUNT; c++) {
      data[i * FEATURE_COUNT + c] = normalize(c, grid[c][i], PHASE, VELOCITY, DEPTH);
    }
  }

  return { exercise, data, coverage };
}

function normalize(
  channel: number,
  value: number,
  phaseIndex: number,
  velocityIndex: number,
  depthIndex: number,
): number {
  if (channel === phaseIndex || channel === depthIndex) return value;
  if (channel === velocityIndex) {
    return Math.max(-1, Math.min(1, value / VELOCITY_CLIP));
  }
  const name = FEATURE_NAMES[channel];
  const scale = name.endsWith('Asymmetry') ? ASYMMETRY_SCALE : ANGLE_SCALE;
  return value / scale;
}

/** Read one grid cell back out, for tests and for debugging exported tensors. */
export function featureAt(features: RepFeatures, step: number, name: string): number {
  const channel = (FEATURE_NAMES as readonly string[]).indexOf(name);
  if (channel < 0) throw new Error(`Unknown feature: ${name}`);
  return features.data[step * FEATURE_COUNT + channel];
}
