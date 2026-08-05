import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  SPEAK_ONCE_PER_SET,
  evaluateRules,
  primaryCue,
  type RuleErrorCode,
} from './rules.ts';
import { RepWindowBuilder, type RepWindow } from './repWindow.ts';
import { DEFAULT_CONFIGS, RepCounter, type RepEvent } from './repCounter.ts';
import type { ExerciseKind, JointAngles } from './types.ts';
import { equalConfidence } from './angles.ts';

function angles(overrides: Partial<JointAngles> = {}): JointAngles {
  return {
    elbowLeft: null,
    elbowRight: null,
    shoulderLeft: null,
    shoulderRight: null,
    hipLeft: null,
    hipRight: null,
    kneeLeft: null,
    kneeRight: null,
    trunkLean: null,
    // Both sides equally seen: side selection is not what these test.
    confidence: equalConfidence(),
    ...overrides,
  };
}

/**
 * Build a window whose bottom sits at t=1000 with the given angles, framed by
 * lockout frames either side — the shape every real rep has.
 */
function windowAt(bottom: Partial<JointAngles>, event: Partial<RepEvent> = {}): RepWindow {
  const builder = new RepWindowBuilder();
  const top = event.maxAngle ?? 170;
  const primaryTop = { elbowLeft: top, elbowRight: top, kneeLeft: top, kneeRight: top };

  builder.push(0, angles(primaryTop));
  builder.push(500, angles(primaryTop));
  builder.push(1000, angles(bottom));
  builder.push(1500, angles(primaryTop));

  return builder.take({
    counted: true,
    index: 1,
    startMs: 0,
    bottomMs: 1000,
    endMs: 1500,
    minAngle: 80,
    maxAngle: top,
    eccentricMs: 1000,
    concentricMs: 500,
    ...event,
  });
}

function codes(findings: { code: RuleErrorCode }[]): RuleErrorCode[] {
  return findings.map((f) => f.code);
}

/**
 * These are the tests that would have caught the dead-rule bug.
 *
 * The per-rule tests below all pass against synthetic windows built by hand,
 * because a hand-built window can hold any angle. What they cannot see is that
 * the *rep counter* would never emit such a window in the first place. These
 * assertions close that gap by checking the two modules against each other.
 */
describe('thresholds must be reachable from what the counter emits', () => {
  const exercises: ExerciseKind[] = ['pushup', 'squat'];

  it.each(exercises)('%s: credit depth sits inside the descent phase', (exercise) => {
    // The descent phase only begins past `downEnter`, so a credit threshold
    // above it could never be evaluated — the machine would award credit for
    // entering the phase rather than for reaching the bottom.
    const { downEnter, creditMax } = DEFAULT_CONFIGS[exercise];
    expect(creditMax).toBeLessThanOrEqual(downEnter);
  });

  it.each(exercises)('%s: lockout rule is stricter than the counter gate', (exercise) => {
    expect(DEFAULT_THRESHOLDS[exercise].lockoutMin).toBeGreaterThan(
      DEFAULT_CONFIGS[exercise].upEnter,
    );
  });

  it.each(exercises)('%s: hysteresis band stays wide enough to reject jitter', (exercise) => {
    const { downEnter, upEnter } = DEFAULT_CONFIGS[exercise];
    expect(upEnter - downEnter).toBeGreaterThanOrEqual(20);
  });

  /** Drive a movement through the real counter and read what it emits. */
  function driveRep(exercise: ExerciseKind, bottom: number): RepEvent | null {
    const { upEnter } = DEFAULT_CONFIGS[exercise];
    const counter = new RepCounter(exercise);
    const top = upEnter + 12;

    let event: RepEvent | null = null;
    const sequence = [...Array(12).fill(top), ...Array(12).fill(bottom), ...Array(12).fill(top)];

    sequence.forEach((angle, i) => {
      event = counter.update(angle, i * 33) ?? event;
    });
    return event;
  }

  /**
   * The behaviour the whole two-threshold split exists for: a half repetition
   * is *seen* — so it can be corrected — and not *credited*.
   *
   * Reported from a phone as squats counting without reaching depth. A counter
   * that credits half reps tells the lifter something untrue about the work
   * they did, and inflates the target the session loop then progresses from.
   */
  it.each(exercises)('%s: a half rep is reported but not counted', (exercise) => {
    const { downEnter, creditMax } = DEFAULT_CONFIGS[exercise];
    // Past the attempt gate, short of the credit depth.
    const event = driveRep(exercise, (creditMax + downEnter) / 2);

    expect(event).not.toBeNull();
    expect(event!.counted).toBe(false);
  });

  it.each(exercises)('%s: a full rep is counted', (exercise) => {
    const event = driveRep(exercise, DEFAULT_CONFIGS[exercise].creditMax - 10);
    expect(event).not.toBeNull();
    expect(event!.counted).toBe(true);
  });

  it.each(exercises)('%s: the count only moves for credited reps', (exercise) => {
    const { downEnter, upEnter, creditMax } = DEFAULT_CONFIGS[exercise];
    const counter = new RepCounter(exercise);
    const top = upEnter + 12;
    const half = (creditMax + downEnter) / 2;
    const full = creditMax - 10;

    const sequence = [
      ...Array(12).fill(top),
      ...Array(12).fill(half),
      ...Array(12).fill(top),
      ...Array(12).fill(full),
      ...Array(12).fill(top),
    ];
    sequence.forEach((angle, i) => counter.update(angle, i * 33));

    expect(counter.status.repCount).toBe(1);
    expect(counter.status.rejectedCount).toBe(1);
  });
});

