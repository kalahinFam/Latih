import { describe, expect, it } from 'vitest';

import { buildWeeklyPlan, DEFAULT_PREFERENCES } from './plan.ts';
import {
  choosePattern,
  estimatedMinutes,
  hasBackToBackDays,
  movementsOn,
  recommendSplit,
  recommendedSets,
  sessionFor,
  type SplitInput,
} from './split.ts';

/** Monday 3 August 2026, 09:00 local. */
const MONDAY = new Date(2026, 7, 3, 9, 0, 0).getTime();

function input(overrides: Partial<SplitInput> = {}): SplitInput {
  return { trainingDays: [0, 2, 4], experience: 'baru', goal: 'maintain', ...overrides };
}

describe('choosePattern', () => {
  it('trains everything each session when the days are few and spread', () => {
    expect(choosePattern([0, 3])).toBe('full-body');
    expect(choosePattern([0, 2, 4])).toBe('full-body');
  });

  it('splits when sessions are stacked back to back', () => {
    // Friday, Saturday, Sunday is the same frequency as Mon/Wed/Fri and a
    // different training problem: pushing three days running.
    expect(choosePattern([4, 5, 6])).toBe('upper-lower');
  });

  it('splits at four days and above regardless of spacing', () => {
    expect(choosePattern([0, 1, 3, 5])).toBe('upper-lower');
    expect(choosePattern([0, 1, 2, 3, 4, 5])).toBe('upper-lower');
  });

  it('sees the week wrap around', () => {
    // Sunday then Monday is one night's recovery, not six days'.
    expect(hasBackToBackDays([0, 6])).toBe(true);
    expect(hasBackToBackDays([0, 3])).toBe(false);
  });
});

describe('recommendSplit', () => {
  it('puts every movement in every session on a full-body week', () => {
    const split = recommendSplit(input({ trainingDays: [0, 2, 4] }));

    expect(split.pattern).toBe('full-body');
    expect(split.sessions.map((s) => s.weekday)).toEqual([0, 2, 4]);
    for (const session of split.sessions) {
      expect(session.movements).toEqual(['pushup', 'squat', 'plank']);
    }
    expect(split.weeklyFrequency).toEqual({ pushup: 3, squat: 3, plank: 3 });
  });

  it('alternates push and legs when it splits, keeping the trunk in both', () => {
    const split = recommendSplit(input({ trainingDays: [0, 1, 3, 4] }));

    expect(split.sessions.map((s) => s.focus)).toEqual(['upper', 'lower', 'upper', 'lower']);
    expect(movementsOn(split, 0)).toEqual(['pushup', 'plank']);
    expect(movementsOn(split, 1)).toEqual(['squat', 'plank']);
    // Nobody trains twice as often as the plan claims: two each, plank every
    // session because a hold is the cheapest thing here to recover from.
    expect(split.weeklyFrequency).toEqual({ pushup: 2, squat: 2, plank: 4 });
  });

  it('trains the trunk last, so a tired core does not wreck the push-up', () => {
    for (const days of [[0, 2, 4], [0, 1, 3, 4]]) {
      for (const session of recommendSplit(input({ trainingDays: days })).sessions) {
        expect(session.movements[session.movements.length - 1]).toBe('plank');
      }
    }
  });

  it('never lets a movement land more often than there are sessions', () => {
    const split = recommendSplit(input({ trainingDays: [0, 1, 2, 3, 4, 5] }));
    for (const count of Object.values(split.weeklyFrequency)) {
      expect(count).toBeLessThanOrEqual(split.sessions.length);
    }
  });

  it('reports no session on a rest day', () => {
    const split = recommendSplit(input({ trainingDays: [0, 2, 4] }));
    expect(sessionFor(split, 1)).toBeNull();
    expect(movementsOn(split, 1)).toEqual([]);
  });
});

describe('recommendedSets', () => {
  it('starts a beginner low and keeps them there', () => {
    expect(recommendedSets('baru', 'maintain')).toBe(2);
    // Even chasing mass: the first weeks fail on soreness and on quitting, and
    // a third set fixes neither.
    expect(recommendedSets('baru', 'gain')).toBe(2);
  });

  it('adds a set for mass once there is a base to add it to', () => {
    expect(recommendedSets('pernah', 'maintain')).toBe(3);
    expect(recommendedSets('pernah', 'gain')).toBe(4);
    expect(recommendedSets('rutin', 'lose')).toBe(3);
  });
});

describe('estimatedMinutes', () => {
  it('grows with sets and with the rest the goal asks for', () => {
    const lean = recommendSplit(input({ goal: 'lose', experience: 'pernah' }));
    const mass = recommendSplit(input({ goal: 'gain', experience: 'pernah' }));

    expect(estimatedMinutes(lean, lean.sessions[0])).toBeLessThan(
      estimatedMinutes(mass, mass.sessions[0]),
    );
    // A number a person can plan an evening around, not a number that needs a
    // caveat.
    expect(estimatedMinutes(lean, lean.sessions[0])).toBeGreaterThan(5);
    expect(estimatedMinutes(mass, mass.sessions[0])).toBeLessThan(60);
  });
});

describe('the split as the week is built from it', () => {
  it('gives each day the movements the split put there, in its own unit', () => {
    const split = recommendSplit(input({ trainingDays: [0, 1, 3, 4] }));
    const plan = buildWeeklyPlan(DEFAULT_PREFERENCES, [], MONDAY, split);

    const monday = plan.days[0];
    expect(monday.isTraining).toBe(true);
    expect(monday.focusLabel).toBe('Dorongan & inti');
    expect(monday.exercises.map((e) => e.movement)).toEqual(['pushup', 'plank']);
    // A plank is prescribed in seconds. Reading reps off it would print a zero.
    expect(monday.exercises.map((e) => e.unit)).toEqual(['reps', 'seconds']);
    expect(monday.exercises[1].amount).toBeGreaterThan(0);

    expect(plan.plannedDays).toBe(4);
    expect(plan.days[2].isTraining).toBe(false);
    expect(plan.days[2].exercises).toEqual([]);
  });

  it('lets the split override the evenly spread days it would have used', () => {
    // The preferences say three evenly spread days; the split says four.
    const split = recommendSplit(input({ trainingDays: [1, 2, 4, 5] }));
    const plan = buildWeeklyPlan(DEFAULT_PREFERENCES, [], MONDAY, split);
    expect(plan.days.filter((d) => d.isTraining).map((d) => d.weekday)).toEqual([1, 2, 4, 5]);
  });
});
