/**
 * Session loop — adapts targets from training history.
 *
 * The third of the three loops, and the slowest. The fast loop reacts inside a
 * repetition, the slow loop reflects on a set, and this one looks across
 * sessions: it decides what to ask of the user next time.
 *
 * ## Why quality gates the increase, not just quantity
 *
 * The obvious rule — "did more reps, so raise the target" — trains people to
 * chase the number by cutting depth, which is precisely the failure the fast
 * loop exists to catch. Adding reps while form degrades is not progress. So a
 * target only rises when the previous session was both *completed* and *clean*;
 * when reps were hit but form slipped, the target holds and the coaching
 * narrative points at quality instead.
 *
 * ## Why it waits for consistency
 *
 * One good session is noise — a fresh day, a better camera angle. Raising after
 * every good session produces a target that ratchets up faster than anyone
 * adapts, and then a run of failures. Requiring two consecutive qualifying
 * sessions costs a little progression speed and avoids that oscillation.
 *
 * Pure logic, no storage: the same rules are unit-tested here and exercised
 * from the app through `session/history.ts`.
 */

import type { ExerciseKind } from './types.ts';

/** One completed set, as retained across sessions. */
export interface SetRecord {
  exercise: ExerciseKind;
  /** Epoch milliseconds, recorded when the set ended. */
  at: number;
  repCount: number;
  /** Reps that triggered at least one form rule. */
  flaggedReps: number;
  /** Mean depth reached, degrees. Smaller is deeper. */
  meanDepthDeg: number;
  /** Share of frames the pose was readable, 0..1. */
  trackingQuality: number;
  /**
   * How long the set took, milliseconds.
   *
   * Kept because `at` marks the *end* of a set: without a duration, elapsed
   * time for a session would silently omit its first set.
   */
  durationMs?: number;
  /**
   * Occurrences per error code.
   *
   * Adaptation never reads this — `flaggedReps` is what gates progression. It
   * is stored so the session summary and history can show *which* faults
   * happened rather than only how many reps were imperfect.
   */
  errorCounts?: Record<string, number>;
}

export interface ExerciseTarget {
  exercise: ExerciseKind;
  /** Reps to aim for in the next set. */
  targetReps: number;
  /** Why the target is what it is, shown to the user and sent to the coach. */
  reason:
    | 'baseline'
    | 'progressed'
    | 'held-for-form'
    | 'held-for-consistency'
    | 'reduced';
  /** Sessions of history the decision drew on. */
  basedOnSessions: number;
}

/** Starting point before any history exists. Modest on purpose. */
const DEFAULT_TARGET: Record<ExerciseKind, number> = { pushup: 8, squat: 10 };

/** Above this share of flagged reps, the set was not clean enough to progress. */
const MAX_FLAGGED_SHARE = 0.25;

/** Consecutive qualifying sessions required before the target rises. */
const SESSIONS_BEFORE_PROGRESS = 2;

/** Reps added when progressing. One at a time — this compounds weekly. */
const PROGRESS_STEP = 1;

/**
 * Below this share of the target, the target was not merely missed but is
 * probably wrong for this person right now.
 */
const RESET_SHARE = 0.7;

/**
 * A set whose tracking was this poor says more about the camera than the
 * lifter, and must not move the target in either direction.
 */
const MIN_TRUSTWORTHY_TRACKING = 0.7;

/** Group sets into sessions — sets within this gap belong to one workout. */
const SESSION_GAP_MS = 90 * 60 * 1000;

export interface Session {
  startedAt: number;
  sets: SetRecord[];
}

/**
 * Split a flat history into sessions.
 *
 * Sets are recorded individually because that is when the data exists; the
 * boundary is inferred from the gap between them rather than asking the user
 * to declare a workout over.
 */
export function groupIntoSessions(history: SetRecord[]): Session[] {
  const sorted = [...history].sort((a, b) => a.at - b.at);
  const sessions: Session[] = [];

  for (const set of sorted) {
    const current = sessions[sessions.length - 1];
    if (current && set.at - current.sets[current.sets.length - 1].at <= SESSION_GAP_MS) {
      current.sets.push(set);
    } else {
      sessions.push({ startedAt: set.at, sets: [set] });
    }
  }

  return sessions;
}

/** Best set of a session — progression is judged on what the person can do. */
function bestSet(sets: SetRecord[]): SetRecord | null {
  return sets.reduce<SetRecord | null>(
    (best, set) => (best === null || set.repCount > best.repCount ? set : best),
    null,
  );
}

function isClean(set: SetRecord): boolean {
  return set.repCount > 0 && set.flaggedReps / set.repCount <= MAX_FLAGGED_SHARE;
}

function isTrustworthy(set: SetRecord): boolean {
  return set.trackingQuality >= MIN_TRUSTWORTHY_TRACKING;
}