describe('evaluateRules — push-up', () => {
  it('passes a clean rep', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 178, hipRight: 178 });
    expect(evaluateRules('pushup', w)).toEqual([]);
  });

  it('flags a sagging hip', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 145, hipRight: 145 });
    expect(codes(evaluateRules('pushup', w))).toContain('hip_sag');
  });

  it('flags a piked hip', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 215, hipRight: 215 });
    expect(codes(evaluateRules('pushup', w))).toContain('hip_pike');
  });

  it('never reports sag and pike for the same rep', () => {
    const sag = evaluateRules('pushup', windowAt({ elbowLeft: 80, hipLeft: 140 }));
    const pike = evaluateRules('pushup', windowAt({ elbowLeft: 80, hipLeft: 220 }));
    expect(codes(sag)).not.toContain('hip_pike');
    expect(codes(pike)).not.toContain('hip_sag');
  });

  it('flags a partial lockout from the observed peak extension', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 178 }, { maxAngle: 130 });
    expect(codes(evaluateRules('pushup', w))).toContain('partial_lockout');
  });

  it('reports several independent faults on one rep', () => {
    const w = windowAt(
      { elbowLeft: 80, elbowRight: 80, hipLeft: 140, hipRight: 140 },
      { maxAngle: 150 },
    );
    const found = codes(evaluateRules('pushup', w));
    expect(found).toContain('hip_sag');
    expect(found).toContain('partial_lockout');
  });

  it('orders findings by severity, worst first', () => {
    // Lockout is barely off; the hip is badly collapsed. Both fire, and the
    // hip must be spoken first.
    const w = windowAt(
      { elbowLeft: 80, elbowRight: 80, hipLeft: 120, hipRight: 120 },
      { maxAngle: 159 },
    );
    const findings = evaluateRules('pushup', w);
    expect(findings).toHaveLength(2);
    expect(findings[0].code).toBe('hip_sag');
    expect(findings[0].severity).toBeGreaterThan(findings[1].severity);
  });

  it('does not flag a joint that was never visible', () => {
    // Hips occluded all rep: silence is correct. Guessing would produce a
    // correction the user cannot act on and does not deserve.
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: null, hipRight: null });
    expect(codes(evaluateRules('pushup', w))).not.toContain('hip_sag');
  });

  it('honours threshold overrides', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 150, hipRight: 150 });
    expect(codes(evaluateRules('pushup', w))).toContain('hip_sag');
    expect(codes(evaluateRules('pushup', w, { hipSagMin: 140 }))).not.toContain('hip_sag');
  });

  it('no longer judges depth — the counter does', () => {
    // Depth used to be checked twice, in two places, with an ordering between
    // them that had to be kept straight. It is now the counter's `creditMax`
    // and nothing else: an attempt either reaches the bottom and counts, or it
    // does not and is reported uncounted.
    const shallow = windowAt({ elbowLeft: 128, elbowRight: 128, hipLeft: 178, hipRight: 178 });
    expect(codes(evaluateRules('pushup', shallow))).not.toContain('shallow_depth');
  });
});

