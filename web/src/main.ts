import './style.css';
import { registerServiceWorker } from './pwa.ts';
import { Router, parseHash, type Route } from './app/router.ts';
import { WorkoutSession } from './app/workoutSession.ts';
import { TrainingHistory, toSetRecord } from './session/history.ts';
import { hasLaunched, loadPreferences, markLaunched } from './session/profile.ts';
import { explainTarget } from './core/sessionLoop.ts';
import { WorkoutEngine, type Readiness } from './ui/workoutEngine.ts';
import { createHomeScreen } from './ui/screens/homeScreen.ts';
import { createPickerScreen } from './ui/screens/pickerScreen.ts';
import { createSetupScreen } from './ui/screens/setupScreen.ts';
import { createFeedbackScreen } from './ui/screens/feedbackScreen.ts';
import { createSummaryScreen } from './ui/screens/summaryScreen.ts';
import { createHistoryScreen } from './ui/screens/historyScreen.ts';
import { createNutritionScreen } from './ui/screens/nutritionScreen.ts';
import { createSettingsScreen } from './ui/screens/settingsScreen.ts';
import { createOnboardingScreen } from './ui/screens/onboardingScreen.ts';
import { el, required } from './ui/dom.ts';
import { hasIcon, icon, logoMark } from './ui/icons.ts';
import { isHold, type MovementKind } from './core/types.ts';
import type { SetSummary } from './core/setSummary.ts';

const history = new TrainingHistory();
const engine = new WorkoutEngine({
  video: required<HTMLVideoElement>('#video'),
  canvas: required<HTMLCanvasElement>('#canvas'),
  cameraLayer: required('#cameraLayer'),
  hud: required('#hud'),
  hudWash: required('#hudWash'),
  movementLabel: required('#movementLabel'),
  repStrips: required('#repStrips'),
  repCount: required('#repCount'),
  repCaption: required('#repCaption'),
  statusBanner: required('#statusBanner'),
});

/* ------------------------------------------------------------------- state */

let exercise: MovementKind = 'pushup';
let workout: WorkoutSession | null = null;
let lastSummary: SetSummary | null = null;

const MOVEMENT_LABEL: Record<MovementKind, string> = {
  pushup: 'PUSH-UP',
  squat: 'SQUAT',
  plank: 'PLANK',
};

function setLabel(): string {
  if (!workout) return '';
  return `SET ${workout.currentSet}/${workout.plan.setsPlanned}`;
}

/** Repetitions for a counted movement, seconds for a held one. */
function currentTargetAmount(): number {
  return isHold(exercise)
    ? history.currentHoldTarget(exercise).targetSeconds
    : history.currentTarget(exercise).targetReps;
}

function startWorkout(): void {
  const prefs = loadPreferences();
  workout = new WorkoutSession({
    exercise,
    setsPlanned: prefs.setsPerExercise,
    targetReps: currentTargetAmount(),
  });
  lastSummary = null;
}

/**
 * Beat between hitting the target and the sheet arriving.
 *
 * Long enough to see the final number land and hear "target tercapai"; short
 * enough that it reads as the app finishing for you rather than lagging.
 */
const TARGET_CLOSE_DELAY_MS = 1500;

let closing = false;

/** The set met its target — close it without making the user reach for a button. */
function autoFinishSet(): void {
  if (closing) return;
  closing = true;
  window.setTimeout(() => {
    // Only if they are still on the workout screen: tapping "Selesai set"
    // during the pause, or backing out, must not be overridden.
    if (parseHash(window.location.hash).name === 'latihan') finishSet();
    closing = false;
  }, TARGET_CLOSE_DELAY_MS);
}

/**
 * End the set, persist it, and attach the session context the coach needs.
 *
 * Recorded before the network call, so history survives a failed or slow
 * request — and before the trend is read, so the deltas compare this session
 * with the last one rather than the last two.
 */
function finishSet(): void {
  if (!workout) return;

  const summary = engine.endSet();
  const workedTo = isHold(exercise)
    ? history.currentHoldTarget(exercise)
    : history.currentTarget(exercise);
  history.recordSet(toSetRecord(summary));

  // The coach's session context is rep-shaped. A hold has no rep trend to
  // report, so it goes without rather than with a number that means something
  // else.
  const trend = isHold(exercise) ? null : history.trend(exercise);
  if (trend) {
    summary.session = {
      targetReps: 'targetReps' in workedTo ? workedTo.targetReps : workedTo.targetSeconds,
      targetReason: explainTarget(workedTo),
      sessions: trend.sessions,
      repsDelta: trend.repsDelta,
      depthDeltaDeg: trend.depthDeltaDeg,
    };
  }

  workout.record(summary);
  lastSummary = summary;
  router.go('umpanbalik');
}

/* ----------------------------------------------------------------- screens */

const setupScreen = createSetupScreen({
  getExercise: () => exercise,
  onReady: () => router.go('latihan'),
});

engine.onReadiness((readiness: Readiness) => setupScreen.update(readiness));
engine.onTargetReached(autoFinishSet);

