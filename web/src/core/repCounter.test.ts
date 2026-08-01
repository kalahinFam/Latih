import { describe, expect, it } from 'vitest';
import { RepCounter, type RepEvent } from './repCounter.ts';

/**
 * Feed a sequence of angles at a fixed frame interval and collect the reps.
 * `null` entries stand for frames where the pose was not confidently visible.
 */
function run(
  counter: RepCounter,
  angles: (number | null)[],
  frameMs = 33,
  startMs = 0,
): RepEvent[] {
  const events: RepEvent[] = [];
  angles.forEach((angle, i) => {
    const event = counter.update(angle, startMs + i * frameMs);
    if (event) events.push(event);
  });
  return events;
}

/** Linear sweep between two angles, inclusive, over `frames` samples. */
function sweep(from: number, to: number, frames: number): number[] {
  if (frames <= 1) return [to];
  return Array.from({ length: frames }, (_, i) => from + ((to - from) * i) / (frames - 1));
}

/** One clean push-up: lock out, descend, hold at the bottom, press back up. */
function pushupRep(): number[] {
  return [
    ...Array(10).fill(170),
    ...sweep(170, 80, 15),
    ...Array(5).fill(80),
    ...sweep(80, 170, 15),
    ...Array(10).fill(170),
  ];
}