describe('evaluateRules — squat', () => {
  it('passes a clean rep', () => {
    const w = windowAt({ kneeLeft: 85, kneeRight: 85, trunkLean: 30 }, { maxAngle: 175 });
    expect(evaluateRules('squat', w)).toEqual([]);
  });

  it('leaves depth to the counter', () => {
    // A squat above parallel never becomes a counted rep in the first place —
    // `creditMax` is 90 — so there is nothing here for a depth rule to flag.
    const w = windowAt({ kneeLeft: 125, kneeRight: 125, trunkLean: 30 }, { maxAngle: 175 });
    expect(codes(evaluateRules('squat', w))).not.toContain('shallow_depth');
  });

  it('flags excessive forward lean', () => {
    const w = windowAt({ kneeLeft: 85, kneeRight: 85, trunkLean: 75 }, { maxAngle: 175 });
    expect(codes(evaluateRules('squat', w))).toContain('excessive_trunk_lean');
  });

  it('accepts the forward lean a correct squat requires', () => {
    // Some pitch is right in a squat; flagging it would train users out of
    // good technique.
    const w = windowAt({ kneeLeft: 85, kneeRight: 85, trunkLean: 45 }, { maxAngle: 175 });
    expect(codes(evaluateRules('squat', w))).not.toContain('excessive_trunk_lean');
  });

  it('does not apply push-up hip rules to squats', () => {
    // A squat's hip angle is legitimately far from straight at the bottom.
    const w = windowAt(
      { kneeLeft: 85, kneeRight: 85, hipLeft: 60, hipRight: 60, trunkLean: 30 },
      { maxAngle: 175 },
    );
    const found = codes(evaluateRules('squat', w));
    expect(found).not.toContain('hip_sag');
    expect(found).not.toContain('hip_pike');
  });
});

describe('partial lockout', () => {
  const clean = { elbowLeft: 80, elbowRight: 80, hipLeft: 178, hipRight: 178 };

  it('does not fire on a consistent set, whatever the tracker reads as straight', () => {
    // The reported failure: "luruskan lengan sepenuhnya" and "berdiri tegak
    // sepenuhnya" on *every* repetition. A pose estimator does not read a
    // locked joint as 180°, and the absolute threshold sat above whatever this
    // person's camera angle produced — so the rule fired constantly and
    // carried no information at all.
    for (const peak of [163, 166, 164, 165]) {
      const w = windowAt(clean, { maxAngle: peak });
      const findings = evaluateRules('pushup', w, {}, { bestLockoutDeg: 166 });
      expect(codes(findings), `peak ${peak}`).not.toContain('partial_lockout');
    }
  });

  it('fires when a rep falls well short of the same lifter’s own best', () => {
    // This is what the rule is actually for: reps getting shorter as the set
    // goes on.
    const w = windowAt(clean, { maxAngle: 148 });
    const findings = evaluateRules('pushup', w, {}, { bestLockoutDeg: 172 });
    expect(codes(findings)).toContain('partial_lockout');
  });

  it('judges each exercise against its own reference', () => {
    // A squat peaking at 168 is fine next to a best of 174, and short next to
    // a best of 186 — the same number, two verdicts, which is the point.
    const bottom = { kneeLeft: 85, kneeRight: 85, trunkLean: 20 };
    expect(
      codes(evaluateRules('squat', windowAt(bottom, { maxAngle: 168 }), {}, { bestLockoutDeg: 174 })),
    ).not.toContain('partial_lockout');
    expect(
      codes(evaluateRules('squat', windowAt(bottom, { maxAngle: 168 }), {}, { bestLockoutDeg: 186 })),
    ).toContain('partial_lockout');
  });

  it('falls back to the absolute backstop on the first rep', () => {
    // Nothing to compare against yet. Inventing a reference would flag or
    // excuse the opening rep arbitrarily.
    expect(codes(evaluateRules('pushup', windowAt(clean, { maxAngle: 159 })))).toContain(
      'partial_lockout',
    );
    expect(codes(evaluateRules('pushup', windowAt(clean, { maxAngle: 170 })))).not.toContain(
      'partial_lockout',
    );
  });

  it('never lets the reference drift below the absolute backstop', () => {
    // A set whose best is already poor must not thereby excuse worse reps.
    const w = windowAt(clean, { maxAngle: 155 });
    expect(codes(evaluateRules('pushup', w, {}, { bestLockoutDeg: 160 }))).toContain(
      'partial_lockout',
    );
  });

  it('is rationed to once per set', () => {
    // Actionable on the next rep is coaching; repeated every rep is one
    // correction shouted twelve times, drowning out the cues that do change.
    expect(SPEAK_ONCE_PER_SET.has('partial_lockout')).toBe(true);
    expect(SPEAK_ONCE_PER_SET.has('shallow_depth')).toBe(false);
  });
});

