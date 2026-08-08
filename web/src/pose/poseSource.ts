/**
 * MediaPipe PoseLandmarker wrapper.
 *
 * This is the only file that knows MediaPipe exists. `core/` stays free of it
 * so the same fast-loop logic can run under Node against recorded landmark
 * sequences during evaluation.
 *
 * Assets (WASM runtime and the .task model) are served from `public/`, not from
 * a CDN. That is what lets the app run with the network switched off — which is
 * both the privacy claim and the insurance against bad venue wifi during the
 * demo.
 */

import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../core/types.ts';

export type ModelVariant = 'lite' | 'full';

const MODEL_PATHS: Record<ModelVariant, string> = {
  lite: '/models/pose_landmarker_lite.task',
  full: '/models/pose_landmarker_full.task',
};

export interface PoseDetection {
  frame: PoseFrame;
  /** Image-space landmarks, [0,1] over width and height. For drawing only. */
  normalized: Landmark[];
  /** Milliseconds spent inside MediaPipe inference for this frame. */
  inferenceMs: number;
}

/**
 * Merge the two coordinate sets MediaPipe returns.
 *
 * World landmarks carry the metric geometry the angle maths needs, but their
 * `visibility` is not consistently populated across builds. The normalised set
 * always has it. Taking coordinates from one and confidence from the other
 * avoids a silent failure where every joint reads as invisible and the app
 * simply never counts a rep.
 */
function mergeLandmarks(
  world: PoseLandmarkerResult['worldLandmarks'][number],
  normalized: PoseLandmarkerResult['landmarks'][number],
): Landmark[] {
  return world.map((lm, i) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: normalized[i]?.visibility ?? lm.visibility ?? 0,
  }));
}

function toNormalized(landmarks: PoseLandmarkerResult['landmarks'][number]): Landmark[] {
  return landmarks.map((lm) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: lm.visibility ?? 0,
  }));
}

export class PoseSource {
  private landmarker: PoseLandmarker | null = null;
  private variant: ModelVariant = 'lite';
  private lastTimestampMs = -1;
  private loading: { variant: ModelVariant; promise: Promise<void> } | null = null;
  private warmedUp = false;

  get modelVariant(): ModelVariant {
    return this.variant;
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  /** True once a warm-up inference has run on the real video path. */
  get isWarmedUp(): boolean {
    return this.warmedUp;
  }

  /**
   * Load the WASM runtime and model. Slow (tens of MB); call once at startup
   * and show a loading state. Concurrent calls join the same in-flight load
   * instead of building a second landmarker.
   */
  async load(variant: ModelVariant = 'lite'): Promise<void> {
    if (this.landmarker && this.variant === variant) return;
    if (this.loading && this.loading.variant === variant) {
      await this.loading.promise;
      return;
    }
    const promise = this.loadNow(variant);
    this.loading = { variant, promise };
    try {
      await promise;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  private async loadNow(variant: ModelVariant): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    const landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_PATHS[variant],
        // GPU is dramatically faster on mid-range Android. MediaPipe falls back
        // to CPU on its own if the device has no usable WebGL backend.
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });

    this.landmarker?.close();
    this.landmarker = landmarker;
    this.variant = variant;
    this.warmedUp = false;
    // Timestamps must increase monotonically per landmarker instance; a fresh
    // instance starts a fresh clock.
    this.lastTimestampMs = -1;
  }

  /** Swap between the lite and full models. Used for the latency/FPS table. */
  async setVariant(variant: ModelVariant): Promise<void> {
    if (variant === this.variant && this.landmarker) return;
    await this.load(variant);
  }

  /**
   * Run throwaway inferences so the graph initialises now, not on the first
   * real frame. The first detectForVideo call on a fresh landmarker pays a
   * one-time setup cost (shader compile, graph wiring) — and it scales with the
   * actual input, so warming needs the real video path at its real size.
   *
   * No-ops when the video has no frames yet: the caller (the camera screens)
   * retries once the feed is live, and `warmedUp` stays false until the real
   * path has actually run. Best-effort — a failure just means the cost lands
   * on the first visible frame.
   */
  warmUp(video: HTMLVideoElement): void {
    if (!this.landmarker || this.warmedUp) return;
    if (video.readyState < 2) return;
    try {
      const stamp = this.lastTimestampMs + 1;
      for (let i = 0; i < 3; i++) {
        this.landmarker.detectForVideo(video, stamp + i);
      }
      this.warmedUp = true;
    } catch {
      // The real video frame still works — it just pays the setup cost once.
    }
  }

  /**
   * Run inference on the current video frame.
   *
   * Returns null when no person is detected, which the UI surfaces as a framing
   * hint rather than silently freezing the counter.
   */
  detect(video: HTMLVideoElement, timestampMs: number): PoseDetection | null {
    if (!this.landmarker) return null;

    // MediaPipe rejects non-increasing timestamps in VIDEO mode. Two rAF
    // callbacks can land on the same integer millisecond, so nudge forward
    // instead of throwing away the frame.
    const stamp = timestampMs <= this.lastTimestampMs ? this.lastTimestampMs + 1 : timestampMs;
    this.lastTimestampMs = stamp;

    const startedAt = performance.now();
    const result = this.landmarker.detectForVideo(video, stamp);
    const inferenceMs = performance.now() - startedAt;

    const world = result.worldLandmarks?.[0];
    const normalized = result.landmarks?.[0];
    if (!world || !normalized) return null;

    return {
      frame: { landmarks: mergeLandmarks(world, normalized), timestampMs: stamp },
      normalized: toNormalized(normalized),
      inferenceMs,
    };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** Skeleton edges, re-exported so the renderer does not import MediaPipe. */
export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;
