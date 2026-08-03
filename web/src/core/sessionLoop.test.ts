import { describe, expect, it } from 'vitest';
import {
  explainTarget,
  groupIntoSessions,
  nextTarget,
  progressTrend,
  type SetRecord,
} from './sessionLoop.ts';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 7, 1, 8, 0, 0);

function set(overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    exercise: 'pushup',
    at: BASE,
    repCount: 10,
    flaggedReps: 0,
    meanDepthDeg: 85,
    trackingQuality: 0.95,
    ...overrides,
  };
}

/** `days` sessions, one per day, each a single set. */
function daily(count: number, perDay: (day: number) => Partial<SetRecord>): SetRecord[] {
  return Array.from({ length: count }, (_, day) => set({ at: BASE + day * DAY, ...perDay(day) }));
}

describe('groupIntoSessions', () => {
  it('groups sets performed close together', () => {
    const history = [
      set({ at: BASE }),
      set({ at: BASE + 5 * 60 * 1000 }),
      set({ at: BASE + 12 * 60 * 1000 }),
    ];
    expect(groupIntoSessions(history)).toHaveLength(1);
  });

  it('splits sets separated by a long gap', () => {
    const history = [set({ at: BASE }), set({ at: BASE + 3 * 60 * 60 * 1000 })];
    expect(groupIntoSessions(history)).toHaveLength(2);
  });

  it('orders sets even when history arrives out of order', () => {
    const sessions = groupIntoSessions([set({ at: BASE + DAY }), set({ at: BASE })]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].startedAt).toBe(BASE);
  });

  it('handles empty history', () => {
    expect(groupIntoSessions([])).toEqual([]);
  });
});

describe('nextTarget — starting out', () => {
  it('gives a modest baseline with no history', () => {
    const target = nextTarget('pushup', []);
    expect(target.reason).toBe('baseline');
    expect(target.targetReps).toBeGreaterThan(0);
  });

  it('adopts what the user actually managed rather than inventing a number', () => {
    const target = nextTarget('pushup', [set({ repCount: 15 })]);
    expect(target.targetReps).toBeGreaterThanOrEqual(15);
  });

  it('ignores history from a different exercise', () => {
    const target = nextTarget('squat', [set({ exercise: 'pushup', repCount: 40 })]);
    expect(target.reason).toBe('baseline');
    expect(target.targetReps).toBeLessThan(40);
  });
});

describe('nextTarget — progression', () => {
  it('raises the target after two clean sessions at target', () => {
    const history = daily(2, () => ({ repCount: 10, flaggedReps: 0 }));
    const target = nextTarget('pushup', history, 10);
    expect(target.reason).toBe('progressed');
    expect(target.targetReps).toBe(11);
  });

  it('waits for a second session before raising', () => {
    // One good day is noise. Raising immediately ratchets faster than anyone
    // adapts, then produces a run of failures.
    const target = nextTarget('pushup', daily(1, () => ({ repCount: 10 })), 10);
    expect(target.reason).toBe('held-for-consistency');
    expect(target.targetReps).toBe(10);
  });

  it('raises by one rep at a time', () => {
    const history = daily(2, () => ({ repCount: 25, flaggedReps: 0 }));
    expect(nextTarget('pushup', history, 10).targetReps).toBe(11);
  });
});

describe('nextTarget — quality gates the increase', () => {
  it('holds the target when reps were hit but form slipped', () => {
    // The failure this rule exists to prevent: rewarding more reps bought by
    // cutting depth, which is exactly what the fast loop is there to catch.
    const history = daily(2, () => ({ repCount: 12, flaggedReps: 6 }));
    const target = nextTarget('pushup', history, 10);
    expect(target.reason).toBe('held-for-form');
    expect(target.targetReps).toBe(10);
  });

  it('progresses when a few reps are flagged but most are clean', () => {
    const history = daily(2, () => ({ repCount: 12, flaggedReps: 2 }));
    expect(nextTarget('pushup', history, 10).reason).toBe('progressed');
  });

  it('does not progress on one clean and one sloppy session', () => {
    const history = [
      set({ at: BASE, repCount: 12, flaggedReps: 0 }),
      set({ at: BASE + DAY, repCount: 12, flaggedReps: 8 }),
    ];
    expect(nextTarget('pushup', history, 10).reason).toBe('held-for-form');
  });
});

