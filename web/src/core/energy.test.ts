import { describe, expect, it } from 'vitest';

import {
  InvalidProfileError,
  basalMetabolicRate,
  energyTarget,
  mealBudgets,
  type BodyProfile,
} from './energy.ts';

function profile(overrides: Partial<BodyProfile> = {}): BodyProfile {
  return {
    weightKg: 70,
    heightCm: 175,
    ageYears: 25,
    sex: 'male',
    activity: 'light',
    goal: 'maintain',
    ...overrides,
  };
}

describe('basalMetabolicRate', () => {
  // Worked by hand from Mifflin-St Jeor so a refactor cannot quietly change
  // the equation: 10(70) + 6.25(175) - 5(25) + 5 = 1673.75
  it('matches the published equation for men', () => {
    expect(basalMetabolicRate(profile())).toBeCloseTo(1673.75, 2);
  });

  // 10(60) + 6.25(165) - 5(30) - 161 = 1320.25
  it('matches the published equation for women', () => {
    expect(
      basalMetabolicRate(profile({ weightKg: 60, heightCm: 165, ageYears: 30, sex: 'female' })),
    ).toBeCloseTo(1320.25, 2);
  });

  it('falls with age', () => {
    expect(basalMetabolicRate(profile({ ageYears: 50 })))
      .toBeLessThan(basalMetabolicRate(profile({ ageYears: 25 })));
  });
});

describe('energyTarget', () => {
  it('applies the activity factor to reach maintenance', () => {
    const target = energyTarget(profile({ activity: 'moderate' }), false);
    expect(target.maintenance).toBe(Math.round(1673.75 * 1.55));
  });

  it('leaves maintenance untouched when the goal is to maintain', () => {
    const target = energyTarget(profile(), false);
    expect(target.targetKcal).toBeCloseTo(target.maintenance, -1);
  });

  it('cuts for weight loss and adds for gain', () => {
    const lose = energyTarget(profile({ goal: 'lose' }), false).targetKcal;
    const maintain = energyTarget(profile({ goal: 'maintain' }), false).targetKcal;
    const gain = energyTarget(profile({ goal: 'gain' }), false).targetKcal;

    expect(lose).toBeLessThan(maintain);
    expect(gain).toBeGreaterThan(maintain);
  });

  it('adds only a modest amount on a training day', () => {
    const rest = energyTarget(profile(), false).targetKcal;
    const training = energyTarget(profile(), true).targetKcal;

    // Bodyweight training costs far less than people assume. A bonus large
    // enough to matter here would erase the deficit the app just recommended.
    expect(training - rest).toBeLessThanOrEqual(150);
    expect(training).toBeGreaterThan(rest);
  });

  it('never recommends eating below resting expenditure', () => {
    // Small, older, sedentary, cutting — the combination that drives the
    // goal-based number underneath BMR.
    const target = energyTarget(
      profile({ weightKg: 45, heightCm: 150, ageYears: 60, sex: 'female', activity: 'sedentary', goal: 'lose' }),
      false,
    );

    expect(target.targetKcal).toBeGreaterThanOrEqual(target.bmr);
    expect(target.floored).toBe(true);
  });

  it('holds the absolute floor even when BMR is lower still', () => {
    const target = energyTarget(
      profile({ weightKg: 40, heightCm: 145, ageYears: 70, sex: 'female', activity: 'sedentary', goal: 'lose' }),
      false,
    );

    expect(target.targetKcal).toBeGreaterThanOrEqual(1200);
  });

  it('reports the range rather than a single confident number', () => {
    const target = energyTarget(profile(), false);
    expect(target.range.lowKcal).toBeLessThan(target.targetKcal);
    expect(target.range.highKcal).toBeGreaterThan(target.targetKcal);
  });

  it('scales protein with body weight', () => {
    expect(energyTarget(profile({ weightKg: 70 }), false).proteinG).toBe(112);
  });

  it('refuses inputs the equation was never validated on', () => {
    // Returning a number anyway would look exactly as authoritative as a
    // correct one.
    expect(() => energyTarget(profile({ weightKg: 12 }), false)).toThrow(InvalidProfileError);
    expect(() => energyTarget(profile({ heightCm: 300 }), false)).toThrow(InvalidProfileError);
    expect(() => energyTarget(profile({ ageYears: 8 }), false)).toThrow(InvalidProfileError);
    expect(() => energyTarget(profile({ weightKg: Number.NaN }), false)).toThrow(InvalidProfileError);
  });
});

describe('mealBudgets', () => {
  it('splits the day without losing or inventing calories', () => {
    const budgets = mealBudgets(2400);
    const total = budgets.pagi + budgets.siang + budgets.malam;

    // Rounding to ten may shift the total slightly; drifting further would
    // mean the three meals no longer describe the day they came from.
    expect(Math.abs(total - 2400)).toBeLessThanOrEqual(10);
  });

  it('gives lunch the largest share', () => {
    const budgets = mealBudgets(2000);
    expect(budgets.siang).toBeGreaterThan(budgets.pagi);
    expect(budgets.siang).toBeGreaterThan(budgets.malam);
  });
});
