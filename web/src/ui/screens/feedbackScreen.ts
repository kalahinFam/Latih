/**
 * 5 · Umpan balik akhir set.
 *
 * A sheet over the dimmed camera rather than a page of its own: the next set
 * happens on the screen underneath, and navigating away and back would tear
 * down the camera between two sets of the same workout.
 *
 * Latency and token cost are shown as they are. They are the numbers the paper
 * reports, and reading them off the running product beats trusting a
 * spreadsheet.
 */

import { errorLabel } from '../../core/quality.ts';
import { CoachError, requestCoaching } from '../../coach/coachClient.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import type { SetSummary } from '../../core/setSummary.ts';

/** Rest between sets, per the design. Counts down and then simply reads zero. */
const REST_SECONDS = 60;

export interface FeedbackDeps {
  /** The set just finished, or null when the screen is opened out of order. */
  getSummary: () => SetSummary | null;
  getSetLabel: () => string;
  getTargetReps: () => number;
  /** False on the last planned set, which relabels the primary action. */
  hasMoreSets: () => boolean;
  onNext: () => void;
  onFinish: () => void;
  onNarration: (text: string) => void;
}

export function createFeedbackScreen(deps: FeedbackDeps): Screen {
  const title = required('#feedbackTitle');
  const rest = required('#feedbackRest');
  const eyebrow = required('#feedbackEyebrow');
  const reps = required('#feedbackReps');
  const target = required('#feedbackTarget');
  const narration = required('#feedbackNarration');
  const focusWrap = required('#feedbackFocusWrap');
  const focus = required('#feedbackFocus');
  const errorsWrap = required('#feedbackErrorsWrap');
  const errors = required('#feedbackErrors');
  const meta = required('#feedbackMeta');
  const next = required<HTMLButtonElement>('#feedbackNext');
  const finish = required<HTMLButtonElement>('#feedbackFinish');

  let restTimer: number | null = null;
  let requestId = 0;

  next.addEventListener('click', deps.onNext);
  finish.addEventListener('click', deps.onFinish);

  function startRest(): void {
    let left = REST_SECONDS;
    rest.textContent = `Istirahat ${left} s`;

    if (restTimer !== null) window.clearInterval(restTimer);
    restTimer = window.setInterval(() => {
      left -= 1;
      // Stops at zero rather than nagging. The rest is a suggestion, and the
      // user starts the next set when they are ready.
      rest.textContent = left > 0 ? `Istirahat ${left} s` : 'Siap untuk set berikutnya';
      if (left <= 0 && restTimer !== null) {
        window.clearInterval(restTimer);
        restTimer = null;
      }
    }, 1000);
  }

  function renderErrors(summary: SetSummary): void {
    const entries = Object.entries(summary.errorCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    errorsWrap.hidden = entries.length === 0;
    errors.replaceChildren();

    const worst = entries[0]?.[1] ?? 1;
    for (const [code, count] of entries) {
      const n = count ?? 0;
      errors.append(
        el(
          'div',
          { class: 'bar' },
          el('span', { class: 'bar__dot' }),
          el('span', { class: 'bar__label', text: errorLabel(code) }),
          el(
            'span',
            { class: 'bar__track' },
            el('span', { class: 'bar__fill', style: `width:${Math.round((n / worst) * 100)}%` }),
          ),
          el('span', { class: 'bar__count', text: `${n}×` }),
        ),
      );
    }
  }

  async function loadCoaching(summary: SetSummary): Promise<void> {
    const id = ++requestId;
    narration.textContent = 'Menganalisis set…';
    focusWrap.hidden = true;
    meta.textContent = '';

    try {
      const feedback = await requestCoaching(summary);
      // A slow response for a set the user has already moved past must not
      // overwrite the current one.
      if (id !== requestId) return;

      narration.textContent = feedback.narasi;
      focus.textContent = feedback.fokus_set_berikutnya;
      focusWrap.hidden = feedback.fokus_set_berikutnya.length === 0;
      deps.onNarration(feedback.narasi);

      meta.textContent =
        feedback.latencyMs && feedback.usage
          ? `${(feedback.latencyMs / 1000).toFixed(1)} s · ${feedback.usage.promptTokens}+${feedback.usage.completionTokens} token · $${feedback.usage.costUsd.toFixed(6)}`
          : '';
    } catch (error) {
      if (id !== requestId) return;
      // The fast loop already did its job on device. Losing the narration is a
      // degraded set, not a failed one.
      narration.textContent =
        error instanceof CoachError ? error.message : 'Umpan balik pelatih tidak tersedia.';
      focusWrap.hidden = true;
    }
  }

  return {
    enter() {
      const summary = deps.getSummary();
      title.textContent = deps.getSetLabel();
      next.textContent = deps.hasMoreSets() ? 'Lanjut ke set berikutnya' : 'Tambah satu set lagi';
      startRest();

      if (!summary) {
        eyebrow.textContent = 'BELUM ADA SET';
        reps.textContent = '0';
        target.textContent = 'repetisi';
        narration.textContent = 'Set belum tercatat.';
        focusWrap.hidden = true;
        errorsWrap.hidden = true;
        meta.textContent = '';
        return;
      }

      eyebrow.textContent = 'SET SELESAI';
      reps.textContent = String(summary.repCount);
      target.textContent = `repetisi · target ${deps.getTargetReps()}`;
      renderErrors(summary);
      void loadCoaching(summary);
    },

    leave() {
      if (restTimer !== null) window.clearInterval(restTimer);
      restTimer = null;
      // Any in-flight coaching response is for a set that is no longer on
      // screen.
      requestId += 1;
    },
  };
}
