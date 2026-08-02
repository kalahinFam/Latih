import { describe, expect, it } from 'vitest';
import { LiveDepthCue } from './liveCue.ts';
import { RepCounter } from './repCounter.ts';
import { DEFAULT_THRESHOLDS } from './rules.ts';
import type { ExerciseKind } from './types.ts';

/**
 * Drive a cue through a rep and report the frame index it fired on, or -1.
 * `inDescent` is derived from a real RepCounter so the test exercises the same
 * coupling the app has.
 */
function runRep(exercise: ExerciseKind, angles: number[]): { firedAt: number; repAt: number } {
  const counter = new RepCounter(exercise);
  const cue = new LiveDepthCue(exercise);
  let firedAt = -1;
  let repAt = -1;

  angles.forEach((angle, i) => {
    const phaseBefore = counter.status.phase;
    const rep = counter.update(angle, i * 33);
    if (cue.update(angle, phaseBefore === 'down') && firedAt < 0) firedAt = i;
    if (rep && repAt < 0) repAt = i;
  });

  return { firedAt, repAt };
}

function ramp(from: number, to: number, frames: number): number[] {
  return Array.from({ length: frames }, (_, i) => from + ((to - from) * i) / (frames - 1));
}

/** Top, descend, bottom out at `bottom`, come back up, hold at the top. */
function rep(top: number, bottom: number): number[] {
  return [
    ...Array(12).fill(top),
    ...ramp(top, bottom, 10),
    ...Array(3).fill(bottom),
    ...ramp(bottom, top, 10),
    ...Array(12).fill(top),
  ];
}

describe('LiveDepthCue — push-up', () => {
  it('fires on a shallow rep', () => {
    // Counter gate is 135, depth threshold 105, grace 8 -> 120 is clearly short.
    const { firedAt } = runRep('pushup', rep(168, 125));
    expect(firedAt).toBeGreaterThan(0);
  });

  it('stays silent on a rep that reaches depth', () => {
    const { firedAt } = runRep('pushup', rep(168, 80));
    expect(firedAt).toBe(-1);
  });

  it('fires before the rep is counted, not after', () => {
    // The entire point. Previously the correction arrived with the RepEvent,
    // which only exists once the lifter is back at lockout — aimed at a
    // repetition that was already finished.
    const { firedAt, repAt } = runRep('pushup', rep(168, 125));
    expect(firedAt).toBeGreaterThan(0);
    expect(repAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThan(repAt);
  });

  it('fires close to the reversal rather than at lockout', () => {
    const angles = rep(168, 125);
    const { firedAt, repAt } = runRep('pushup', angles);
    // The bottom sits around frame 22; lockout lands around frame 35.
    // Reacting within a few frames of the turn is what makes it actionable.
    expect(firedAt).toBeLessThan(repAt - 5);
  });

  it('forgives a rep that only just misses depth', () => {
    // 110 is 5 degrees past the 105 threshold, inside the 8-degree grace.
    // Nagging over that trains people to ignore the coach.
    const { firedAt } = runRep('pushup', rep(168, 110));
    expect(firedAt).toBe(-1);
  });

  it('fires at most once per repetition', () => {
    const counter = new RepCounter('pushup');
    const cue = new LiveDepthCue('pushup');
    let fires = 0;
    rep(168, 125).forEach((angle, i) => {
      const phase = counter.status.phase;
      counter.update(angle, i * 33);
      if (cue.update(angle, phase === 'down')) fires++;
    });
    expect(fires).toBe(1);
  });

  it('re-arms for the next repetition', () => {
    const counter = new RepCounter('pushup');
    const cue = new LiveDepthCue('pushup');
    let fires = 0;
    [...rep(168, 125), ...rep(168, 125)].forEach((angle, i) => {
      const phase = counter.status.phase;
      counter.update(angle, i * 33);
      if (cue.update(angle, phase === 'down')) fires++;
    });
    expect(fires).toBe(2);
  });
});

describe('LiveDepthCue — squat', () => {
  it('fires on a squat that stops above parallel', () => {
    // Gate 140, depth threshold 110, grace 8 -> 130 is short.
    const { firedAt } = runRep('squat', rep(175, 130));
    expect(firedAt).toBeGreaterThan(0);
  });

  it('stays silent on a squat that reaches depth', () => {
    const { firedAt } = runRep('squat', rep(175, 88));
    expect(firedAt).toBe(-1);
  });
});

describe('LiveDepthCue — robustness', () => {
  it('does not fire from tracker jitter at the bottom', () => {
    // Small oscillation while holding a *good* depth must not read as a
    // reversal from a shallow one.
    const angles = [...Array(12).fill(168), ...ramp(168, 80, 10)];
    for (let i = 0; i < 20; i++) angles.push(i % 2 === 0 ? 80 : 82);
    angles.push(...ramp(80, 168, 10), ...Array(12).fill(168));

    expect(runRep('pushup', angles).firedAt).toBe(-1);
  });

  it('survives a tracking gap near the bottom', () => {
    const angles = [
      ...Array(12).fill(168),
      ...ramp(168, 125, 10),
      ...Array(3).fill(null),
      ...ramp(125, 168, 10),
      ...Array(12).fill(168),
    ] as (number | null)[];

    const counter = new RepCounter('pushup');
    const cue = new LiveDepthCue('pushup');
    let fired = false;
    angles.forEach((angle, i) => {
      const phase = counter.status.phase;
      counter.update(angle, i * 33);
      if (cue.update(angle, phase === 'down')) fired = true;
    });
    // A brief dropout must not disarm the check for the whole repetition.
    expect(fired).toBe(true);
  });

  it('never fires while the lifter is at the top', () => {
    const counter = new RepCounter('pushup');
    const cue = new LiveDepthCue('pushup');
    let fires = 0;
    for (let i = 0; i < 60; i++) {
      const phase = counter.status.phase;
      counter.update(168, i * 33);
      if (cue.update(168, phase === 'down')) fires++;
    }
    expect(fires).toBe(0);
  });

  it('uses the exercise-specific depth threshold', () => {
    // 125 is short for a push-up (105) but past the squat threshold (110)
    // by more than the grace, so both should fire — but a 115 bottom is
    // forgiven for squat and flagged for push-up.
    expect(runRep('pushup', rep(168, 125)).firedAt).toBeGreaterThan(0);
    expect(runRep('squat', rep(175, 115)).firedAt).toBe(-1);
  });

  it('agrees with the rule threshold it is derived from', () => {
    // Both read DEFAULT_THRESHOLDS, so a threshold change moves them together
    // rather than leaving the live cue and the post-rep rule disagreeing.
    for (const exercise of ['pushup', 'squat'] as const) {
      const { depthMax } = DEFAULT_THRESHOLDS[exercise];
      const top = exercise === 'pushup' ? 168 : 175;
      expect(runRep(exercise, rep(top, depthMax + 30)).firedAt).toBeGreaterThan(0);
      expect(runRep(exercise, rep(top, depthMax - 20)).firedAt).toBe(-1);
    }
  });
});
