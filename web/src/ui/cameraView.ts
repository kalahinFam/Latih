/**
 * The camera view: the product.
 *
 * Wires the camera to MediaPipe, MediaPipe to the pure fast-loop logic in
 * `core/`, and the results to the screen. Deliberately not a framework
 * component — every high-frequency update (skeleton, rep count, status) goes
 * straight to canvas or to a text node at 30 fps, which is exactly the work a
 * virtual DOM would make more expensive rather than cheaper.
 */

import { computeJointAngles, primaryAngle } from '../core/angles.ts';
import {
  CAMERA_GUIDANCE,
  checkFraming,
  framingMessage,
  type FramingIssue,
} from '../core/framing.ts';
import { PerfMonitor } from '../core/metrics.ts';
import { RepCounter } from '../core/repCounter.ts';
import { MedianFilter } from '../core/smoothing.ts';
import { RepWindowBuilder } from '../core/repWindow.ts';
import { evaluateRules, primaryCue } from '../core/rules.ts';
import { summarizeSet, toRepRecord, type RepRecord, type SetSummary } from '../core/setSummary.ts';
import { CoachError, requestCoaching } from '../coach/coachClient.ts';
import type { ExerciseKind } from '../core/types.ts';
import { PoseSource, type ModelVariant } from '../pose/poseSource.ts';
import { clearSkeleton, drawSkeleton } from './skeleton.ts';

/**
 * How long the person may be undetected before we prompt about framing.
 * Short enough to be helpful, long enough not to flash during a fast rep.
 */
const NO_POSE_GRACE_MS = 700;

/**
 * How long a corrective cue stays on screen.
 *
 * Long enough to read mid-set, short enough that it has cleared before the
 * next repetition arrives — a cue still showing from two reps ago is worse
 * than none, because the user corrects something they already fixed.
 */
const CUE_VISIBLE_MS = 2200;

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'running' }
  | { kind: 'framing'; message: string }
  | { kind: 'low-confidence' }
  | { kind: 'error'; message: string };

export interface CameraViewElements {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  repCount: HTMLElement;
  phase: HTMLElement;
  cue: HTMLElement;
  statusBanner: HTMLElement;
  perf: HTMLElement;
  startButton: HTMLButtonElement;
  exerciseSelect: HTMLSelectElement;
  modelSelect: HTMLSelectElement;
  guide: HTMLDetailsElement;
  guideList: HTMLElement;
  guideNote: HTMLElement;
  finishSetButton: HTMLButtonElement;
  coachPanel: HTMLElement;
  coachNarration: HTMLElement;
  coachFocus: HTMLElement;
  coachMeta: HTMLElement;
}

export class CameraView {
  private readonly pose = new PoseSource();
  private readonly perf = new PerfMonitor();
  private readonly ctx: CanvasRenderingContext2D;

  private counter: RepCounter;
  /**
   * Rejects single-frame tracker glitches before they reach the state machine.
   * MediaPipe solves the skeleton jointly, so poorly tracked legs destabilise
   * the elbow too — which showed up in testing as miscounted push-ups.
   */
  private smoother = new MedianFilter();
  private readonly windows = new RepWindowBuilder();
  private exercise: ExerciseKind = 'pushup';
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private running = false;
  private lastPoseSeenMs = 0;
  private status: Status = { kind: 'idle' };
  private readonly reps: RepRecord[] = [];
  private readonly el: CameraViewElements;

  private setStartedMs = 0;
  private trackedFrames = 0;
  private heldFrames = 0;
  private cueUntilMs = 0;

  constructor(el: CameraViewElements) {
    this.el = el;
    const ctx = el.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.counter = new RepCounter(this.exercise);

    el.startButton.addEventListener('click', () => void this.toggle());
    el.exerciseSelect.addEventListener('change', () => {
      this.exercise = el.exerciseSelect.value as ExerciseKind;
      // Thresholds and rules are per-exercise, so anything measured under the
      // previous movement is meaningless now.
      this.startNewSet();
      this.renderGuidance();
      this.render();
    });

    this.renderGuidance();
    el.modelSelect.addEventListener('change', () => {
      void this.pose.setVariant(el.modelSelect.value as ModelVariant);
    });
    el.finishSetButton.addEventListener('click', () => void this.finishSet());

    this.render();
  }

