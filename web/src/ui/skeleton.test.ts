import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_JOINTS, SkeletonSmoother, highlightFor } from './skeleton.ts';
import { CUE_TEXT } from '../core/rules.ts';
import { LANDMARK_COUNT, LM, type Landmark } from '../core/types.ts';

describe('highlightFor', () => {
  it('points at the joint each rule actually measures', () => {
    // The overlay answers "where". Getting this wrong points the user at a
    // healthy joint while the real fault stays unmarked — worse than no
    // highlight, because it is confidently wrong.
    expect(highlightFor('pushup', 'shallow_depth')).toEqual([LM.LEFT_ELBOW, LM.RIGHT_ELBOW]);
    expect(highlightFor('squat', 'shallow_depth')).toEqual([LM.LEFT_KNEE, LM.RIGHT_KNEE]);
    expect(highlightFor('pushup', 'hip_sag')).toEqual([LM.LEFT_HIP, LM.RIGHT_HIP]);
  });

  it('marks both ends of a segment-based rule', () => {
    // Trunk lean is measured shoulder-to-hip; marking one end would suggest
    // the other is fine.
    expect(highlightFor('squat', 'excessive_trunk_lean')).toEqual([
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
    ]);
  });

  it('covers every cue the fast loop can speak', () => {
    // CUE_TEXT is the closed set of corrections. A cue with no mapping shows
    // amber text over a plain white skeleton, which reads as the overlay
    // having missed the problem.
    for (const key of Object.keys(CUE_TEXT)) {
      expect(HIGHLIGHT_JOINTS[key], `no highlight mapped for ${key}`).toBeDefined();
      expect(HIGHLIGHT_JOINTS[key].length).toBeGreaterThan(0);
    }
  });

  it('highlights nothing when the form is clean', () => {
    expect(highlightFor('pushup', null)).toEqual([]);
    expect(highlightFor('pushup', 'not_a_rule')).toEqual([]);
  });
});

describe('SkeletonSmoother', () => {
  function landmarks(x: number, visibility = 1): Landmark[] {
    return Array.from({ length: LANDMARK_COUNT }, () => ({ x, y: 0, z: 0, visibility }));
  }

  it('dampens an abrupt visual landmark jump', () => {
    const smoother = new SkeletonSmoother(0.5);
    smoother.update(landmarks(0));
    expect(smoother.update(landmarks(1))[0].x).toBe(0.5);
  });

  it('dampens low-confidence overlap more strongly', () => {
    const smoother = new SkeletonSmoother(0.5);
    smoother.update(landmarks(0));
    expect(smoother.update(landmarks(1, 0.1))[0].x).toBeCloseTo(0.175, 6);
  });

  it('keeps overlapping feet attached to their previous side', () => {
    const smoother = new SkeletonSmoother(1);
    const first = landmarks(0);
    first[LM.LEFT_ANKLE].x = 0;
    first[LM.RIGHT_ANKLE].x = 1;
    first[LM.LEFT_FOOT_INDEX].x = 0;
    first[LM.RIGHT_FOOT_INDEX].x = 1;
    smoother.update(first);

    const swapped = landmarks(0);
    swapped[LM.LEFT_ANKLE].x = 1;
    swapped[LM.RIGHT_ANKLE].x = 0;
    swapped[LM.LEFT_FOOT_INDEX].x = 1;
    swapped[LM.RIGHT_FOOT_INDEX].x = 0;
    const result = smoother.update(swapped);

    expect(result[LM.LEFT_ANKLE].x).toBe(0);
    expect(result[LM.RIGHT_ANKLE].x).toBe(1);
    expect(result[LM.LEFT_FOOT_INDEX].x).toBe(0);
    expect(result[LM.RIGHT_FOOT_INDEX].x).toBe(1);
  });
});
