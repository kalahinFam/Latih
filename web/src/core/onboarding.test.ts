import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTRAS,
  EXPERIENCE_LABELS,
  RESTRICTION_LABELS,
  baselineHoldSeconds,
  baselineReps,
  bmi,
  bmiLabel,
  excludedCodes,
  preferredCodes,
  type DietaryRestriction,
  type ExperienceLevel,
} from './onboarding.ts';
import { PANTRY_CODES, PANTRY_LABELS } from './pantry.ts';
import { energyTarget, macroTargets, explainArithmetic, type BodyProfile } from './energy.ts';

const EXPERIENCES = Object.keys(EXPERIENCE_LABELS) as ExperienceLevel[];
const RESTRICTIONS = Object.keys(RESTRICTION_LABELS) as DietaryRestriction[];
const ALL_PANTRY = new Set(Object.values(PANTRY_CODES).flat());

describe('baseline targets', () => {
  it('rises with experience', () => {
    expect(baselineReps('baru', 'pushup')).toBeLessThan(baselineReps('pernah', 'pushup'));
    expect(baselineReps('pernah', 'pushup')).toBeLessThan(baselineReps('rutin', 'pushup'));
  });

  it('covers every experience level and movement', () => {
    for (const level of EXPERIENCES) {
      expect(baselineReps(level, 'pushup')).toBeGreaterThan(0);
      expect(baselineReps(level, 'squat')).toBeGreaterThan(0);
      expect(baselineHoldSeconds(level, 'plank')).toBeGreaterThan(0);
    }
  });

  it('starts a beginner somewhere finishable', () => {
    // A first set that ends early is a good session. A first set that cannot
    // be finished is a reason to stop using the app.
    expect(baselineReps('baru', 'pushup')).toBeLessThanOrEqual(10);
    expect(baselineHoldSeconds('baru', 'plank')).toBeLessThanOrEqual(30);
  });
});

describe('excludedCodes', () => {
  it('removes only codes the pantry actually has', () => {
    // A code that matches nothing is a rule that silently does nothing, which
    // reads as working right up until someone checks.
    for (const code of excludedCodes(RESTRICTIONS)) {
      expect(ALL_PANTRY.has(code), `${code} is not in the pantry`).toBe(true);
    }
  });

  it('removes every fish and shellfish for seafood', () => {
    const excluded = excludedCodes(['seafood']);
    expect(excluded).toContain('GR084');
    expect(excluded).toContain('GR070');
    expect(excluded).toContain('GR050');
  });

  it('leaves eggs and milk to their own answers under vegetarian', () => {
    // The screen offers "Telur" and "Susu sapi" as separate chips, so folding
    // them into vegetarian would take away a choice someone made on purpose.
    const excluded = excludedCodes(['vegetarian']);
    expect(excluded).not.toContain('HR002');
    expect(excluded).not.toContain('JR006');
  });

  it('combines restrictions without duplicating', () => {
    const excluded = excludedCodes(['seafood', 'vegetarian']);
    expect(new Set(excluded).size).toBe(excluded.length);
    expect(excluded).toContain('FR005');
  });

  it('excludes nothing when nothing was chosen', () => {
    expect(excludedCodes([])).toEqual([]);
  });

  it('never empties the pantry', () => {
    // Somebody who ticks every box must still be offered a menu, or the screen
    // that promised to respect their answers produces nothing at all.
    const remaining = [...ALL_PANTRY].filter((c) => !excludedCodes(RESTRICTIONS).includes(c));
    expect(remaining.length).toBeGreaterThan(10);
  });
});

describe('preferredCodes', () => {
  it('passes pantry codes through, sorted and de-duplicated', () => {
    expect(preferredCodes(['CP061', 'CP077'])).toEqual(['CP061', 'CP077']);
    expect(preferredCodes(['CP077', 'CP061', 'CP077'])).toEqual(['CP061', 'CP077']);
  });

  it('ignores a code outside the pantry rather than throwing', () => {
    expect(preferredCodes(['tidak-ada'])).toEqual([]);
    expect(preferredCodes(['CP061', 'TIDAK'])).toEqual(['CP061']);
  });

  it('only names codes that exist in the pantry', () => {
    for (const code of preferredCodes(Object.values(PANTRY_CODES).flat())) {
      expect(ALL_PANTRY.has(code), `${code} is not in the pantry`).toBe(true);
    }
  });

  it('starts with something ticked', () => {
    // An empty preference is a wasted question; the defaults are the
    // ingredients most Indonesian kitchens have.
    expect(DEFAULT_EXTRAS.homeFoods.length).toBeGreaterThan(0);
  });
});

