import { describe, expect, it } from 'vitest';
import {
  bilateralMean,
  computeJointAngles,
  jointAngleDeg,
  primaryAngle,
  torsoLength,
  trunkLeanDeg,
} from './angles';
import { LANDMARK_COUNT, LM, type Landmark } from './types';

function lm(x: number, y: number, z = 0, visibility = 1): Landmark {
  return { x, y, z, visibility };
}

/** A body with every joint at the origin and fully visible. */
function blankBody(visibility = 1): Landmark[] {
  return Array.from({ length: LANDMARK_COUNT }, () => lm(0, 0, 0, visibility));
}

describe('jointAngleDeg', () => {
  it('measures a right angle', () => {
    // a above b, c to the right of b -> 90 degrees at b.
    expect(jointAngleDeg(lm(0, 1), lm(0, 0), lm(1, 0))).toBeCloseTo(90, 6);
  });

  it('measures a straight limb as 180 degrees', () => {
    expect(jointAngleDeg(lm(-1, 0), lm(0, 0), lm(1, 0))).toBeCloseTo(180, 6);
  });

  it('measures a fully folded limb as 0 degrees', () => {
    expect(jointAngleDeg(lm(1, 0), lm(0, 0), lm(1, 0))).toBeCloseTo(0, 6);
  });

  it('works in three dimensions', () => {
    expect(jointAngleDeg(lm(0, 0, 1), lm(0, 0, 0), lm(1, 0, 0))).toBeCloseTo(90, 6);
  });

  it('returns null for a zero-length segment rather than NaN', () => {
    expect(jointAngleDeg(lm(0, 0), lm(0, 0), lm(1, 0))).toBeNull();
  });

  it('never returns NaN for collinear points, where acos can drift out of domain', () => {
    // Repeated collinear cases are where floating-point error pushes the cosine
    // just past +/-1; without clamping this yields NaN and poisons every
    // downstream feature silently.
    for (let i = 1; i <= 50; i++) {
      const angle = jointAngleDeg(lm(-i, 0), lm(0, 0), lm(i, 0));
      expect(angle).not.toBeNaN();
      expect(angle).toBeCloseTo(180, 6);
    }
  });
});

describe('computeJointAngles', () => {
  it('computes a bent elbow', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(0, 1);
    body[LM.LEFT_ELBOW] = lm(0, 0);
    body[LM.LEFT_WRIST] = lm(1, 0);
    expect(computeJointAngles(body).elbowLeft).toBeCloseTo(90, 6);
  });

  it('returns null for joints below the visibility threshold', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(0, 1, 0, 0.9);
    body[LM.LEFT_ELBOW] = lm(0, 0, 0, 0.2); // occluded
    body[LM.LEFT_WRIST] = lm(1, 0, 0, 0.9);
    expect(computeJointAngles(body).elbowLeft).toBeNull();
  });

  it('respects a custom visibility threshold', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(0, 1, 0, 0.4);
    body[LM.LEFT_ELBOW] = lm(0, 0, 0, 0.4);
    body[LM.LEFT_WRIST] = lm(1, 0, 0, 0.4);
    expect(computeJointAngles(body, 0.5).elbowLeft).toBeNull();
    expect(computeJointAngles(body, 0.3).elbowLeft).toBeCloseTo(90, 6);
  });
});

describe('trunkLeanDeg', () => {
  it('reports zero for an upright torso', () => {
    const body = blankBody();
    // World space: -y is up, so shoulders sit above hips at a lower y.
    body[LM.LEFT_SHOULDER] = lm(-0.2, -0.5);
    body[LM.RIGHT_SHOULDER] = lm(0.2, -0.5);
    body[LM.LEFT_HIP] = lm(-0.15, 0);
    body[LM.RIGHT_HIP] = lm(0.15, 0);
    expect(trunkLeanDeg(body)).toBeCloseTo(0, 6);
  });

  it('reports 90 degrees for a horizontal torso, as in a push-up', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(-0.2, 0, -0.5);
    body[LM.RIGHT_SHOULDER] = lm(0.2, 0, -0.5);
    body[LM.LEFT_HIP] = lm(-0.15, 0, 0);
    body[LM.RIGHT_HIP] = lm(0.15, 0, 0);
    expect(trunkLeanDeg(body)).toBeCloseTo(90, 6);
  });

  it('returns null when the hips are not visible', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(-0.2, -0.5);
    body[LM.RIGHT_SHOULDER] = lm(0.2, -0.5);
    body[LM.LEFT_HIP] = lm(-0.15, 0, 0, 0.1);
    body[LM.RIGHT_HIP] = lm(0.15, 0, 0, 0.1);
    expect(trunkLeanDeg(body)).toBeNull();
  });
});

describe('torsoLength', () => {
  it('measures the shoulder-to-hip distance', () => {
    const body = blankBody();
    body[LM.LEFT_SHOULDER] = lm(0, -0.4);
    body[LM.RIGHT_SHOULDER] = lm(0, -0.4);
    body[LM.LEFT_HIP] = lm(0, 0);
    body[LM.RIGHT_HIP] = lm(0, 0);
    expect(torsoLength(body)).toBeCloseTo(0.4, 6);
  });
});

describe('bilateralMean', () => {
  it('averages when both sides are visible', () => {
    expect(bilateralMean(80, 100)).toBe(90);
  });

  it('falls back to whichever single side is visible', () => {
    expect(bilateralMean(80, null)).toBe(80);
    expect(bilateralMean(null, 100)).toBe(100);
  });

  it('returns null when neither side is visible', () => {
    expect(bilateralMean(null, null)).toBeNull();
  });

  it('does not treat a legitimate 0-degree angle as missing', () => {
    // `left ?? right` is deliberate: `left || right` would discard a real 0.
    expect(bilateralMean(0, null)).toBe(0);
  });
});

describe('primaryAngle', () => {
  const angles = {
    elbowLeft: 90,
    elbowRight: 110,
    shoulderLeft: null,
    shoulderRight: null,
    hipLeft: null,
    hipRight: null,
    kneeLeft: 70,
    kneeRight: 80,
    trunkLean: null,
  };

  it('tracks the elbow for push-ups', () => {
    expect(primaryAngle(angles, 'pushup')).toBe(100);
  });

  it('tracks the knee for squats', () => {
    expect(primaryAngle(angles, 'squat')).toBe(75);
  });
});