  /**
   * End the set and ask the slow loop for narrative feedback.
   *
   * Counting stops first. Reps performed while the coach is thinking would land
   * in a set that has already been summarised, and would silently go missing.
   */
  private async finishSet(): Promise<void> {
    if (!this.running) return;
    const summary = this.summarizeCurrentSet();
    this.stop();

    this.el.coachPanel.hidden = false;
    this.el.coachNarration.textContent = 'Menganalisis set…';
    this.el.coachFocus.textContent = '';
    this.el.coachMeta.textContent = '';

    try {
      const feedback = await requestCoaching(summary);
      this.el.coachNarration.textContent = feedback.narasi;
      this.el.coachFocus.textContent = feedback.fokus_set_berikutnya;
      this.el.coachMeta.textContent =
        feedback.latencyMs && feedback.usage
          ? `${(feedback.latencyMs / 1000).toFixed(1)} s · ${feedback.usage.promptTokens}+${feedback.usage.completionTokens} token · $${feedback.usage.costUsd.toFixed(6)}`
          : '';
    } catch (error) {
      // The fast loop already did its job on device. Losing the narration is a
      // degraded set, not a failed one, so say so and let training continue.
      this.el.coachNarration.textContent =
        error instanceof CoachError ? error.message : 'Umpan balik pelatih tidak tersedia.';
      this.el.coachFocus.textContent = `Set tercatat: ${summary.repCount} repetisi.`;
    }
  }

  /** Completed reps for the current set. */
  get completedReps(): readonly RepRecord[] {
    return this.reps;
  }

  get performance() {
    return this.perf.snapshot();
  }

  /**
   * The payload the slow loop will post. Nothing image-shaped can reach it —
   * see the privacy contract in `core/setSummary.ts`.
   */
  summarizeCurrentSet(): SetSummary {
    const total = this.trackedFrames + this.heldFrames;
    return summarizeSet(this.exercise, this.reps, {
      durationMs: this.setStartedMs === 0 ? 0 : performance.now() - this.setStartedMs,
      trackingQuality: total === 0 ? 0 : this.trackedFrames / total,
    });
  }

  private startNewSet(): void {
    this.counter = new RepCounter(this.exercise);
    this.smoother = new MedianFilter();
    this.windows.clear();
    this.reps.length = 0;
    this.setStartedMs = performance.now();
    this.trackedFrames = 0;
    this.heldFrames = 0;
    this.cueUntilMs = 0;
    this.el.cue.hidden = true;
  }

  private async toggle(): Promise<void> {
    if (this.running) this.stop();
    else await this.start();
  }

  private async start(): Promise<void> {
    try {
      this.setStatus({ kind: 'loading', message: 'Menyiapkan kamera…' });
      await this.openCamera();

      if (!this.pose.ready) {
        // Tens of megabytes of WASM and model weights; say so rather than
        // appearing frozen.
        this.setStatus({ kind: 'loading', message: 'Memuat model pose…' });
        await this.pose.load(this.el.modelSelect.value as ModelVariant);
      }

      this.startNewSet();
      this.perf.reset();
      this.running = true;
      this.lastPoseSeenMs = performance.now();
      this.el.startButton.textContent = 'Berhenti';
      this.el.finishSetButton.hidden = false;
      this.el.coachPanel.hidden = true;
      this.setStatus({ kind: 'running' });
      this.loop();
    } catch (error) {
      this.stop();
      this.setStatus({ kind: 'error', message: describeStartError(error) });
    }
  }

  private stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.el.video.srcObject = null;

