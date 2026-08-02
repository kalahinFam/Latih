/**
 * Buffers the frames belonging to one repetition.
 *
 * Both consumers of per-rep data need the whole window, not just the endpoints:
 * the rules need the joint angles *at the bottom* (hip sag is only meaningful
 * there), and the classifier needs the full trajectory resampled to a fixed
 * length. Buffering once and handing the same window to both keeps them
 * describing the same repetition.
 */

import type { RepEvent } from './repCounter.ts';
import { median } from './smoothing.ts';
import type { JointAngles } from './types.ts';

export interface RepFrame {
  timestampMs: number;
  angles: JointAngles;
}

export interface RepWindow {
  event: RepEvent;
  /** Frames from the top of the rep through to lockout, in capture order. */
  frames: RepFrame[];
}

/**
 * A rep is bounded by two lockouts, so the buffer has to retain frames from
 * before the rep was known to have started. Capacity is bounded so a long pause
 * mid-set cannot grow memory without limit.
 */
const DEFAULT_CAPACITY = 600; // ~20 s at 30 fps

export class RepWindowBuilder {
  private readonly capacity: number;
  private frames: RepFrame[] = [];

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  push(timestampMs: number, angles: JointAngles): void {
    this.frames.push({ timestampMs, angles });
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  /**
   * Cut the window for a completed rep and drop everything up to its end.
   *
   * Frames are selected by the timestamps the counter reported rather than by
   * position, so the window matches the rep the counter actually emitted even
   * when frames were dropped for low visibility.
   */
  take(event: RepEvent): RepWindow {
    const frames = this.frames.filter(
      (frame) => frame.timestampMs >= event.startMs && frame.timestampMs <= event.endMs,
    );
    // Retain the closing lockout: it is the opening lockout of the next rep.
    this.frames = this.frames.filter((frame) => frame.timestampMs >= event.endMs);
    return { event, frames };
  }

  clear(): void {
    this.frames = [];
  }

  get size(): number {
    return this.frames.length;
  }
}

/** Frames at or near the deepest point, where depth-dependent errors show. */
export function bottomFrames(window: RepWindow, toleranceMs = 150): RepFrame[] {
  const { bottomMs } = window.event;
  const near = window.frames.filter(
    (frame) => Math.abs(frame.timestampMs - bottomMs) <= toleranceMs,
  );
  if (near.length > 0) return near;

  // Fall back to the single closest frame so a rule never silently evaluates
  // against an empty set and reports "no error" for a rep it never inspected.
  const closest = window.frames.reduce<RepFrame | null>((best, frame) => {
    if (best === null) return frame;
    return Math.abs(frame.timestampMs - bottomMs) < Math.abs(best.timestampMs - bottomMs)
      ? frame
      : best;
  }, null);
  return closest ? [closest] : [];
}

/**
 * Median of the defined values, or null when a joint was never visible.
 *
 * Preferred over both mean and extreme for judging a rep: a single badly-fitted
 * frame at the bottom would drag a mean and would *become* an extreme. Depth
 * measured by `min` is the most optimistic reading possible, which is exactly
 * the wrong bias for a rule that decides whether to stay quiet.
 */
export function medianOf(
  frames: RepFrame[],
  select: (angles: JointAngles) => number | null,
): number | null {
  const values = frames.map((frame) => select(frame.angles)).filter((v): v is number => v !== null);
  return median(values);
}

/** Mean of the defined values, or null when a joint was never visible. */
export function meanOf(
  frames: RepFrame[],
  select: (angles: JointAngles) => number | null,
): number | null {
  const values = frames.map((frame) => select(frame.angles)).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Extreme of the defined values, or null when a joint was never visible. */
export function extremeOf(
  frames: RepFrame[],
  select: (angles: JointAngles) => number | null,
  kind: 'min' | 'max',
): number | null {
  const values = frames.map((frame) => select(frame.angles)).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return kind === 'min' ? Math.min(...values) : Math.max(...values);
}
