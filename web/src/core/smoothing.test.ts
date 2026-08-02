import { describe, expect, it } from 'vitest';
import { MedianFilter, median } from './smoothing.ts';
import { RepCounter } from './repCounter.ts';

describe('median', () => {
  it('returns the middle value of an odd list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns null for an empty list', () => {
    expect(median([])).toBeNull();
  });

  it('is unmoved by an extreme outlier', () => {
    // The property the whole module exists for.
    expect(median([100, 101, 102, 103, 9999])).toBe(102);
  });
});

describe('MedianFilter', () => {
  it('rejects an odd-length window requirement violation', () => {
    // An even window has no single middle, and averaging the two middles
    // reintroduces the outlier sensitivity we are here to remove.
    expect(() => new MedianFilter(4)).toThrow(/odd/i);
  });

  it('passes a steady signal through unchanged', () => {
    const f = new MedianFilter(5);
    for (let i = 0; i < 10; i++) expect(f.push(120)).toBe(120);
  });

  it('suppresses a single-frame spike', () => {
    const f = new MedianFilter(5);
    [150, 150, 150, 150].forEach((v) => f.push(v));
    // One catastrophically wrong frame — the exact MediaPipe failure mode.
    expect(f.push(20)).toBe(150);
  });

  it('suppresses two consecutive bad frames in a five-wide window', () => {
    const f = new MedianFilter(5);
    [150, 150, 150].forEach((v) => f.push(v));
    f.push(20);
    expect(f.push(25)).toBe(150);
  });

  it('still follows a real, sustained movement', () => {
    // Smoothing must not become blindness: a genuine descent has to arrive.
    const f = new MedianFilter(5);
    let last = 0;
    for (const angle of [170, 160, 150, 140, 130, 120, 110, 100, 90, 80]) {
      last = f.push(angle)!;
    }
    expect(last).toBeLessThan(110);
  });

  it('produces output before the window has filled', () => {
    // Waiting for a full window would blind the counter at the start of a set.
    const f = new MedianFilter(5);
    expect(f.push(170)).toBe(170);
  });

  it('passes null through and forgets stale samples', () => {
    // The counter must see the gap so it can hold; samples from before a
    // dropout do not describe what happens after it.
    const f = new MedianFilter(5);
    [150, 150, 150, 150, 150].forEach((v) => f.push(v));
    expect(f.push(null)).toBeNull();
    expect(f.push(90)).toBe(90);
  });
});

describe('smoothing protects rep counting', () => {
  /** Drive a counter with a sequence, optionally through the filter. */
  function count(sequence: number[], smooth: boolean): number {
    const counter = new RepCounter('pushup');
    const filter = new MedianFilter(5);
    let reps = 0;
    sequence.forEach((angle, i) => {
      const value = smooth ? filter.push(angle) : angle;
      if (counter.update(value, i * 33)) reps++;
    });
    return reps;
  }

  it('recovers reps that intermittent bad fits would otherwise lose', () => {
    // The reported symptom: reps counted only ~90% of the time. A bad fit
    // every third frame keeps pushing the angle back over the gate, the dwell
    // candidate resets on each crossing, and a real repetition never commits.
    const flickering: number[] = [...Array(12).fill(168)];
    for (let i = 0; i < 18; i++) flickering.push(i % 3 === 2 ? 150 : 80);
    flickering.push(...Array(12).fill(168));

    expect(count(flickering, false)).toBe(0); // unsmoothed: rep is lost
    expect(count(flickering, true)).toBe(1); // smoothed: rep is recovered
  });

  it('cannot rescue a perfect 50/50 oscillation, and should not pretend to', () => {
    // A median removes minority impulses; a square wave puts 3 of one value
    // and 2 of the other in every window, so the output alternates too.
    // Recorded deliberately: a signal this degraded means the camera setup is
    // wrong, and the honest response is the framing warning, not a filter that
    // silently invents a plausible rep.
    const square: number[] = [...Array(12).fill(168)];
    for (let i = 0; i < 16; i++) square.push(i % 2 === 0 ? 80 : 150);
    square.push(...Array(12).fill(168));

    expect(count(square, true)).toBe(0);
  });

  it('does not invent reps from an isolated bad frame', () => {
    // Smoothing must not be the only thing standing between noise and a
    // phantom rep — and it is not: the counter's dwell already rejects this,
    // smoothed or otherwise. Asserted both ways so a future change to either
    // mechanism cannot quietly remove the protection.
    const glitchy: number[] = [];
    for (let i = 0; i < 60; i++) glitchy.push(i === 20 || i === 40 ? 30 : 168);

    expect(count(glitchy, false)).toBe(0);
    expect(count(glitchy, true)).toBe(0);
  });

  it('still counts genuine reps after smoothing', () => {
    const clean: number[] = [];
    for (let r = 0; r < 3; r++) {
      clean.push(...Array(12).fill(168), ...Array(12).fill(80));
    }
    clean.push(...Array(12).fill(168));

    expect(count(clean, true)).toBe(3);
  });
});
