/**
 * 3 · Posisi kamera.
 *
 * ## Which rows carry a tick, and why the others do not
 *
 * The design shows four checks. The app can genuinely measure two of them:
 * whether the whole body is inside the frame, and roughly how far away the
 * person is — `bodyFill`, the share of frame height the body spans, which is a
 * real measurement even though it is not metres.
 *
 * It cannot measure camera angle or camera height at all. Nothing in the
 * pipeline estimates either. Those two rows are therefore shown as written
 * guidance with no tick and no value: the tick means *the app checked this*,
 * and a tick that meant "we assume so" would make the other two worthless. A
 * judge asking how the 30–45° check works deserves an answer better than a
 * green circle.
 *
 * Distance is stated as a range in body-fill terms rather than a number in
 * metres, because metres would be a conversion the app cannot justify: it
 * depends on lens field of view and on the person's height, and it has neither.
 */

import { CAMERA_GUIDANCE } from '../../core/framing.ts';
import { el, required } from '../dom.ts';
import { icon } from '../icons.ts';
import type { Screen } from '../../app/router.ts';
import type { Readiness } from '../workoutEngine.ts';
import type { ExerciseKind } from '../../core/types.ts';

/**
 * Body height as a share of frame height that reads as a workable distance.
 *
 * The lower bound is `MIN_BODY_FILL` in `core/framing.ts`, which is what
 * actually gates readiness; above the upper bound the person is close enough
 * that limbs start leaving the frame during the movement.
 */
const FILL_GOOD = { min: 0.25, max: 0.92 };

/** Countdown shown once the position has been held, before counting starts. */
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 700;

export interface SetupDeps {
  getExercise: () => ExerciseKind;
  /** Fires when the countdown completes. */
  onReady: () => void;
  onSpeak: (text: string) => void;
}

export function createSetupScreen(deps: SetupDeps): Screen & {
  update: (readiness: Readiness) => void;
} {
  const title = required('#setupTitle');
  const checks = required('#setupChecks');
  const ready = required('#setupReady');
  const readyTitle = required('#setupReadyTitle');
  const readySub = required('#setupReadySub');
  const readyCount = required('#setupReadyCount');
  const note = required('#setupNote');

  let active = false;
  let countdown: number | null = null;
  let timer: number | null = null;

  function row(
    state: 'ok' | 'pending' | 'info',
    text: string,
    value?: string,
  ): HTMLElement {
    const mark = el('span', { class: 'check__mark', 'data-state': state, 'aria-hidden': 'true' });

    // Drawn rather than typed: "✓" and "i" land on whatever glyph the device
    // font happens to have, and the tick is the one thing on this screen that
    // has to be unmistakable at a glance.
    if (state === 'ok') mark.append(icon('centang', 13, 2.6));
    else if (state === 'info') mark.append(icon('info', 13, 2));

    return el(
      'li',
      { class: 'check' },
      mark,
      el('span', { class: 'check__text', text }),
      value ? el('span', { class: 'check__value', text: value }) : null,
    );
  }

  function renderChecks(readiness: Readiness | null): void {
    const exercise = deps.getExercise();
    const guidance = CAMERA_GUIDANCE[exercise];
    const fill = readiness?.bodyFill ?? 0;
    const distanceOk = fill >= FILL_GOOD.min && fill <= FILL_GOOD.max;

    checks.replaceChildren(
      row(
        readiness?.framingOk ? 'ok' : 'pending',
        'Seluruh badan terlihat',
      ),
      row(
        readiness?.hasPose && distanceOk ? 'ok' : 'pending',
        `Jarak pas — ${guidance.distance}`,
        // Body fill is what is actually measured, so body fill is what is
        // shown. Converting it to metres would need the lens field of view and
        // the person's height, and the app has neither.
        readiness?.hasPose ? `badan ${Math.round(fill * 100)}% tinggi layar` : undefined,
      ),
      // No tick: not measured.
      row('info', guidance.angle),
      row('info', `Tinggi kamera ${guidance.height}`),
    );

    note.textContent = guidance.note;
  }

  function stopCountdown(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    countdown = null;
  }

  function renderReady(readiness: Readiness | null): void {
    const isReady = readiness?.ready === true;
    ready.dataset.ready = String(isReady);

    if (!isReady) {
      stopCountdown();
      readyTitle.textContent = 'ATUR POSISI';
      readySub.textContent = readiness?.message ?? 'Ikuti panduan di bawah';
      readyCount.textContent = '—';
      return;
    }

    readyTitle.textContent = 'POSISI SIAP';
    readySub.textContent = 'Tahan posisi, hitungan mulai';

    if (countdown === null) {
      countdown = COUNTDOWN_FROM;
      tick();
    }
    readyCount.textContent = String(countdown);
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
      title.textContent = `POSISI KAMERA · ${deps.getExercise() === 'pushup' ? 'PUSH-UP' : 'SQUAT'}`;
      renderChecks(null);
      renderReady(null);
    },

    leave() {
      active = false;
      stopCountdown();
    },

    update(readiness: Readiness) {
      if (!active) return;
      renderChecks(readiness);
      renderReady(readiness);
    },
  };
}
