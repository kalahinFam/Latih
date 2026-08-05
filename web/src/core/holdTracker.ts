/**
 * Plank: the clock, and what stops it.
 *
 * ## Why this is not the rep counter with a timer bolted on
 *
 * A repetition is an event — a threshold crossed twice in order. A hold has no
 * events at all; it is a *state* that is either being maintained or is not, and
 * the only quantity is how long it was maintained. The state machine, the
 * signal, and the failure modes are different enough that sharing code would
 * mean a counter full of branches serving neither movement well.
 *
 * ## The clock only runs while the plank is real
 *
 * Time in which the hips had collapsed is not plank time. Crediting it would
 * make a sagging thirty seconds indistinguishable from a held thirty seconds,
 * which is the same error as crediting a half repetition — and this codebase
 * already decided that one: an attempt that does not reach the standard is
 * shown and corrected, not counted.
 *
 * So a break pauses the clock rather than ending the set. The user sees the
 * number stop and the screen turn amber, which says *why* it stopped without
 * any text at all, and the hold resumes the moment the line is straight again.
 *
 * ## Grace, because a plank is not a photograph
 *
 * The hip line wanders continuously under fatigue; there is no frame at which
 * it "breaks". A momentary dip that the lifter immediately corrects is part of
 * holding a plank, not a failure to hold one, so a break has to persist before
 * the clock stops — and has to clear before it restarts.
 *
 * Pure logic: no DOM, no clock of its own. Timestamps arrive from the caller,
 * so replaying a recording reproduces exactly what happened live.
 */

import type { HoldKind } from './types.ts';

export interface HoldConfig {
  /** Hip angle below this is a sag — the body has folded downward. */
  hipSagMin: number;
  /** Hip angle above this is a pike — the hips have risen. */
  hipPikeMax: number;
  /**
   * How long the line must be out of band before the clock stops.
   *
   * Field reasoning rather than data: at 30 fps this is about nine frames, long
   * enough that a wobble the lifter fixes themselves does not interrupt the
   * count, short enough that a genuine collapse is not credited.
   */
  breakGraceMs: number;
  /** How long the line must be back in band before the clock restarts. */
  recoverMs: number;
  /**
   * Losing the pose for longer than this ends the accumulation rather than
   * guessing at time spent unobserved.
   */
  maxHoldMs: number;
}

export const DEFAULT_HOLD_CONFIGS: Record<HoldKind, HoldConfig> = {
  // Shoulder-hip-knee. A straight plank is ~180; the band matches the push-up
  // rules, because it is the same line judged the same way.
  plank: { hipSagMin: 160, hipPikeMax: 200, breakGraceMs: 300, recoverMs: 250, maxHoldMs: 2000 },
};

export type HoldFault = 'hip_sag' | 'hip_pike';

export interface HoldStatus {
  /** Milliseconds credited so far. Only advances while the position is valid. */
  heldMs: number;
  /** True while the clock is running. */
  running: boolean;
  /** What is wrong right now, or null when the line is good. */
  fault: HoldFault | null;
  /** Milliseconds lost to breaks — the honest cost of a wobbling plank. */
  brokenMs: number;
  /** Times the clock stopped. A useful shape-of-the-set number for the coach. */
  breaks: number;
}

/** Reported once the set ends. */
export interface HoldSummary {
  heldMs: number;
  brokenMs: number;
  breaks: number;
  /** Occurrences per fault, for the set summary and the error breakdown. */
  faultCounts: Record<string, number>;
  /** Share of frames the hip line was readable, 0..1. */
  trackingQuality: number;
}

export class HoldTracker {
  private readonly config: HoldConfig;

  private heldMs = 0;
  private brokenMs = 0;
  private breaks = 0;
  private running = false;
  private fault: HoldFault | null = null;

  /** When the current out-of-band or in-band run began. */
  private pendingSinceMs: number | null = null;
  private pendingFault: HoldFault | null = null;

  private lastMs: number | null = null;
  private readableFrames = 0;
  private totalFrames = 0;
  private readonly faultCounts: Record<string, number> = {};

  constructor(movement: HoldKind = 'plank', overrides: Partial<HoldConfig> = {}) {
    this.config = { ...DEFAULT_HOLD_CONFIGS[movement], ...overrides };
  }

  get status(): HoldStatus {
    return {
      heldMs: this.heldMs,
      running: this.running,
      fault: this.fault,
      brokenMs: this.brokenMs,
      breaks: this.breaks,
    };
  }