describe('PANTRY_LABELS', () => {
  it('names every curated code', () => {
    for (const code of Object.values(PANTRY_CODES).flat()) {
      expect(PANTRY_LABELS[code], `${code} has no label`).toBeTruthy();
    }
  });
});

describe('bmi', () => {
  it('computes the standard ratio', () => {
    // 68 kg at 172 cm -> 68 / 1.72^2 = 22.98
    expect(bmi(68, 172)).toBeCloseTo(23, 1);
  });

  it('makes a typo obvious', () => {
    // 178 entered for 78: the label is what catches it before the user moves on.
    expect(bmiLabel(bmi(178, 172))).toBe('jauh di atas normal');
    expect(bmiLabel(bmi(68, 172))).toBe('normal');
  });

  it('refuses nonsense rather than returning Infinity', () => {
    expect(bmi(68, 0)).toBeNull();
    expect(bmi(Number.NaN, 172)).toBeNull();
  });
});

function profile(overrides: Partial<BodyProfile> = {}): BodyProfile {
  return {
    weightKg: 68,
    heightCm: 172,
    ageYears: 28,
    sex: 'male',
    activity: 'moderate',
    goal: 'lose',
    ...overrides,
  };
}

describe('macroTargets', () => {
  it('reconstructs the calorie target from its own grams', () => {
    // The closing screen shows the grams and the total side by side. If they
    // disagree the screen is arguing with itself.
    const target = energyTarget(profile(), false);
    const macros = macroTargets(target);
    const fromMacros = macros.proteinG * 4 + macros.fatG * 9 + macros.carbG * 4;

    expect(Math.abs(fromMacros - target.targetKcal)).toBeLessThanOrEqual(12);
  });

  it('sets protein from body weight, not from a share of calories', () => {
    const light = macroTargets(energyTarget(profile({ weightKg: 55 }), false));
    const heavy = macroTargets(energyTarget(profile({ weightKg: 90 }), false));
    expect(heavy.proteinG).toBeGreaterThan(light.proteinG);
  });

  it('never reports negative carbohydrate', () => {
    // A big deficit for a heavy person can leave protein and fat accounting
    // for the whole target.
    const macros = macroTargets(
      energyTarget(profile({ weightKg: 130, activity: 'sedentary', goal: 'lose' }), false),
    );
    expect(macros.carbG).toBeGreaterThanOrEqual(0);
  });

  it('reports shares that add up', () => {
    const macros = macroTargets(energyTarget(profile(), false));
    const sum = macros.shares.protein + macros.shares.fat + macros.shares.carb;
    expect(sum).toBeCloseTo(1, 2);
  });
});

describe('explainArithmetic', () => {
  it('shows the sum, not only the answer', () => {
    const body = profile({ goal: 'lose' });
    const text = explainArithmetic(body, energyTarget(body, false));

    expect(text).toContain('BMR');
    expect(text).toContain('aktivitas');
    expect(text).toContain('dikurangi');
  });

  it('does not describe a deficit that is not being applied', () => {
    const body = profile({ goal: 'maintain' });
    const text = explainArithmetic(body, energyTarget(body, false));

    expect(text).not.toContain('dikurangi');
    expect(text).not.toContain('ditambah');
  });

  it('says so when a floor overrode the goal', () => {
    const body = profile({
      weightKg: 45,
      heightCm: 150,
      ageYears: 60,
      sex: 'female',
      activity: 'sedentary',
      goal: 'lose',
    });
    const target = energyTarget(body, false);

    expect(target.floored).toBe(true);
    expect(explainArithmetic(body, target)).toContain('batas aman');
  });
});