describe('nextTarget — falling short', () => {
  it('holds the target on a near miss', () => {
    const target = nextTarget('pushup', daily(2, () => ({ repCount: 9 })), 10);
    expect(target.reason).toBe('held-for-consistency');
    expect(target.targetReps).toBe(10);
  });

  it('reduces the target when the user is far short', () => {
    // Leaving an unreachable target in place just produces repeated failure.
    const target = nextTarget('pushup', daily(2, () => ({ repCount: 4 })), 12);
    expect(target.reason).toBe('reduced');
    expect(target.targetReps).toBe(4);
  });

  it('never reduces below one rep', () => {
    const target = nextTarget('pushup', daily(1, () => ({ repCount: 0 })), 10);
    expect(target.targetReps).toBeGreaterThanOrEqual(1);
  });
});

describe('nextTarget — untrustworthy sessions', () => {
  it('ignores a session the camera barely read', () => {
    // A badly framed session says something about the camera, not the lifter,
    // and must not drag the target down.
    const history = daily(2, () => ({ repCount: 2, trackingQuality: 0.3 }));
    const target = nextTarget('pushup', history, 10);
    expect(target.targetReps).toBe(10);
    expect(target.reason).toBe('baseline');
  });

  it('does not let a poorly tracked session block progression', () => {
    const history = [
      set({ at: BASE, repCount: 10, flaggedReps: 0 }),
      set({ at: BASE + DAY, repCount: 1, trackingQuality: 0.2 }),
      set({ at: BASE + 2 * DAY, repCount: 10, flaggedReps: 0 }),
    ];
    expect(nextTarget('pushup', history, 10).reason).toBe('progressed');
  });
});

describe('nextTarget — judged on the best set of a session', () => {
  it('uses the best set, not the last', () => {
    // Later sets in a session are lower through fatigue; judging on the last
    // would read every normal workout as a regression.
    const history = [
      set({ at: BASE, repCount: 12, flaggedReps: 0 }),
      set({ at: BASE + 3 * 60 * 1000, repCount: 8, flaggedReps: 0 }),
      set({ at: BASE + 6 * 60 * 1000, repCount: 6, flaggedReps: 0 }),
      set({ at: BASE + DAY, repCount: 12, flaggedReps: 0 }),
      set({ at: BASE + DAY + 3 * 60 * 1000, repCount: 7, flaggedReps: 0 }),
    ];
    expect(nextTarget('pushup', history, 12).reason).toBe('progressed');
  });
});

describe('progressTrend', () => {
  it('returns null with no history', () => {
    expect(progressTrend('pushup', [])).toBeNull();
  });

  it('reports improvement between sessions', () => {
    const history = [
      set({ at: BASE, repCount: 8, meanDepthDeg: 95 }),
      set({ at: BASE + DAY, repCount: 11, meanDepthDeg: 88 }),
    ];
    const trend = progressTrend('pushup', history)!;
    expect(trend.repsDelta).toBe(3);
    // Negative depth delta means deeper, since a smaller angle is deeper.
    expect(trend.depthDeltaDeg).toBeCloseTo(-7, 1);
  });

  it('reports no delta for a first session', () => {
    const trend = progressTrend('pushup', [set({ repCount: 9 })])!;
    expect(trend.sessions).toBe(1);
    expect(trend.repsDelta).toBe(0);
  });

  it('reports the flagged share across the latest session', () => {
    const history = [
      set({ at: BASE, repCount: 10, flaggedReps: 2 }),
      set({ at: BASE + 4 * 60 * 1000, repCount: 10, flaggedReps: 3 }),
    ];
    expect(progressTrend('pushup', history)!.latestFlaggedShare).toBeCloseTo(0.25, 2);
  });
});

describe('explainTarget', () => {
  it('gives a non-empty Indonesian reason for every outcome', () => {
    const reasons = [
      'baseline',
      'progressed',
      'held-for-form',
      'held-for-consistency',
      'reduced',
    ] as const;
    for (const reason of reasons) {
      const text = explainTarget({ exercise: 'pushup', targetReps: 10, reason, basedOnSessions: 1 });
      expect(text.length, reason).toBeGreaterThan(0);
    }
  });
});
