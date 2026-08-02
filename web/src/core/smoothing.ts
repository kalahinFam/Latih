/**
 * Median filter for the primary joint angle.
 *
 * ## Why this exists
 *
 * MediaPipe solves the whole skeleton jointly — it does not estimate the elbow
 * independently of the ankles. So when the legs are poorly tracked (the usual
 * case in a push-up: the body is horizontal, which is where BlazePose is
 * weakest, and the feet are often near the frame edge), the instability leaks
 * into *every* joint, including the one the rep counter reads. Field testing
 * showed exactly this: bad leg landmarks producing miscounted reps.
 *
 * ## What it actually fixes — and what it does not
 *
 * It does *not* prevent phantom reps. The counter's dwell requirement already
 * rejects any excursion shorter than `minPhaseMs`, and a test written on the
 * assumption that smoothing was needed for that failed: unsmoothed, the
 * counter was already correct.
 *
 * What it fixes is the opposite symptom, and the one actually reported from
 * the field: **missed** reps. When the estimate flickers between two fits, the
 * angle keeps crossing back over the threshold, the dwell candidate resets on
 * every crossing, and a perfectly good repetition never commits. Filtering
 * first turns that flicker into a stable value the counter can act on.
 *
 * It also stabilises the depth the rules read at the bottom of a rep, which
 * feeds directly into how often a corrective cue is right.
 *
 * ## Why median and not a moving average
 *
 * The failure mode is a few frames with badly wrong fits, not gaussian noise.
 * A mean drags toward the outlier; a median discards it outright. A median
 * also preserves the sharp turn at the bottom of a rep, which a mean would
 * round off — and that turn is what the depth measurement reads.
 */

/**
 * Window size in frames. Five frames is ~165 ms at 30 fps, and rejects up to
 * two consecutive bad frames. Wider would reject more but shifts the measured
 * bottom of the rep, which feeds the tempo numbers.
 */
export const DEFAULT_WINDOW = 5;

export class MedianFilter {
  private readonly window: number;
  private readonly buffer: number[] = [];

  constructor(window: number = DEFAULT_WINDOW) {
    if (window < 1 || window % 2 === 0) {
      // An even window has no single middle element, and averaging the two
      // middles reintroduces exactly the outlier sensitivity we came here to
      // avoid.
      throw new Error(`Median window must be odd and >= 1, got ${window}`);
    }
    this.window = window;
  }

  /**
   * Push a sample and get the filtered value.
   *
   * `null` (joint not confidently visible) passes straight through and clears
   * the buffer: the rep counter must see the gap so it can hold, and stale
   * samples from before the dropout would misrepresent what happens after it.
   */
  push(value: number | null): number | null {
    if (value === null) {
      this.buffer.length = 0;
      return null;
    }

    this.buffer.push(value);
    if (this.buffer.length > this.window) this.buffer.shift();

    // Before the buffer fills, return the median of what is there. Waiting for
    // a full window would blind the counter for the first frames of a set.
    const sorted = [...this.buffer].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset(): void {
    this.buffer.length = 0;
  }
}

/** Median of a list, or null when empty. Used by the rules over a rep window. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