  reset(): void {
    this.heldMs = 0;
    this.brokenMs = 0;
    this.breaks = 0;
    this.running = false;
    this.fault = null;
    this.pendingSinceMs = null;
    this.pendingFault = null;
    this.lastMs = null;
    this.readableFrames = 0;
    this.totalFrames = 0;
    for (const key of Object.keys(this.faultCounts)) delete this.faultCounts[key];
  }

  /**
   * Feed one frame.
   *
   * @param hipAngle Shoulder-hip-knee angle, or null when not readable.
   * @param inPosition Whether the body is plausibly in a plank at all — the
   *   posture gate. False while the person is standing up or walking away.
   * @returns The fault that *started* on this frame, for the cue. Null
   *   otherwise, including on every frame a known fault continues.
   */
  update(hipAngle: number | null, inPosition: boolean, timestampMs: number): HoldFault | null {
    this.totalFrames += 1;

    const elapsed = this.lastMs === null ? 0 : timestampMs - this.lastMs;
    this.lastMs = timestampMs;

    // A long gap means the frames in between are unaccounted for. Crediting
    // them would reward walking out of shot.
    const gapped = elapsed > this.config.maxHoldMs;
    const usable = hipAngle !== null && inPosition && !gapped;
    if (hipAngle !== null) this.readableFrames += 1;

    if (!usable) {
      // Unreadable is not the same as wrong: no fault is reported, but no time
      // is credited either.
      this.stopClock(elapsed, gapped ? 0 : elapsed);
      this.pendingSinceMs = null;
      this.pendingFault = null;
      return null;
    }

    const fault = this.faultFor(hipAngle);
    return fault === null
      ? this.handleGood(elapsed, timestampMs)
      : this.handleFault(fault, elapsed, timestampMs);
  }

  private faultFor(hipAngle: number): HoldFault | null {
    if (hipAngle < this.config.hipSagMin) return 'hip_sag';
    if (hipAngle > this.config.hipPikeMax) return 'hip_pike';
    return null;
  }

  /** In band. Credit time if running; otherwise wait out the recovery. */
  private handleGood(elapsed: number, timestampMs: number): null {
    if (this.running) {
      this.heldMs += elapsed;
      this.pendingSinceMs = null;
      this.pendingFault = null;
      return null;
    }

    this.brokenMs += elapsed;

    if (this.pendingFault !== null || this.pendingSinceMs === null) {
      this.pendingFault = null;
      this.pendingSinceMs = timestampMs;
      return null;
    }

    if (timestampMs - this.pendingSinceMs >= this.config.recoverMs) {
      this.running = true;
      this.fault = null;
      this.pendingSinceMs = null;
    }
    return null;
  }

  /** Out of band. Keep crediting until the break has lasted past the grace. */
  private handleFault(fault: HoldFault, elapsed: number, timestampMs: number): HoldFault | null {
    if (this.pendingFault !== fault) {
      this.pendingFault = fault;
      this.pendingSinceMs = timestampMs;
    }

    if (this.running) {
      const sustained = timestampMs - (this.pendingSinceMs ?? timestampMs);
      if (sustained < this.config.breakGraceMs) {
        // Still inside the grace: a wobble the lifter may fix themselves.
        this.heldMs += elapsed;
        return null;
      }

      this.running = false;
      this.breaks += 1;
      this.fault = fault;
      this.faultCounts[fault] = (this.faultCounts[fault] ?? 0) + 1;
      // Reported once, on the frame the break commits — not every frame it
      // continues, which would repeat the cue thirty times a second.
      return fault;
    }

    this.brokenMs += elapsed;
    this.fault = fault;
    return null;
  }

  private stopClock(elapsed: number, brokenElapsed: number): void {
    if (this.running) {
      this.running = false;
      this.breaks += 1;
    }
    this.brokenMs += brokenElapsed;
    void elapsed;
  }

  /**
   * Start the clock.
   *
   * Explicit rather than automatic: the set begins when the app says so, after
   * the camera has been framed and the countdown has run.
   */
  start(timestampMs: number): void {
    this.lastMs = timestampMs;
    this.running = true;
    this.fault = null;
    this.pendingSinceMs = null;
    this.pendingFault = null;
  }

  summary(): HoldSummary {
    return {
      heldMs: Math.round(this.heldMs),
      brokenMs: Math.round(this.brokenMs),
      breaks: this.breaks,
      faultCounts: { ...this.faultCounts },
      trackingQuality:
        this.totalFrames === 0 ? 0 : Number((this.readableFrames / this.totalFrames).toFixed(2)),
    };
  }
}
