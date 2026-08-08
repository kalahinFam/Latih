/**
 * Training history storage.
 *
 * Kept in `localStorage`, on the device, alongside everything else about this
 * product: the fast loop never sends frames anywhere, and the history that
 * drives target adaptation has no reason to leave either. Nothing here is
 * uploaded — the slow loop receives a derived target and trend, not the log.
 *
 * Separated from `core/sessionLoop.ts` so the adaptation rules stay testable
 * without a DOM.
 */

import {
  nextHoldTarget,
  nextTarget,
  progressTrend,
  type ExerciseTarget,
  type HoldTarget,
  type SetRecord,
} from '../core/sessionLoop.ts';
import type { SetSummary } from '../core/setSummary.ts';
import { isHold, type ExerciseKind, type HoldKind, type MovementKind } from '../core/types.ts';

const STORAGE_KEY = 'latih.history.v1';

/**
 * Cap on retained sets. Roughly a year of training three times a week, and
 * enough that adaptation never sees a truncated view — while keeping a
 * localStorage quota error out of reach.
 */
const MAX_SETS = 500;

interface StoredHistory {
  version: 1;
  sets: SetRecord[];
  /**
   * Target currently being worked to, per movement.
   *
   * Repetitions for the counted movements, seconds for the held ones — the key
   * says which, so one map serves both.
   */
  targets: Partial<Record<MovementKind, number>>;
}

function empty(): StoredHistory {
  return { version: 1, sets: [], targets: {} };
}

/**
 * Read the stored history.
 *
 * Any corruption resets to empty rather than throwing. Losing history is a
 * small cost; a stored value that crashes the app on every load is not
 * recoverable by the user at all.
 */
function read(): StoredHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as StoredHistory;
    if (parsed.version !== 1 || !Array.isArray(parsed.sets)) return empty();
    return { version: 1, sets: parsed.sets, targets: parsed.targets ?? {} };
  } catch {
    return empty();
  }
}

function write(history: StoredHistory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Private browsing, or a full quota. The session loop degrades to
    // baseline targets; the rest of the product is unaffected, so failing
    // loudly here would cost more than it explains.
  }
}

/**
 * Reduce a set summary to what the session loop needs.
 *
 * Deliberately much smaller than the summary: adaptation reads rep counts,
 * cleanliness and depth, so storing per-rep detail forever would grow the
 * record without changing a single decision.
 */
export function toSetRecord(summary: SetSummary, at = Date.now()): SetRecord {
  return {
    exercise: summary.exercise,
    at,
    repCount: summary.repCount,
    // For a hold this is the number of breaks — the same meaning in both
    // cases: how much of the set failed the standard.
    flaggedReps: summary.hold
      ? summary.hold.breaks
      : summary.reps.filter((rep) => rep.errors.length > 0).length,
    meanDepthDeg: summary.depth.meanDeg,
    trackingQuality: summary.trackingQuality,
    durationMs: summary.durationMs,
    errorCounts: { ...summary.errorCounts },
    holdSeconds: summary.hold ? Math.round(summary.hold.heldMs / 1000) : undefined,
  };
}

export class TrainingHistory {
  /** Record a completed set and return the target for the next one. */
  recordSet(record: SetRecord): ExerciseTarget | HoldTarget {
    const history = read();
    history.sets.push(record);
    if (history.sets.length > MAX_SETS) {
      history.sets = history.sets.slice(-MAX_SETS);
    }

    const stored = history.targets[record.exercise];
    const target = isHold(record.exercise)
      ? nextHoldTarget(record.exercise, history.sets, stored)
      : nextTarget(record.exercise, history.sets, stored);

    history.targets[record.exercise] =
      'movement' in target ? target.targetSeconds : target.targetReps;
    write(history);

    return target;
  }

  /** Target for a counted movement without recording anything. */
  currentTarget(exercise: ExerciseKind): ExerciseTarget {
    const history = read();
    return nextTarget(exercise, history.sets, history.targets[exercise]);
  }

  /** Target for a held movement without recording anything. */
  currentHoldTarget(movement: HoldKind): HoldTarget {
    const history = read();
    return nextHoldTarget(movement, history.sets, history.targets[movement]);
  }

  trend(exercise: ExerciseKind) {
    return progressTrend(exercise, read().sets);
  }

  /**
   * Seed the starting targets from onboarding.
   *
   * Written as the *current* target rather than as a new default, because that
   * is exactly what it is: a number the user is working to, which the session
   * loop then adjusts from real results after the first set. Anything already
   * stored wins — a returning user re-running onboarding must not have their
   * earned target reset to a beginner's.
   */
  seedTargets(targets: Partial<Record<MovementKind, number>>): void {
    const history = read();
    for (const [movement, value] of Object.entries(targets) as [MovementKind, number][]) {
      if (history.targets[movement] === undefined) history.targets[movement] = value;
    }
    write(history);
  }

  /** Everything recorded, for the summary view and for manual export. */
  all(): SetRecord[] {
    return read().sets;
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }
}
