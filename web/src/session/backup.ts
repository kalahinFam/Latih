/**
 * Export and restore everything this product knows about its user.
 *
 * ## Why a file rather than an account
 *
 * Keeping history on the device is a promise the rest of the code takes
 * seriously — frames never leave, measurements never leave, and only derived
 * numbers reach an endpoint. The cost of that promise is that clearing site
 * data destroys months of training with no way back, and browsers do that
 * without asking on storage pressure.
 *
 * A file the user holds resolves it without breaking the promise. Syncing
 * through a server would fix the same problem by moving the data to somewhere
 * we said it would never go.
 *
 * ## What is in it, and what is deliberately not
 *
 * The four keys below are the whole of it. `latih.reminder.id.v1` is left out
 * on purpose: it identifies a push subscription belonging to one browser on one
 * device, and restoring it elsewhere would point that phone's reminder switch
 * at a subscription it does not own. `latih.launched.v1` is left out because it
 * is derived — a restored profile already means onboarding is done.
 */

import { HISTORY_KEY } from './history.ts';
import { EXTRAS_KEY, PREFERENCES_KEY, PROFILE_KEY } from './profile.ts';

/** Bumped only if a future format cannot be read by this code. */
const BACKUP_VERSION = 1;

const KEYS = [HISTORY_KEY, PROFILE_KEY, PREFERENCES_KEY, EXTRAS_KEY] as const;

export interface BackupEnvelope {
  app: 'latih';
  version: number;
  exportedAt: string;
  /** Raw stored strings, keyed exactly as `localStorage` holds them. */
  data: Record<string, string>;
}

export type ImportResult = { ok: true; restored: number } | { ok: false; reason: string };

/**
 * Values are copied as their stored strings, not re-parsed and re-serialised.
 *
 * Parsing would mean this module has to understand — and keep understanding —
 * the shape of every record it carries. It does not need to: the readers in
 * `history.ts` and `profile.ts` already validate on load and discard anything
 * malformed, so a backup that carries a value through verbatim cannot introduce
 * a corruption those readers would not already catch.
 */
export function buildBackup(now = new Date()): BackupEnvelope {
  const data: Record<string, string> = {};
  for (const key of KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) data[key] = value;
  }
  return { app: 'latih', version: BACKUP_VERSION, exportedAt: now.toISOString(), data };
}

export function backupFilename(now = new Date()): string {
  return `latih-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function exportBackup(now = new Date()): Blob {
  return new Blob([JSON.stringify(buildBackup(now), null, 2)], {
    type: 'application/json',
  });
}

function isEnvelope(value: unknown): value is BackupEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Partial<BackupEnvelope>;
  return (
    envelope.app === 'latih' &&
    typeof envelope.version === 'number' &&
    typeof envelope.data === 'object' &&
    envelope.data !== null
  );
}

/**
 * Replace the stored data with a backup's contents.
 *
 * All of it or none of it. A half-applied restore leaves a profile that does
 * not match its history, and the session loop reads both together to decide the
 * next target — so the failure would not surface as an error but as targets
 * quietly computed from two different people.
 *
 * Keys absent from the file are cleared rather than left alone, so the result
 * is the state the backup describes rather than a merge of two.
 */
export function importBackup(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'File itu bukan JSON yang sah.' };
  }

  if (!isEnvelope(parsed)) {
    return { ok: false, reason: 'File itu bukan cadangan LATIH.' };
  }

  if (parsed.version > BACKUP_VERSION) {
    return {
      ok: false,
      reason: 'Cadangan itu dibuat versi aplikasi yang lebih baru. Perbarui aplikasinya dulu.',
    };
  }

  const incoming: [string, string][] = [];
  for (const key of KEYS) {
    const value = parsed.data[key];
    if (typeof value === 'string') incoming.push([key, value]);
  }

  if (incoming.length === 0) {
    return { ok: false, reason: 'Cadangan itu tidak berisi data apa pun.' };
  }

  // Snapshot first: a quota error partway through would otherwise leave the
  // user with neither their old data nor the backup's.
  const previous = KEYS.map((key) => [key, localStorage.getItem(key)] as const);

  try {
    for (const key of KEYS) localStorage.removeItem(key);
    for (const [key, value] of incoming) localStorage.setItem(key, value);
  } catch {
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    return { ok: false, reason: 'Penyimpanan perangkat penuh — data lama dikembalikan.' };
  }

  return { ok: true, restored: incoming.length };
}
