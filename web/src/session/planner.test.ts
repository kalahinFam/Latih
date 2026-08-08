import { beforeEach, describe, expect, it, vi } from 'vitest';

import { currentSplit, todaysMovements, weekdayOf } from './planner.ts';
import { savePreferences, saveExtras, saveProfile } from './profile.ts';
import { DEFAULT_PREFERENCES } from '../core/plan.ts';
import { DEFAULT_EXTRAS } from '../core/onboarding.ts';
import type { BodyProfile } from '../core/energy.ts';

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

const PROFILE: BodyProfile = {
  weightKg: 70,
  heightCm: 175,
  ageYears: 25,
  sex: 'male',
  activity: 'moderate',
  goal: 'gain',
};

/** Wednesday 5 August 2026 — a training day in the Mon/Wed/Fri schedule below. */
const WEDNESDAY = new Date(2026, 7, 5, 9, 0, 0).getTime();
const TUESDAY = new Date(2026, 7, 4, 9, 0, 0).getTime();

describe('currentSplit', () => {
  beforeEach(() => {
    installStorage();
  });

  it('follows the days the user picked', () => {
    savePreferences({ ...DEFAULT_PREFERENCES, daysPerWeek: 4, trainingDays: [0, 1, 3, 4] });
    const split = currentSplit();

    expect(split.sessions.map((s) => s.weekday)).toEqual([0, 1, 3, 4]);
    expect(split.pattern).toBe('upper-lower');
  });

  it('reads the goal from the profile and the level from onboarding', () => {
    savePreferences({ ...DEFAULT_PREFERENCES, daysPerWeek: 3, trainingDays: [0, 2, 4] });
    saveExtras({ ...DEFAULT_EXTRAS, experience: 'rutin' });
    saveProfile(PROFILE);

    // Gaining mass, with a base to build on: an extra set and a longer rest.
    expect(currentSplit().restSeconds).toBe(90);
  });

  it('lets the stored sets override what the split would have recommended', () => {
    savePreferences({ ...DEFAULT_PREFERENCES, trainingDays: [0, 2, 4], setsPerExercise: 5 });
    saveExtras({ ...DEFAULT_EXTRAS, experience: 'baru' });

    // The recommendation for a beginner is two. What Pengaturan says is what
    // the session will actually run, so it is what the split has to report —
    // otherwise the estimated session length on screen is for a workout nobody
    // is doing.
    expect(currentSplit().setsPerExercise).toBe(5);
  });

  it('works before onboarding has produced a profile', () => {
    // Skipping onboarding must not leave the home screen with no plan to show.
    const split = currentSplit();
    expect(split.sessions.length).toBeGreaterThanOrEqual(2);
    expect(split.restSeconds).toBe(60);
  });
});

describe('todaysMovements', () => {
  beforeEach(() => {
    installStorage();
    savePreferences({ ...DEFAULT_PREFERENCES, daysPerWeek: 3, trainingDays: [0, 2, 4] });
  });

  it('is Monday-first, matching the plan', () => {
    expect(weekdayOf(WEDNESDAY)).toBe(2);
  });

  it('lists what the split put on today', () => {
    expect(todaysMovements(currentSplit(), WEDNESDAY)).toEqual(['pushup', 'squat', 'plank']);
  });

  it('is empty on a rest day', () => {
    expect(todaysMovements(currentSplit(), TUESDAY)).toEqual([]);
  });
});
