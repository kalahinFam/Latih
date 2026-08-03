import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  buildWeeklyPlan,
  isTrainingDay,
  nextSessionAt,
  startOfWeek,
  trainingWeekdays,
  type PlanPreferences,
} from './plan.ts';
import type { SetRecord } from './sessionLoop.ts';

/** Monday 3 August 2026, 09:00 local. */
const MONDAY = new Date(2026, 7, 3, 9, 0, 0).getTime();

function prefs(overrides: Partial<PlanPreferences> = {}): PlanPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

function set(at: number, overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    exercise: 'pushup',
    at,
    repCount: 10,
    flaggedReps: 0,
    meanDepthDeg: 90,
    trackingQuality: 0.95,
    ...overrides,
  };
}

describe('trainingWeekdays', () => {
  it('spreads sessions rather than clustering them', () => {
    const days = trainingWeekdays(3);
    expect(days).toHaveLength(3);

    // Recovery happens between sessions, so three days in a row is a worse
    // week than the same three spread out.
    const gaps = days.slice(1).map((day, i) => day - days[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);
  });

  it('returns exactly the requested number of days at every frequency', () => {
    for (let n = 2; n <= 6; n += 1) {
      expect(trainingWeekdays(n)).toHaveLength(n);
    }
  });

  it('always leaves a rest day', () => {
    expect(trainingWeekdays(6).length).toBeLessThan(7);
  });

  it('clamps frequencies outside the sensible range', () => {
    expect(trainingWeekdays(1)).toHaveLength(2);
    expect(trainingWeekdays(9)).toHaveLength(6);
  });

  it('never repeats a weekday', () => {
    for (let n = 2; n <= 6; n += 1) {
      const days = trainingWeekdays(n);
      expect(new Set(days).size).toBe(days.length);
    }
  });
});

describe('startOfWeek', () => {
  it('anchors to Monday midnight', () => {
    const start = new Date(startOfWeek(MONDAY));
    expect(start.getDay()).toBe(1);
    expect(start.getHours()).toBe(0);
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = new Date(2026, 7, 9, 20, 0, 0).getTime();
    // Sunday-first indexing would jump the week forward here and mark a day
    // already trained as still to come.
    expect(startOfWeek(sunday)).toBe(startOfWeek(MONDAY));
  });
});

describe('buildWeeklyPlan', () => {
  it('gives every training day the same target for the week', () => {
    const plan = buildWeeklyPlan(prefs(), [], MONDAY);
    const targets = plan.days
      .filter((day) => day.isTraining)
      .map((day) => day.exercises.find((e) => e.exercise === 'pushup')?.targetReps);

    // A target that drifted mid-week would change on days the user has not
    // trained yet, which reads as the app changing its mind.
    expect(new Set(targets).size).toBe(1);
  });

  it('takes its targets from the session loop', () => {
    const day = 24 * 60 * 60 * 1000;
    const history = [
      set(MONDAY - 14 * day, { repCount: 12 }),
      set(MONDAY - 7 * day, { repCount: 12 }),
    ];

    const plan = buildWeeklyPlan(prefs(), history, MONDAY);
    const pushup = plan.days.find((d) => d.isTraining)!.exercises[0];

    // Two clean sessions at 12 with no prior target: adopt 12, then progress.
    expect(pushup.targetReps).toBe(13);
    expect(pushup.reason).toBe('progressed');
  });

  it('marks a day done when history has a set on it', () => {
    const plan = buildWeeklyPlan(prefs(), [set(MONDAY)], MONDAY);
    expect(plan.days[0].done).toBe(true);
    expect(plan.completedDays).toBe(1);
  });

  it('counts progress only against planned days', () => {
    const plan = buildWeeklyPlan(prefs({ daysPerWeek: 3 }), [], MONDAY);
    expect(plan.plannedDays).toBe(3);
    expect(plan.completedDays).toBe(0);
  });

  it('leaves rest days empty', () => {
    const plan = buildWeeklyPlan(prefs(), [], MONDAY);
    for (const day of plan.days) {
      if (!day.isTraining) expect(day.exercises).toEqual([]);
    }
  });

  it('marks exactly one day as today', () => {
    const plan = buildWeeklyPlan(prefs(), [], MONDAY);
    expect(plan.days.filter((day) => day.isToday)).toHaveLength(1);
  });

  it('honours the requested sets, clamped to something survivable', () => {
    expect(buildWeeklyPlan(prefs({ setsPerExercise: 4 }), [], MONDAY).days[0].exercises[0].sets).toBe(4);
    expect(buildWeeklyPlan(prefs({ setsPerExercise: 99 }), [], MONDAY).days[0].exercises[0].sets).toBe(6);
  });

  it('plans only the exercises asked for', () => {
    const plan = buildWeeklyPlan(prefs({ exercises: ['squat'] }), [], MONDAY);
    expect(plan.days[0].exercises.map((e) => e.exercise)).toEqual(['squat']);
  });
});

describe('isTrainingDay', () => {
  it('is true on a scheduled day and false on a rest day', () => {
    const plan = buildWeeklyPlan(prefs({ daysPerWeek: 3 }), [], MONDAY);
    expect(isTrainingDay(plan)).toBe(true);

    const tuesday = new Date(2026, 7, 4, 9, 0, 0).getTime();
    expect(isTrainingDay(buildWeeklyPlan(prefs({ daysPerWeek: 3 }), [], tuesday))).toBe(false);
  });
});

describe('nextSessionAt', () => {
  it('finds today’s session when the time has not passed', () => {
    const plan = buildWeeklyPlan(prefs({ timeOfDay: '18:00' }), [], MONDAY);
    const next = new Date(nextSessionAt(plan, MONDAY)!);

    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(18);
  });

  it('skips to the next training day once today’s time has passed', () => {
    const plan = buildWeeklyPlan(prefs({ timeOfDay: '06:00' }), [], MONDAY);
    expect(nextSessionAt(plan, MONDAY)).toBeGreaterThan(MONDAY);
    expect(new Date(nextSessionAt(plan, MONDAY)!).getDay()).not.toBe(1);
  });

  it('rolls into next week from a spent Sunday', () => {
    const sundayNight = new Date(2026, 7, 9, 23, 0, 0).getTime();
    const plan = buildWeeklyPlan(prefs(), [], sundayNight);

    // Without a second week of lookahead the reminder would have nothing to
    // schedule for the whole of Sunday evening.
    const next = nextSessionAt(plan, sundayNight);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(sundayNight);
  });

  it('falls back to a sane time when the preference is malformed', () => {
    const plan = buildWeeklyPlan(prefs({ timeOfDay: 'nanti aja' }), [], MONDAY);
    expect(new Date(nextSessionAt(plan, MONDAY)!).getHours()).toBe(18);
  });
});
