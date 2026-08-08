/**
 * The fast loop, wired to the camera and the screen.
 *
 * Owns the camera stream, MediaPipe, and the per-frame path from landmarks to
 * a rep count. Deliberately not a framework component: every high-frequency
 * update — skeleton, count, status — goes straight to a canvas or a text node
 * at 30 fps, which is exactly the work a virtual DOM would make more expensive
 * rather than cheaper.
 *
 * ## Two modes, one camera
 *
 * `setup` runs the whole pipeline except counting: pose, skeleton, framing and
 * posture checks, and the arming timer. `workout` adds the counter, the rules,
 * and the cues.
 *
 * They share one stream because the alternative is stopping and restarting
 * `getUserMedia` between the setup screen and the workout screen — several
 * seconds of black, at the moment the user is already face-down on the floor
 * waiting for it.
 */

import { bilateralMean, computeJointAngles, primaryAngleForCounting } from '../core/angles.ts';
import { LiveDepthCue } from '../core/liveCue.ts';
import {
  READY_CUE,
  TARGET_CUE,
  allSetupSpeech,
  checkFraming,
  framingMessage,
  framingSpeech,
  type FramingIssue,
} from '../core/framing.ts';
import {
  allPostureCueTexts,
  checkPosture,
  handsPlanted,
  postureCueFor,
  postureMessage,
  type PostureIssue,
} from '../core/posture.ts';
import { HoldTracker } from '../core/holdTracker.ts';
import { PerfMonitor } from '../core/metrics.ts';
import { RepCounter } from '../core/repCounter.ts';
import { MedianFilter } from '../core/smoothing.ts';
import { RepWindowBuilder } from '../core/repWindow.ts';
import {
  SPEAK_ONCE_PER_SET,
  allCueTexts,
  cueFor,
  evaluateRules,
  primaryCue,
  type RuleErrorCode,
} from '../core/rules.ts';
import {
  summarizeHold,
  summarizeSet,
  toRepRecord,
  type RepRecord,
  type SetSummary,
} from '../core/setSummary.ts';
import { Voice } from '../audio/voice.ts';
import { isHold, type ExerciseKind, type MovementKind } from '../core/types.ts';
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
 * How often the same posture problem may be spoken again.
 *
 * The framing cue has had a rate limit from the start and the posture cue did
 * not, which mattered once the squat gates arrived: they depend on ankle
 * separation and on how close a wrist is to the floor, both of which lean on
 * the depth coordinate the tracker estimates worst. A gate flickering
 * on-off-on would otherwise speak on every flip, which is the "cue keeps
 * repeating" complaint arriving by a new route.
 *
 * Applies whether or not the problem is the same one. Exempting a *changed*
 * issue reads kinder and leaves the hole open, because two gates alternating
 * change on every flip.
 */
const POSTURE_SPEECH_INTERVAL_MS = 8000;

/**
 * How long framing must stay good before the set may begin.
 *
 * A set that starts the instant the camera glimpses a body starts while the
 * user is still walking into position, and the first "repetition" is them
 * lying down.
 */
const READY_HOLD_MS = 1200;

/**
 * Above this target the strip column stops being readable at a glance and
 * becomes a texture. The caption already states the number.
 */
const MAX_STRIPS = 20;

/** Progress segments for a held movement — tenths of the target. */
const HOLD_SEGMENTS = 10;

const MOVEMENT_LABEL: Record<MovementKind, string> = {
  pushup: 'PUSH-UP',
  squat: 'SQUAT',
  plank: 'PLANK',
};

export type EngineMode = 'idle' | 'setup' | 'workout';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'running' }
  | { kind: 'framing'; message: string }
  | { kind: 'posture'; message: string }
  | { kind: 'low-confidence' }
  | { kind: 'error'; message: string };

/** What the setup screen needs from the engine each frame. */
export interface Readiness {
  hasPose: boolean;
  framingOk: boolean;
  postureOk: boolean;
  /** Height of the detected body as a fraction of frame height. */
  bodyFill: number;
  message: string | null;
  /** Framing has been good long enough for the set to start. */
  ready: boolean;
}

export interface WorkoutEngineElements {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  cameraLayer: HTMLElement;
  hud: HTMLElement;
  hudWash: HTMLElement;
  movementLabel: HTMLElement;
  repStrips: HTMLElement;
  repCount: HTMLElement;
  /** The "/ 8" half of the readout — target reps or seconds, smaller type. */
  repTarget: HTMLElement;
  repCaption: HTMLElement;
  statusBanner: HTMLElement;
}

