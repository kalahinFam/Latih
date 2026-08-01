import { describe, expect, it } from 'vitest';
import {
  extractFeatures,
  featureAt,
  FEATURE_COUNT,
  FEATURE_NAMES,
  TIMESTEPS,
} from './features.ts';
import { RepWindowBuilder, type RepWindow } from './repWindow.ts';
import type { JointAngles } from './types.ts';

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
    ...overrides,
  };
}

/** A push-up rep: 170 at the top, down to `bottom`, back to 170. */
function pushupWindow(
  bottom = 80,
  options: { frames?: number; frameMs?: number; hip?: number | null } = {},
): RepWindow {
  const { frames = 30, frameMs = 33, hip = 178 } = options;
  const builder = new RepWindowBuilder();
  const half = Math.floor(frames / 2);

  for (let i = 0; i < frames; i++) {
    const t = i * frameMs;
    const ratio = i <= half ? i / half : (frames - 1 - i) / (frames - 1 - half);
    const elbow = 170 - (170 - bottom) * ratio;
    builder.push(
      t,
      angles({
        elbowLeft: elbow,
        elbowRight: elbow,
        hipLeft: hip,
        hipRight: hip,
        shoulderLeft: 60,
        shoulderRight: 60,
        trunkLean: 88,
      }),
    );
  }

  return builder.take({
    index: 1,
    startMs: 0,
    bottomMs: half * frameMs,
    endMs: (frames - 1) * frameMs,
    minAngle: bottom,
    maxAngle: 170,
    eccentricMs: half * frameMs,
    concentricMs: (frames - 1 - half) * frameMs,
  });
}

