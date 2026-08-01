/**
 * Rep counting: a two-threshold hysteresis state machine over the primary joint
 * angle.
 *
 * ## Why this is a rule and not a learned model
 *
 * Rep counting is a deterministic property of one scalar crossing two
 * thresholds in order. A learned model would be slower, unexplainable, and
 * would need training data to reproduce behaviour we can specify exactly. The
 * classifier earns its place on form errors that a per-frame threshold cannot
 * express (tempo collapse, left-right asymmetry) — not here.
 *
 * ## Three guards, each for a distinct failure
 *
 * 1. **Hysteresis.** Two separate thresholds mean a phantom rep requires an
 *    implausibly large excursion, not a wobble around one boundary.
 * 2. **Dwell time.** A crossing only commits once the angle has stayed past the
 *    threshold continuously for `minPhaseMs`. Timing from phase *entry* instead
 *    would let a signal oscillating across both thresholds commit anyway, just
 *    because enough wall-clock time had passed.
 * 3. **Descent must be observed.** A rep is only emitted if the machine saw the
 *    descent that preceded the ascent. Without this, starting a set from the
 *    bottom — or resuming after the tracker loses the person mid-rep — reports
 *    half a movement as a whole repetition.
 */

import type { ExerciseKind } from './types';

export type RepPhase = 'unknown' | 'up' | 'down';

export interface RepCounterConfig {
  /** Angle must fall below this to enter the bottom of the rep, degrees. */
  downEnter: number;
  /** Angle must rise above this to return to the top, degrees. */
  upEnter: number;
  /** The angle must stay past a threshold this long before the phase commits. */
  minPhaseMs: number;
  /**
   * If the angle is unavailable (low visibility) for longer than this, the
   * in-flight rep is abandoned rather than completed with invented timings.
   */
  maxHoldMs: number;
}

/**
 * Tuned against the observable range of motion of each movement.
 *
 * ## These gates count the attempt, they do not judge it
 *
 * The thresholds here are deliberately *permissive*: they answer "did the
 * person attempt a repetition", not "was it a good one". Quality is the rules'
 * job (`core/rules.ts`), and the rules can only see a rep the counter emitted.
 *
 * That imposes a hard invariant: **every counter gate must be looser than the
 * corresponding rule threshold.** If `downEnter` equalled the rules' depth
 * threshold, a rep deep enough to be counted would by definition be deep
 * enough to pass, and the shallow-depth rule could never fire on any real
 * repetition — it would be unreachable code that still looked correct in
 * isolation. `rules.test.ts` asserts this relationship so it cannot regress.
 *
 * `minPhaseMs` is 120 ms — about four frames at 30 fps. It has to reject
 * frame-level tracker noise without rejecting fast repetitions: a trained
 * lifter can spend well under 250 ms past the threshold, and dropping those
 * reps is a worse failure than admitting an occasional noisy one. Large-
 * amplitude noise is already handled by the hysteresis band, which a wobble
 * cannot traverse.
 */
export const DEFAULT_CONFIGS: Record<ExerciseKind, RepCounterConfig> = {
  // Elbow: ~170 deg locked out at the top, ~70-90 deg at a good bottom.
  // 135 deg is an unmistakable descent while still leaving shallow reps
  // countable — and therefore coachable.
  pushup: { downEnter: 135, upEnter: 158, minPhaseMs: 120, maxHoldMs: 2000 },
  // Knee: ~175 deg standing, ~90 deg at parallel.
  squat: { downEnter: 140, upEnter: 162, minPhaseMs: 120, maxHoldMs: 2000 },
};

/** One completed repetition. This is the unit the form classifier scores. */
export interface RepEvent {
  /** 1-based position within the current set. */
  index: number;
  /** When the lifter left the top — the last frame at peak extension. */
  startMs: number;
  /** When peak depth was first reached. */
  bottomMs: number;
  /** When lockout was regained. */
  endMs: number;
  /** Deepest angle reached — the depth signal. */
  minAngle: number;
  /** Peak extension before the descent — the lockout signal. */
  maxAngle: number;
  /** Descent duration, ms. */
  eccentricMs: number;
  /** Ascent duration, ms. */
  concentricMs: number;
}

export interface RepCounterStatus {
  phase: RepPhase;
  repCount: number;
  /** True while pose confidence is too low to judge the movement. */
  holding: boolean;
}

interface Extreme {
  angle: number;
  timestampMs: number;
}

/**
 * Stateful across frames, but every transition is a pure function of the
 * arguments — so replaying a recorded landmark sequence through it reproduces
 * exactly what happened live. That property is what lets the eval scripts and
 * the app share this code.
 */
export class RepCounter {
  private readonly config: RepCounterConfig;

  private phase: RepPhase = 'unknown';
  private repCount = 0;

  /** Pending threshold crossing, held until it has lasted `minPhaseMs`. */
  private candidate: { phase: RepPhase; sinceMs: number } | null = null;