export class WorkoutEngine {
  private readonly pose = new PoseSource();
  private readonly perf = new PerfMonitor();
  private readonly voice = new Voice();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly el: WorkoutEngineElements;

  private counter: RepCounter;
  /**
   * Rejects single-frame tracker glitches before they reach the state machine.
   * MediaPipe solves the skeleton jointly, so poorly tracked legs destabilise
   * the elbow too — which showed up in testing as miscounted push-ups.
   */
  private smoother = new MedianFilter();
  private liveCue: LiveDepthCue;
  private readonly windows = new RepWindowBuilder();

  private readonly hold = new HoldTracker();
  private exercise: MovementKind = 'pushup';
  /** Repetitions for a counted movement, seconds for a held one. */
  private targetReps = 8;
  private setLabel = '';
  private mode: EngineMode = 'idle';
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private lastPoseSeenMs = 0;
  private status: Status = { kind: 'idle' };
  private readonly reps: RepRecord[] = [];

  private setStartedMs = 0;
  private trackedFrames = 0;
  private heldFrames = 0;
  private cueUntilMs = 0;
  /**
   * Codes already spoken for the repetition in flight, so a correction fired
   * live at the reversal is not repeated by the post-rep rules a moment later.
   */
  private readonly spokenThisRep = new Set<string>();
  /** Prevents a support-form rejection from being narrated as shallow depth. */
  private repInvalidatedThisRep = false;
  /**
   * Frames where the counting angle was unavailable. Surfaced because "reps are
   * being missed" is not actionable and "the angle was readable in 61% of
   * frames" points straight at the camera setup.
   */
  private nullAngleFrames = 0;
  /**
   * Best peak extension seen this set, the reference the lockout rule is judged
   * against. See `lockoutDropMax` in `core/rules.ts`.
   */
  private bestLockoutDeg: number | null = null;
  /** Codes already spoken once this set, for the say-once corrections. */
  private readonly spokenThisSet = new Set<RuleErrorCode>();
  /** Fires once per set, when the rep target is reached. */
  private targetListener: (() => void) | null = null;
  private targetAnnounced = false;
  private framingSpokenUntilMs = 0;
  private lastSpokenFraming: string | null = null;
  /**
   * Counting is suspended until the camera has held a good view. Once armed it
   * never disarms: a counter that switches itself off partway through a set is
   * indistinguishable from one that is broken.
   */
  private armed = false;
  private goodFramingSinceMs: number | null = null;
  private highlightJoints: readonly number[] = [];
  private strippedDone = -1;
  /**
   * Count the HUD last displayed, so the confirmation only fires when a
   * repetition actually lands — `render` runs on every frame.
   */
  private lastShownCount = -1;
  private postureSpokenUntilMs = 0;

  private readinessListener: ((readiness: Readiness) => void) | null = null;

  constructor(el: WorkoutEngineElements) {
    this.el = el;
    const ctx = el.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    // Replaced by `configure` before any set runs; a counted movement is the
    // safe thing to construct with.
    this.counter = new RepCounter('pushup');
    this.liveCue = new LiveDepthCue('pushup');
  }

  /**
   * Prime audio playback.
   *
   * Must be called synchronously inside a user-gesture handler, not from a
   * promise that resolves later — by then the gesture has expired and the
   * browser refuses again, silently, leaving the coach mute for the first rep.
   */
  unlockAudio(): void {
    this.voice.unlock();
    this.voice.preloadCues([...allCueTexts(), ...allSetupSpeech(), ...allPostureCueTexts()]);
  }

  onReadiness(listener: (readiness: Readiness) => void): void {
    this.readinessListener = listener;
  }

  /**
   * Called once per set, on the frame the rep target is reached.
   *
   * The set is not ended here — the engine counts, and what happens next is the
   * app's decision.
   */
  onTargetReached(listener: () => void): void {
    this.targetListener = listener;
  }

  configure(exercise: MovementKind, target: number, setLabel: string): void {
    this.exercise = exercise;
    this.targetReps = target;
    this.setLabel = setLabel;
    // The HUD is portrait and the body lies perpendicular for push-ups, so the
    // count turns a quarter turn. CSS keys off the same element.
    this.el.hud.dataset.exercise = exercise;
    // Thresholds and rules are per-movement, so anything measured under the
    // previous one is meaningless now.
    if (!isHold(exercise)) {
      this.counter = new RepCounter(exercise);
      this.liveCue = new LiveDepthCue(exercise);
    }
    this.hold.reset();
    this.strippedDone = -1;
    this.renderLabel();
  }

