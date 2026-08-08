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

/** A grounded, shoulder-width squat with the hands well clear of the floor. */
function squatBody(): Landmark[] {
  const body = blank();
  const put = (index: number, x: number, y: number) => {
    body[index] = { x, y, z: 0, visibility: 0.9 };
  };

  put(LM.LEFT_SHOULDER, -0.2, -0.5);
  put(LM.RIGHT_SHOULDER, 0.2, -0.5);
  put(LM.LEFT_HIP, -0.15, 0);
  put(LM.RIGHT_HIP, 0.15, 0);
  put(LM.LEFT_KNEE, -0.2, 0.45);
  put(LM.RIGHT_KNEE, 0.2, 0.45);
  put(LM.LEFT_ANKLE, -0.2, 0.9);
  put(LM.RIGHT_ANKLE, 0.2, 0.9);
  put(LM.LEFT_FOOT_INDEX, -0.22, 0.95);
  put(LM.RIGHT_FOOT_INDEX, 0.22, 0.95);
  put(LM.LEFT_WRIST, -0.45, 0.2);
  put(LM.RIGHT_WRIST, 0.45, 0.2);
  return body;
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

describe('checkPosture — which gates reject a rep', () => {
  function squatBody(): Landmark[] {
    const lm = withTorso(15);
    const at = (i: number, x: number, y: number, z = 0) => {
      lm[i] = { x, y, z, visibility: 0.9 };
    };
    // Standing, feet under the shoulders, hands clear of the floor.
    at(LM.LEFT_SHOULDER, -0.2, -0.5);
    at(LM.RIGHT_SHOULDER, 0.2, -0.5);
    at(LM.LEFT_KNEE, -0.18, 0.45);
    at(LM.RIGHT_KNEE, 0.18, 0.45);
    at(LM.LEFT_ANKLE, -0.19, 0.85);
    at(LM.RIGHT_ANKLE, 0.19, 0.85);
    at(LM.LEFT_FOOT_INDEX, -0.19, 0.92);
    at(LM.RIGHT_FOOT_INDEX, 0.19, 0.92);
    at(LM.LEFT_WRIST, -0.25, -0.05);
    at(LM.RIGHT_WRIST, 0.25, -0.05);
    return lm;
  }

  it('accepts a clean squat', () => {
    const status = checkPosture(squatBody(), 'squat');
    expect(status.issue).toBeNull();
    expect(status.countable).toBe(true);
    expect(status.invalidatesRep).toBe(false);
  });

  it('rejects the rep when a hand is taking weight', () => {
    // A cheat: it makes the movement easier, so the rep is not the rep the
    // count would be claiming.
    const lm = squatBody();
    lm[LM.LEFT_WRIST] = { x: -0.3, y: 0.88, z: 0, visibility: 0.9 };

    const status = checkPosture(lm, 'squat');
    expect(status.issue).toBe('squat-hands-on-floor');
    expect(status.invalidatesRep).toBe(true);
  });

  it('rejects the rep when a heel comes up', () => {
    const lm = squatBody();
    // Ankle rises, toe stays down: the gap between them opens.
    lm[LM.LEFT_ANKLE] = { x: -0.19, y: 0.7, z: 0, visibility: 0.9 };

    const status = checkPosture(lm, 'squat');
    expect(status.issue).toBe('squat-feet-lifted');
    expect(status.invalidatesRep).toBe(true);
  });

  it('warns about a narrow stance but still counts the rep', () => {
    // Not a cheat — squatting inside shoulder width is a preference, and this
    // is the gate most likely to fire on a good rep because ankle separation
    // leans on the depth coordinate the tracker estimates worst.
    const lm = squatBody();
    lm[LM.LEFT_ANKLE] = { x: -0.05, y: 0.85, z: 0, visibility: 0.9 };
    lm[LM.RIGHT_ANKLE] = { x: 0.05, y: 0.85, z: 0, visibility: 0.9 };

    const status = checkPosture(lm, 'squat');
    expect(status.issue).toBe('squat-stance');
    expect(status.invalidatesRep).toBe(false);
    expect(status.countable).toBe(true);
  });
});

describe('postureMessage', () => {
  it('says what to do, not what is wrong internally', () => {
    expect(postureMessage('not-upright')).toContain('dada');
    expect(postureMessage('not-horizontal')).toContain('plank');
  });
});

describe('checkPosture — squat form gates', () => {
  it('allows a grounded shoulder-width squat', () => {
    const status = checkPosture(squatBody(), 'squat');
    expect(status.plausible).toBe(true);
    expect(status.countable).toBe(true);
  });

  it('withholds a squat when a hand reaches the floor', () => {
    const body = squatBody();
    body[LM.LEFT_WRIST].y = 0.95;
    const status = checkPosture(body, 'squat');
    expect(status.issue).toBe('squat-hands-on-floor');
    expect(status.invalidatesRep).toBe(true);
  });

  it('withholds a squat when an ankle lifts from the foot', () => {
    const body = squatBody();
    body[LM.LEFT_ANKLE].y = 0.7;
    expect(checkPosture(body, 'squat').issue).toBe('squat-feet-lifted');
  });

  it('withholds a squat outside shoulder-width stance', () => {
    const body = squatBody();
    body[LM.LEFT_ANKLE].x = -0.05;
    body[LM.RIGHT_ANKLE].x = 0.05;
    expect(checkPosture(body, 'squat').issue).toBe('squat-stance');
  });

  it('keeps the squat visible but not countable when the torso leans too far', () => {
    const status = checkPosture(withTorso(60), 'squat');
    expect(status.plausible).toBe(true);
    expect(status.countable).toBe(false);
    expect(status.invalidatesRep).toBe(false);
    expect(status.issue).toBe('not-upright');
  });

  it('rejects an extreme torso lean as an invalid squat attempt', () => {
    const status = checkPosture(withTorso(72), 'squat');
    expect(status.plausible).toBe(true);
    expect(status.invalidatesRep).toBe(true);
  });
});
