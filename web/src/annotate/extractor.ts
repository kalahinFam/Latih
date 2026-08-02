/**
 * Video file → keypoints + rep segmentation.
 *
 * Runs the *same* PoseSource and the *same* RepCounter the live app runs, so
 * the landmarks and rep boundaries produced here are byte-for-byte what the
 * product would have produced watching the same movement. That is the whole
 * reason extraction lives in the browser rather than in a Python script: a
 * separate implementation path, even against the same model weights, would
 * make every reported metric a statement about the harness instead of about
 * the product.
 */

import { computeJointAngles, primaryAngle } from '../core/angles.ts';
import { RepCounter, type RepEvent } from '../core/repCounter.ts';
import { RepWindowBuilder } from '../core/repWindow.ts';
import { evaluateRules, type RuleErrorCode } from '../core/rules.ts';
import type { ExerciseKind, Landmark } from '../core/types.ts';
import { PoseSource, type ModelVariant } from '../pose/poseSource.ts';

/** Coordinate precision kept in the export. */
const COORD_DECIMALS = 4;

export interface ExtractedFrame {
  timestampMs: number;
  landmarks: Landmark[];
}

export interface ExtractedRep {
  event: RepEvent;
  /** What the deterministic rules said — the annotator's starting point. */
  suggested: RuleErrorCode[];
}

export interface ExtractionResult {
  exercise: ExerciseKind;
  model: ModelVariant;
  durationMs: number;
  frameCount: number;
  /** Fraction of frames where a pose was detected at all. */
  detectionRate: number;
  frames: ExtractedFrame[];
  reps: ExtractedRep[];
}

export interface ExtractionProgress {
  processedFrames: number;
  currentMs: number;
  durationMs: number;
  repsSoFar: number;
}

function round(value: number): number {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function compactLandmarks(landmarks: Landmark[]): Landmark[] {
  // Full float64 precision would roughly triple the export size for digits
  // far below the tracker's own noise floor.
  return landmarks.map((lm) => ({
    x: round(lm.x),
    y: round(lm.y),
    z: round(lm.z),
    visibility: round(lm.visibility),
  }));
}

/**
 * Iterate a video's frames as the decoder presents them.
 *
 * `requestVideoFrameCallback` gives the true presentation timestamp of each
 * frame, which a `setTimeout` sampling loop cannot — and those timestamps are
 * what the rep counter's tempo measurements are built on.
 */
function eachVideoFrame(
  video: HTMLVideoElement,
  onFrame: (mediaTimeMs: number) => void,
  onDone: () => void,
): void {
  type VideoWithRVFC = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  };
  const el = video as VideoWithRVFC;

  if (typeof el.requestVideoFrameCallback !== 'function') {
    // Fallback for browsers without rVFC: sample on rAF and use currentTime.
    const tick = () => {
      if (video.ended || video.paused) return onDone();
      onFrame(video.currentTime * 1000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return;
  }

  const step = (_now: number, meta: { mediaTime: number }) => {
    onFrame(meta.mediaTime * 1000);
    if (video.ended) return onDone();
    el.requestVideoFrameCallback!(step);
  };
  el.requestVideoFrameCallback(step);
}

export interface ExtractOptions {
  file: File;
  exercise: ExerciseKind;
  model?: ModelVariant;
  /**
   * Playback speed during extraction. Above ~2x the decoder starts dropping
   * frames on mid-range hardware, which silently thins the data.
   */
  playbackRate?: number;
  onProgress?: (progress: ExtractionProgress) => void;
}

export async function extractFromVideo(options: ExtractOptions): Promise<ExtractionResult> {
  const { file, exercise, model = 'lite', playbackRate = 1, onProgress } = options;

  const pose = new PoseSource();
  await pose.load(model);

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.playbackRate = playbackRate;

  try {
    await new Promise<void>((ok, fail) => {
      video.onloadedmetadata = () => ok();
      video.onerror = () => fail(new Error('Video tidak bisa dibaca. Coba format MP4/WebM.'));
    });

    const counter = new RepCounter(exercise);
    const windows = new RepWindowBuilder(Number.MAX_SAFE_INTEGER);
    const frames: ExtractedFrame[] = [];
    const reps: ExtractedRep[] = [];
    let detected = 0;
    let processed = 0;

    const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;

    await new Promise<void>((done) => {
      eachVideoFrame(
        video,
        (mediaTimeMs) => {
          processed += 1;
          const detection = pose.detect(video, mediaTimeMs);

          if (detection === null) {
            counter.update(null, mediaTimeMs);
          } else {
            detected += 1;
            const angles = computeJointAngles(detection.frame.landmarks);
            frames.push({
              timestampMs: Math.round(mediaTimeMs),
              landmarks: compactLandmarks(detection.frame.landmarks),
            });
            windows.push(mediaTimeMs, angles);

            const rep = counter.update(primaryAngle(angles, exercise), mediaTimeMs);
            if (rep) {
              const window = windows.take(rep);
              reps.push({
                event: rep,
                suggested: evaluateRules(exercise, window).map((f) => f.code),
              });
            }
          }

          onProgress?.({
            processedFrames: processed,
            currentMs: mediaTimeMs,
            durationMs,
            repsSoFar: reps.length,
          });
        },
        () => done(),
      );

      void video.play();
    });

    return {
      exercise,
      model,
      durationMs: Math.round(durationMs),
      frameCount: processed,
      detectionRate: processed === 0 ? 0 : detected / processed,
      frames,
      reps,
    };
  } finally {
    pose.close();
    video.pause();
    video.src = '';
    URL.revokeObjectURL(url);
  }
}
