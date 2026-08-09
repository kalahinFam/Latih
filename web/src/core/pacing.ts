/**
 * How often the pose model is allowed to run.
 *
 * ## Why this exists
 *
 * The fast loop was driven by `requestAnimationFrame` alone, which means it ran
 * inference as often as the screen refreshed — 60 times a second on most phones
 * and 120 on the newer ones. Nothing in this product needs that. The counter's
 * guards are wall-clock (`minPhaseMs`, `maxHoldMs`), the smoother's window is
 * five samples whatever their spacing, and a squat takes the better part of a
 * second. Everything above 30 fps was heat.
 *
 * Heat is not a cosmetic problem here. A phone propped on the floor running GPU
 * inference for a twenty-minute session throttles, and a throttled phone does
 * not fail loudly — it quietly stretches each frame until the corrections arrive
 * after the repetition they were about. The session gets worse in exactly the
 * part the user cannot see, late, when they are most tired.
 *
 * ## Why a cap and a floor rather than "as fast as possible"
 *
 * Two different savings. The cap stops work nobody asked for: at 15 fps the
 * setup screen still answers "is the whole body in frame" instantly, and a plank
 * at 12 fps still catches a sagging hip well inside the 300 ms grace the hold
 * tracker allows. The floor protects the one phase where latency is visible —
 * counting — and it is why the degraded cadence is 20 fps and not 10. The median
 * filter costs five frames of lag, which is 165 ms at 30 fps and 250 ms at 20.
 * Below that the "go deeper" cue starts landing after the user has come back up,
 * which is worse than not saying it.
 *
 * ## Why the thresholds have a gap between them
 *
 * A single threshold on a device sitting near it would flip cadence every
 * second, and a rep counted across a cadence flip is a rep counted from two
 * different sampling rates. Degrading at 45 ms and only recovering below 30 ms
 * means a device has to genuinely get better, not merely wobble.
 *
 * Pure: no DOM, no clock, no MediaPipe. Runs under Node with the rest of `core/`.
 */

/**
 * Which part of the session is asking.
 *
 * Not the same as the engine's mode — a plank and a set of squats are both
 * `workout`, and they want very different sampling rates.
 */
export type PacingPhase = 'setup' | 'counting' | 'hold';

export interface Cadence {
  /** Inference runs at most this often. */
  fps: number;
  /** True once the device has shown it cannot keep up at the normal rate. */
  degraded: boolean;
}

/** Framing and the arming timer are slow signals; the wizard needs no more. */
const SETUP_FPS = 15;

/** `DEFAULT_HOLD_CONFIGS.plank.breakGraceMs` is 300 — an 83 ms gap fits inside it. */
const HOLD_FPS = 12;

/** The rate the rep counter's thresholds were tuned at. */
const COUNTING_FPS = 30;

/**
 * The slowest counting is ever allowed to get.
 *
 * See the note above on the median filter: this is a latency floor, not a
 * performance target. A phone that cannot hold 20 fps is better served by a
 * visibly slower count than by a cue that arrives after the repetition.
 */
const COUNTING_DEGRADED_FPS = 20;

/** p95 inference cost above which the device is not keeping up. */
export const DEGRADE_ABOVE_MS = 45;

/** And below which it has recovered. Deliberately not the same number. */
export const RECOVER_BELOW_MS = 30;

export const INITIAL_CADENCE: Cadence = { fps: COUNTING_FPS, degraded: false };

/**
 * The cadence for this frame.
 *
 * `previous` carries the degraded flag forward: between the two thresholds the
 * answer is "whatever it already was", which is what makes the band hysteresis
 * rather than two thresholds in a trench coat.
 *
 * A `posePp95Ms` of 0 means nothing has been measured yet — the first frames of
 * a session, before the ring buffer has anything in it. That must not read as
 * "fast", or a warm phone would be handed the undegraded rate every time the
 * monitor resets.
 */
export function chooseCadence(
  phase: PacingPhase,
  posePp95Ms: number,
  previous: Cadence = INITIAL_CADENCE,
): Cadence {
  const degraded =
    posePp95Ms <= 0
      ? previous.degraded
      : posePp95Ms > DEGRADE_ABOVE_MS
        ? true
        : posePp95Ms < RECOVER_BELOW_MS
          ? false
          : previous.degraded;

  return { fps: fpsFor(phase, degraded), degraded };
}

/**
 * Re-rate an existing verdict for a new phase, without re-judging the device.
 *
 * The caller reads the phase every frame and the p95 only on frames that ran the
 * model — measuring costs a percentile over the sample buffer, and paying that
 * on every screen refresh would spend more deciding to skip than skipping saves.
 * So the two halves of `chooseCadence` are separable, and this is the cheap one.
 */
export function cadenceForPhase(phase: PacingPhase, previous: Cadence): Cadence {
  return { fps: fpsFor(phase, previous.degraded), degraded: previous.degraded };
}

function fpsFor(phase: PacingPhase, degraded: boolean): number {
  switch (phase) {
    case 'setup':
      return SETUP_FPS;
    case 'hold':
      return HOLD_FPS;
    case 'counting':
      return degraded ? COUNTING_DEGRADED_FPS : COUNTING_FPS;
  }
}

/** Milliseconds one frame is owed, for the caller's skip test. */
export function frameIntervalMs(cadence: Cadence): number {
  return 1000 / cadence.fps;
}