describe('primaryCue', () => {
  it('returns the most severe finding within a priority tier', () => {
    const w = windowAt({ elbowLeft: 105, elbowRight: 105, hipLeft: 120, hipRight: 120 });
    expect(primaryCue(evaluateRules('pushup', w))?.code).toBe('hip_sag');
  });

  it('puts range of motion ahead of lockout', () => {
    // The reported failure: a quarter squat counted, and the user was told
    // "berdiri tegak sepenuhnya". True, useless, and it reads as the app not
    // understanding the movement. Half reps usually fail both rules at once,
    // and normalised by the same band the lockout miss can score higher.
    const findings = [
      { code: 'partial_lockout' as const, cue: 'x', value: 150, threshold: 172, severity: 0.9 },
      { code: 'shallow_depth' as const, cue: 'y', value: 128, threshold: 110, severity: 0.7 },
    ];
    expect(primaryCue(findings)?.code).toBe('shallow_depth');
  });

  it('still speaks lockout when it is the only fault', () => {
    const findings = [
      { code: 'partial_lockout' as const, cue: 'x', value: 150, threshold: 172, severity: 0.9 },
    ];
    expect(primaryCue(findings)?.code).toBe('partial_lockout');
  });

  it('returns null for a clean rep', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 178, hipRight: 178 });
    expect(primaryCue(evaluateRules('pushup', w))).toBeNull();
  });

  it('carries a non-empty Indonesian cue for every finding', () => {
    const w = windowAt({ elbowLeft: 125, elbowRight: 125, hipLeft: 140, hipRight: 140 });
    for (const finding of evaluateRules('pushup', w)) {
      expect(finding.cue.length).toBeGreaterThan(0);
    }
  });
});

describe('RepWindowBuilder', () => {
  it('keeps only the frames inside the rep', () => {
    const builder = new RepWindowBuilder();
    for (let t = 0; t <= 2000; t += 250) builder.push(t, angles({ elbowLeft: 100 }));

    const window = builder.take({
      counted: true,
      index: 1,
      startMs: 500,
      bottomMs: 1000,
      endMs: 1500,
      minAngle: 80,
      maxAngle: 170,
      eccentricMs: 500,
      concentricMs: 500,
    });

    expect(window.frames.every((f) => f.timestampMs >= 500 && f.timestampMs <= 1500)).toBe(true);
    expect(window.frames).toHaveLength(5);
  });

  it('retains the closing lockout for the next rep', () => {
    const builder = new RepWindowBuilder();
    for (let t = 0; t <= 2000; t += 250) builder.push(t, angles({ elbowLeft: 100 }));

    builder.take({
      counted: true,
      index: 1,
      startMs: 0,
      bottomMs: 500,
      endMs: 1000,
      minAngle: 80,
      maxAngle: 170,
      eccentricMs: 500,
      concentricMs: 500,
    });

    // Frames from the closing lockout onward survive: t = 1000..2000.
    expect(builder.size).toBe(5);
  });

  it('bounds memory when a set is paused mid-rep', () => {
    const builder = new RepWindowBuilder(10);
    for (let t = 0; t < 100; t += 1) builder.push(t, angles());
    expect(builder.size).toBe(10);
  });
});
