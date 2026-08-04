import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_JOINTS, highlightFor } from './skeleton.ts';
import { CUE_TEXT } from '../core/rules.ts';
import { LM } from '../core/types.ts';

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
