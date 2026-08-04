/**
 * The camera view: the product.
 *
 * Wires the camera to MediaPipe, MediaPipe to the pure fast-loop logic in
 * `core/`, and the results to the screen. Deliberately not a framework
 * component — every high-frequency update (skeleton, rep count, status) goes
 * straight to canvas or to a text node at 30 fps, which is exactly the work a
 * virtual DOM would make more expensive rather than cheaper.
 */

import { computeJointAngles, primaryAngleForCounting } from '../core/angles.ts';
import { LiveDepthCue } from '../core/liveCue.ts';
import {
  CAMERA_GUIDANCE,
  READY_CUE,
  allSetupSpeech,
  checkFraming,
  framingMessage,
  framingSpeech,
  type FramingIssue,
} from '../core/framing.ts';
import { checkPosture, handsPlanted, postureMessage, type PostureIssue } from '../core/posture.ts';
import { PerfMonitor } from '../core/metrics.ts';
import { RepCounter } from '../core/repCounter.ts';
import { MedianFilter } from '../core/smoothing.ts';
import { RepWindowBuilder } from '../core/repWindow.ts';
import { cueFor, evaluateRules, primaryCue } from '../core/rules.ts';
import { summarizeSet, toRepRecord, type RepRecord, type SetSummary } from '../core/setSummary.ts';
import { explainTarget, type ExerciseTarget } from '../core/sessionLoop.ts';
import { TrainingHistory, toSetRecord } from '../session/history.ts';
import { loadPreferences } from '../session/profile.ts';
import { CoachError, requestCoaching } from '../coach/coachClient.ts';
import { allCueTexts } from '../core/rules.ts';
import { Voice } from '../audio/voice.ts';
import type { ExerciseKind } from '../core/types.ts';
import { PoseSource, type ModelVariant } from '../pose/poseSource.ts';
import { DEFAULT_SKELETON_STYLE, clearSkeleton, drawSkeleton, highlightFor } from './skeleton.ts';

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

/**
 * How often the same framing problem may be spoken again.
 *
 * Long enough not to nag, short enough that someone who was mid-repetition the
 * first time still hears it.
 */
const FRAMING_SPEECH_INTERVAL_MS = 8000;

/**
 * How long framing must stay good before counting begins.
 *
 * A set that starts the instant the camera glimpses a body starts while the
 * user is still walking into position, and the first "repetition" is them
 * lying down. Holding for a moment also gives them time to see that the
 * skeleton has locked on, which is the only feedback that the setup worked.
 */
const READY_HOLD_MS = 1200;

/**
 * Above this target, the strip column stops being readable at a glance and
 * becomes a texture. The caption already states the number, so the strips are
 * simply omitted rather than crammed.
 */
const MAX_STRIPS = 20;

const MOVEMENT_LABEL: Record<ExerciseKind, string> = {
  pushup: 'PUSH-UP',
  squat: 'SQUAT',
};

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'running' }
  | { kind: 'framing'; message: string }
  | { kind: 'posture'; message: string }
  | { kind: 'arming' }
  | { kind: 'low-confidence' }
  | { kind: 'error'; message: string };

export interface CameraViewElements {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  hudWash: HTMLElement;
  movementLabel: HTMLElement;
  repStrips: HTMLElement;
  repCount: HTMLElement;
  repCaption: HTMLElement;
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
  private readonly voice = new Voice();
  private readonly ctx: CanvasRenderingContext2D;

  private counter: RepCounter;
  /**
   * Rejects single-frame tracker glitches before they reach the state machine.
   * MediaPipe solves the skeleton jointly, so poorly tracked legs destabilise
   * the elbow too — which showed up in testing as miscounted push-ups.
   */
  private smoother = new MedianFilter();
  /**
   * Fires the depth correction at the reversal, not after the rep completes.
   * Built in the constructor: a field initializer would run before `exercise`
   * has a value.
   */
  private liveCue: LiveDepthCue;
  private readonly windows = new RepWindowBuilder();
  /** Session loop: on-device history, and the target it derives from it. */
  private readonly history = new TrainingHistory();
  private target: ExerciseTarget;
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
  /**
   * Codes already spoken for the repetition in flight, so a correction fired
   * live at the reversal is not repeated by the post-rep rules a moment later.
   */
  private readonly spokenThisRep = new Set<string>();
  /**
   * Frames where the counting angle was unavailable.
   *
   * Surfaced on screen because "reps are being missed" is not actionable, and
   * "the joint angle was readable in 61% of frames" points straight at the
   * camera setup. Turns the next round of feedback into a number.
   */
  private nullAngleFrames = 0;
  /**
   * Frames rejected because the body was not in the movement. Surfaced with the
   * other counters so "why did nothing count" has a number behind it.
   */
  private implausibleFrames = 0;
  /**
   * When the framing problem currently on screen may next be spoken.
   *
   * Repeating it every frame would be unusable, and saying it once would miss
   * the user who was mid-rep and did not hear it.
   */
  private framingSpokenUntilMs = 0;
  private lastSpokenFraming: string | null = null;
  /**
   * Counting is suspended until the camera has held a good view. Set once per
   * set; a framing problem mid-set warns but does not disarm, because stopping
   * the count halfway through someone's set is worse than a few noisy frames.
   */
  private armed = false;
  private goodFramingSinceMs: number | null = null;
  /**
   * Joints the visible correction refers to, drawn amber on the overlay.
   * Cleared with the cue, so the highlight and the text always agree.
   */
  private highlightJoints: readonly number[] = [];
  /** Sets finished in this session, for the "SET 2/3" label. */
  private setsDone = 0;
  /** Rep count the strips were last rendered for, so the loop can skip work. */
  private strippedDone = -1;