/**
 * Decide the next target for one exercise.
 *
 * @param history Every set ever recorded, any exercise. Filtered internally.
 * @param currentTarget The target the user has been working to, if any.
 */
export function nextTarget(
  exercise: ExerciseKind,
  history: SetRecord[],
  currentTarget?: number,
): ExerciseTarget {
  const relevant = history.filter((set) => set.exercise === exercise);
  const sessions = groupIntoSessions(relevant);

  if (sessions.length === 0) {
    return {
      exercise,
      targetReps: currentTarget ?? DEFAULT_TARGET[exercise],
      reason: 'baseline',
      basedOnSessions: 0,
    };
  }

  // Sessions whose tracking was too poor to judge are skipped entirely rather
  // than counted as failures — the camera was the problem, not the lifter.
  const judgeable = sessions
    .map((session) => bestSet(session.sets.filter(isTrustworthy)))
    .filter((set): set is SetRecord => set !== null);

  if (judgeable.length === 0) {
    return {
      exercise,
      targetReps: currentTarget ?? DEFAULT_TARGET[exercise],
      reason: 'baseline',
      basedOnSessions: 0,
    };
  }

  const latest = judgeable[judgeable.length - 1];
  // With no target set yet, adopt what they actually managed rather than
  // inventing a number they have never hit.
  const target = currentTarget ?? Math.max(DEFAULT_TARGET[exercise], latest.repCount);

  if (latest.repCount < target * RESET_SHARE) {
    return {
      exercise,
      // Meet them where they are, never below the floor.
      targetReps: Math.max(1, latest.repCount),
      reason: 'reduced',
      basedOnSessions: judgeable.length,
    };
  }

  const metTarget = latest.repCount >= target;
  if (!metTarget) {
    return { exercise, targetReps: target, reason: 'held-for-consistency', basedOnSessions: judgeable.length };
  }

  if (!isClean(latest)) {
    // Reps were there, form was not. Raising now rewards the wrong thing.
    return { exercise, targetReps: target, reason: 'held-for-form', basedOnSessions: judgeable.length };
  }

  const qualifying = judgeable
    .slice(-SESSIONS_BEFORE_PROGRESS)
    .filter((set) => set.repCount >= target && isClean(set));

  if (qualifying.length < SESSIONS_BEFORE_PROGRESS) {
    return {
      exercise,
      targetReps: target,
      reason: 'held-for-consistency',
      basedOnSessions: judgeable.length,
    };
  }

  return {
    exercise,
    targetReps: target + PROGRESS_STEP,
    reason: 'progressed',
    basedOnSessions: judgeable.length,
  };
}

export interface ProgressTrend {
  sessions: number;
  /** Best rep count in the most recent session. */
  latestBestReps: number;
  /** Change in best reps versus the previous session. */
  repsDelta: number;
  /** Change in mean depth, degrees. Negative means deeper. */
  depthDeltaDeg: number;
  /** Share of reps flagged in the latest session, 0..1. */
  latestFlaggedShare: number;
}

/**
 * Summarise progress for the coaching narrative.
 *
 * This is what makes the three loops one system rather than three features
 * sitting side by side: the slow loop can say "deeper than last week" only
 * because the session loop remembers last week.
 */
export function progressTrend(exercise: ExerciseKind, history: SetRecord[]): ProgressTrend | null {
  const sessions = groupIntoSessions(history.filter((set) => set.exercise === exercise));
  if (sessions.length === 0) return null;

  const latestSets = sessions[sessions.length - 1].sets;
  const latest = bestSet(latestSets);
  if (!latest) return null;

  const previous = sessions.length >= 2 ? bestSet(sessions[sessions.length - 2].sets) : null;
  const flagged = latestSets.reduce((sum, s) => sum + s.flaggedReps, 0);
  const reps = latestSets.reduce((sum, s) => sum + s.repCount, 0);

  return {
    sessions: sessions.length,
    latestBestReps: latest.repCount,
    repsDelta: previous ? latest.repCount - previous.repCount : 0,
    depthDeltaDeg: previous ? Number((latest.meanDepthDeg - previous.meanDepthDeg).toFixed(1)) : 0,
    latestFlaggedShare: reps === 0 ? 0 : Number((flagged / reps).toFixed(2)),
  };
}

/** Short Indonesian explanation of a target, for the UI. */
export function explainTarget(target: ExerciseTarget): string {
  switch (target.reason) {
    case 'baseline':
      return 'Target awal. Akan menyesuaikan setelah beberapa sesi.';
    case 'progressed':
      return 'Naik satu repetisi — dua sesi terakhir tercapai dengan form bersih.';
    case 'held-for-form':
      return 'Target ditahan dulu. Repetisinya tercapai, tapi form perlu dirapikan.';
    case 'held-for-consistency':
      return 'Target ditahan sampai tercapai dua sesi berturut-turut.';
    case 'reduced':
      return 'Target diturunkan agar sesuai kemampuan sekarang.';
  }
}
