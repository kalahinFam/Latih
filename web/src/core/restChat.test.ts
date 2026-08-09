import { describe, expect, it } from 'vitest';

import {
  BODY_PARTS,
  SUBSTITUTE_HOWTO,
  SUBSTITUTE_NAMES,
  describeRemaining,
  describeSubstitution,
  isRestChatReply,
  remainingToday,
  substitutionFor,
  type BodyPart,
} from './restChat.ts';
import { MOVEMENT_NAMES } from './types.ts';

describe('substitutionFor', () => {
  it('replaces the squat when the knee hurts', () => {
    const substitution = substitutionFor('lutut');
    expect(substitution).toMatchObject({ from: 'squat', to: 'glute-bridge' });
  });

  it('marks every substitute as something the camera does not judge', () => {
    // The whole point of keeping these out of MovementKind. A screen that
    // showed a rep count for one of them would be showing a number nothing
    // measured.
    for (const part of BODY_PARTS) {
      const substitution = substitutionFor(part);
      if (substitution) expect(substitution.tracked).toBe(false);
    }
  });

  it('returns nothing when no trained movement loads that part', () => {
    // An elbow complaint changes nothing here, and saying it did would tell
    // somebody their plan moved when it did not.
    expect(substitutionFor('siku')).toBeNull();
    expect(substitutionFor('lainnya')).toBeNull();
  });

  it('offers a replacement for every part it claims to handle', () => {
    for (const part of BODY_PARTS) {
      const substitution = substitutionFor(part);
      if (!substitution) continue;
      expect(SUBSTITUTE_NAMES[substitution.to]).toBeTruthy();
      // Nothing will be counting these, so the instructions are the only thing
      // standing between the user and guessing.
      expect(SUBSTITUTE_HOWTO[substitution.to]).toBeTruthy();
    }
  });

  it('never replaces a movement with one that loads the same joint', () => {
    // A knee complaint answered with a wall sit would be a plan change that
    // changes nothing about the load.
    expect(substitutionFor('lutut')?.to).not.toBe('wall-sit');
  });

  it('describes the swap in the words the screens use', () => {
    const substitution = substitutionFor('lutut')!;
    expect(describeSubstitution(substitution)).toBe(
      `${MOVEMENT_NAMES.squat} diganti ${SUBSTITUTE_NAMES['glute-bridge']}`,
    );
  });
});

describe('remainingToday', () => {
  const today = ['pushup', 'squat', 'plank'] as const;

  it('lists what is left after the current movement', () => {
    expect(remainingToday(today, 'pushup')).toEqual(['squat', 'plank']);
    expect(remainingToday(today, 'squat')).toEqual(['plank']);
    expect(remainingToday(today, 'plank')).toEqual([]);
  });

  it('returns nothing for a movement that is not in today’s session', () => {
    expect(remainingToday(['pushup'], 'squat')).toEqual([]);
  });

  it('says so plainly when the session is over', () => {
    expect(describeRemaining([])).toMatch(/terakhir/i);
  });

  it('reads as a sentence for one and for several', () => {
    expect(describeRemaining(['plank'])).toBe('Habis ini Plank.');
    expect(describeRemaining(['squat', 'plank'])).toBe('Habis ini Squat, lalu Plank.');
  });
});

describe('isRestChatReply', () => {
  const valid = {
    intent: 'complaint',
    bodyPart: 'lutut' as BodyPart,
    side: 'kiri',
    answer: 'Oke, kita ganti gerakannya.',
    substitution: null,
  };

  it('accepts a well-formed reply', () => {
    expect(isRestChatReply(valid)).toBe(true);
  });

  it('rejects a body part outside the closed set', () => {
    // A part nothing maps to would flow into substitutionFor and quietly
    // return null, which reads as "no complaint" rather than "unrecognised".
    expect(isRestChatReply({ ...valid, bodyPart: 'tempurung-lutut' })).toBe(false);
  });

  it('rejects an unknown intent', () => {
    expect(isRestChatReply({ ...valid, intent: 'diagnosis' })).toBe(false);
  });

  it('rejects an empty answer, which would render as a blank coach reply', () => {
    expect(isRestChatReply({ ...valid, answer: '   ' })).toBe(false);
  });

  it('rejects anything that is not an object', () => {
    expect(isRestChatReply(null)).toBe(false);
    expect(isRestChatReply('lutut sakit')).toBe(false);
  });
});