    clearSkeleton(this.ctx);
    this.el.startButton.textContent = 'Mulai';
    this.el.finishSetButton.hidden = true;
    if (this.status.kind !== 'error') this.setStatus({ kind: 'idle' });
  }

  private async openCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        // The pose model downsamples anyway; requesting more pixels costs
        // bandwidth and battery for no accuracy gain.
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    this.stream = stream;
    this.el.video.srcObject = stream;
    await this.el.video.play();

    // Match the canvas to the video's intrinsic size so overlay coordinates
    // need no per-frame rescaling.
    this.el.canvas.width = this.el.video.videoWidth;
    this.el.canvas.height = this.el.video.videoHeight;
  }

  private loop = (): void => {
    if (!this.running) return;

    const frameStart = performance.now();
    const detection = this.pose.detect(this.el.video, frameStart);

    if (detection === null) {
      // Hold the counter: a rep counted from a pose we cannot see is worse
      // than no count, because the user sees the error immediately.
      this.counter.update(null, frameStart);
      this.smoother.push(null);
      this.heldFrames += 1;
      clearSkeleton(this.ctx);
      if (frameStart - this.lastPoseSeenMs > NO_POSE_GRACE_MS) {
        this.setStatus({ kind: 'framing', message: framingMessage({ kind: 'no-pose' }, this.exercise) });
      }
    } else {
      this.lastPoseSeenMs = frameStart;
      this.perf.recordPose(detection.inferenceMs);

      const fastLoopStart = performance.now();
      // Framing is judged on image-space landmarks: the question is literally
      // whether the body is inside the picture, which world coordinates cannot
      // answer.
      const framing = checkFraming(detection.normalized, this.exercise);
      const angles = computeJointAngles(detection.frame.landmarks);
      const angle = this.smoother.push(primaryAngle(angles, this.exercise));
      this.windows.push(detection.frame.timestampMs, angles);
      const rep = this.counter.update(angle, detection.frame.timestampMs);

      if (rep) {
        const findings = evaluateRules(this.exercise, this.windows.take(rep));
        this.reps.push(toRepRecord(rep, findings));
        this.showCue(primaryCue(findings)?.cue ?? null, frameStart);
      }
      this.perf.recordFastLoop(performance.now() - fastLoopStart);

      if (this.counter.status.holding) this.heldFrames += 1;
      else this.trackedFrames += 1;

      drawSkeleton(this.ctx, detection.normalized);
      // Framing outranks low confidence: a cropped body is *why* confidence is
      // low, and "step back" is something the user can act on.
      this.setStatus(this.framingOrTrackingStatus(framing.issue));
    }

    this.expireCue(frameStart);

    const now = performance.now();
    this.perf.recordFrame(now - frameStart, now);
    this.render();

    this.rafId = requestAnimationFrame(this.loop);
  };

  private renderGuidance(): void {
    const guidance = CAMERA_GUIDANCE[this.exercise];
    const rows: [string, string][] = [
      ['Sudut', guidance.angle],
      ['Tinggi', guidance.height],
      ['Jarak', guidance.distance],
      ['Orientasi', guidance.orientation],
    ];

    this.el.guideList.innerHTML = '';
    for (const [term, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.el.guideList.append(dt, dd);
    }
    this.el.guideNote.textContent = guidance.note;
  }

  private framingOrTrackingStatus(issue: FramingIssue | null): Status {
    if (issue) return { kind: 'framing', message: framingMessage(issue, this.exercise) };
    if (this.counter.status.holding) return { kind: 'low-confidence' };
    return { kind: 'running' };
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.renderStatus();
  }

  /**
   * Show a correction. Placeholder for the pre-generated audio cue: the text
   * lands now, the MP3 playback hooks into the same call site later.
   */
  private showCue(cue: string | null, nowMs: number): void {
    if (cue === null) return;
    this.el.cue.textContent = cue;
    this.el.cue.hidden = false;
    this.cueUntilMs = nowMs + CUE_VISIBLE_MS;
  }

  private expireCue(nowMs: number): void {
    if (!this.el.cue.hidden && nowMs > this.cueUntilMs) this.el.cue.hidden = true;
  }

  private render(): void {
    const { repCount, phase } = this.counter.status;
    this.el.repCount.textContent = String(repCount);
    this.el.phase.textContent = PHASE_LABEL[phase];

    const perf = this.perf.snapshot();
    this.el.perf.textContent =
      perf.frame.count === 0
        ? ''
        : `${perf.fps} fps · pose ${perf.pose.meanMs.toFixed(1)} ms · fast loop ${perf.fastLoop.meanMs.toFixed(2)} ms`;

    this.renderStatus();
  }

  private renderStatus(): void {
    const banner = this.el.statusBanner;
    const message = STATUS_MESSAGE[this.status.kind](this.status);
    banner.textContent = message ?? '';
    banner.dataset.kind = this.status.kind;
    banner.hidden = message === null;
  }
}

const PHASE_LABEL: Record<string, string> = {
  unknown: 'Bersiap',
  up: 'Atas',
  down: 'Bawah',
};

/**
 * Every failure the user can actually hit gets a message that says what to do,
 * not what went wrong internally.
 */
const STATUS_MESSAGE: Record<Status['kind'], (status: Status) => string | null> = {
  idle: () => null,
  running: () => null,
  loading: (s) => (s.kind === 'loading' ? s.message : null),
  framing: (s) => (s.kind === 'framing' ? s.message : null),
  'low-confidence': () => 'Pencahayaan kurang — hitungan ditahan sementara.',
  error: (s) => (s.kind === 'error' ? s.message : null),
};

function describeStartError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return 'Izin kamera ditolak. Aktifkan izin kamera di pengaturan browser, lalu coba lagi.';
      case 'NotFoundError':
        return 'Kamera tidak ditemukan di perangkat ini.';
      case 'NotReadableError':
        return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.';
    }
  }
  if (!window.isSecureContext) {
    return 'Kamera hanya bisa diakses lewat HTTPS. Buka aplikasi ini dari alamat https.';
  }
  return 'Gagal memulai kamera. Muat ulang halaman lalu coba lagi.';
}
