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
import type { Landmark, PoseFrame } from '../core/types';

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

  get modelVariant(): ModelVariant {
    return this.variant;
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  /**
   * Load the WASM runtime and model. Slow (tens of MB); call once at startup
   * and show a loading state.
   */
  async load(variant: ModelVariant = 'lite'): Promise<void> {
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
