/**
 * Depth correction delivered at the moment of the mistake.
 *
 * ## The problem this fixes
 *
 * Rules run on a completed `RepEvent`, which only exists once the lifter has
 * returned to lockout. So "go deeper" arrived *after* the whole repetition —
 * roughly 600-900 ms late, aimed at a rep that was already finished and
 * counted. Field testing put it plainly: the cue showed up after the rep was
 * done.
 *
 * That contradicted the design principle the pre-rendered audio was built on:
 * a cue that arrives after the repetition it describes is not late, it is
 * wrong.
 *
 * ## Why the reversal is the right moment
 *
 * The mistake is not "reached a shallow bottom" — a lifter on the way down has
 * not made an error yet. The mistake is *deciding to come back up too early*,
 * and that decision is observable: the angle stops decreasing and starts
 * increasing while still short of depth. Firing there catches the lifter mid-
 * ascent, when the next rep can still be different.
 *
 * This does not replace the post-rep rules. Those still judge the completed
 * repetition and feed the set summary; this only pulls the one time-critical
 * correction forward.
 */

import { DEFAULT_CONFIGS } from './repCounter.ts';
import type { ExerciseKind } from './types.ts';

/**
 * Degrees the angle must rise above the session minimum before movement counts
 * as reversed. Small enough to react quickly, large enough that tracker noise
 * at the bottom of a rep does not read as an ascent.
 */
const REVERSAL_MARGIN_DEG = 4;

/** Consecutive rising frames required. Three at 30 fps is ~100 ms. */
const REVERSAL_FRAMES = 3;

/**
 * How far past the depth threshold still counts as "nearly there".
 *
 * Without this, a rep one degree short fires the same correction as one thirty
 * degrees short, and the coach nags over noise. The lifter is trying.
 */
const DEPTH_GRACE_DEG = 8;

export class LiveDepthCue {
  /** The depth that would have earned the count — see `creditMax`. */
  private readonly depthMax: number;

  private minAngle = Number.POSITIVE_INFINITY;
  private risingFrames = 0;
  private lastAngle: number | null = null;
  private firedThisRep = false;

  constructor(exercise: ExerciseKind) {
    this.depthMax = DEFAULT_CONFIGS[exercise].creditMax;
  }

  /**
   * Feed one frame.
   *
   * @param angle Primary joint angle, or null when not confidently visible.
   * @param inDescent True while the rep counter is in its `down` phase.
   * @returns True on the single frame where the correction should fire.
   */
  update(angle: number | null, inDescent: boolean): boolean {
    if (!inDescent) {
      // Back at the top: arm for the next repetition.
      this.reset();
      return false;
    }

    if (angle === null) {
      // Tracking gap. Hold state rather than resetting, so a brief dropout
      // near the bottom does not disarm the check for the whole rep.
      this.risingFrames = 0;
      return false;
    }

    this.minAngle = Math.min(this.minAngle, angle);

    const rising =
      this.lastAngle !== null && angle > this.lastAngle && angle > this.minAngle + REVERSAL_MARGIN_DEG;
    this.risingFrames = rising ? this.risingFrames + 1 : 0;
    this.lastAngle = angle;

    if (this.firedThisRep || this.risingFrames < REVERSAL_FRAMES) return false;

    // Reversal confirmed. Only complain if the bottom was clearly short.
    this.firedThisRep = true;
    return this.minAngle > this.depthMax + DEPTH_GRACE_DEG;
  }

  private reset(): void {
    this.minAngle = Number.POSITIVE_INFINITY;
    this.risingFrames = 0;
    this.lastAngle = null;
    this.firedThisRep = false;
  }
}
