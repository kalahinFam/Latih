import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE, formatRoute, parseHash } from './router.ts';
import { WorkoutSession } from './workoutSession.ts';
import { summarizeSet, type RepRecord } from '../core/setSummary.ts';

describe('parseHash', () => {
  it('reads a bare screen name', () => {
    expect(parseHash('#/latihan')).toEqual({ name: 'latihan', params: {} });
    expect(parseHash('#latihan')).toEqual({ name: 'latihan', params: {} });
  });

  it('reads query parameters', () => {
    expect(parseHash('#/latihan?gerakan=pushup&set=2')).toEqual({
      name: 'latihan',
      params: { gerakan: 'pushup', set: '2' },
    });
  });

  it('decodes escaped values', () => {
    expect(parseHash('#/gizi?slot=makan%20siang').params.slot).toBe('makan siang');
  });

  it('falls back to the home screen rather than throwing', () => {
    // A stale bookmark or a hand-edited hash should land somewhere usable,
    // not on a blank screen.
    expect(parseHash('').name).toBe(DEFAULT_ROUTE);
    expect(parseHash('#').name).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/').name).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/?a=1').name).toBe(DEFAULT_ROUTE);
  });

  it('survives a malformed query', () => {
    expect(parseHash('#/latihan?&=&x').params).toEqual({ x: '' });
  });
});

describe('formatRoute', () => {
  it('round-trips through parseHash', () => {
    const hash = formatRoute('latihan', { gerakan: 'squat' });
    expect(hash).toBe('#/latihan?gerakan=squat');
    expect(parseHash(hash)).toEqual({ name: 'latihan', params: { gerakan: 'squat' } });
  });

  it('omits an empty query', () => {
    expect(formatRoute('beranda')).toBe('#/beranda');
  });
});

function rep(index: number, errors: string[] = []): RepRecord {
  return {
    index,
    minAngle: 92,
    maxAngle: 172,
    eccentricMs: 800,
    concentricMs: 700,
    errors: errors as RepRecord['errors'],
  };
}

function summary(reps: RepRecord[]) {
  return summarizeSet('pushup', reps, { durationMs: 45_000, trackingQuality: 0.93 });
}

describe('WorkoutSession', () => {
  const plan = { exercise: 'pushup' as const, setsPlanned: 3, targetReps: 12 };

  it('starts on set one', () => {
    const session = new WorkoutSession(plan);
    expect(session.currentSet).toBe(1);
    expect(session.setsDone).toBe(0);
    expect(session.isComplete).toBe(false);
  });

  it('advances as sets are recorded', () => {
    const session = new WorkoutSession(plan);
    session.record(summary([rep(1), rep(2)]));
    expect(session.currentSet).toBe(2);
    expect(session.setsDone).toBe(1);
  });

  it('does not count past the plan', () => {
    // "SET 4/3" would be nonsense on screen.
    const session = new WorkoutSession(plan);
    for (let i = 0; i < 4; i += 1) session.record(summary([rep(1)]));
    expect(session.currentSet).toBe(3);
    expect(session.isComplete).toBe(true);
  });

  it('adds up reps and flagged reps across sets', () => {
    const session = new WorkoutSession(plan);
    session.record(summary([rep(1, ['hip_sag']), rep(2)]));
    session.record(summary([rep(1), rep(2), rep(3, ['shallow_depth', 'hip_sag'])]));

    expect(session.totalReps).toBe(5);
    // Two errors on one rep is still one flagged rep.
    expect(session.flaggedReps).toBe(2);
  });

  it('adds up error codes across sets', () => {
    const session = new WorkoutSession(plan);
    session.record(summary([rep(1, ['hip_sag']), rep(2, ['hip_sag'])]));
    session.record(summary([rep(1, ['shallow_depth'])]));

    expect(session.errorCounts).toEqual({ hip_sag: 2, shallow_depth: 1 });
  });

  it('hands out a copy of its sets', () => {
    // The summary screen reads this while the session may still be running.
    const session = new WorkoutSession(plan);
    session.record(summary([rep(1)]));

    const taken = session.sets as ReturnType<typeof summary>[];
    taken.push(summary([rep(2)]));
    expect(session.setsDone).toBe(1);
  });
});
