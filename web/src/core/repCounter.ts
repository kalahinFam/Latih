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

import type { ExerciseKind } from './types.ts';

export type RepPhase = 'unknown' | 'up' | 'down';

export interface RepCounterConfig {
  /** Angle must fall below this to enter the bottom of the rep, degrees. */
  downEnter: number;
  /**
   * Depth that must actually be reached for the repetition to count.
   *
   * ## Two thresholds, two questions
   *
   * `downEnter` asks "is a repetition being attempted" — it is what starts the
   * descent phase and makes the movement observable. `creditMax` asks "did it
   * reach the bottom" and is the only thing that increments the count.
   *
   * An attempt that reverses between the two is still emitted, with
   * `counted: false`, so the app can flag it in amber and say what was wrong.
   * It simply does not add to the number.
   *
   * This is the single depth authority in the system. It used to be split — the
   * counter credited anything past `downEnter` and a separate rule flagged it
   * as shallow afterwards — which meant a set of twelve half squats reported
   * twelve repetitions and twelve corrections. A counter that counts half reps
   * is telling the lifter something untrue about the work they did, and it
   * inflates the target the session loop then progresses from.
   */
  creditMax: number;
  /** Angle must rise above this to return to the top, degrees. */
  upEnter: number;
  /**
   * The angle must stay at credit depth this long before the depth counts.
   *
   * Optional: the squat sets it, because its knee signal is the noisiest of the
   * three movements and a half squat that only dips below `creditMax` for one
   * or two frames must not credit. Leave it undefined for a movement whose
   * credit should land on the first frame it reaches depth (push-up, as it has
   * always worked).
   */
  minCreditMs?: number;
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
 * That imposes a hard invariant: **`creditMax` must be at or below
 * `downEnter`.** The descent phase only begins once the angle passes
 * `downEnter`, so a credit threshold above it could never be evaluated — the
 * machine would award credit for entering the phase rather than for reaching
 * the bottom. `repCounter.test.ts` asserts this so it cannot regress.
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
  // 135 marks an unmistakable descent; 105 is the chest-down position that
  // earns the count.
  pushup: { downEnter: 135, creditMax: 105, upEnter: 158, minPhaseMs: 120, maxHoldMs: 2000 },
  // Knee: ~175 deg standing, ~90 deg at parallel. Parallel is the standard the
  // count is held to, so 90 is the credit threshold; it must persist for
  // 90 ms, so tracker noise cannot credit a half squat that only dips below
  // the threshold for one or two frames.
  squat: {
    downEnter: 140,
    creditMax: 90,
    upEnter: 162,
    minCreditMs: 90,
    minPhaseMs: 120,
    maxHoldMs: 2000,
  },
};

/** One completed attempt at a repetition. */
export interface RepEvent {
  /**
   * Did it reach `creditMax`?
   *
   * False means the lifter went down and came back up without reaching depth.
   * The attempt is still reported — it is worth a correction — but it did not
   * add to the count.
   */
  counted: boolean;
  /**
   * 1-based position within the current set. For an uncounted attempt this is
   * the number it *would* have taken, which is what the count still stands at
   * plus one.
   */
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
  /** Attempts that reversed before reaching depth. */
  rejectedCount: number;
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
  private rejectedCount = 0;

  /** Pending threshold crossing, held until it has lasted `minPhaseMs`. */
  private candidate: { phase: RepPhase; sinceMs: number } | null = null;

  /** Peak extension seen since the last rep ended — the top of this rep. */
  private top: Extreme | null = null;
  /** Deepest point of the descent currently in flight. */
  private bottom: Extreme | null = null;
  /** Null until the machine has actually observed a descent commit. */
  private descentObserved = false;
  /** Form gate failed during the in-flight attempt, so it must not be credited. */
  private attemptInvalid = false;
  /** Continuous dwell at the credit threshold. */
  private creditSinceMs: number | null = null;
  private creditReached = false;

  private lastValidMs: number | null = null;
  private holding = false;

  constructor(exercise: ExerciseKind, overrides: Partial<RepCounterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIGS[exercise], ...overrides };
  }

  get status(): RepCounterStatus {
    return {
      phase: this.phase,
      repCount: this.repCount,
      rejectedCount: this.rejectedCount,
      holding: this.holding,
    };
  }

  /** Clears counts and in-flight rep state. Call when a new set starts. */
  reset(): void {
    this.phase = 'unknown';
    this.repCount = 0;
    this.rejectedCount = 0;
    this.candidate = null;
    this.abandonRep();
    this.lastValidMs = null;
    this.holding = false;
  }

  /**
   * Mark the current descent invalid without destroying its event timing.
   *
   * The counter still emits the attempt when the lifter returns to the top, so
   * the caller can coach it, but `counted` remains false and the rep total does
   * not reward a squat performed with support or a lifted foot.
   */
  invalidateCurrentAttempt(): void {
    if (this.phase === 'down') this.attemptInvalid = true;
  }

  /**
   * Feed one frame.
   *
   * @param angle Primary joint angle in degrees, or null when the pose is not
   *   confidently visible.
   * @returns The completed attempt, if this frame finished one. Check
   *   `counted` before treating it as a repetition.
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
        this.updateCredit(angle, timestampMs);
        if (this.dwelled('up', angle >= this.config.upEnter, timestampMs)) {
          return this.enterUp(angle, timestampMs);
        }
        return null;
    }
  }

  private handleMissingPose(timestampMs: number): null {
    this.holding = true;
    if (!this.creditReached) this.creditSinceMs = null;
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
    this.creditSinceMs = null;
    this.creditReached = false;
    this.updateCredit(angle, timestampMs);
    // Adopting 'down' straight from 'unknown' means the descent happened before
    // we were watching, so this rep is not creditable.
    this.descentObserved = this.top !== null;
  }

  /**
   * Commit the ascent. Emits an attempt only when the matching descent was
   * observed; otherwise this is just a state change.
   */
  private enterUp(angle: number, timestampMs: number): RepEvent | null {
    const attempted = this.descentObserved && this.top !== null && this.bottom !== null;
    let event: RepEvent | null = null;

    if (attempted) {
      const top = this.top!;
      const bottom = this.bottom!;
      // Depth decides credit. Everything else about the attempt is reported
      // either way.
      const counted = this.creditReached && !this.attemptInvalid;

      if (counted) this.repCount += 1;
      else this.rejectedCount += 1;

      event = {
        counted,
        index: counted ? this.repCount : this.repCount + 1,
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
    this.attemptInvalid = false;
    this.creditSinceMs = null;
    this.creditReached = false;
    // The next rep's top is measured from this lockout onward.
    this.top = { angle, timestampMs };

    return event;
  }

  private abandonRep(): void {
    this.top = null;
    this.bottom = null;
    this.descentObserved = false;
    this.attemptInvalid = false;
    this.creditSinceMs = null;
    this.creditReached = false;
  }

  private updateCredit(angle: number, timestampMs: number): void {
    if (this.creditReached) return;
    if (angle > this.config.creditMax) {
      this.creditSinceMs = null;
      return;
    }

    this.creditSinceMs ??= timestampMs;
    const minCreditMs = this.config.minCreditMs;
    if (minCreditMs === undefined || timestampMs - this.creditSinceMs >= minCreditMs) {
      this.creditReached = true;
    }
  }
}
