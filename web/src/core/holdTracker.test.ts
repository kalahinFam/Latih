import { describe, expect, it } from 'vitest';

import { DEFAULT_HOLD_CONFIGS, HoldTracker, type HoldFault } from './holdTracker.ts';

const FRAME_MS = 33;

/** Drive frames at 30 fps, returning every fault the tracker announced. */
function run(
  tracker: HoldTracker,
  frames: (number | null)[],
  options: { inPosition?: boolean[]; startAt?: number } = {},
): HoldFault[] {
  const announced: HoldFault[] = [];
  tracker.start(options.startAt ?? 0);

  frames.forEach((angle, i) => {
    const t = (options.startAt ?? 0) + (i + 1) * FRAME_MS;
    const inPosition = options.inPosition?.[i] ?? true;
    const fault = tracker.update(angle, inPosition, t);
    if (fault) announced.push(fault);
  });

  return announced;
}

function frames(angle: number, count: number): number[] {
  return Array(count).fill(angle);
}

describe('HoldTracker — a clean hold', () => {
  it('credits every frame the line is straight', () => {
    const tracker = new HoldTracker();
    run(tracker, frames(180, 30));

    // 30 frames at 33 ms.
    expect(tracker.status.heldMs).toBe(30 * FRAME_MS);
    expect(tracker.status.running).toBe(true);
    expect(tracker.status.breaks).toBe(0);
  });

  it('reports no fault while inside the band', () => {
    const tracker = new HoldTracker();
    const { hipSagMin, hipPikeMax } = DEFAULT_HOLD_CONFIGS.plank;

    expect(run(tracker, [...frames(hipSagMin + 1, 20), ...frames(hipPikeMax - 1, 20)])).toEqual([]);
  });
});

describe('HoldTracker — breaks', () => {
  it('forgives a wobble the lifter fixes themselves', () => {
    // The hip line wanders continuously under fatigue; there is no frame at
    // which it "breaks". A dip corrected within the grace is part of holding a
    // plank, not a failure to hold one.
    const tracker = new HoldTracker();
    const faults = run(tracker, [...frames(180, 20), ...frames(140, 5), ...frames(180, 20)]);

    expect(faults).toEqual([]);
    expect(tracker.status.breaks).toBe(0);
    expect(tracker.status.running).toBe(true);
  });

  it('stops the clock once a sag is sustained', () => {
    const tracker = new HoldTracker();
    const faults = run(tracker, [...frames(180, 20), ...frames(140, 30)]);

    expect(faults).toEqual(['hip_sag']);
    expect(tracker.status.running).toBe(false);
    expect(tracker.status.fault).toBe('hip_sag');
  });

  it('announces a break once, not on every frame it continues', () => {
    // Announced every frame, the cue would fire thirty times a second.
    const tracker = new HoldTracker();
    expect(run(tracker, [...frames(180, 20), ...frames(140, 120)])).toEqual(['hip_sag']);
  });

  it('does not credit time spent broken', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 20), ...frames(140, 60)]);

    // Time in which the hips had collapsed is not plank time. Crediting it
    // would make a sagging thirty seconds indistinguishable from a held one.
    const grace = DEFAULT_HOLD_CONFIGS.plank.breakGraceMs;
    expect(tracker.status.heldMs).toBeLessThan(20 * FRAME_MS + grace + FRAME_MS * 2);
    expect(tracker.status.brokenMs).toBeGreaterThan(0);
  });

  it('resumes once the line is straight again', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 20), ...frames(140, 30), ...frames(180, 30)]);

    expect(tracker.status.running).toBe(true);
    expect(tracker.status.fault).toBeNull();
    expect(tracker.status.breaks).toBe(1);
  });

  it('distinguishes a sag from a pike', () => {
    const sag = new HoldTracker();
    expect(run(sag, [...frames(180, 20), ...frames(140, 30)])).toEqual(['hip_sag']);

    const pike = new HoldTracker();
    expect(run(pike, [...frames(180, 20), ...frames(225, 30)])).toEqual(['hip_pike']);
  });

  it('counts each break separately', () => {
    const tracker = new HoldTracker();
    run(tracker, [
      ...frames(180, 20),
      ...frames(140, 30),
      ...frames(180, 30),
      ...frames(225, 30),
      ...frames(180, 30),
    ]);

    expect(tracker.status.breaks).toBe(2);
    expect(tracker.summary().faultCounts).toEqual({ hip_sag: 1, hip_pike: 1 });
  });
});

describe('HoldTracker — when it cannot see', () => {
  it('credits nothing while the hip line is unreadable', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 20), ...Array(30).fill(null)]);

    expect(tracker.status.heldMs).toBe(20 * FRAME_MS);
    expect(tracker.status.running).toBe(false);
  });

  it('reports no fault for an unreadable frame', () => {
    // Unreadable is not the same as wrong. Telling someone their hips have
    // dropped when the camera simply lost them is a correction they cannot act
    // on.
    const tracker = new HoldTracker();
    expect(run(tracker, [...frames(180, 20), ...Array(30).fill(null)])).toEqual([]);
  });

  it('stops when the person leaves the plank position entirely', () => {
    const tracker = new HoldTracker();
    const inPosition = [...Array(20).fill(true), ...Array(30).fill(false)];
    run(tracker, [...frames(180, 20), ...frames(180, 30)], { inPosition });

    expect(tracker.status.heldMs).toBe(20 * FRAME_MS);
    expect(tracker.status.running).toBe(false);
  });

  it('does not credit a gap in the timestamps', () => {
    // Backgrounding the tab, or the tracker losing the person for seconds.
    const tracker = new HoldTracker();
    tracker.start(0);
    tracker.update(180, true, 33);
    tracker.update(180, true, 60_000);

    expect(tracker.status.heldMs).toBe(33);
  });
});

describe('HoldTracker — summary', () => {
  it('reports held, broken, and how often it broke', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 30), ...frames(140, 40), ...frames(180, 30)]);

    const summary = tracker.summary();
    expect(summary.heldMs).toBeGreaterThan(0);
    expect(summary.brokenMs).toBeGreaterThan(0);
    expect(summary.breaks).toBe(1);
    expect(summary.faultCounts.hip_sag).toBe(1);
  });

  it('reports the share of frames the line was readable', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 30), ...Array(10).fill(null)]);

    expect(tracker.summary().trackingQuality).toBeCloseTo(30 / 40, 2);
  });

  it('starts clean after a reset', () => {
    const tracker = new HoldTracker();
    run(tracker, [...frames(180, 20), ...frames(140, 30)]);
    tracker.reset();

    expect(tracker.status).toEqual({
      heldMs: 0,
      running: false,
      fault: null,
      brokenMs: 0,
      breaks: 0,
    });
    expect(tracker.summary().faultCounts).toEqual({});
  });
});

describe('HoldTracker — signed hip direction', () => {
  it('labels positive deviation as sag and negative deviation as pike', () => {
    const sag = new HoldTracker();
    sag.start(0);
    expect(sag.updateDeviation(20, true, 33)).toBeNull();
    expect(sag.updateDeviation(20, true, 400)).toBe('hip_sag');

    const pike = new HoldTracker();
    pike.start(0);
    expect(pike.updateDeviation(-20, true, 33)).toBeNull();
    expect(pike.updateDeviation(-20, true, 400)).toBe('hip_pike');
  });
});
