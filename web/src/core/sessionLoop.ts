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

import type { ExerciseKind, HoldKind, MovementKind } from './types.ts';

/** One completed set, as retained across sessions. */
export interface SetRecord {
  exercise: MovementKind;
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
  /**
   * Seconds credited, for held movements.
   *
   * A plank has no repetitions, so `repCount` is 0 and this carries the work
   * instead. Kept as a separate field rather than overloading `repCount`
   * because the two are different units and the history charts would otherwise
   * plot seconds against repetitions on one axis.
   */
  holdSeconds?: number;
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

/**
 * Starting point before any history exists. Modest on purpose.
 *
 * Onboarding overrides these from the experience answer, by storing the chosen
 * baseline as the current target — so the value here is what someone who
 * skipped onboarding gets, and matches the "baru mulai" level.
 */
const DEFAULT_TARGET: Record<ExerciseKind, number> = { pushup: 8, squat: 10 };

/** Seconds a first plank is asked to hold. */
const DEFAULT_HOLD_TARGET: Record<HoldKind, number> = { plank: 20 };

/**
 * Seconds added when a hold progresses.
 *
 * Five rather than one: a second is inside the noise of how long anyone holds a
 * plank, so a one-second step would be progression the user cannot perceive.
 */
const HOLD_PROGRESS_STEP = 5;

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

export interface HoldTarget {
  movement: HoldKind;
  /** Seconds to aim for in the next set. */
  targetSeconds: number;
  reason: ExerciseTarget['reason'];
  basedOnSessions: number;
}

/**
 * Decide the next hold target.
 *
 * The rules are the rep-target rules, applied to seconds: progress only after
 * two consecutive sessions that both reached the target and held it cleanly,
 * reduce when the target is clearly wrong for the person, and skip sessions the
 * camera could not judge.
 *
 * Written out rather than sharing a generic with `nextTarget` because the two
 * differ in what "clean" means — a repetition is clean when few reps were
 * flagged, a hold is clean when the clock barely stopped — and a generic
 * carrying that difference as a parameter would be harder to read than both
 * versions side by side.
 */
export function nextHoldTarget(
  movement: HoldKind,
  history: SetRecord[],
  currentTarget?: number,
): HoldTarget {
  const sessions = groupIntoSessions(history.filter((set) => set.exercise === movement));

  const judgeable = sessions
    .map((session) => bestHold(session.sets.filter(isTrustworthy)))
    .filter((set): set is SetRecord => set !== null);

  if (judgeable.length === 0) {
    return {
      movement,
      targetSeconds: currentTarget ?? DEFAULT_HOLD_TARGET[movement],
      reason: 'baseline',
      basedOnSessions: 0,
    };
  }

  const latest = judgeable[judgeable.length - 1];
  const latestSeconds = latest.holdSeconds ?? 0;
  const target = currentTarget ?? Math.max(DEFAULT_HOLD_TARGET[movement], latestSeconds);

  if (latestSeconds < target * RESET_SHARE) {
    return {
      movement,
      // Meet them where they are, never below a hold worth attempting.
      targetSeconds: Math.max(10, Math.round(latestSeconds)),
      reason: 'reduced',
      basedOnSessions: judgeable.length,
    };
  }

  if (latestSeconds < target) {
    return {
      movement,
      targetSeconds: target,
      reason: 'held-for-consistency',
      basedOnSessions: judgeable.length,
    };
  }

  if (!isCleanHold(latest)) {
    // The seconds were there and the line was not. Raising now would ask for
    // more of a plank they are not yet holding.
    return {
      movement,
      targetSeconds: target,
      reason: 'held-for-form',
      basedOnSessions: judgeable.length,
    };
  }

  const qualifying = judgeable
    .slice(-SESSIONS_BEFORE_PROGRESS)
    .filter((set) => (set.holdSeconds ?? 0) >= target && isCleanHold(set));

  if (qualifying.length < SESSIONS_BEFORE_PROGRESS) {
    return {
      movement,
      targetSeconds: target,
      reason: 'held-for-consistency',
      basedOnSessions: judgeable.length,
    };
  }

  return {
    movement,
    targetSeconds: target + HOLD_PROGRESS_STEP,
    reason: 'progressed',
    basedOnSessions: judgeable.length,
  };
}

/** Longest hold of a session — progression is judged on what they can do. */
function bestHold(sets: SetRecord[]): SetRecord | null {
  return sets.reduce<SetRecord | null>(
    (best, set) => (best === null || (set.holdSeconds ?? 0) > (best.holdSeconds ?? 0) ? set : best),
    null,
  );
}

/**
 * A hold is clean when the clock barely stopped.
 *
 * `flaggedReps` carries the number of breaks for a hold — the same field, the
 * same meaning: how much of the set failed the standard.
 */
function isCleanHold(set: SetRecord): boolean {
  return (set.holdSeconds ?? 0) > 0 && set.flaggedReps <= 1;
}

/** Short Indonesian explanation of a target, for the UI. */
export function explainTarget(target: ExerciseTarget | HoldTarget): string {
  switch (target.reason) {
    case 'baseline':
      return 'Target awal. Akan menyesuaikan setelah beberapa sesi.';
    case 'progressed':
      return 'movement' in target
        ? `Naik ${HOLD_PROGRESS_STEP} detik — dua sesi terakhir tercapai dengan garis badan bersih.`
        : 'Naik satu repetisi — dua sesi terakhir tercapai dengan form bersih.';
    case 'held-for-form':
      return 'movement' in target
        ? 'Target ditahan dulu. Durasinya tercapai, tapi garis badan sempat putus.'
        : 'Target ditahan dulu. Repetisinya tercapai, tapi form perlu dirapikan.';
    case 'held-for-consistency':
      return 'Target ditahan sampai tercapai dua sesi berturut-turut.';
    case 'reduced':
      return 'Target diturunkan agar sesuai kemampuan sekarang.';
  }
}
