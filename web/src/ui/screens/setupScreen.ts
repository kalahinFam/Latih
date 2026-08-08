/**
 * 3 · Posisi kamera.
 *
 * The camera is the feedback: the live feed and skeleton show whether the body
 * is in frame, the engine's spoken cues and the shared status banner say what
 * to fix, and this screen only handles the two short overlays that sit on top
 * — the rotate hint for sideways movements and the hold-and-count before the
 * set starts.
 */

import { required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import type { Readiness } from '../workoutEngine.ts';
import type { MovementKind } from '../../core/types.ts';

/** Countdown shown once the position has been held, before counting starts. */
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 700;

/**
 * Movements filmed with the phone turned on its side.
 *
 * The app renders portrait throughout; for these the user rotates the phone by
 * hand. The overlay tells them once, the first seconds the camera appears —
 * squat needs nothing, its guidance is already portrait.
 */
const LANDSCAPE_EXERCISES = new Set<MovementKind>(['pushup', 'plank']);

/** How long the rotate hint stays before getting out of the way. */
const ROTATE_OVERLAY_MS = 3000;

const MOVEMENT_LABEL: Record<MovementKind, string> = {
  pushup: 'PUSH-UP',
  squat: 'SQUAT',
  plank: 'PLANK',
};

export interface SetupDeps {
  getExercise: () => MovementKind;
  /** Fires when the countdown completes. */
  onReady: () => void;
}

export function createSetupScreen(deps: SetupDeps): Screen & {
  update: (readiness: Readiness) => void;
} {
  const title = required('#setupTitle');
  const rotateOverlay = required('#rotateOverlay');
  const readyOverlay = required('#readyOverlay');
  const readyCount = required('#readyCount');

  let active = false;
  let countdown: number | null = null;
  let timer: number | null = null;
  let rotateTimer: number | null = null;

  function hideRotate(): void {
    if (rotateTimer !== null) window.clearTimeout(rotateTimer);
    rotateTimer = null;
    rotateOverlay.hidden = true;
  }

  function showRotate(): void {
    if (!LANDSCAPE_EXERCISES.has(deps.getExercise())) return;
    rotateOverlay.hidden = false;
    rotateTimer = window.setTimeout(hideRotate, ROTATE_OVERLAY_MS);
  }

  // A tap skips the wait: the overlay has said its piece, and the camera is
  // more useful than the text.
  rotateOverlay.addEventListener('click', hideRotate);

  function stopCountdown(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    countdown = null;
    readyOverlay.hidden = true;
  }

  // The countdown is short and the body is the point of the frame; a tap skips
  // the remaining wait.
  readyOverlay.addEventListener('click', () => {
    if (!active || countdown === null) return;
    stopCountdown();
    deps.onReady();
  });

  function startCountdown(): void {
    countdown = COUNTDOWN_FROM;
    readyCount.textContent = String(countdown);
    readyOverlay.hidden = false;
    tick();
  }

  function tick(): void {
    readyCount.textContent = String(countdown);
    timer = window.setTimeout(() => {
      if (!active) return;
      countdown = (countdown ?? 1) - 1;

      if (countdown <= 0) {
        stopCountdown();
        deps.onReady();
        return;
      }
      tick();
    }, COUNTDOWN_STEP_MS);
  }

  return {
    enter() {
      active = true;
      stopCountdown();
      title.textContent = `POSISI KAMERA · ${MOVEMENT_LABEL[deps.getExercise()]}`;
      showRotate();
    },

    leave() {
      active = false;
      stopCountdown();
      hideRotate();
    },

    update(readiness: Readiness) {
      if (!active) return;

      // Once the camera has held a good view long enough, say so and count
      // down — the set starts itself when the count reaches zero.
      if (readiness.ready && countdown === null) startCountdown();
    },
  };
}