  constructor(el: CameraViewElements) {
    this.el = el;
    const ctx = el.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.counter = new RepCounter(this.exercise);
    this.liveCue = new LiveDepthCue(this.exercise);
    this.target = this.history.currentTarget(this.exercise);

    el.startButton.addEventListener('click', () => {
      // Synchronously inside the gesture handler. Awaiting anything first
      // would spend the user activation and leave the first cue silent.
      this.voice.unlock();
      this.voice.preloadCues([...allCueTexts(), ...allSetupSpeech()]);
      void this.toggle();
    });
    el.exerciseSelect.addEventListener('change', () => {
      this.exercise = el.exerciseSelect.value as ExerciseKind;
      // Thresholds and rules are per-exercise, so anything measured under the
      // previous movement is meaningless now.
      this.startNewSet();
      this.renderGuidance();
      this.refreshTarget();
      this.render();
    });

    this.renderGuidance();
    this.refreshTarget();
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

    // Record before reading the trend, so the deltas compare this session with
    // the last one rather than the last two — and before the network call, so
    // history survives a failed or slow coach request.
    const workedTo = this.target;
    this.setsDone += 1;
    this.showTarget(this.history.recordSet(toSetRecord(summary)));

    const trend = this.history.trend(this.exercise);
    if (trend) {
      summary.session = {
        targetReps: workedTo.targetReps,
        targetReason: explainTarget(workedTo),
        sessions: trend.sessions,
        repsDelta: trend.repsDelta,
        depthDeltaDeg: trend.depthDeltaDeg,
      };
    }

    this.el.coachPanel.hidden = false;
    this.el.coachNarration.textContent = 'Menganalisis set…';
    this.el.coachFocus.textContent = '';
    this.el.coachMeta.textContent = '';

    try {
      const feedback = await requestCoaching(summary);
      this.el.coachNarration.textContent = feedback.narasi;
      this.el.coachFocus.textContent = feedback.fokus_set_berikutnya;
      // Not awaited: the text is already on screen, and blocking the panel on
      // audio generation would delay reading it for no benefit.
      void this.voice.speakNarration(feedback.narasi);
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

  /**
   * Show the target for the next set.
   *
   * On screen during the set, not only in the summary afterwards: a target you
   * are told about after finishing is a score, and a target you can see while
   * working is the thing that actually changes what you do.
   */
  private refreshTarget(): void {
    this.showTarget(this.history.currentTarget(this.exercise));
  }

  /**
   * Render a target decision.
   *
   * Takes the decision rather than re-reading it, because the reason is only
   * accurate at the moment it is made: once "progressed" has been stored, a
   * fresh read of the same history reports the raised target as merely held.
   */
  /**
   * Adopt a target decision.
   *
   * Nothing on the workout screen states the target as its own number — the
   * caption says what the count is out of, and the strips show it as length.
   * Per the design, the target and its reasoning belong on the home screen,
   * where they can be read at arm's length rather than glanced at from the
   * floor.
   */
  private showTarget(target: ExerciseTarget): void {
    this.target = target;
    // The strip count is derived from the target, so a changed target has to
    // rebuild them.
    this.strippedDone = -1;
    this.renderMovementLabel();
  }

  /** "PUSH-UP · SET 2/3" — movement and position in the session, in one line. */
  private renderMovementLabel(): void {
    const total = loadPreferences().setsPerExercise;
    const current = Math.min(this.setsDone + 1, total);
    this.el.movementLabel.textContent = `${MOVEMENT_LABEL[this.exercise]} · SET ${current}/${total}`;
  }

  private startNewSet(): void {
    this.counter = new RepCounter(this.exercise);
    this.smoother = new MedianFilter();
    this.liveCue = new LiveDepthCue(this.exercise);
    this.spokenThisRep.clear();
    this.windows.clear();
    this.reps.length = 0;
    this.setStartedMs = performance.now();
    this.trackedFrames = 0;
    this.heldFrames = 0;
    this.nullAngleFrames = 0;
    this.implausibleFrames = 0;
    this.cueUntilMs = 0;
    this.lastSpokenFraming = null;
    this.framingSpokenUntilMs = 0;
    this.armed = false;
    this.goodFramingSinceMs = null;
    this.strippedDone = -1;
    this.clearCue();
    this.renderMovementLabel();
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
    // A cue still playing after the set ended is talking about nothing.
    this.voice.stop();

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
      // Judging angles use the strict visibility bar; the counting angle uses
      // the lenient one. Same landmarks, two different questions.
      const angles = computeJointAngles(detection.frame.landmarks);

      // Is the body even in this movement? A knee that bends and straightens
      // reads the same lying down as standing, so the joint angle alone cannot
      // tell — and without this, arbitrary limb movement counts as reps.
      const posture = checkPosture(detection.frame.landmarks, this.exercise);
      const plausible =
        posture.plausible &&
        (this.exercise !== 'pushup' || handsPlanted(detection.frame.landmarks));

      this.updateArming(framing.ok && posture.plausible, frameStart);

      // Feed null when the body is not in the movement, or before the set is
      // armed. The counter already treats null as "hold", which is exactly the
      // behaviour wanted in both cases.
      const countable = plausible && this.armed;
      const angle = this.smoother.push(
        countable ? primaryAngleForCounting(detection.frame.landmarks, this.exercise) : null,
      );
      if (!plausible) this.implausibleFrames += 1;
      this.windows.push(detection.frame.timestampMs, angles);

      const phaseBefore = this.counter.status.phase;
      const rep = this.counter.update(angle, detection.frame.timestampMs);

      // Live depth check runs during the descent, so the correction lands as
      // the lifter starts back up rather than after the rep is already done.
      if (this.liveCue.update(angle, phaseBefore === 'down')) {
        this.spokenThisRep.add('shallow_depth');
        this.showCue('shallow_depth', cueFor(this.exercise, 'shallow_depth'), frameStart);
      }

      if (rep) {
        const findings = evaluateRules(this.exercise, this.windows.take(rep));
        this.reps.push(toRepRecord(rep, findings));

        // Skip anything already said live for this rep — hearing the same
        // correction twice makes the coach sound broken.
        const unspoken = findings.filter((f) => !this.spokenThisRep.has(f.code));
        const cue = primaryCue(unspoken);
        this.showCue(cue?.code ?? null, cue?.cue ?? null, frameStart);
        this.spokenThisRep.clear();
      }
      this.perf.recordFastLoop(performance.now() - fastLoopStart);

      if (angle === null) this.nullAngleFrames += 1;

      if (this.counter.status.holding) this.heldFrames += 1;
      else this.trackedFrames += 1;

      drawSkeleton(this.ctx, detection.normalized, {
        ...DEFAULT_SKELETON_STYLE,
        highlight: this.highlightJoints,
      });
      // Framing outranks low confidence: a cropped body is *why* confidence is
      // low, and "step back" is something the user can act on.
      this.setStatus(this.framingOrTrackingStatus(framing.issue, posture.issue));
      // Only nag about framing while it still blocks the set. Once armed, a
      // transient issue is reported on screen and left alone.
      if (!this.armed) this.speakFraming(framing.issue, frameStart);
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

  /**
   * Arm the set once the view has been good for long enough.
   *
   * One-way: it never disarms. Framing that wobbles mid-set should warn, not
   * stop counting — a counter that silently switches itself off partway through
   * a set is indistinguishable from one that is broken.
   */
  private updateArming(good: boolean, nowMs: number): void {
    if (this.armed) return;

    if (!good) {
      this.goodFramingSinceMs = null;
      return;
    }

    this.goodFramingSinceMs ??= nowMs;
    if (nowMs - this.goodFramingSinceMs >= READY_HOLD_MS) {
      this.armed = true;
      this.voice.playCue(READY_CUE);
    }
  }

  private framingOrTrackingStatus(
    issue: FramingIssue | null,
    posture: PostureIssue | null,
  ): Status {
    // Framing first: if the camera cannot see the body, every other reading is
    // downstream of that.
    if (issue) return { kind: 'framing', message: framingMessage(issue, this.exercise) };
    if (posture) return { kind: 'posture', message: postureMessage(posture) };
    if (!this.armed) return { kind: 'arming' };
    if (this.counter.status.holding) return { kind: 'low-confidence' };
    return { kind: 'running' };
  }

  /**
   * Say the framing problem aloud, at a survivable rate.
   *
   * The banner is written for a phone in the hand; this is for a phone across
   * the room while the user is face-down on the floor. Repeated only after the
   * interval, and only while the same problem persists — a new problem speaks
   * immediately, because it is new information.
   */
  private speakFraming(issue: FramingIssue | null, nowMs: number): void {
    if (!issue) {
      this.lastSpokenFraming = null;
      return;
    }

    const phrase = framingSpeech(issue, this.exercise);
    const changed = phrase !== this.lastSpokenFraming;
    if (!changed && nowMs < this.framingSpokenUntilMs) return;

    this.lastSpokenFraming = phrase;
    this.framingSpokenUntilMs = nowMs + FRAMING_SPEECH_INTERVAL_MS;
    this.voice.playCue(phrase);
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.renderStatus();
  }

  /**
   * Show a correction.
   *
   * Three things move together and must never disagree: the caption text, the
   * colour of the count, and the amber joint on the overlay. They are set here
   * and cleared in one place, so a cue can never be showing while the skeleton
   * still points at the previous fault.
   *
   * @param code Rule that fired, used to pick the joint to highlight.
   */
  private showCue(code: string | null, cue: string | null, nowMs: number): void {
    if (cue === null) return;

    this.el.repCaption.textContent = cue;
    this.el.hud.dataset.state = 'correction';
    this.el.hudWash.classList.add('hud__wash--correction');
    this.highlightJoints = highlightFor(this.exercise, code);
    this.cueUntilMs = nowMs + CUE_VISIBLE_MS;

    // Pre-rendered clip: plays immediately, no network round trip. A cue that
    // arrives after the rep it describes is not a late cue, it is a wrong one.
    this.voice.playCue(cue);
  }

  private expireCue(nowMs: number): void {
    if (this.el.hud.dataset.state !== 'correction' || nowMs <= this.cueUntilMs) return;
    this.clearCue();
  }

  private clearCue(): void {
    this.el.hud.dataset.state = 'good';
    this.el.hudWash.classList.remove('hud__wash--correction');
    this.highlightJoints = [];
    this.el.repCaption.textContent = this.captionText();
  }

  /** The resting caption: what the count is out of. */
  private captionText(): string {
    if (!this.armed) return 'BERSIAP';
    return `DARI ${this.target.targetReps} REPETISI`;
  }

  /**
   * One strip per rep of the target, done ones long and coloured.
   *
   * Rebuilt only when the count or the target changes — this runs inside the
   * render loop, and rebuilding a dozen nodes at 30 fps for no visual change is
   * the kind of waste that shows up as dropped frames on a mid-range phone.
   */
  private renderStrips(done: number): void {
    const total = this.target.targetReps;
    // Beyond this the strips stop being readable at a glance and start being a
    // texture; the caption already carries the number.
    const show = total <= MAX_STRIPS ? total : 0;

    if (this.el.repStrips.childElementCount !== show) {
      this.el.repStrips.replaceChildren();
      for (let i = 0; i < show; i += 1) {
        const strip = document.createElement('span');
        strip.className = 'hud__strip';
        this.el.repStrips.append(strip);
      }
      this.strippedDone = -1;
    }

    if (this.strippedDone === done) return;
    this.strippedDone = done;

    const strips = this.el.repStrips.children;
    for (let i = 0; i < strips.length; i += 1) {
      strips[i].classList.toggle('hud__strip--done', i < done);
    }
  }

  private render(): void {
    const { repCount } = this.counter.status;
    this.el.repCount.textContent = String(repCount);
    this.renderStrips(repCount);

    // The caption is owned by the cue while one is showing.
    if (this.el.hud.dataset.state !== 'correction') {
      this.el.repCaption.textContent = this.captionText();
    }

    const perf = this.perf.snapshot();
    const seen = this.trackedFrames + this.heldFrames;
    // Readable-angle share is the number that explains missed reps, so it goes
    // next to the frame rate rather than into a debug console nobody opens.
    const readable = seen === 0 ? 0 : Math.round(((seen - this.nullAngleFrames) / seen) * 100);
    this.el.perf.textContent =
      perf.frame.count === 0
        ? ''
        : `${perf.fps} fps · pose ${perf.pose.meanMs.toFixed(1)} ms · sudut terbaca ${readable}%`;

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

/**
 * Every failure the user can actually hit gets a message that says what to do,
 * not what went wrong internally.
 */
const STATUS_MESSAGE: Record<Status['kind'], (status: Status) => string | null> = {
  idle: () => null,
  running: () => null,
  loading: (s) => (s.kind === 'loading' ? s.message : null),
  framing: (s) => (s.kind === 'framing' ? s.message : null),
  posture: (s) => (s.kind === 'posture' ? s.message : null),
  arming: () => 'Posisi terbaca. Tahan sebentar…',
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
