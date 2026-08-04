import { describe, expect, it } from 'vitest';

import { checkPosture, handsPlanted, postureMessage } from './posture.ts';
import { LANDMARK_COUNT, LM, type Landmark } from './types.ts';

function blank(): Landmark[] {
  return Array.from({ length: LANDMARK_COUNT }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 0,
  }));
}

/**
 * Build a body with a torso at a given lean. World space has -y up, so an
 * upright torso puts the shoulders at negative y relative to the hips.
 */
function withTorso(leanDeg: number, visibility = 0.9): Landmark[] {
  const lm = blank();
  const radians = (leanDeg * Math.PI) / 180;

  for (const hip of [LM.LEFT_HIP, LM.RIGHT_HIP]) {
    lm[hip] = { x: 0, y: 0, z: 0, visibility };
  }
  for (const shoulder of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]) {
    lm[shoulder] = {
      x: Math.sin(radians) * 0.5,
      y: -Math.cos(radians) * 0.5,
      z: 0,
      visibility,
    };
  }
  return lm;
}

describe('checkPosture — squat', () => {
  it('accepts an upright body', () => {
    expect(checkPosture(withTorso(5), 'squat').plausible).toBe(true);
  });

  it('accepts the forward lean a real squat requires', () => {
    // A deep squat with long femurs leans a long way. The trunk-lean *rule*
    // flags 55 degrees; this gate must sit clear above it, or a rep the rules
    // exist to criticise would never reach them.
    expect(checkPosture(withTorso(60), 'squat').plausible).toBe(true);
  });

  it('rejects a body lying down', () => {
    // Reported as "kayak knee crunch dihitung asal kaki ditekuk trus
    // dilurusin". The knee angle trace is identical either way — orientation
    // is the only thing that separates them.
    const status = checkPosture(withTorso(88), 'squat');
    expect(status.plausible).toBe(false);
    expect(status.issue).toBe('not-upright');
  });
});

describe('checkPosture — push-up', () => {
  it('accepts a horizontal body', () => {
    expect(checkPosture(withTorso(85), 'pushup').plausible).toBe(true);
  });

  it('accepts a push-up seen obliquely, which never measures flat', () => {
    expect(checkPosture(withTorso(62), 'pushup').plausible).toBe(true);
  });

  it('rejects someone standing and bending their arms', () => {
    const status = checkPosture(withTorso(8), 'pushup');
    expect(status.plausible).toBe(false);
    expect(status.issue).toBe('not-horizontal');
  });
});

describe('checkPosture — when it cannot tell', () => {
  it('allows counting with no landmarks at all', () => {
    // A missed rep is the failure users notice and resent most, so silence
    // has to be permissive.
    expect(checkPosture(null, 'squat').plausible).toBe(true);
    expect(checkPosture([], 'pushup').plausible).toBe(true);
  });

  it('allows counting when the torso is too faint to read', () => {
    expect(checkPosture(withTorso(90, 0.1), 'squat').plausible).toBe(true);
    expect(checkPosture(withTorso(90, 0.1), 'squat').trunkLeanDeg).toBeNull();
  });
});

describe('handsPlanted', () => {
  function withHands(shoulderY: number, wristY: number, visibility = 0.9): Landmark[] {
    const lm = blank();
    for (const i of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]) {
      lm[i] = { x: 0, y: shoulderY, z: 0, visibility };
    }
    for (const i of [LM.LEFT_WRIST, LM.RIGHT_WRIST]) {
      lm[i] = { x: 0, y: wristY, z: 0, visibility };
    }
    return lm;
  }

  it('accepts hands at or below the shoulders', () => {
    // -y is up, so a larger y is lower.
    expect(handsPlanted(withHands(-0.3, 0.2))).toBe(true);
    expect(handsPlanted(withHands(0, 0))).toBe(true);
  });

  it('rejects hands well above the shoulders', () => {
    expect(handsPlanted(withHands(0.2, -0.4))).toBe(false);
  });

  it('stays permissive when the joints are not visible', () => {
    expect(handsPlanted(withHands(0.2, -0.4, 0.1))).toBe(true);
    expect(handsPlanted(null)).toBe(true);
  });
});

describe('postureMessage', () => {
  it('says what to do, not what is wrong internally', () => {
    expect(postureMessage('not-upright')).toContain('Berdiri');
    expect(postureMessage('not-horizontal')).toContain('plank');
  });
});
