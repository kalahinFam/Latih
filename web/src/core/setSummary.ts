/**
 * Per-set aggregation — the slow loop's input.
 *
 * ## This shape is the privacy claim
 *
 * What leaves the device is this object and nothing else: counts, angles in
 * degrees, durations in milliseconds, and error codes. No frames, no landmark
 * coordinates, no image data of any kind. The claim that video never leaves the
 * phone is enforced here, by there being no field capable of carrying it — not
 * by a promise elsewhere in the codebase.
 *
 * Keeping it small also keeps the between-set narration fast and cheap, which
 * is what makes coaching feel live rather than delayed.
 */

import type { RepEvent } from './repCounter.ts';
import type { RuleErrorCode, RuleFinding } from './rules.ts';
import type { ExerciseKind } from './types.ts';

/** One rep as the coach sees it. */
export interface RepRecord {
  index: number;
  /** Depth reached, degrees. */
  minAngle: number;
  /** Peak extension, degrees. */
  maxAngle: number;
  eccentricMs: number;
  concentricMs: number;
  errors: RuleErrorCode[];
}

export interface SetSummary {
  exercise: ExerciseKind;
  repCount: number;
  durationMs: number;
  reps: RepRecord[];
  /** How often each error occurred across the set. */
  errorCounts: Partial<Record<RuleErrorCode, number>>;
  depth: { meanDeg: number; bestDeg: number; worstDeg: number; consistencyDeg: number };
  tempo: { meanEccentricMs: number; meanConcentricMs: number; tempoDriftMs: number };
  /** Share of frames the pose was confidently visible, 0..1. */
  trackingQuality: number;
}

export function toRepRecord(event: RepEvent, findings: RuleFinding[]): RepRecord {
  return {
    index: event.index,
    minAngle: round(event.minAngle),
    maxAngle: round(event.maxAngle),
    eccentricMs: Math.round(event.eccentricMs),
    concentricMs: Math.round(event.concentricMs),
    errors: findings.map((f) => f.code),
  };
}

function round(value: number, places = 1): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * Change in descent speed from the first half of the set to the second.
 *
 * Positive means the descent slowed as the set went on — the usual signature of
 * fatigue. This is the kind of across-rep pattern no single-frame rule can see,
 * and giving the coach the number lets it say something a rep counter cannot.
 */
function tempoDrift(reps: RepRecord[]): number {
  if (reps.length < 4) return 0;
  const half = Math.floor(reps.length / 2);
  const first = mean(reps.slice(0, half).map((r) => r.eccentricMs));
  const second = mean(reps.slice(half).map((r) => r.eccentricMs));
  return Math.round(second - first);
}

export function summarizeSet(
  exercise: ExerciseKind,
  reps: RepRecord[],
  options: { durationMs: number; trackingQuality: number },
): SetSummary {
  const depths = reps.map((r) => r.minAngle);
  const errorCounts: Partial<Record<RuleErrorCode, number>> = {};
  for (const rep of reps) {
    for (const code of rep.errors) {
      errorCounts[code] = (errorCounts[code] ?? 0) + 1;
    }
  }

  return {
    exercise,
    repCount: reps.length,
    durationMs: Math.round(options.durationMs),
    reps,
    errorCounts,
    depth: {
      // Smaller angle means deeper, so "best" is the minimum.
      meanDeg: round(mean(depths)),
      bestDeg: round(depths.length ? Math.min(...depths) : 0),
      worstDeg: round(depths.length ? Math.max(...depths) : 0),
      consistencyDeg: round(stdDev(depths)),
    },
    tempo: {
      meanEccentricMs: Math.round(mean(reps.map((r) => r.eccentricMs))),
      meanConcentricMs: Math.round(mean(reps.map((r) => r.concentricMs))),
      tempoDriftMs: tempoDrift(reps),
    },
    trackingQuality: round(options.trackingQuality, 2),
  };
}

/**
 * Guard against a payload ever carrying image-like data.
 *
 * Cheap to run, and it turns the privacy claim into something the test suite
 * checks rather than something a future edit could quietly break.
 */
export function assertNoRawPoseData(summary: SetSummary): void {
  const serialized = JSON.stringify(summary);
  const forbidden = ['landmark', 'image', 'frame', 'pixel', 'data:', 'base64'];
  for (const token of forbidden) {
    if (serialized.toLowerCase().includes(token)) {
      throw new Error(`Set summary must not contain "${token}"`);
    }
  }
}
