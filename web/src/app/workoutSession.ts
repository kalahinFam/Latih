/**
 * The workout in progress: which movement, which set, what happened so far.
 *
 * Lives for as long as the user is training and is thrown away when they
 * finish. It is deliberately separate from `session/history.ts`, which is the
 * permanent record: this one holds the full `SetSummary` for each set — every
 * repetition, every error — because the end-of-set and summary screens show
 * detail that would be wasteful to keep on disk for a year.
 *
 * Pure state, no DOM, no storage.
 */

import type { SetSummary } from '../core/setSummary.ts';
import type { ExerciseKind } from '../core/types.ts';

export interface WorkoutPlan {
  exercise: ExerciseKind;
  /** Sets intended for this workout. */
  setsPlanned: number;
  /** Rep target per set, from the session loop. */
  targetReps: number;
}

export class WorkoutSession {
  readonly plan: WorkoutPlan;
  private readonly summaries: SetSummary[] = [];

  constructor(plan: WorkoutPlan) {
    this.plan = plan;
  }

  /** 1-based number of the set about to be performed. */
  get currentSet(): number {
    return Math.min(this.summaries.length + 1, this.plan.setsPlanned);
  }

  get setsDone(): number {
    return this.summaries.length;
  }

  get isComplete(): boolean {
    return this.summaries.length >= this.plan.setsPlanned;
  }

  /**
   * Sets recorded so far.
   *
   * A copy: the summary screen reads this while the session may still be
   * running, and handing out the live array invites a screen that renders
   * whatever arrives next.
   */
  get sets(): readonly SetSummary[] {
    return [...this.summaries];
  }

  get lastSet(): SetSummary | null {
    return this.summaries[this.summaries.length - 1] ?? null;
  }

  record(summary: SetSummary): void {
    this.summaries.push(summary);
  }

  get totalReps(): number {
    return this.summaries.reduce((sum, s) => sum + s.repCount, 0);
  }

  /** Reps that broke at least one rule, across the workout. */
  get flaggedReps(): number {
    return this.summaries.reduce(
      (sum, s) => sum + s.reps.filter((rep) => rep.errors.length > 0).length,
      0,
    );
  }

  /** Occurrences per error code, across the workout. */
  get errorCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const summary of this.summaries) {
      for (const [code, n] of Object.entries(summary.errorCounts)) {
        counts[code] = (counts[code] ?? 0) + (n ?? 0);
      }
    }
    return counts;
  }
}
