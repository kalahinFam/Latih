import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeSubstitutions,
  applySubstitution,
  clearComplaints,
  endOfDay,
  loadComplaints,
  recordComplaint,
  substituteFor,
  SUBSTITUTIONS_KEY,
  type ComplaintRecord,
} from './complaints.ts';

function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

/** Saturday 8 August 2026, 10:00 local. */
const MORNING = new Date(2026, 7, 8, 10, 0, 0).getTime();

function complaint(overrides: Partial<ComplaintRecord> = {}): ComplaintRecord {
  return {
    at: MORNING,
    part: 'lutut',
    side: 'kiri',
    said: 'lutut kiriku sakit',
    replaced: 'squat',
    replacedWith: 'glute-bridge',
    ...overrides,
  };
}

beforeEach(() => {
  installStorage();
});

describe('complaint log', () => {
  it('keeps what the user actually said', () => {
    recordComplaint(complaint());
    expect(loadComplaints()).toEqual([complaint()]);
  });

  it('survives a corrupt store instead of taking the app down with it', () => {
    installStorage({ 'latih.complaints.v1': 'bukan json' });
    expect(loadComplaints()).toEqual([]);
  });

  it('records a complaint that changed nothing', () => {
    // An elbow maps to no substitution. The log should still hold it — it is a
    // health record first and a plan input second.
    recordComplaint(complaint({ part: 'siku', replaced: null, replacedWith: null }));
    expect(loadComplaints()[0]).toMatchObject({ part: 'siku', replaced: null });
  });
});

describe('substitutions', () => {
  it('applies for the rest of the day', () => {
    applySubstitution('squat', 'glute-bridge', MORNING);
    expect(substituteFor('squat', MORNING + 3_600_000)).toBe('glute-bridge');
  });

  it('expires at midnight rather than carrying into tomorrow', () => {
    applySubstitution('squat', 'glute-bridge', MORNING);
    // A knee that hurt today is not evidence about tomorrow, and the app has
    // no way to know whether it healed.
    expect(substituteFor('squat', endOfDay(MORNING) + 1)).toBeNull();
  });

  it('drops expired entries from storage on read', () => {
    const store = installStorage();
    applySubstitution('squat', 'glute-bridge', MORNING);
    activeSubstitutions(endOfDay(MORNING) + 1);
    expect(JSON.parse(store.get(SUBSTITUTIONS_KEY)!)).toEqual([]);
  });

  it('leaves other movements alone', () => {
    applySubstitution('squat', 'glute-bridge', MORNING);
    expect(substituteFor('pushup', MORNING)).toBeNull();
  });

  it('replaces an earlier swap for the same movement instead of stacking', () => {
    applySubstitution('squat', 'glute-bridge', MORNING);
    applySubstitution('squat', 'wall-sit', MORNING + 60_000);

    const live = activeSubstitutions(MORNING + 120_000);
    expect(live).toHaveLength(1);
    expect(live[0].to).toBe('wall-sit');
  });

  it('holds swaps for different movements at once', () => {
    applySubstitution('squat', 'glute-bridge', MORNING);
    applySubstitution('pushup', 'incline-pushup', MORNING);
    expect(activeSubstitutions(MORNING)).toHaveLength(2);
  });

  it('clears both logs together', () => {
    recordComplaint(complaint());
    applySubstitution('squat', 'glute-bridge', MORNING);
    clearComplaints();

    expect(loadComplaints()).toEqual([]);
    expect(activeSubstitutions(MORNING)).toEqual([]);
  });
});

describe('endOfDay', () => {
  it('is the midnight after the moment given, not 24 hours later', () => {
    // 23:30 has half an hour left, not a full day.
    const late = new Date(2026, 7, 8, 23, 30).getTime();
    expect(endOfDay(late)).toBe(new Date(2026, 7, 9, 0, 0, 0, 0).getTime());
  });
});
