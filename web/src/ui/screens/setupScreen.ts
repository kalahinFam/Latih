/**
 * 3 · Posisi kamera.
 *
 * ## Why the panel collapses
 *
 * The first build put the whole checklist in a fixed sheet, and on a phone it
 * covered half the frame — so the screen asking the user to fix their position
 * was hiding the only thing that would let them fix it.
 *
 * A checklist is useful until you know what is wrong. After that what you need
 * is to see yourself. So the sheet has two stages: collapsed it is one line —
 * the state, and the single thing to fix — and the full list is a tap away. It
 * collapses itself the moment a pose is detected, which is exactly the moment
 * the camera becomes more useful than the text.
 *
 * ## Which rows carry a tick, and why the others do not
 *
 * The app genuinely measures two things: whether the whole body is inside the
 * frame, and roughly how far away the person is — `bodyFill`, the share of
 * frame height the body spans.
 *
 * It cannot measure camera angle or camera height at all. Nothing in the
 * pipeline estimates either. Those rows are written guidance with no tick: the
 * tick means *the app checked this*, and a tick meaning "we assume so" would
 * make the other two worthless.
 *
 * Distance is stated in body-fill terms rather than metres, because metres
 * would need the lens field of view and the person's height and the app has
 * neither.
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
 * The lower bound is `MIN_BODY_FILL` in `core/framing.ts`, which is what gates
 * readiness; above the upper bound the person is close enough that limbs start
 * leaving the frame during the movement.
 */
const FILL_GOOD = { min: 0.25, max: 0.92 };

/** Countdown shown once the position has been held, before counting starts. */
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 700;

export interface SetupDeps {
  getExercise: () => ExerciseKind;
  /** Fires when the countdown completes. */
  onReady: () => void;
}

export function createSetupScreen(deps: SetupDeps): Screen & {
  update: (readiness: Readiness) => void;
} {
  const title = required('#setupTitle');
  const sheet = required('#setupSheet');
  const toggle = required<HTMLButtonElement>('#setupToggle');
  const detail = required('#setupDetail');
  const barTitle = required('#setupBarTitle');
  const barSub = required('#setupBarSub');
  const count = required('#setupReadyCount');
  const checks = required('#setupChecks');
  const note = required('#setupNote');

  let active = false;
  let countdown: number | null = null;
  let timer: number | null = null;
  /** Cleared once a pose arrives, so the auto-collapse happens exactly once. */
  let awaitingFirstPose = true;

  function setExpanded(expanded: boolean): void {
    sheet.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    detail.hidden = !expanded;
  }

  toggle.addEventListener('click', () => {
    // A manual tap ends the automatic behaviour: after this the sheet is the
    // user's to open and close.
    awaitingFirstPose = false;
    setExpanded(sheet.dataset.expanded !== 'true');
  });

  function row(state: 'ok' | 'pending' | 'info', text: string, value?: string): HTMLElement {
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

  /**
   * Is the distance workable?
   *
   * Gated on framing, not only on `bodyFill`. Body fill is measured over the
   * landmarks that *are* visible, so a head alone can produce a plausible
   * number — which is how a screenshot ended up showing "Jarak pas ✓" beside a
   * frame containing nothing but the top of someone's head. A distance reading
   * means nothing until the body is actually in shot.
   */
  function distanceOk(readiness: Readiness | null): boolean {
    if (!readiness?.hasPose || !readiness.framingOk) return false;
    return readiness.bodyFill >= FILL_GOOD.min && readiness.bodyFill <= FILL_GOOD.max;
  }

  function renderChecks(readiness: Readiness | null): void {
    const guidance = CAMERA_GUIDANCE[deps.getExercise()];
    const framingOk = readiness?.framingOk === true;
    const distance = distanceOk(readiness);

    checks.replaceChildren(
      row(framingOk ? 'ok' : 'pending', 'Seluruh badan terlihat'),
      row(
        distance ? 'ok' : 'pending',
        `Jarak pas — ${guidance.distance}`,
        // Body fill is what is measured, so body fill is what is shown.
        readiness?.hasPose ? `badan ${Math.round(readiness.bodyFill * 100)}% tinggi layar` : undefined,
      ),
      row('info', guidance.angle),
      row('info', `Tinggi kamera ${guidance.height}`),
    );

    note.textContent = guidance.note;
  }

  function passedCount(readiness: Readiness | null): string {
    const passed = (readiness?.framingOk ? 1 : 0) + (distanceOk(readiness) ? 1 : 0);
    return `${passed}/2`;
  }

  function stopCountdown(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    countdown = null;
  }

  function renderBar(readiness: Readiness | null): void {
    const isReady = readiness?.ready === true;
    sheet.dataset.ready = String(isReady);

    if (isReady) {
      barTitle.textContent = 'POSISI SIAP';
      barSub.textContent = 'Tahan posisi, hitungan mulai';
      count.hidden = false;

      if (countdown === null) {
        countdown = COUNTDOWN_FROM;
        tick();
      }
      count.textContent = String(countdown);
      return;
    }

    stopCountdown();
    // The same slot carries the tally while the position is still being set,
    // so the bar never changes width as it switches.
    count.hidden = false;
    count.textContent = passedCount(readiness);
    barTitle.textContent = 'ATUR POSISI';
    // The single thing to fix. This is the whole point of the collapsed state:
    // one instruction, not a list to work through.
    barSub.textContent =
      readiness?.message ?? (readiness?.hasPose ? 'Tahan posisi sebentar' : 'Berdiri di depan kamera');
  }

  function tick(): void {
    count.textContent = String(countdown);
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
      awaitingFirstPose = true;
      stopCountdown();
      title.textContent = `POSISI KAMERA · ${deps.getExercise() === 'pushup' ? 'PUSH-UP' : 'SQUAT'}`;
      // Open to begin with: before a pose exists there is nothing to look at,
      // so the guidance is the most useful thing on screen.
      setExpanded(true);
      renderChecks(null);
      renderBar(null);
    },

    leave() {
      active = false;
      stopCountdown();
    },

    update(readiness: Readiness) {
      if (!active) return;

      if (awaitingFirstPose && readiness.hasPose) {
        // The camera has found them. From here the frame is worth more than
        // the list.
        awaitingFirstPose = false;
        setExpanded(false);
      }

      renderChecks(readiness);
      renderBar(readiness);
    },
  };
}