  private get isHoldMovement(): boolean {
    return isHold(this.exercise);
  }

  get performance() {
    return this.perf.snapshot();
  }

  /** True while the camera stream is open. */
  get cameraActive(): boolean {
    return this.stream !== null;
  }

  /**
   * Load the pose model ahead of any camera work.
   *
   * Called at app boot: fetching and compiling the WASM runtime needs no user
   * gesture (only the camera does), so the tens-of-megabytes cost runs while
   * the user reads the opening screens. `warmUp` and `enterSetup` then join
   * the same in-flight load.
   */
  async preloadModel(): Promise<void> {
    if (!this.pose.ready) await this.pose.load();
  }

  /**
   * Open the camera and load the pose model ahead of the camera screen.
   *
   * Called from a user gesture on the home screen: the permission prompt lands
   * there (one-time per browser) instead of on the camera screen, and the WASM
   * compile + graph setup happen while the user walks the picker. `enterSetup`
   * then finds everything already warm. Failures are swallowed — the camera
   * screen reports them in the usual way.
   */
  async warmUp(): Promise<void> {
    try {
      await this.openCamera();
      if (!this.pose.ready) await this.pose.load();
      // Warm the real video path (shader compile at the camera's resolution),
      // so the first visible skeleton frame is not the first inference.
      this.pose.warmUp(this.el.video);
    } catch {
      // Leave the error reporting to the camera screen.
    }
  }

  /** Open the camera and load the model, then run in setup mode. */
  async enterSetup(variant: ModelVariant = 'lite'): Promise<void> {
    try {
      this.setStatus({ kind: 'loading', message: 'Menyiapkan kamera…' });
      await this.openCamera();
      // Show the live feed as soon as it exists — the model can finish loading
      // behind it. A black screen under a loading banner reads as broken.
      this.el.cameraLayer.hidden = false;

      if (!this.pose.ready) {
        // Tens of megabytes of WASM and model weights; say so rather than
        // appearing frozen.
        this.setStatus({ kind: 'loading', message: 'Memuat model pose…' });
        await this.pose.load(variant);
      }

      // Safety net for when `warmUp` never warmed (stream closed while the
      // model was still loading, swallowed error). Pays the graph-setup cost
      // once here instead of on the first visible frame.
      if (!this.pose.isWarmedUp) this.pose.warmUp(this.el.video);

      this.resetSetState();
      this.perf.reset();
      this.mode = 'setup';
      this.lastPoseSeenMs = performance.now();
      this.setStatus({ kind: 'running' });
      if (this.rafId === null) this.loop();
    } catch (error) {
      this.stopCamera();
      this.setStatus({ kind: 'error', message: describeStartError(error) });
      throw error;
    }
  }

  /** Begin counting. The camera is already open and, normally, already armed. */
  beginSet(): void {
    const wasArmed = this.armed;
    this.resetSetState();
    // Arming survives the transition from setup: the user held position to earn
    // it, and making them hold again after pressing start is a delay with no
    // purpose.
    this.armed = wasArmed;
    this.setStartedMs = performance.now();
    this.mode = 'workout';
    if (this.isHoldMovement) this.hold.start(performance.now());
    this.render();
  }

  /**
   * Stop counting and hand back the set.
   *
   * Counting stops before anything else. Reps performed while the coach is
   * thinking would land in a set that has already been summarised, and would
   * silently go missing.
   */
  endSet(): SetSummary {
    this.mode = 'setup';
    this.voice.stop();
    const total = this.trackedFrames + this.heldFrames;
    const durationMs = this.setStartedMs === 0 ? 0 : performance.now() - this.setStartedMs;

    if (this.isHoldMovement) {
      const summary = this.hold.summary();
      return summarizeHold(this.exercise, summary, {
        durationMs,
        trackingQuality: summary.trackingQuality,
      });
    }

    return summarizeSet(this.exercise as ExerciseKind, this.reps, {
      durationMs,
      trackingQuality: total === 0 ? 0 : this.trackedFrames / total,
    });
  }