describe('RepCounter', () => {
  it('counts a single clean rep', () => {
    const counter = new RepCounter('pushup');
    const events = run(counter, pushupRep());
    expect(events).toHaveLength(1);
    expect(counter.status.repCount).toBe(1);
    expect(events[0].index).toBe(1);
  });

  it('counts consecutive reps and numbers them in order', () => {
    const counter = new RepCounter('pushup');
    const events = run(counter, [...pushupRep(), ...pushupRep(), ...pushupRep()]);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('does not count a movement too small to be a repetition', () => {
    const counter = new RepCounter('pushup');
    // Bottoms out at 150, short of the 135-degree gate. Note the gate is
    // deliberately permissive: a *shallow but real* rep does get counted, so
    // that the rules can flag it. Only a non-movement is ignored.
    const events = run(counter, [
      ...Array(10).fill(170),
      ...Array(12).fill(150),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(0);
    expect(counter.status.repCount).toBe(0);
  });

  it('counts a shallow rep so the rules can coach it', () => {
    const counter = new RepCounter('pushup');
    // 120 deg is a poor push-up, not a non-event. Counting it is what lets the
    // user hear "turunkan dada lebih dalam" instead of silently getting no rep.
    const events = run(counter, [
      ...Array(10).fill(170),
      ...Array(12).fill(120),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(1);
  });

  it('does not count a rep that never returns to lockout', () => {
    const counter = new RepCounter('pushup');
    const events = run(counter, [
      ...Array(10).fill(170),
      ...sweep(170, 80, 15),
      // Comes back up only to 130, below the 150-degree upEnter threshold.
      ...sweep(80, 130, 15),
      ...Array(10).fill(130),
    ]);
    expect(events).toHaveLength(0);
  });

  it('rejects threshold jitter instead of double-counting', () => {
    const counter = new RepCounter('pushup');
    // Oscillates across both thresholds far faster than a human rep. Without
    // hysteresis plus minPhaseMs this would report a stream of phantom reps.
    const jitter: number[] = [];
    for (let i = 0; i < 40; i++) jitter.push(i % 2 === 0 ? 160 : 90);
    const events = run(counter, [...Array(10).fill(170), ...jitter], 16);
    expect(events).toHaveLength(0);
  });

  it('records depth, lockout and phase durations', () => {
    const counter = new RepCounter('pushup');
    const [rep] = run(counter, pushupRep(), 33);

    expect(rep.minAngle).toBeCloseTo(80, 5);
    expect(rep.maxAngle).toBeCloseTo(170, 5);
    expect(rep.eccentricMs).toBeGreaterThan(0);
    expect(rep.concentricMs).toBeGreaterThan(0);
    expect(rep.endMs).toBeGreaterThan(rep.bottomMs);
    expect(rep.bottomMs).toBeGreaterThanOrEqual(rep.startMs);
  });

  it('measures a slow descent as a longer eccentric than concentric', () => {
    const counter = new RepCounter('pushup');
    const [rep] = run(counter, [
      ...Array(10).fill(170),
      ...sweep(170, 80, 40), // slow down
      ...sweep(80, 170, 10), // fast up
      ...Array(10).fill(170),
    ]);
    expect(rep.eccentricMs).toBeGreaterThan(rep.concentricMs);
  });

  it('holds instead of counting while the pose is not visible', () => {
    const counter = new RepCounter('pushup');
    run(counter, [...Array(10).fill(170), ...Array(5).fill(null)]);
    expect(counter.status.holding).toBe(true);
    expect(counter.status.repCount).toBe(0);
  });

  it('clears holding once the pose returns', () => {
    const counter = new RepCounter('pushup');
    run(counter, [...Array(10).fill(170), null, null, 170]);
    expect(counter.status.holding).toBe(false);
  });

  it('tolerates a brief tracking dropout mid-rep', () => {
    const counter = new RepCounter('pushup');
    // ~99 ms of lost tracking, well inside the 2000 ms maxHoldMs budget.
    const events = run(counter, [
      ...Array(10).fill(170),
      ...sweep(170, 80, 15),
      null,
      null,
      null,
      ...sweep(80, 170, 15),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(1);
  });

  it('abandons a rep after a long dropout rather than inventing its tempo', () => {
    const counter = new RepCounter('pushup');
    // 3.3 s of lost tracking exceeds maxHoldMs; the timings that survive it
    // would include the blind window and be meaningless.
    const events = run(counter, [
      ...Array(10).fill(170),
      ...sweep(170, 80, 15),
      ...Array(100).fill(null),
      ...sweep(80, 170, 15),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(0);
  });

  it('does not emit a rep when the set starts at the bottom', () => {
    const counter = new RepCounter('pushup');
    // Starting mid-movement must not be read as half a completed rep. The
    // trailing frames are the pause at lockout that any real rep has.
    const events = run(counter, [
      ...Array(10).fill(80),
      ...sweep(80, 170, 15),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(0);
    expect(counter.status.phase).toBe('up');
  });

  it('counts the first full rep after starting at the bottom', () => {
    const counter = new RepCounter('pushup');
    const events = run(counter, [
      ...Array(10).fill(80),
      ...sweep(80, 170, 15),
      ...Array(10).fill(170),
      ...sweep(170, 80, 15),
      ...sweep(80, 170, 15),
      ...Array(10).fill(170),
    ]);
    expect(events).toHaveLength(1);
  });

  it('counts squats using knee thresholds', () => {
    const counter = new RepCounter('squat');
    const events = run(counter, [
      ...Array(10).fill(175),
      ...sweep(175, 85, 15),
      ...Array(5).fill(85),
      ...sweep(85, 175, 15),
      ...Array(10).fill(175),
    ]);
    expect(events).toHaveLength(1);
  });

  it('does not count a knee bend too small to be a squat', () => {
    const counter = new RepCounter('squat');
    // 152 deg is short of the 140-degree gate — barely a shift in stance.
    const events = run(counter, [
      ...Array(10).fill(175),
      ...Array(12).fill(152),
      ...Array(10).fill(175),
    ]);
    expect(events).toHaveLength(0);
  });

  it('honours threshold overrides', () => {
    // A stricter gate should reject a rep the default would accept.
    const shallow = [...Array(10).fill(175), ...Array(12).fill(130), ...Array(10).fill(175)];
    expect(run(new RepCounter('squat'), shallow)).toHaveLength(1);
    expect(run(new RepCounter('squat', { downEnter: 110 }), shallow)).toHaveLength(0);
  });

  it('reset clears the count and in-flight state', () => {
    const counter = new RepCounter('pushup');
    run(counter, pushupRep());
    expect(counter.status.repCount).toBe(1);

    counter.reset();
    expect(counter.status.repCount).toBe(0);
    expect(counter.status.phase).toBe('unknown');
    expect(counter.status.holding).toBe(false);
  });

  it('is deterministic when the same sequence is replayed', () => {
    // The eval scripts depend on this: replaying recorded landmarks must
    // reproduce exactly what the app did live, or the reported numbers are
    // not numbers about the shipped product.
    const sequence = [...pushupRep(), ...pushupRep()];
    const first = run(new RepCounter('pushup'), sequence);
    const second = run(new RepCounter('pushup'), sequence);
    expect(second).toEqual(first);
  });
});
