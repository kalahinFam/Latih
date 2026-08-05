import { describe, expect, it } from 'vitest';
import { assertNoRawPoseData, summarizeSet, toRepRecord, type RepRecord } from './setSummary.ts';
import type { RepEvent } from './repCounter.ts';

function rep(index: number, overrides: Partial<RepRecord> = {}): RepRecord {
  return {
    index,
    minAngle: 85,
    maxAngle: 170,
    eccentricMs: 900,
    concentricMs: 700,
    errors: [],
    ...overrides,
  };
}

const OPTIONS = { durationMs: 30_000, trackingQuality: 0.97 };

describe('toRepRecord', () => {
  it('carries the rule findings as codes', () => {
    const event: RepEvent = {
      counted: true,
      index: 3,
      startMs: 0,
      bottomMs: 800,
      endMs: 1500,
      minAngle: 118.44,
      maxAngle: 168.91,
      eccentricMs: 800,
      concentricMs: 700,
    };
    const record = toRepRecord(event, [
      { code: 'shallow_depth', cue: 'Turun lebih dalam', value: 118, threshold: 110, severity: 0.3 },
    ]);

    expect(record.errors).toEqual(['shallow_depth']);
    expect(record.minAngle).toBe(118.4);
    expect(record.index).toBe(3);
  });

  it('survives a non-finite angle from an abandoned rep', () => {
    const event: RepEvent = {
      counted: true,
      index: 1,
      startMs: 0,
      bottomMs: 0,
      endMs: 0,
      minAngle: Number.NaN,
      maxAngle: Number.NaN,
      eccentricMs: 0,
      concentricMs: 0,
    };
    // NaN would serialise to null and break the coach's JSON schema.
    expect(toRepRecord(event, [])).toMatchObject({ minAngle: 0, maxAngle: 0 });
  });
});

describe('summarizeSet', () => {
  it('counts reps and totals each error', () => {
    const summary = summarizeSet(
      'pushup',
      [
        rep(1, { errors: ['shallow_depth'] }),
        rep(2, { errors: ['shallow_depth', 'hip_sag'] }),
        rep(3),
      ],
      OPTIONS,
    );

    expect(summary.repCount).toBe(3);
    expect(summary.errorCounts.shallow_depth).toBe(2);
    expect(summary.errorCounts.hip_sag).toBe(1);
    expect(summary.errorCounts.hip_pike).toBeUndefined();
  });

  it('treats the smallest angle as the deepest rep', () => {
    const summary = summarizeSet(
      'squat',
      [rep(1, { minAngle: 70 }), rep(2, { minAngle: 120 })],
      OPTIONS,
    );
    expect(summary.depth.bestDeg).toBe(70);
    expect(summary.depth.worstDeg).toBe(120);
  });

  it('reports near-zero spread when every rep matches', () => {
    const summary = summarizeSet('squat', [rep(1), rep(2), rep(3)], OPTIONS);
    expect(summary.depth.consistencyDeg).toBe(0);
  });

  it('reports a large spread when depth is inconsistent', () => {
    const summary = summarizeSet(
      'squat',
      [rep(1, { minAngle: 70 }), rep(2, { minAngle: 130 })],
      OPTIONS,
    );
    expect(summary.depth.consistencyDeg).toBeGreaterThan(20);
  });

  it('detects a descent that slows across the set', () => {
    const summary = summarizeSet(
      'pushup',
      [
        rep(1, { eccentricMs: 700 }),
        rep(2, { eccentricMs: 750 }),
        rep(3, { eccentricMs: 1200 }),
        rep(4, { eccentricMs: 1300 }),
      ],
      OPTIONS,
    );
    expect(summary.tempo.tempoDriftMs).toBeGreaterThan(400);
  });

  it('reports no drift for a set too short to judge', () => {
    const summary = summarizeSet('pushup', [rep(1), rep(2)], OPTIONS);
    expect(summary.tempo.tempoDriftMs).toBe(0);
  });

  it('handles an empty set without dividing by zero', () => {
    const summary = summarizeSet('pushup', [], OPTIONS);
    expect(summary.repCount).toBe(0);
    expect(summary.depth.meanDeg).toBe(0);
    expect(Number.isNaN(summary.tempo.meanEccentricMs)).toBe(false);
  });
});

describe('privacy contract', () => {
  it('carries no landmark, image or frame data', () => {
    const summary = summarizeSet(
      'pushup',
      [rep(1, { errors: ['hip_sag'] }), rep(2)],
      OPTIONS,
    );
    expect(() => assertNoRawPoseData(summary)).not.toThrow();
  });

  it('serialises to a payload small enough to feel instant between sets', () => {
    const reps = Array.from({ length: 20 }, (_, i) => rep(i + 1, { errors: ['shallow_depth'] }));
    const bytes = JSON.stringify(summarizeSet('pushup', reps, OPTIONS)).length;
    // A 20-rep set is a long one; if this ever approaches the size of an image
    // then something image-shaped has been added to the payload.
    expect(bytes).toBeLessThan(4000);
  });

  it('rejects a payload that smuggles in pose data', () => {
    const summary = summarizeSet('pushup', [rep(1)], OPTIONS);
    const tampered = { ...summary, landmarks: [[0.1, 0.2]] } as never;
    expect(() => assertNoRawPoseData(tampered)).toThrow(/landmark/i);
  });
});
