import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPreferences, loadProfile, savePreferences, saveProfile } from './profile.ts';
import type { BodyProfile } from '../core/energy.ts';
import { DEFAULT_PREFERENCES } from '../core/plan.ts';

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

const VALID: BodyProfile = {
  weightKg: 70,
  heightCm: 175,
  ageYears: 25,
  sex: 'male',
  activity: 'light',
  goal: 'maintain',
};

describe('profile storage', () => {
  beforeEach(() => {
    installStorage();
  });

  it('round-trips a valid profile', () => {
    saveProfile(VALID);
    expect(loadProfile()).toEqual(VALID);
  });

  it('reports no profile before one is saved', () => {
    expect(loadProfile()).toBeNull();
  });

  it('rejects a hand-edited profile rather than feeding it to the equation', () => {
    const store = installStorage();
    // localStorage is editable from the console, and these values drive a
    // calorie recommendation. Honouring an edited sex or a string weight would
    // put the equation somewhere it was never validated.
    store.set('latih.profile.v1', JSON.stringify({ ...VALID, sex: 'other' }));
    expect(loadProfile()).toBeNull();

    store.set('latih.profile.v1', JSON.stringify({ ...VALID, weightKg: 'tujuh puluh' }));
    expect(loadProfile()).toBeNull();
  });

  it('survives a corrupted store', () => {
    const store = installStorage();
    store.set('latih.profile.v1', 'not json at all');
    expect(loadProfile()).toBeNull();
  });

  it('does not throw when storage refuses to write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    });

    expect(() => saveProfile(VALID)).not.toThrow();
  });
});

describe('preference storage', () => {
  beforeEach(() => {
    installStorage();
  });

  it('returns the defaults when nothing is stored', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips saved preferences', () => {
    const prefs = { ...DEFAULT_PREFERENCES, daysPerWeek: 5, timeOfDay: '06:30' };
    savePreferences(prefs);
    expect(loadPreferences()).toEqual(prefs);
  });

  it('falls back per field, not wholesale', () => {
    const store = installStorage();
    // An older version, or a partial write. Losing one key should not cost the
    // user their whole schedule.
    store.set('latih.preferences.v1', JSON.stringify({ daysPerWeek: 4 }));

    const loaded = loadPreferences();
    expect(loaded.daysPerWeek).toBe(4);
    expect(loaded.timeOfDay).toBe(DEFAULT_PREFERENCES.timeOfDay);
    expect(loaded.setsPerExercise).toBe(DEFAULT_PREFERENCES.setsPerExercise);
  });

  it('clamps a frequency outside the sensible range', () => {
    const store = installStorage();
    store.set('latih.preferences.v1', JSON.stringify({ daysPerWeek: 99 }));
    expect(loadPreferences().daysPerWeek).toBe(6);
  });

  it('keeps the day count in step with the days picked', () => {
    const store = installStorage();
    // The two disagree; the explicit days are the stronger answer, and a
    // schedule that says "3 hari" while training four days reads as a lie.
    store.set(
      'latih.preferences.v1',
      JSON.stringify({ daysPerWeek: 3, trainingDays: [0, 2, 4, 6] }),
    );

    const loaded = loadPreferences();
    expect(loaded.trainingDays).toEqual([0, 2, 4, 6]);
    expect(loaded.daysPerWeek).toBe(4);
  });

  it('discards picked days that are out of range or not days', () => {
    const store = installStorage();
    store.set('latih.preferences.v1', JSON.stringify({ daysPerWeek: 4, trainingDays: [9, 'senin'] }));

    const loaded = loadPreferences();
    expect(loaded.trainingDays).toEqual([]);
    expect(loaded.daysPerWeek).toBe(4);
  });

  it('drops unknown exercises and never leaves the list empty', () => {
    const store = installStorage();
    // Training days with nothing to do on them would be worse than defaults.
    store.set('latih.preferences.v1', JSON.stringify({ exercises: ['burpee'] }));
    expect(loadPreferences().exercises).toEqual(DEFAULT_PREFERENCES.exercises);
  });

  it('rejects a malformed time', () => {
    const store = installStorage();
    store.set('latih.preferences.v1', JSON.stringify({ timeOfDay: 'sore' }));
    expect(loadPreferences().timeOfDay).toBe(DEFAULT_PREFERENCES.timeOfDay);
  });
});