const screens = {
  beranda: createHomeScreen({
    history,
    defaultExercise: exercise,
    onStart: () => {
      // Inside the gesture, before any await: otherwise the activation is spent
      // and the first cue plays silently.
      engine.unlockAudio();
      router.go('pilih');
    },
    onSettings: () => router.go('pengaturan'),
  }),

  pilih: createPickerScreen({
    history,
    getSelected: () => exercise,
    setSelected: (next) => {
      exercise = next;
    },
    onContinue: (chosen) => {
      exercise = chosen;
      startWorkout();
      router.go('kamera');
    },
  }),

  kamera: {
    enter() {
      setupScreen.enter?.({});
      if (!workout) startWorkout();
      engine.configure(exercise, workout!.plan.targetReps, setLabel());
      void engine.enterSetup().catch(() => {
        /* the engine already put the reason in the banner */
      });
    },
    leave() {
      setupScreen.leave?.();
    },
  },

  latihan: {
    enter() {
      if (!workout) {
        router.go('beranda');
        return;
      }
      engine.configure(exercise, workout.plan.targetReps, setLabel());
      engine.beginSet();
    },
  },

  umpanbalik: createFeedbackScreen({
    getSummary: () => lastSummary,
    getSetLabel: () => (workout ? `${MOVEMENT_LABEL[exercise]} · ${setLabel()}` : ''),
    getTargetReps: () => workout?.plan.targetReps ?? 0,
    hasMoreSets: () => (workout ? !workout.isComplete : false),
    onNext: () => router.go('kamera'),
    onFinish: () => router.go('ringkasan'),
    onNarration: (text) => void engine.speakNarration(text),
  }),

  ringkasan: createSummaryScreen({
    history,
    getExercise: () => exercise,
    onDone: () => {
      workout = null;
      lastSummary = null;
      router.go('beranda');
    },
  }),

  riwayat: createHistoryScreen({ history }),

  gizi: createNutritionScreen({
    history,
    onOpenSettings: () => router.go('pengaturan'),
  }),

  pengaturan: createSettingsScreen({ history }),

  mulai: createSplashScreen({
    onStart: () => router.go('onboarding'),
    onSkip: () => {
      // A real skip. The rest of the app already handles a missing profile —
      // nutrition offers to collect it, targets fall back to the beginner
      // baseline — so there is nothing here to protect them from.
      markLaunched();
      router.go('beranda');
    },
  }),

  onboarding: createOnboardingScreen({
    history,
    onDone: () => {
      markLaunched();
      router.go('beranda');
    },
    onStartFirstSession: () => {
      markLaunched();
      // Straight into the flow rather than to the home screen: the user has
      // just been shown their first target, and the next thing they want is to
      // attempt it.
      engine.unlockAudio();
      router.go('pilih');
    },
  }),
};

/**
 * 0 · Pembuka.
 *
 * Small enough to live here rather than in its own module: it renders three
 * fixed lines and owns two buttons.
 */
function createSplashScreen(deps: { onStart: () => void; onSkip: () => void }) {
  const mark = required('#splashMark');
  const promises = required('#splashPromises');

  mark.append(logoMark(96, true));
  for (const [name, text] of [
    ['kamera', 'Butuh kamera ponsel, tanpa alat lain'],
    ['gembok', 'Video diproses di ponsel, tidak dikirim'],
    ['jam', 'Enam pertanyaan, sekitar dua menit'],
  ] as const) {
    promises.append(
      el('li', { class: 'promise' }, icon(name, 19, 1.6), el('span', { text })),
    );
  }

  required<HTMLButtonElement>('#splashStart').addEventListener('click', deps.onStart);
  required<HTMLButtonElement>('#splashSkip').addEventListener('click', deps.onSkip);

  return { enter() {} };
}

/* ------------------------------------------------------------------ chrome */

const sections = new Map<string, HTMLElement>();
for (const node of document.querySelectorAll<HTMLElement>('[data-screen]')) {
  sections.set(node.dataset.screen!, node);
}

const tabs = required('#tabs');
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];

/**
 * Fill every icon slot declared in the markup.
 *
 * The markup names the icon; this puts it there. Building the SVG in script
 * rather than writing it inline keeps `index.html` readable as a description of
 * the screens, and keeps every path in one file where they can be kept
 * consistent with each other.
 */
for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  const name = slot.dataset.icon!;
  if (!hasIcon(name)) continue;
  slot.prepend(icon(name));
}

/** Screens that show the camera; everything else releases it. */
const CAMERA_SCREENS = new Set(['kamera', 'latihan', 'umpanbalik']);
/** Screens the tab bar belongs on. Not during a workout — nothing to switch to. */
const TABBED = new Set(['beranda', 'riwayat', 'gizi']);

/** Screens reachable before onboarding has been completed. */
const PRE_ONBOARDING = new Set(['mulai', 'onboarding']);

function applyChrome(route: Route): void {
  for (const [name, node] of sections) node.hidden = name !== route.name;

  tabs.hidden = !TABBED.has(route.name);
  for (const button of tabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.tab === route.name));
  }

  if (!CAMERA_SCREENS.has(route.name)) engine.stopCamera();
  // Every screen is its own scroll context; arriving part-way down a page the
  // user has never seen is disorienting.
  document.querySelector('.screen:not([hidden]) .screen__body')?.scrollTo(0, 0);
}

const router = new Router(screens, (route) => guard(route));

/**
 * Send a first-time user to the opening screen.
 *
 * Checked on every navigation rather than only at startup, because a deep link
 * or a stale hash can land anywhere.
 *
 * The question is whether they have *seen* the opening screen, not whether they
 * finished the questions. Gating on completion would make "lewati dulu"
 * navigate somewhere that bounces straight back.
 */
function guard(route: Route): void {
  if (!hasLaunched() && !PRE_ONBOARDING.has(route.name)) {
    router.go('mulai');
    return;
  }
  applyChrome(route);
}

for (const button of tabButtons) {
  button.addEventListener('click', () => router.go(button.dataset.tab!));
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
  button.addEventListener('click', () => window.history.back());
}

required<HTMLButtonElement>('#finishSet').addEventListener('click', finishSet);

router.start();
registerServiceWorker();

// Exposed for manual inspection during device testing and for capturing the
// latency/FPS table that goes into the paper.
Object.assign(window, { latih: { engine, history } });
