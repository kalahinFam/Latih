import { describe, expect, it } from 'vitest';

import {
  currentStreak,
  errorLabel,
  formatDuration,
  isDirty,
  latestQuality,
  sessionStats,
  summarizeSession,
} from './quality.ts';
import { DIRTY_SESSION_SHARE } from './quality.ts';
import { groupIntoSessions, type SetRecord } from './sessionLoop.ts';
import { CUE_TEXT } from './rules.ts';

const DAY = 24 * 60 * 60 * 1000;
/** Monday 3 August 2026, 18:00 local. */
const MONDAY = new Date(2026, 7, 3, 18, 0, 0).getTime();

function set(overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    exercise: 'pushup',
    at: MONDAY,
    repCount: 12,
    flaggedReps: 0,
    meanDepthDeg: 95,
    trackingQuality: 0.94,
    durationMs: 60_000,
    errorCounts: {},
    ...overrides,
  };
}

describe('summarizeSession', () => {
  it('scores quality as the share of reps that broke no rule', () => {
    // The design's own worked example: 34 reps, 5 flagged, score 85.
    // Anyone can check the division, which is the point of defining it this way.
    const session = groupIntoSessions([
      set({ at: MONDAY, repCount: 12, flaggedReps: 2 }),
      set({ at: MONDAY + 120_000, repCount: 11, flaggedReps: 2 }),
      set({ at: MONDAY + 240_000, repCount: 11, flaggedReps: 1 }),
    ])[0];

    const stats = summarizeSession(session);
    expect(stats.reps).toBe(34);
    expect(stats.flaggedReps).toBe(5);
    expect(stats.quality).toBe(85);
  });

  it('counts the first set’s own duration in elapsed time', () => {
    // `at` marks the end of a set. Taking last.at - first.at alone would
    // report a one-set session as zero minutes.
    const session = groupIntoSessions([set({ at: MONDAY, durationMs: 90_000 })])[0];
    expect(summarizeSession(session).elapsedMs).toBe(90_000);
  });

  it('spans from the first set to the last', () => {
    const session = groupIntoSessions([
      set({ at: MONDAY, durationMs: 60_000 }),
      set({ at: MONDAY + 5 * 60_000 }),
    ])[0];
    expect(summarizeSession(session).elapsedMs).toBe(6 * 60_000);
  });

  it('adds up error codes across the whole session', () => {
    const session = groupIntoSessions([
      set({ at: MONDAY, errorCounts: { hip_sag: 2, shallow_depth: 1 } }),
      set({ at: MONDAY + 120_000, errorCounts: { hip_sag: 1 } }),
    ])[0];

    expect(summarizeSession(session).errorCounts).toEqual({ hip_sag: 3, shallow_depth: 1 });
  });

  it('weights depth by reps, not by set', () => {
    // A two-rep set should not move the session mean as much as a twelve-rep
    // one.
    const session = groupIntoSessions([
      set({ at: MONDAY, repCount: 10, meanDepthDeg: 90 }),
      set({ at: MONDAY + 120_000, repCount: 2, meanDepthDeg: 120 }),
    ])[0];

    expect(summarizeSession(session).meanDepthDeg).toBeCloseTo(95, 1);
  });

  it('reports no quality for a session with no reps', () => {
    const session = groupIntoSessions([set({ repCount: 0, flaggedReps: 0 })])[0];
    expect(summarizeSession(session).quality).toBeNull();
    expect(summarizeSession(session).meanDepthDeg).toBeNull();
  });
});

describe('currentStreak', () => {
  it('counts consecutive days back from today', () => {
    const history = [
      set({ at: MONDAY }),
      set({ at: MONDAY - DAY }),
      set({ at: MONDAY - 2 * DAY }),
    ];
    expect(currentStreak(history, MONDAY + 60_000)).toBe(3);
  });

  it('keeps the streak alive on a day not yet trained', () => {
    // Resetting at midnight would punish someone for not having trained *yet
    // today*, which is most of the day for most people.
    const history = [set({ at: MONDAY }), set({ at: MONDAY - DAY })];
    expect(currentStreak(history, MONDAY + DAY + 3 * 60 * 60 * 1000)).toBe(2);
  });

  it('breaks after a missed day', () => {
    const history = [set({ at: MONDAY }), set({ at: MONDAY - 3 * DAY })];
    expect(currentStreak(history, MONDAY)).toBe(1);
  });

  it('counts a day once however many sets it holds', () => {
    const history = [set({ at: MONDAY }), set({ at: MONDAY + 120_000 }), set({ at: MONDAY - DAY })];
    expect(currentStreak(history, MONDAY)).toBe(2);
  });

  it('is zero with no history, and once the streak is stale', () => {
    expect(currentStreak([], MONDAY)).toBe(0);
    expect(currentStreak([set({ at: MONDAY - 5 * DAY })], MONDAY)).toBe(0);
  });
});

describe('sessionStats', () => {
  it('separates exercises', () => {
    const history = [
      set({ exercise: 'pushup', at: MONDAY }),
      set({ exercise: 'squat', at: MONDAY + 60_000 }),
    ];
    expect(sessionStats('pushup', history)).toHaveLength(1);
    expect(sessionStats('squat', history)[0].reps).toBe(12);
  });

  it('returns sessions oldest first', () => {
    const history = [set({ at: MONDAY }), set({ at: MONDAY - 3 * DAY })];
    const stats = sessionStats('pushup', history);
    expect(stats[0].startedAt).toBeLessThan(stats[1].startedAt);
  });
});

describe('isDirty', () => {
  it('agrees with the threshold the session loop progresses on', () => {
    // A bar the chart calls clean must be one the target actually rose for,
    // or the chart tells a different story from the app.
    const clean = summarizeSession(groupIntoSessions([set({ repCount: 12, flaggedReps: 3 })])[0]);
    const dirty = summarizeSession(groupIntoSessions([set({ repCount: 12, flaggedReps: 4 })])[0]);

    expect(3 / 12).toBeLessThanOrEqual(DIRTY_SESSION_SHARE);
    expect(isDirty(clean)).toBe(false);
    expect(isDirty(dirty)).toBe(true);
  });
});

describe('latestQuality', () => {
  it('reads the most recent session, not the best one', () => {
    const history = [
      set({ at: MONDAY - 3 * DAY, repCount: 10, flaggedReps: 0 }),
      set({ at: MONDAY, repCount: 10, flaggedReps: 5 }),
    ];
    expect(latestQuality(history)).toBe(50);
  });

  it('is null before anything is recorded', () => {
    expect(latestQuality([])).toBeNull();
  });
});

describe('errorLabel', () => {
  it('has a human label for every cue the fast loop can speak', () => {
    // An unlabelled code would surface a raw identifier like "hip_sag" on the
    // summary screen.
    for (const key of Object.keys(CUE_TEXT)) {
      const code = key.split(':')[1];
      expect(errorLabel(code), code).not.toBe(code);
    }
  });
});

describe('formatDuration', () => {
  it('never reports a real session as zero minutes', () => {
    expect(formatDuration(20_000)).toBe('1 menit');
    expect(formatDuration(18 * 60_000)).toBe('18 menit');
  });
});
