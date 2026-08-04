import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, evaluateRules, primaryCue, type RuleErrorCode } from './rules.ts';
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
describe('rule thresholds must be reachable from counted reps', () => {
  const exercises: ExerciseKind[] = ['pushup', 'squat'];

  it.each(exercises)('%s: depth rule is stricter than the counter gate', (exercise) => {
    // If these were equal, every counted rep would already be deep enough and
    // shallow_depth could never fire on a real repetition.
    expect(DEFAULT_THRESHOLDS[exercise].depthMax).toBeLessThan(DEFAULT_CONFIGS[exercise].downEnter);
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

  /**
   * End-to-end proof, not just an inequality: drive a genuinely shallow rep
   * through the real counter and assert the rule fires on what it emits.
   */
  it.each(exercises)('%s: a shallow rep is counted and then flagged', (exercise) => {
    const { downEnter, upEnter } = DEFAULT_CONFIGS[exercise];
    // Bottom out between the rule threshold and the counter gate.
    const shallowBottom = (DEFAULT_THRESHOLDS[exercise].depthMax + downEnter) / 2;
    const top = upEnter + 12;

    const counter = new RepCounter(exercise);
    const builder = new RepWindowBuilder();
    const isPushup = exercise === 'pushup';

    let event: RepEvent | null = null;
    const sequence = [
      ...Array(12).fill(top),
      ...Array(12).fill(shallowBottom),
      ...Array(12).fill(top),
    ];

    sequence.forEach((angle, i) => {
      const t = i * 33;
      const joints: Partial<JointAngles> = isPushup
        ? { elbowLeft: angle, elbowRight: angle, hipLeft: 178, hipRight: 178 }
        : { kneeLeft: angle, kneeRight: angle, trunkLean: 30 };
      builder.push(t, angles(joints));
      event = counter.update(angle, t) ?? event;
    });

    expect(event).not.toBeNull();
    const findings = evaluateRules(exercise, builder.take(event!));
    expect(codes(findings)).toContain('shallow_depth');
  });
});

describe('evaluateRules — push-up', () => {
  it('passes a clean rep', () => {
    const w = windowAt({ elbowLeft: 80, elbowRight: 80, hipLeft: 178, hipRight: 178 });
    expect(evaluateRules('pushup', w)).toEqual([]);
  });

  it('flags insufficient depth', () => {
    const w = windowAt({ elbowLeft: 120, elbowRight: 120, hipLeft: 178, hipRight: 178 });
    expect(codes(evaluateRules('pushup', w))).toContain('shallow_depth');
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
    const w = windowAt({ elbowLeft: 125, elbowRight: 125, hipLeft: 140, hipRight: 140 });
    const found = codes(evaluateRules('pushup', w));
    expect(found).toContain('shallow_depth');
    expect(found).toContain('hip_sag');
  });

  it('orders findings by severity, worst first', () => {
    // Depth is barely off (just past the 105 threshold); the hip is badly
    // collapsed. Both fire, and the hip must be spoken first.
    const w = windowAt({ elbowLeft: 110, elbowRight: 110, hipLeft: 120, hipRight: 120 });
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
    const w = windowAt({ elbowLeft: 120, elbowRight: 120, hipLeft: 178 });
    expect(codes(evaluateRules('pushup', w, { depthMax: 130 }))).not.toContain('shallow_depth');
  });
});

describe('evaluateRules — squat', () => {
  it('passes a clean rep', () => {
    const w = windowAt({ kneeLeft: 85, kneeRight: 85, trunkLean: 30 }, { maxAngle: 175 });
    expect(evaluateRules('squat', w)).toEqual([]);
  });

  it('flags a squat above parallel', () => {
    const w = windowAt({ kneeLeft: 125, kneeRight: 125, trunkLean: 30 }, { maxAngle: 175 });
    expect(codes(evaluateRules('squat', w))).toContain('shallow_depth');
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
