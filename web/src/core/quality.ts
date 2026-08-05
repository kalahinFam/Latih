/**
 * Session-level numbers for the home, summary, and history screens.
 *
 * ## Why the quality score is defined the way it is
 *
 * "85 out of 100" on a summary screen is worth nothing unless the user can be
 * told where it came from. So the score is the share of repetitions that broke
 * no rule, and the screen says so directly: *5 of 34 repetitions flagged*.
 * Anyone can check the division.
 *
 * The obvious alternative — folding tracking quality, depth, and consistency
 * into one weighted number — produces a score nobody can trace back to
 * anything they did, and weights that exist only because someone had to pick
 * them. Tracking quality is reported alongside instead, as context for how much
 * to trust the score, which is what it actually is.
 *
 * Pure logic over `SetRecord[]`. No storage, no DOM.
 */

import { groupIntoSessions, type SetRecord, type Session } from './sessionLoop.ts';
import { isHold, type MovementKind } from './types.ts';

export interface SessionStats {
  startedAt: number;
  /** True when this session was a held movement rather than a counted one. */
  isHold: boolean;
  /** Seconds credited, for held movements. */
  holdSeconds: number;
  /** Wall time from the start of the first set to the end of the last, ms. */
  elapsedMs: number;
  sets: number;
  reps: number;
  flaggedReps: number;
  /** Share of reps that broke no rule, 0..100. Null when there were no reps. */
  quality: number | null;
  /** Mean depth across the session, weighted by reps. Degrees, smaller deeper. */
  meanDepthDeg: number | null;
  /** Mean share of frames the pose was readable, 0..1. */
  trackingQuality: number;
  /** Occurrences per error code across the whole session. */
  errorCounts: Record<string, number>;
}

/** Reps-weighted mean, ignoring sets that contributed no reps. */
function weightedMean(records: SetRecord[], value: (r: SetRecord) => number): number | null {
  const reps = records.reduce((sum, r) => sum + r.repCount, 0);
  if (reps === 0) return null;
  return records.reduce((sum, r) => sum + value(r) * r.repCount, 0) / reps;
}

export function summarizeSession(session: Session): SessionStats {
  const sets = [...session.sets].sort((a, b) => a.at - b.at);
  const reps = sets.reduce((sum, s) => sum + s.repCount, 0);
  const flagged = sets.reduce((sum, s) => sum + s.flaggedReps, 0);

  const errorCounts: Record<string, number> = {};
  for (const set of sets) {
    for (const [code, count] of Object.entries(set.errorCounts ?? {})) {
      errorCounts[code] = (errorCounts[code] ?? 0) + count;
    }
  }

  const hold = sets.length > 0 && isHold(sets[0].exercise);
  const holdSeconds = sets.reduce((sum, s) => sum + (s.holdSeconds ?? 0), 0);

  const first = sets[0];
  const last = sets[sets.length - 1];
  // `at` marks the end of a set, so the first set's own duration has to be
  // added back or a one-set session would read as zero minutes.
  const elapsedMs = last.at - first.at + (first.durationMs ?? 0);

  // Held sets are scored on the share of the set actually spent holding the
  // position, which is the same idea as the rep score — how much of the work
  // met the standard — expressed in the unit the movement is measured in.
  const totalMs = sets.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const holdQuality =
    totalMs === 0 ? null : Math.min(100, Math.round(((holdSeconds * 1000) / totalMs) * 100));

  return {
    startedAt: first.at - (first.durationMs ?? 0),
    isHold: hold,
    holdSeconds,
    elapsedMs: Math.max(0, elapsedMs),
    sets: sets.length,
    reps,
    flaggedReps: flagged,
    quality: hold ? holdQuality : reps === 0 ? null : Math.round(((reps - flagged) / reps) * 100),
    meanDepthDeg: weightedMean(sets, (r) => r.meanDepthDeg),
    trackingQuality:
      sets.length === 0 ? 0 : sets.reduce((sum, s) => sum + s.trackingQuality, 0) / sets.length,
    errorCounts,
  };
}

/** Every session for one movement, oldest first. */
export function sessionStats(exercise: MovementKind, history: SetRecord[]): SessionStats[] {
  return groupIntoSessions(history.filter((s) => s.exercise === exercise)).map(summarizeSession);
}

/** Local calendar day as a sortable key, so "same day" survives time zones. */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Consecutive days ending today or yesterday that have at least one set.
 *
 * Yesterday counts as still alive: a streak that resets at midnight punishes
 * someone who has not trained *yet today*, which is most of the day for most
 * people, and turns the number into a source of anxiety rather than momentum.
 */
export function currentStreak(history: SetRecord[], now = Date.now()): number {
  if (history.length === 0) return 0;

  const days = new Set(history.map((set) => dayKey(set.at)));
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);

  if (!days.has(dayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor.getTime()))) return 0;
  }

  let streak = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Quality of the most recent session, for the home screen. */
export function latestQuality(history: SetRecord[]): number | null {
  const sessions = groupIntoSessions(history);
  if (sessions.length === 0) return null;
  return summarizeSession(sessions[sessions.length - 1]).quality;
}

/** The most recent session across all exercises, for "last session" copy. */
export function latestSession(history: SetRecord[]): SessionStats | null {
  const sessions = groupIntoSessions(history);
  return sessions.length === 0 ? null : summarizeSession(sessions[sessions.length - 1]);
}

/**
 * Above this share of flagged reps a session is marked amber in the history
 * chart. Matches `MAX_FLAGGED_SHARE` in the session loop on purpose: a bar the
 * chart calls clean must be one the target actually rose for, or the chart is
 * telling a different story from the app.
 */
export const DIRTY_SESSION_SHARE = 0.25;

export function isDirty(stats: SessionStats): boolean {
  // For a hold, "dirty" is the clock having stopped more than once — the same
  // question, asked of the unit the movement is measured in.
  if (stats.isHold) return stats.flaggedReps > 1;
  return stats.reps > 0 && stats.flaggedReps / stats.reps > DIRTY_SESSION_SHARE;
}

/** Human-readable error labels, shared by the summary and feedback screens. */
export const ERROR_LABELS: Record<string, string> = {
  shallow_depth: 'Kurang dalam',
  partial_lockout: 'Belum lurus penuh',
  hip_sag: 'Pinggul turun',
  hip_pike: 'Pinggul terlalu naik',
  excessive_trunk_lean: 'Badan terlalu membungkuk',
};

export function errorLabel(code: string): string {
  return ERROR_LABELS[code] ?? code;
}

/** "18 menit" — minutes, floored at one so a real session never reads as zero. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes} menit`;
}
