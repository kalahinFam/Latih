/**
 * Latency and throughput instrumentation.
 *
 * The paper needs a latency/FPS table across at least three phone tiers, and
 * the rubric names operating cost and latency explicitly. Collecting this from
 * the start — rather than bolting it on the night before — means the numbers
 * describe the product as shipped.
 *
 * Percentiles, not just means: a 30 fps average with a 200 ms tail still feels
 * broken to the user, and the mean would hide that.
 */

export interface StageSummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  fps: number;
  /** MediaPipe inference time. */
  pose: StageSummary;
  /** Angles, rep counting and rules — everything in `core/`. */
  fastLoop: StageSummary;
  /** Total per-frame budget, including drawing. */
  frame: StageSummary;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

function summarize(samples: number[]): StageSummary {
  if (samples.length === 0) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    meanMs: total / samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

/** Fixed-capacity ring buffer, so a long session cannot grow memory unbounded. */
class Samples {
  private readonly values: number[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  snapshot(): number[] {
    return this.values;
  }

  clear(): void {
    this.values.length = 0;
  }
}

export class PerfMonitor {
  private readonly pose: Samples;
  private readonly fastLoop: Samples;
  private readonly frame: Samples;
  private frameTimestamps: number[] = [];

  constructor(capacity = 600) {
    this.pose = new Samples(capacity);
    this.fastLoop = new Samples(capacity);
    this.frame = new Samples(capacity);
  }

  recordPose(ms: number): void {
    this.pose.push(ms);
  }

  recordFastLoop(ms: number): void {
    this.fastLoop.push(ms);
  }

  /** Call once per rendered frame with the total frame cost. */
  recordFrame(ms: number, nowMs: number): void {
    this.frame.push(ms);
    this.frameTimestamps.push(nowMs);
    // FPS over a trailing one-second window, which is what the user perceives.
    const cutoff = nowMs - 1000;
    while (this.frameTimestamps.length > 0 && this.frameTimestamps[0] < cutoff) {
      this.frameTimestamps.shift();
    }
  }

  /**
   * Inference p95 alone.
   *
   * `snapshot()` summarises three buffers and is meant for a human reading a
   * table. The pacing check runs inside the loop and wants one number, so it
   * gets one — sorting the other two to throw them away would be work done in
   * the name of saving work.
   */
  get posePp95Ms(): number {
    const sorted = [...this.pose.snapshot()].sort((a, b) => a - b);
    return percentile(sorted, 0.95);
  }

  snapshot(): MetricsSnapshot {
    return {
      fps: this.frameTimestamps.length,
      pose: summarize(this.pose.snapshot()),
      fastLoop: summarize(this.fastLoop.snapshot()),
      frame: summarize(this.frame.snapshot()),
    };
  }

  reset(): void {
    this.pose.clear();
    this.fastLoop.clear();
    this.frame.clear();
    this.frameTimestamps = [];
  }
}
