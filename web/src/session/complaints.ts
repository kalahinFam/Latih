/**
 * Reported pain, and the plan changes it caused.
 *
 * On the device, like everything else here. A complaint is the most personal
 * thing this product will ever hold — it is a health statement, not a rep count
 * — so it does not leave, and nothing derived from it leaves either. The
 * endpoint that reads the sentence never sees this log; it is written after the
 * reply comes back.
 *
 * ## Why a substitution expires at the end of the day
 *
 * A knee that hurt on Tuesday is not evidence about Thursday, and this product
 * has no way to know whether it healed. Carrying the swap forward silently
 * would be the app making a medical judgement it is not equipped for; dropping
 * it and letting the person say so again if it still hurts costs one sentence
 * and claims nothing.
 *
 * The complaint itself is kept. That is a record the user can look at, and the
 * thing they might want to show someone who does make medical judgements.
 */

import type { BodyPart, BodySide, SubstituteMovement } from '../core/restChat.ts';
import type { MovementKind } from '../core/types.ts';

export const COMPLAINTS_KEY = 'latih.complaints.v1';
export const SUBSTITUTIONS_KEY = 'latih.substitutions.v1';

/** Roughly two years of the occasional sore knee. */
const MAX_COMPLAINTS = 100;

export interface ComplaintRecord {
  at: number;
  part: BodyPart;
  side: BodySide | null;
  /** What the user actually said, as spoken or typed. */
  said: string;
  /** The movement swapped out, when the complaint caused one. */
  replaced: MovementKind | null;
  replacedWith: SubstituteMovement | null;
}

export interface ActiveSubstitution {
  from: MovementKind;
  to: SubstituteMovement;
  at: number;
  /** Epoch ms. Local midnight after `at`. */
  expiresAt: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    // Corruption resets to empty rather than throwing, for the same reason as
    // `history.ts`: a stored value that crashes the app on every load is not
    // something the user can recover from.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing, or a full quota. Losing the log is bad; refusing to
    // continue the workout over it would be worse.
  }
}

/** Local midnight after the given moment — when a substitution stops applying. */
export function endOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

export function loadComplaints(): ComplaintRecord[] {
  return read<ComplaintRecord[]>(COMPLAINTS_KEY, []);
}

export function recordComplaint(record: ComplaintRecord): void {
  const all = [...loadComplaints(), record];
  write(COMPLAINTS_KEY, all.slice(-MAX_COMPLAINTS));
}

/**
 * Substitutions still in force.
 *
 * Expired entries are dropped on read rather than by a timer: there is no
 * moment the app is guaranteed to be running at midnight, and a swap that
 * outlives its day because nobody was there to clear it is exactly the silent
 * carry-forward this module refuses to do.
 */
export function activeSubstitutions(now: number = Date.now()): ActiveSubstitution[] {
  const stored = read<ActiveSubstitution[]>(SUBSTITUTIONS_KEY, []);
  const live = stored.filter((entry) => entry.expiresAt > now);

  if (live.length !== stored.length) write(SUBSTITUTIONS_KEY, live);
  return live;
}

/** The substitute for one movement today, or null when it stands as planned. */
export function substituteFor(
  movement: MovementKind,
  now: number = Date.now(),
): SubstituteMovement | null {
  return activeSubstitutions(now).find((entry) => entry.from === movement)?.to ?? null;
}

/**
 * Apply a substitution for the rest of the day.
 *
 * One per movement: complaining twice about the same knee should not leave two
 * competing swaps for the squat, with the reader picking whichever comes first.
 */
export function applySubstitution(
  from: MovementKind,
  to: SubstituteMovement,
  now: number = Date.now(),
): void {
  const others = activeSubstitutions(now).filter((entry) => entry.from !== from);
  write(SUBSTITUTIONS_KEY, [...others, { from, to, at: now, expiresAt: endOfDay(now) }]);
}

/** Used by the settings screen's data reset, and by the tests. */
export function clearComplaints(): void {
  try {
    localStorage.removeItem(COMPLAINTS_KEY);
    localStorage.removeItem(SUBSTITUTIONS_KEY);
  } catch {
    /* nothing to do */
  }
}