describe('extractFeatures — shape', () => {
  it('always produces the same tensor size regardless of rep length', () => {
    const fast = extractFeatures('pushup', pushupWindow(80, { frames: 12 }))!;
    const slow = extractFeatures('pushup', pushupWindow(80, { frames: 90 }))!;

    expect(fast.data.length).toBe(TIMESTEPS * FEATURE_COUNT);
    expect(slow.data.length).toBe(fast.data.length);
  });

  it('exposes one coverage value per feature', () => {
    const features = extractFeatures('pushup', pushupWindow())!;
    expect(features.coverage.length).toBe(FEATURE_COUNT);
  });

  it('returns null for a rep with no frames', () => {
    // An abandoned rep must not enter the training set as a zero tensor.
    const empty: RepWindow = {
      event: {
        index: 1,
        startMs: 0,
        bottomMs: 0,
        endMs: 0,
        minAngle: 0,
        maxAngle: 0,
        eccentricMs: 0,
        concentricMs: 0,
      },
      frames: [],
    };
    expect(extractFeatures('pushup', empty)).toBeNull();
  });

  it('keeps every value finite', () => {
    // A NaN anywhere silently poisons a whole training batch.
    const features = extractFeatures('pushup', pushupWindow())!;
    expect(features.data.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('extractFeatures — normalisation', () => {
  it('scales angles into roughly 0..1', () => {
    const features = extractFeatures('pushup', pushupWindow())!;
    // 170 deg at the top -> 170/180.
    expect(featureAt(features, 0, 'elbow')).toBeCloseTo(170 / 180, 3);
  });

  it('runs phase from 0 to 1 across the rep', () => {
    const features = extractFeatures('pushup', pushupWindow())!;
    expect(featureAt(features, 0, 'phase')).toBeCloseTo(0, 5);
    expect(featureAt(features, TIMESTEPS - 1, 'phase')).toBeCloseTo(1, 5);
  });

  it('puts depthProgress at 1 where the rep is deepest', () => {
    const features = extractFeatures('pushup', pushupWindow(80))!;
    const depths = Array.from({ length: TIMESTEPS }, (_, i) =>
      featureAt(features, i, 'depthProgress'),
    );
    expect(Math.max(...depths)).toBeCloseTo(1, 3);
    expect(depths[0]).toBeCloseTo(0, 2);
  });

  it('makes a deep and a shallow rep share a depthProgress shape', () => {
    // Self-normalising by design: the classifier should see the *pattern* of a
    // rep, with absolute depth carried by the `primary` channel instead.
    const deep = extractFeatures('pushup', pushupWindow(70))!;
    const shallow = extractFeatures('pushup', pushupWindow(120))!;

    for (let i = 0; i < TIMESTEPS; i++) {
      expect(featureAt(deep, i, 'depthProgress')).toBeCloseTo(
        featureAt(shallow, i, 'depthProgress'),
        2,
      );
    }
    // But absolute depth still differs where it should.
    expect(featureAt(deep, 16, 'primary')).toBeLessThan(featureAt(shallow, 16, 'primary'));
  });

  it('clips angular velocity into -1..1', () => {
    const features = extractFeatures('pushup', pushupWindow(70, { frames: 6, frameMs: 8 }))!;
    for (let i = 0; i < TIMESTEPS; i++) {
      const v = featureAt(features, i, 'primaryVelocity');
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('gives a fast rep a larger peak velocity than a slow one', () => {
    // The signal the rules cannot express, and the classifier's reason to exist.
    const fast = extractFeatures('pushup', pushupWindow(80, { frames: 30, frameMs: 16 }))!;
    const slow = extractFeatures('pushup', pushupWindow(80, { frames: 30, frameMs: 66 }))!;

    const peak = (f: typeof fast) =>
      Math.max(
        ...Array.from({ length: TIMESTEPS }, (_, i) =>
          Math.abs(featureAt(f, i, 'primaryVelocity')),
        ),
      );
    expect(peak(fast)).toBeGreaterThan(peak(slow));
  });
});

describe('extractFeatures — missing data', () => {
  it('reports full coverage when every joint is visible', () => {
    const features = extractFeatures('pushup', pushupWindow())!;
    const hip = FEATURE_NAMES.indexOf('hip');
    expect(features.coverage[hip]).toBe(1);
  });

  it('reports zero coverage for a joint never observed', () => {
    const features = extractFeatures('pushup', pushupWindow(80, { hip: null }))!;
    const hip = FEATURE_NAMES.indexOf('hip');
    expect(features.coverage[hip]).toBe(0);
  });

  it('does not silently pass off an imputed channel as measured', () => {
    // The whole point of reporting coverage: training code can drop or weight
    // these reps instead of learning from an invented hip angle.
    const features = extractFeatures('pushup', pushupWindow(80, { hip: null }))!;
    const hip = FEATURE_NAMES.indexOf('hip');
    expect(features.coverage[hip]).toBeLessThan(1);
    expect(features.data.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('interpolates across a brief tracking dropout', () => {
    const builder = new RepWindowBuilder();
    for (let i = 0; i < 20; i++) {
      // Hip drops out for frames 8..11 only.
      const occluded = i >= 8 && i <= 11;
      builder.push(
        i * 33,
        angles({
          elbowLeft: 170 - i * 4,
          elbowRight: 170 - i * 4,
          hipLeft: occluded ? null : 100 + i,
          hipRight: occluded ? null : 100 + i,
        }),
      );
    }
    const window = builder.take({
      index: 1,
      startMs: 0,
      bottomMs: 19 * 33,
      endMs: 19 * 33,
      minAngle: 94,
      maxAngle: 170,
      eccentricMs: 600,
      concentricMs: 0,
    });

    const features = extractFeatures('pushup', window)!;
    const hip = FEATURE_NAMES.indexOf('hip');
    // Partial coverage, but a smooth, finite channel — the limb did not
    // teleport just because the tracker blinked.
    expect(features.coverage[hip]).toBeGreaterThan(0.5);
    expect(features.coverage[hip]).toBeLessThan(1);
    expect(features.data.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('feature contract', () => {
  it('has a stable feature order', () => {
    // The ONNX graph is compiled against these indices. Reordering silently
    // invalidates every exported model, so this is pinned deliberately.
    expect([...FEATURE_NAMES]).toEqual([
      'elbow',
      'knee',
      'hip',
      'shoulder',
      'trunkLean',
      'primary',
      'primaryVelocity',
      'elbowAsymmetry',
      'kneeAsymmetry',
      'hipAsymmetry',
      'phase',
      'depthProgress',
    ]);
  });

  it('tracks the knee for squats and the elbow for push-ups', () => {
    const builder = new RepWindowBuilder();
    for (let i = 0; i < 20; i++) {
      builder.push(i * 33, angles({ elbowLeft: 100, elbowRight: 100, kneeLeft: 150, kneeRight: 150 }));
    }
    const event = {
      index: 1,
      startMs: 0,
      bottomMs: 300,
      endMs: 19 * 33,
      minAngle: 100,
      maxAngle: 150,
      eccentricMs: 300,
      concentricMs: 300,
    };
    const frames = builder.take(event);

    expect(featureAt(extractFeatures('pushup', frames)!, 0, 'primary')).toBeCloseTo(100 / 180, 3);
    expect(featureAt(extractFeatures('squat', frames)!, 0, 'primary')).toBeCloseTo(150 / 180, 3);
  });
});
