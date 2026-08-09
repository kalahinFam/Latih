import { describe, expect, it } from 'vitest';
import {
  REFERRAL_THRESHOLD,
  REFERRAL_WINDOW_DAYS,
  needsReferral,
  type ComplaintLike,
} from './referral.ts';
import type { BodyPart } from './restChat.ts';

const NOW = Date.UTC(2026, 7, 9, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number, part: BodyPart = 'lutut'): ComplaintLike {
  return { at: NOW - days * DAY, part };
}

describe('needsReferral', () => {
  it('says nothing the first time a part is mentioned', () => {
    expect(needsReferral([], 'lutut', NOW)).toBe(false);
  });

  it('says nothing the second time', () => {
    // Twice is a hard week, not a pattern.
    expect(needsReferral([daysAgo(3)], 'lutut', NOW)).toBe(false);
  });

  it('fires when the current complaint makes the third', () => {
    expect(needsReferral([daysAgo(6), daysAgo(2)], 'lutut', NOW)).toBe(true);
  });

  it('keeps firing beyond the threshold', () => {
    expect(needsReferral([daysAgo(9), daysAgo(6), daysAgo(2)], 'lutut', NOW)).toBe(true);
  });

  it('ignores complaints older than the window', () => {
    // A knee that hurt last month is not evidence about this fortnight — the
    // same stance `complaints.ts` takes when it expires a substitution.
    const stale = [daysAgo(REFERRAL_WINDOW_DAYS + 1), daysAgo(REFERRAL_WINDOW_DAYS + 2)];
    expect(needsReferral(stale, 'lutut', NOW)).toBe(false);
  });

  it('counts a complaint sitting just inside the window', () => {
    const edge = [daysAgo(REFERRAL_WINDOW_DAYS - 0.5), daysAgo(1)];
    expect(needsReferral(edge, 'lutut', NOW)).toBe(true);
  });

  it('does not aggregate across different parts', () => {
    // Three grumbles about three different joints is a beginner having a normal
    // first week, and telling them to see a doctor about it is noise.
    const mixed = [daysAgo(3, 'bahu'), daysAgo(2, 'punggung')];
    expect(needsReferral(mixed, 'lutut', NOW)).toBe(false);
  });

  it('still fires when the same part is reached through unrelated complaints', () => {
    const mixed = [daysAgo(5, 'lutut'), daysAgo(4, 'bahu'), daysAgo(3, 'lutut')];
    expect(needsReferral(mixed, 'lutut', NOW)).toBe(true);
  });

  it('ignores future-dated entries', () => {
    // A device whose clock jumped must not be able to manufacture the message.
    const future = [{ at: NOW + DAY, part: 'lutut' as BodyPart }, daysAgo(1)];
    expect(needsReferral(future, 'lutut', NOW)).toBe(false);
  });

  it('agrees with its own threshold constant', () => {
    const history = Array.from({ length: REFERRAL_THRESHOLD - 2 }, (_, i) => daysAgo(i + 1));
    expect(needsReferral(history, 'lutut', NOW)).toBe(false);
    expect(needsReferral([...history, daysAgo(0.5)], 'lutut', NOW)).toBe(true);
  });
});
