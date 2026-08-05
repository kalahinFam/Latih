import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrainingHistory, toSetRecord } from './history.ts';
import { summarizeSet, type RepRecord } from '../core/setSummary.ts';

/** Minimal in-memory `localStorage`, so these tests need no DOM. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

function rep(index: number, errors: string[] = []): RepRecord {
  return {
    index,
    minAngle: 90,
    maxAngle: 175,
    eccentricMs: 800,
    concentricMs: 700,
    errors: errors as RepRecord['errors'],
  };
}

describe('toSetRecord', () => {
  it('counts a rep once no matter how many rules it broke', () => {
    const summary = summarizeSet('pushup', [rep(1, ['shallow_depth', 'hip_sag']), rep(2)], {
      durationMs: 20_000,
      trackingQuality: 0.9,
    });

    // Two errors on one rep is one flagged rep. Summing error counts instead
    // would let a single bad rep push flagged share above 100%.
    expect(toSetRecord(summary).flaggedReps).toBe(1);
  });

  it('carries the fields adaptation actually reads', () => {
    const summary = summarizeSet('squat', [rep(1), rep(2), rep(3)], {
      durationMs: 30_000,
      trackingQuality: 0.85,
    });

    const record = toSetRecord(summary, 1_700_000_000_000);
    expect(record).toEqual({
      exercise: 'squat',
      at: 1_700_000_000_000,
      repCount: 3,
      flaggedReps: 0,
      meanDepthDeg: 90,
      trackingQuality: 0.85,
      // Carried for the summary and history screens. Adaptation never reads
      // either — `flaggedReps` is what gates progression.
      durationMs: 30_000,
      errorCounts: {},
    });
  });
});

describe('TrainingHistory', () => {
  beforeEach(() => {
    installStorage();
  });

  it('starts at the baseline target with no history', () => {
    const target = new TrainingHistory().currentTarget('pushup');
    expect(target.targetReps).toBe(8);
    expect(target.reason).toBe('baseline');
  });

  it('persists across instances', () => {
    const first = new TrainingHistory();
    first.recordSet({
      exercise: 'pushup',
      at: Date.now(),
      repCount: 12,
      flaggedReps: 0,
      meanDepthDeg: 88,
      trackingQuality: 0.95,
    });

    // A separate instance reads the same store — the state lives on the device,
    // not in the object.
    expect(new TrainingHistory().all()).toHaveLength(1);
  });

  it('caps retained sets without disturbing the most recent ones', () => {
    const history = new TrainingHistory();
    for (let i = 0; i < 505; i += 1) {
      history.recordSet({
        exercise: 'squat',
        at: i * 1000,
        repCount: i,
        flaggedReps: 0,
        meanDepthDeg: 95,
        trackingQuality: 0.9,
      });
    }

    const all = history.all();
    expect(all).toHaveLength(500);
    expect(all[all.length - 1].repCount).toBe(504);
  });

  it('recovers from a corrupted store instead of throwing', () => {
    const store = installStorage();
    store.set('latih.history.v1', '{not json');

    // Losing history costs one baseline target. Throwing here would break the
    // app on every load with nothing the user could do about it.
    expect(new TrainingHistory().all()).toEqual([]);
    expect(new TrainingHistory().currentTarget('squat').targetReps).toBe(10);
  });

  it('ignores a store written by a future version', () => {
    const store = installStorage();
    store.set('latih.history.v1', JSON.stringify({ version: 2, sets: [{ nonsense: true }] }));

    expect(new TrainingHistory().all()).toEqual([]);
  });

  it('still returns a target when writing fails', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    });

    // Private browsing. The session loop degrades to baseline; nothing else
    // in the product should notice.
    const target = new TrainingHistory().recordSet({
      exercise: 'pushup',
      at: Date.now(),
      repCount: 10,
      flaggedReps: 0,
      meanDepthDeg: 90,
      trackingQuality: 0.95,
    });

    expect(target.targetReps).toBeGreaterThan(0);
  });

  it('reports no trend before any set exists', () => {
    expect(new TrainingHistory().trend('pushup')).toBeNull();
  });

  it('raises the target only after two clean sessions', () => {
    const history = new TrainingHistory();
    const day = 24 * 60 * 60 * 1000;
    const clean = (at: number) => ({
      exercise: 'pushup' as const,
      at,
      repCount: 8,
      flaggedReps: 0,
      meanDepthDeg: 88,
      trackingQuality: 0.95,
    });

    expect(history.recordSet(clean(day)).reason).toBe('held-for-consistency');
    expect(history.recordSet(clean(2 * day)).targetReps).toBe(9);
  });
});
