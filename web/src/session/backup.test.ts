import { beforeEach, describe, expect, it, vi } from 'vitest';

import { backupFilename, buildBackup, importBackup } from './backup.ts';
import { HISTORY_KEY } from './history.ts';
import { EXTRAS_KEY, PREFERENCES_KEY, PROFILE_KEY } from './profile.ts';

function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

const SEED = {
  [HISTORY_KEY]: JSON.stringify({ version: 1, sets: [{ exercise: 'pushup', repCount: 12 }], targets: { pushup: 14 } }),
  [PROFILE_KEY]: JSON.stringify({ weightKg: 70, heightCm: 175 }),
  [PREFERENCES_KEY]: JSON.stringify({ daysPerWeek: 3 }),
  [EXTRAS_KEY]: JSON.stringify({ experience: 'beginner' }),
};

describe('buildBackup', () => {
  beforeEach(() => installStorage(SEED));

  it('carries every stored key', () => {
    const backup = buildBackup();
    expect(Object.keys(backup.data).sort()).toEqual(
      [HISTORY_KEY, PROFILE_KEY, PREFERENCES_KEY, EXTRAS_KEY].sort(),
    );
  });

  it('leaves out the push subscription id', () => {
    installStorage({ ...SEED, 'latih.reminder.id.v1': 'abc123' });
    // It belongs to one browser on one device; restoring it elsewhere would
    // aim that phone's reminder switch at a subscription it does not own.
    expect(buildBackup().data['latih.reminder.id.v1']).toBeUndefined();
  });

  it('omits keys that were never written rather than storing empty strings', () => {
    installStorage({ [PROFILE_KEY]: SEED[PROFILE_KEY] });
    expect(Object.keys(buildBackup().data)).toEqual([PROFILE_KEY]);
  });

  it('names the file by the day it was made', () => {
    expect(backupFilename(new Date('2026-08-08T15:04:00Z'))).toBe('latih-backup-2026-08-08.json');
  });
});

describe('importBackup', () => {
  beforeEach(() => installStorage(SEED));

  it('round-trips: export, wipe, restore, identical', () => {
    const file = JSON.stringify(buildBackup());
    const store = installStorage();

    expect(importBackup(file)).toEqual({ ok: true, restored: 4 });
    expect(Object.fromEntries(store)).toEqual(SEED);
  });

  it('clears keys the backup does not carry, rather than merging two states', () => {
    const partial = JSON.stringify({
      app: 'latih',
      version: 1,
      exportedAt: '2026-08-08T00:00:00.000Z',
      data: { [PROFILE_KEY]: SEED[PROFILE_KEY] },
    });
    const store = installStorage(SEED);

    expect(importBackup(partial).ok).toBe(true);
    // Keeping the old history would pair one person's log with another's
    // profile, and the session loop reads both to pick the next target.
    expect(store.has(HISTORY_KEY)).toBe(false);
    expect(store.get(PROFILE_KEY)).toBe(SEED[PROFILE_KEY]);
  });

  it('refuses a file that is not JSON', () => {
    const result = importBackup('bukan json sama sekali');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('JSON') });
  });

  it('refuses JSON that is not a LATIH backup', () => {
    const result = importBackup(JSON.stringify({ some: 'other app', data: {} }));
    expect(result.ok).toBe(false);
  });

  it('refuses a backup from a newer version rather than guessing at its shape', () => {
    const future = JSON.stringify({ app: 'latih', version: 99, exportedAt: '', data: SEED });
    const result = importBackup(future);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('lebih baru') });
  });

  it('refuses an envelope carrying none of the known keys', () => {
    const empty = JSON.stringify({ app: 'latih', version: 1, exportedAt: '', data: { junk: 'x' } });
    expect(importBackup(empty).ok).toBe(false);
  });

  it('leaves existing data untouched when a restore is refused', () => {
    const store = installStorage(SEED);
    importBackup('{}');
    expect(Object.fromEntries(store)).toEqual(SEED);
  });

  it('puts the old data back if the device runs out of room mid-restore', () => {
    const store = new Map(Object.entries(SEED));
    let writes = 0;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (++writes === 2) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    });

    const file = JSON.stringify({
      app: 'latih',
      version: 1,
      exportedAt: '',
      data: { ...SEED, [PROFILE_KEY]: '{"weightKg":80}' },
    });

    expect(importBackup(file).ok).toBe(false);
    // Neither the old data nor the backup would be the worst outcome of all.
    expect(Object.fromEntries(store)).toEqual(SEED);
  });
});
