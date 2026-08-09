import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_JOINTS, POSTURE_HIGHLIGHT, highlightFor, postureHighlight } from './skeleton.ts';
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

describe('postureHighlight', () => {
  it('points at the joints each squat gate measures', () => {
    // A rejected rep is ambered like any correction, so the overlay must say
    // where the gate found the fault: the lifted foot, the supporting hand,
    // both ends of the trunk lean.
    expect(postureHighlight('squat-feet-lifted')).toEqual([
      LM.LEFT_ANKLE,
      LM.RIGHT_ANKLE,
      LM.LEFT_FOOT_INDEX,
      LM.RIGHT_FOOT_INDEX,
    ]);
    expect(postureHighlight('squat-hands-on-floor')).toEqual([LM.LEFT_WRIST, LM.RIGHT_WRIST]);
    expect(postureHighlight('not-upright')).toEqual([
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
    ]);
  });

  it('maps every gate the engine can reject a rep with', () => {
    // POSTURE_HIGHLIGHT is keyed by every PostureIssue. The engine only ever
    // rejects with these, and an unmapped one would render a blank overlay
    // under amber text.
    expect(Object.keys(POSTURE_HIGHLIGHT).sort()).toEqual([
      'not-horizontal',
      'not-upright',
      'squat-feet-lifted',
      'squat-hands-on-floor',
      'squat-stance',
    ]);
  });
});