  /** Peak extension seen since the last rep ended — the top of this rep. */
  private top: Extreme | null = null;
  /** Deepest point of the descent currently in flight. */
  private bottom: Extreme | null = null;
  /** Null until the machine has actually observed a descent commit. */
  private descentObserved = false;

  private lastValidMs: number | null = null;
  private holding = false;

  constructor(exercise: ExerciseKind, overrides: Partial<RepCounterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIGS[exercise], ...overrides };
  }

  get status(): RepCounterStatus {
    return { phase: this.phase, repCount: this.repCount, holding: this.holding };
  }

  /** Clears counts and in-flight rep state. Call when a new set starts. */
  reset(): void {
    this.phase = 'unknown';
    this.repCount = 0;
    this.candidate = null;
    this.abandonRep();
    this.lastValidMs = null;
    this.holding = false;
  }

  /**
   * Feed one frame.
   *
   * @param angle Primary joint angle in degrees, or null when the pose is not
   *   confidently visible.
   * @returns The completed rep, if this frame finished one.
   */
  update(angle: number | null, timestampMs: number): RepEvent | null {
    if (angle === null) return this.handleMissingPose(timestampMs);

    this.holding = false;
    this.lastValidMs = timestampMs;

    switch (this.phase) {
      case 'unknown':
        // Only adopt a phase from an unambiguous position, so a mid-range
        // starting pose does not immediately produce half a rep.
        if (angle >= this.config.upEnter) this.enterUp(angle, timestampMs);
        else if (angle <= this.config.downEnter) this.enterDown(angle, timestampMs);
        return null;

      case 'up':
        this.trackTop(angle, timestampMs);
        if (this.dwelled('down', angle <= this.config.downEnter, timestampMs)) {
          this.enterDown(angle, timestampMs);
        }
        return null;

      case 'down':
        this.trackBottom(angle, timestampMs);
        if (this.dwelled('up', angle >= this.config.upEnter, timestampMs)) {
          return this.enterUp(angle, timestampMs);
        }
        return null;
    }
  }

  private handleMissingPose(timestampMs: number): null {
    this.holding = true;
    // Losing the person mid-rep makes the tempo meaningless. Drop the rep
    // instead of reporting a duration that spans the blind window.
    if (this.lastValidMs !== null && timestampMs - this.lastValidMs > this.config.maxHoldMs) {
      this.abandonRep();
      this.phase = 'unknown';
      this.candidate = null;
    }
    return null;
  }

  /**
   * True once `satisfied` has held continuously for `minPhaseMs`.
   *
   * Any frame that fails the condition clears the pending crossing, which is
   * what makes an oscillating signal unable to accumulate credit toward a
   * transition.
   */
  private dwelled(phase: RepPhase, satisfied: boolean, timestampMs: number): boolean {
    if (!satisfied) {
      if (this.candidate?.phase === phase) this.candidate = null;
      return false;
    }
    if (this.candidate?.phase !== phase) {
      this.candidate = { phase, sinceMs: timestampMs };
      return false;
    }
    return timestampMs - this.candidate.sinceMs >= this.config.minPhaseMs;
  }

  /** Peak extension, taking the *last* frame at the peak: when they left the top. */
  private trackTop(angle: number, timestampMs: number): void {
    if (this.top === null || angle >= this.top.angle) {
      this.top = { angle, timestampMs };
    }
  }

  /** Peak depth, taking the *first* frame at the peak: when they reached depth. */
  private trackBottom(angle: number, timestampMs: number): void {
    if (this.bottom === null || angle < this.bottom.angle) {
      this.bottom = { angle, timestampMs };
    }
  }

  private enterDown(angle: number, timestampMs: number): void {
    this.phase = 'down';
    this.candidate = null;
    this.bottom = { angle, timestampMs };
    // Adopting 'down' straight from 'unknown' means the descent happened before
    // we were watching, so this rep is not creditable.
    this.descentObserved = this.top !== null;
  }

  /**
   * Commit the ascent. Emits a rep only when the matching descent was observed;
   * otherwise this is just a state change.
   */
  private enterUp(angle: number, timestampMs: number): RepEvent | null {
    const completed = this.descentObserved && this.top !== null && this.bottom !== null;
    let event: RepEvent | null = null;

    if (completed) {
      this.repCount += 1;
      const top = this.top!;
      const bottom = this.bottom!;
      event = {
        index: this.repCount,
        startMs: top.timestampMs,
        bottomMs: bottom.timestampMs,
        endMs: timestampMs,
        minAngle: bottom.angle,
        maxAngle: top.angle,
        eccentricMs: Math.max(0, bottom.timestampMs - top.timestampMs),
        concentricMs: Math.max(0, timestampMs - bottom.timestampMs),
      };
    }

    this.phase = 'up';
    this.candidate = null;
    this.bottom = null;
    this.descentObserved = false;
    // The next rep's top is measured from this lockout onward.
    this.top = { angle, timestampMs };

    return event;
  }

  private abandonRep(): void {
    this.top = null;
    this.bottom = null;
    this.descentObserved = false;
  }
}
