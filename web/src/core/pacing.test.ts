import { describe, expect, it } from 'vitest';
import {
  DEGRADE_ABOVE_MS,
  INITIAL_CADENCE,
  RECOVER_BELOW_MS,
  cadenceForPhase,
  chooseCadence,
  frameIntervalMs,
  type Cadence,
} from './pacing.ts';

describe('chooseCadence phases', () => {
  const healthy = 12;

  it('runs setup slowly, because framing is a slow signal', () => {
    expect(chooseCadence('setup', healthy).fps).toBe(15);
  });

  it('runs a hold slower still', () => {
    // 12 fps is an 83 ms gap, well inside the plank tracker's 300 ms grace.
    expect(chooseCadence('hold', healthy).fps).toBe(12);
  });

  it('runs counting at the rate the thresholds were tuned for', () => {
    expect(chooseCadence('counting', healthy).fps).toBe(30);
  });

  it('never lets counting fall below 20 fps, however bad the device', () => {
    // The latency floor. Five frames of median lag is already 250 ms here;
    // slower and the depth cue lands after the user has come back up.
    const wretched = chooseCadence('counting', 500, { fps: 20, degraded: true });
    expect(wretched.fps).toBe(20);
    expect(wretched.degraded).toBe(true);
  });
});

describe('chooseCadence hysteresis', () => {
  const fast: Cadence = { fps: 30, degraded: false };
  const slow: Cadence = { fps: 20, degraded: true };

  it('degrades once inference costs more than the upper bound', () => {
    const next = chooseCadence('counting', DEGRADE_ABOVE_MS + 1, fast);
    expect(next.degraded).toBe(true);
    expect(next.fps).toBe(20);
  });

  it('recovers only below the lower bound', () => {
    const next = chooseCadence('counting', RECOVER_BELOW_MS - 1, slow);
    expect(next.degraded).toBe(false);
    expect(next.fps).toBe(30);
  });

  it('holds whatever it already was inside the band', () => {
    // The property the whole two-threshold design exists for: a device sitting
    // between the bounds must not flip cadence every second, because a rep
    // counted across a flip is a rep sampled two different ways.
    const middle = (DEGRADE_ABOVE_MS + RECOVER_BELOW_MS) / 2;
    expect(chooseCadence('counting', middle, fast).degraded).toBe(false);
    expect(chooseCadence('counting', middle, slow).degraded).toBe(true);
  });

  it('does not recover on a value that merely stops being terrible', () => {
    // Just under the degrade bound is not recovery.
    expect(chooseCadence('counting', DEGRADE_ABOVE_MS - 1, slow).degraded).toBe(true);
  });

  it('keeps the previous verdict when nothing has been measured yet', () => {
    // An empty ring buffer reports 0 ms. Reading that as "fast" would hand a
    // hot phone the undegraded rate every time the monitor resets.
    expect(chooseCadence('counting', 0, slow).degraded).toBe(true);
    expect(chooseCadence('counting', 0, fast).degraded).toBe(false);
  });

  it('carries the degraded verdict across a phase change', () => {
    // Resting on a throttled phone must not convince the engine it recovered.
    const resting = chooseCadence('setup', 0, slow);
    expect(resting.degraded).toBe(true);
    expect(chooseCadence('counting', 0, resting).fps).toBe(20);
  });

  it('starts undegraded', () => {
    expect(INITIAL_CADENCE.degraded).toBe(false);
    expect(chooseCadence('counting', 0).fps).toBe(30);
  });
});

describe('cadenceForPhase', () => {
  it('re-rates for the new phase without re-judging the device', () => {
    const throttled: Cadence = { fps: 20, degraded: true };
    expect(cadenceForPhase('setup', throttled)).toEqual({ fps: 15, degraded: true });
    expect(cadenceForPhase('counting', throttled)).toEqual({ fps: 20, degraded: true });
  });

  it('agrees with chooseCadence when the verdict is unchanged', () => {
    // The two must not drift: one is called every frame, the other only on the
    // frames that ran the model, and a disagreement would show up as cadence
    // flapping between them.
    for (const phase of ['setup', 'counting', 'hold'] as const) {
      for (const previous of [
        { fps: 30, degraded: false },
        { fps: 20, degraded: true },
      ] satisfies Cadence[]) {
        expect(cadenceForPhase(phase, previous)).toEqual(chooseCadence(phase, 0, previous));
      }
    }
  });
});

describe('frameIntervalMs', () => {
  it('converts a cadence into the gap the loop must wait', () => {
    expect(frameIntervalMs({ fps: 30, degraded: false })).toBeCloseTo(33.33, 1);
    expect(frameIntervalMs({ fps: 12, degraded: false })).toBeCloseTo(83.33, 1);
  });
});