  stopCamera(): void {
    this.mode = 'idle';
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.el.video.srcObject = null;
    // A cue still playing after the set ended is talking about nothing.
    this.voice.stop();

    clearSkeleton(this.ctx);
    this.el.cameraLayer.hidden = true;
    // Always cleared, never kept: the banner lives outside the camera screens
    // now, so a message left over from a failed start would follow the user
    // onto the home screen.
    this.setStatus({ kind: 'idle' });
  }

  speak(text: string): void {
    this.voice.playCue(text);
  }

  /**
   * Which path produced the last sound: a pre-rendered clip or the browser's
   * own synthesiser.
   *
   * Surfaced for device testing. "Sounds robotic" and "the generated audio
   * never played" are the same complaint from the user's side, and this is
   * what separates them.
   */
  get audioSource() {
    return this.voice.lastSource;
  }

  /* ------------------------------------------------------------------ camera */

  private async openCamera(): Promise<void> {
    if (this.stream) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
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

  private resetSetState(): void {
    if (!this.isHoldMovement) {
      const exercise = this.exercise as ExerciseKind;
      this.counter = new RepCounter(exercise);
      this.liveCue = new LiveDepthCue(exercise);
    }
    this.smoother = new MedianFilter();
    this.hold.reset();
    this.spokenThisRep.clear();
    this.repInvalidatedThisRep = false;
    this.windows.clear();
    this.reps.length = 0;
    this.setStartedMs = 0;
    this.trackedFrames = 0;
    this.heldFrames = 0;
    this.nullAngleFrames = 0;
    this.bestLockoutDeg = null;
    this.spokenThisSet.clear();
    this.targetAnnounced = false;
    this.cueUntilMs = 0;
    this.lastSpokenFraming = null;
    this.framingSpokenUntilMs = 0;
    this.armed = false;
    this.goodFramingSinceMs = null;
    this.strippedDone = -1;
    // Without this the second set's first repetition would not be confirmed:
    // the count returns to 0 and would not read as an increase.
    this.lastShownCount = -1;
    this.postureSpokenUntilMs = 0;
    this.clearCue();
    this.renderLabel();
  }

  /* -------------------------------------------------------------- fast loop */

  private loop = (): void => {
    if (this.mode === 'idle') {
      this.rafId = null;
      return;
    }

    const frameStart = performance.now();
    const detection = this.pose.detect(this.el.video, frameStart);

    if (detection === null) {
      // Hold the counter: a rep counted from a pose we cannot see is worse
      // than no count, because the user sees the error immediately.
      if (this.mode === 'workout') {
        this.counter.update(null, frameStart);
        this.heldFrames += 1;
      }
      this.smoother.push(null);
      clearSkeleton(this.ctx);

      if (frameStart - this.lastPoseSeenMs > NO_POSE_GRACE_MS) {
        const issue: FramingIssue = { kind: 'no-pose' };
        this.setStatus({ kind: 'framing', message: framingMessage(issue, this.exercise) });
        this.speakFraming(issue, frameStart);
        this.goodFramingSinceMs = null;
        this.emitReadiness({ hasPose: false, framingOk: false, postureOk: true, bodyFill: 0 });
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
      // reads the same lying down as standing.
      const posture = checkPosture(detection.frame.landmarks, this.exercise);
      const movementPlausible =
        posture.plausible &&
        (this.exercise !== 'pushup' || handsPlanted(detection.frame.landmarks));
      const formValid = posture.countable;
      const plausible = movementPlausible && formValid;

      this.updateArming(framing.ok && plausible, frameStart);

      if (this.mode === 'workout') {
        if (this.isHoldMovement) this.runHold(angles, posture.plausible, frameStart);
        // Narrowed here rather than inside: `runCounting` is only ever reached
        // for a counted movement, and saying so once beats asserting it twice.
        else
          this.runCounting(
            this.exercise as ExerciseKind,
            detection,
            angles,
            movementPlausible,
            posture.invalidatesRep,
            frameStart,
          );
      }

      this.perf.recordFastLoop(performance.now() - fastLoopStart);

      drawSkeleton(this.ctx, detection.normalized, {
        ...DEFAULT_SKELETON_STYLE,
        highlight: this.highlightJoints,
      });

      // Framing outranks low confidence: a cropped body is *why* confidence is
      // low, and "step back" is something the user can act on.
      this.setStatus(this.framingOrTrackingStatus(framing.issue, posture.issue));
      this.showPostureCue(posture.issue, frameStart);
      // Only nag while framing still blocks the set. Once armed, a transient
      // issue is reported on screen and left alone.
      if (!this.armed) this.speakFraming(framing.issue, frameStart);

      this.emitReadiness({
        hasPose: true,
        framingOk: framing.ok,
        postureOk: posture.plausible && posture.countable,
        bodyFill: framing.bodyFill,
      });
    }

    this.expireCue(frameStart);

    const now = performance.now();
    this.perf.recordFrame(now - frameStart, now);
    if (this.mode === 'workout') this.render();

    this.rafId = requestAnimationFrame(this.loop);
  };

  private runCounting(
    exercise: ExerciseKind,
    detection: NonNullable<ReturnType<PoseSource['detect']>>,
    angles: ReturnType<typeof computeJointAngles>,
    movementPlausible: boolean,
    invalidatesRep: boolean,
    frameStart: number,
  ): void {
    // Feed null when the body is not in the movement, or before the set is
    // armed. The counter already treats null as "hold".
    const countable = movementPlausible && this.armed;
    const angle = this.smoother.push(
      countable ? primaryAngleForCounting(detection.frame.landmarks, exercise) : null,
    );
    this.windows.push(detection.frame.timestampMs, angles);

    const phaseBefore = this.counter.status.phase;
    // A support cheat discovered mid-descent must not let the rep count. Marked
    // before the counter consumes the frame so an attempt that ends on the very
    // frame the cheat appears is rejected too.
    if (invalidatesRep && phaseBefore === 'down') {
      this.repInvalidatedThisRep = true;
      this.counter.invalidateCurrentAttempt();
    }
    const rep = this.counter.update(angle, detection.frame.timestampMs);

    // Live depth check runs during the descent, so the correction lands as the
    // lifter starts back up rather than after the rep is already done.
    if (this.liveCue.update(angle, phaseBefore === 'down') && !this.repInvalidatedThisRep) {
      this.spokenThisRep.add('shallow_depth');
      this.showCue('shallow_depth', cueFor(this.exercise, 'shallow_depth'), frameStart);
    }

    if (rep && !rep.counted) {
      // An attempt that reversed before reaching depth — or was rejected by a
      // support gate — is flagged, spoken, and deliberately not counted: a
      // counter that credits half reps tells the lifter something untrue about
      // the work they did, and inflates the target the session loop then
      // progresses from.
      //
      // `liveCue` usually says this first, at the reversal, which is earlier
      // and better; `spokenThisRep` stops it being said twice.
      if (!this.repInvalidatedThisRep && !this.spokenThisRep.has('shallow_depth')) {
        this.showCue('shallow_depth', cueFor(this.exercise, 'shallow_depth'), frameStart);
      }
      this.spokenThisRep.clear();
      this.repInvalidatedThisRep = false;
    } else if (rep) {
      // A rep counted is a rep confirmed: the count pops and a short ping
      // lands alongside it, independent of any cue that may be speaking.
      this.voice.playPing();
      const findings = evaluateRules(
        exercise,
        this.windows.take(rep),
        {},
        { bestLockoutDeg: this.bestLockoutDeg ?? undefined },
      );
      this.reps.push(toRepRecord(rep, findings));

      // Updated after evaluating, so a rep is never compared against itself.
      if (Number.isFinite(rep.maxAngle)) {
        this.bestLockoutDeg = Math.max(this.bestLockoutDeg ?? -Infinity, rep.maxAngle);
      }

      // Skip anything already said live for this rep — hearing the same
      // correction twice makes the coach sound broken — and anything rationed
      // to once per set that has already been used.
      const unspoken = findings.filter(
        (f) => !this.spokenThisRep.has(f.code) && !this.spokenThisSet.has(f.code),
      );
      const cue = primaryCue(unspoken);
      if (cue && SPEAK_ONCE_PER_SET.has(cue.code)) this.spokenThisSet.add(cue.code);

      this.showCue(cue?.code ?? null, cue?.cue ?? null, frameStart);
      this.spokenThisRep.clear();
      this.repInvalidatedThisRep = false;

      // The set has done what it set out to do. Announced here rather than
      // polled, so the transition lands on the frame the target was met.
      if (!this.targetAnnounced && this.counter.status.repCount >= this.targetReps) {
        this.targetAnnounced = true;
        this.voice.playCue(TARGET_CUE);
        this.targetListener?.();
      }
    }

    if (angle === null) this.nullAngleFrames += 1;
    if (this.counter.status.holding) this.heldFrames += 1;
    else this.trackedFrames += 1;
  }

  /**
   * One frame of a held movement.
   *
   * The clock is the tracker's; this only feeds it and reacts to what it
   * announces. A break is spoken once, on the frame it commits.
   */
  private runHold(
    angles: ReturnType<typeof computeJointAngles>,
    inPosition: boolean,
    frameStart: number,
  ): void {
    const hipAngle = bilateralMean(angles.hipLeft, angles.hipRight);
    const fault = this.hold.update(hipAngle, inPosition && this.armed, frameStart);

    if (hipAngle === null) this.nullAngleFrames += 1;
    if (this.hold.status.running) this.trackedFrames += 1;
    else this.heldFrames += 1;

    if (fault) this.showCue(fault, cueFor(this.exercise, fault), frameStart);
    // Recovered: drop the amber immediately rather than waiting out the cue
    // timer, because the clock visibly restarting is the real signal.
    else if (this.hold.status.running && this.hold.status.fault === null) this.expireCue(frameStart);

    if (!this.targetAnnounced && this.hold.status.heldMs >= this.targetReps * 1000) {
      this.targetAnnounced = true;
      this.voice.playCue(TARGET_CUE);
      this.targetListener?.();
    }
  }

  /**
   * Arm once the view has been good for long enough.
   *
   * One-way within a set. Framing that wobbles mid-set should warn, not stop
   * counting.
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

  private emitReadiness(base: Omit<Readiness, 'message' | 'ready'>): void {
    this.readinessListener?.({
      ...base,
      message: this.status.kind === 'framing' || this.status.kind === 'posture'
        ? this.status.message
        : null,
      ready: this.armed,
    });
  }

  /* ------------------------------------------------------------------- cues */

  /** Speak posture gates without turning them into a competing HUD correction. */
  private showPostureCue(issue: PostureIssue | null, nowMs: number): void {
    if (issue === null || this.mode === 'idle') return;

    // One posture cue per interval, whether or not it is the same problem.
    //
    // Exempting a *changed* issue looks kinder and leaves the hole open: two
    // gates alternating — stance, hands, stance — change on every flip, so
    // every flip would speak. The user can act on one correction at a time
    // regardless, which is the rule the rest of this file already follows.
    if (nowMs < this.postureSpokenUntilMs) return;

    this.postureSpokenUntilMs = nowMs + POSTURE_SPEECH_INTERVAL_MS;
    this.clearCue();
    this.voice.playCue(postureCueFor(issue));
  }

  /**
   * Show a correction.
   *
   * Three things move together and must never disagree: the caption, the colour
   * of the count, and the amber joint on the overlay. They are set here and
   * cleared in one place, so a cue can never be showing while the skeleton
   * still points at the previous fault.
   */
  private showCue(code: string | null, cue: string | null, nowMs: number): void {
    if (cue === null) return;

    // Fed to the hidden live region: the cue is spoken aloud and announced to
    // screen readers, never rendered on screen.
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
    this.renderCaption();
  }

  /**
   * The caption is the correction slot and nothing else now — the target moved
   * into the readout line ("0 / 8"). It is also never visible: the cue is
   * spoken, and text appearing under the count would shift the readout.
   */
  private captionText(): string {
    if (!this.armed) return 'BERSIAP';
    return '';
  }

  private renderCaption(): void {
    this.el.repCaption.textContent = this.captionText();
  }

  /**
   * Say the framing problem aloud, at a survivable rate.
   *
   * The banner is written for a phone in the hand; this is for a phone across
   * the room while the user is face-down on the floor.
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

  /* ----------------------------------------------------------------- render */

  private framingOrTrackingStatus(
    issue: FramingIssue | null,
    posture: PostureIssue | null,
  ): Status {
    if (issue) return { kind: 'framing', message: framingMessage(issue, this.exercise) };
    // Posture restrictions are spoken, not rendered as a second visual cue.
    // Framing remains visual because it describes what the camera can see.
    if (posture === 'not-horizontal') return { kind: 'posture', message: postureMessage(posture) };
    if (this.mode === 'workout' && this.counter.status.holding) return { kind: 'low-confidence' };
    return { kind: 'running' };
  }

  private setStatus(status: Status): void {
    this.status = status;
    const banner = this.el.statusBanner;
    const message = STATUS_MESSAGE[status.kind](status);
    banner.textContent = message ?? '';
    banner.dataset.kind = status.kind;
    banner.hidden = message === null;
  }

  private renderLabel(): void {
    this.el.movementLabel.textContent = this.setLabel
      ? `${MOVEMENT_LABEL[this.exercise]} · ${this.setLabel}`
      : MOVEMENT_LABEL[this.exercise];
    // Repetitions for a counted movement, seconds for a held one — same slot,
    // same shape: "/ 8" reads as the target either way.
    this.el.repTarget.textContent = ` / ${this.targetReps}`;
  }

  private render(): void {
    // Seconds for a hold, repetitions otherwise. Same slot, same size — the
    // number is the number, and the target rides beside it.
    const done = this.isHoldMovement
      ? Math.floor(this.hold.status.heldMs / 1000)
      : this.counter.status.repCount;

    if (done !== this.lastShownCount) {
      this.el.repCount.textContent = String(done);
      // A repetition landing is worth confirming; a plank's clock ticking over
      // every second is not, and would twitch the number for the whole hold.
      if (!this.isHoldMovement && done > this.lastShownCount) this.popCount();
      this.lastShownCount = done;
    }
    this.renderStrips(done);

    // The caption is owned by the cue while one is showing.
    if (this.el.hud.dataset.state !== 'correction') {
      this.renderCaption();
    }

    // A paused clock is the plank's amber state: the number simply stops. The
    // wash and the count colour say why without any text.
    if (this.isHoldMovement && this.mode === 'workout') {
      const stalled = !this.hold.status.running && this.armed;
      if (stalled && this.el.hud.dataset.state !== 'correction') {
        this.el.hud.dataset.state = 'correction';
        this.el.hudWash.classList.add('hud__wash--correction');
      }
    }
  }

  /**
   * Confirm a repetition with a small scale.
   *
   * The attribute is removed as soon as the animation ends so the next rep can
   * replay it — CSS animations do not restart on an element that already
   * carries the class.
   */
  private popCount(): void {
    const node = this.el.repCount;
    node.dataset.pop = 'true';
    node.addEventListener('animationend', () => delete node.dataset.pop, { once: true });
  }

  /**
   * One strip per rep of the target, done ones long and coloured.
   *
   * Rebuilt only when the count or the target changes — this runs inside the
   * render loop, and rebuilding a dozen nodes at 30 fps for no visual change is
   * the kind of waste that shows up as dropped frames on a mid-range phone.
   */
  private renderStrips(done: number): void {
    // A thirty-second plank would be thirty strips, which is a texture rather
    // than a progress bar. Holds get ten segments of equal share instead.
    const segments = this.isHoldMovement ? HOLD_SEGMENTS : this.targetReps;
    const show = segments <= MAX_STRIPS ? segments : 0;
    const filled = this.isHoldMovement
      ? Math.min(HOLD_SEGMENTS, Math.floor((done / Math.max(1, this.targetReps)) * HOLD_SEGMENTS))
      : done;

    if (this.el.repStrips.childElementCount !== show) {
      this.el.repStrips.replaceChildren();
      for (let i = 0; i < show; i += 1) {
        const strip = document.createElement('span');
        strip.className = 'hud__strip';
        this.el.repStrips.append(strip);
      }
      this.strippedDone = -1;
    }

    if (this.strippedDone === filled) return;
    this.strippedDone = filled;

    const strips = this.el.repStrips.children;
    for (let i = 0; i < strips.length; i += 1) {
      strips[i].classList.toggle('hud__strip--done', i < filled);
    }
  }

  /** Share of frames whose counting angle was readable, for the meta line. */
  get readableShare(): number {
    const seen = this.trackedFrames + this.heldFrames;
    return seen === 0 ? 0 : (seen - this.nullAngleFrames) / seen;
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
  'low-confidence': () => 'Pencahayaan kurang — hitungan ditahan sementara.',
  error: (s) => (s.kind === 'error' ? s.message : null),
};

export function describeStartError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return 'Izin kamera ditolak. Aktifkan izin kamera di pengaturan browser, lalu coba lagi.';
      case 'NotFoundError':
        return 'Kamera tidak ditemukan di perangkat ini.';
      case 'NotReadableError':
        return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.';
      default:
        return 'Kamera tidak bisa dibuka. Periksa izin lalu coba lagi.';
    }
  }
  return 'Gagal memulai. Muat ulang halaman lalu coba lagi.';
}
