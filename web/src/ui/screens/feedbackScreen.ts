/**
 * 5 · Umpan balik akhir set.
 *
 * The camera closes when the set ends — the privacy light goes off and the
 * fast loop (framing, posture gates, counting) stops with it. The sheet is
 * therefore a screen of its own rather than an overlay over a live feed.
 * Reopening for the next set is cheap: only `getUserMedia` is needed, because
 * the pose model stays loaded in memory.
 */

import { errorLabel } from '../../core/quality.ts';
import { CoachError, requestCoaching } from '../../coach/coachClient.ts';
import { RestChatError, askCoach } from '../../coach/restChatClient.ts';
import { listen, speechDisclosure, speechSupport, type Listening } from '../../audio/speech.ts';
import { applySubstitution, recordComplaint } from '../../session/complaints.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import type { SetSummary } from '../../core/setSummary.ts';
import type { MovementKind } from '../../core/types.ts';

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
  /** The movement just trained, and what today asks for — context for the coach. */
  getMovement: () => MovementKind;
  getTodaysMovements: () => MovementKind[];
  getSetsDone: () => number;
  getSetsPlanned: () => number;
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
  const next = required<HTMLButtonElement>('#feedbackNext');
  const finish = required<HTMLButtonElement>('#feedbackFinish');

  const mic = required<HTMLButtonElement>('#restMic');
  const micLabel = required('#restMicLabel');
  const text = required<HTMLInputElement>('#restText');
  const send = required<HTMLButtonElement>('#restSend');
  const status = required('#restStatus');
  const answer = required('#restAnswer');
  const swap = required('#restSwap');
  const swapHead = required('#restSwapHead');
  const swapHow = required('#restSwapHow');
  const disclosure = required('#restDisclosure');

  let restTimer: number | null = null;
  let requestId = 0;
  let askId = 0;
  let listening: Listening | null = null;

  next.addEventListener('click', deps.onNext);
  finish.addEventListener('click', deps.onFinish);

  /* ---------------------------------------------------- ask during rest */

  const support = speechSupport();
  disclosure.textContent = support.supported ? speechDisclosure() : support.reason;
  mic.hidden = !support.supported;

  function stopListening(): void {
    listening?.cancel();
    listening = null;
    mic.classList.remove('restask__mic--live');
    micLabel.textContent = 'Bicara';
  }

  function toggleMic(): void {
    if (listening) {
      // Second tap means "I'm done", not "cancel" — let the final result land.
      listening.stop();
      listening = null;
      mic.classList.remove('restask__mic--live');
      micLabel.textContent = 'Bicara';
      return;
    }

    status.textContent = 'Mendengarkan…';
    answer.hidden = true;
    swap.hidden = true;

    listening = listen({
      onInterim: (partial) => {
        // Shown as it arrives so the user can see it is hearing them, rather
        // than staring at a button and wondering.
        text.value = partial;
      },
      onFinal: (final) => {
        listening = null;
        mic.classList.remove('restask__mic--live');
        micLabel.textContent = 'Bicara';
        text.value = final;
        void ask(final);
      },
      onError: (message) => {
        listening = null;
        mic.classList.remove('restask__mic--live');
        micLabel.textContent = 'Bicara';
        status.textContent = message;
      },
    });

    if (!listening) {
      status.textContent = 'Mikrofon tidak bisa dipakai sekarang. Ketik saja.';
      return;
    }
    mic.classList.add('restask__mic--live');
    micLabel.textContent = 'Selesai';
  }

  /**
   * Send one message and act on the reply.
   *
   * The substitution is applied here rather than in the client, because
   * applying it is a change to what the user will be asked to do next and
   * belongs where the rest of the screen's decisions are visible.
   */
  async function ask(message: string): Promise<void> {
    const id = ++askId;
    const trimmed = message.trim();
    if (!trimmed) return;

    status.textContent = 'Pelatih sedang menjawab…';
    answer.hidden = true;
    swap.hidden = true;
    send.disabled = true;

    try {
      const reply = await askCoach({
        message: trimmed,
        movement: deps.getMovement(),
        today: deps.getTodaysMovements(),
        setsDone: deps.getSetsDone(),
        setsPlanned: deps.getSetsPlanned(),
      });
      // A reply for a set the user has already moved past must not appear over
      // the current one.
      if (id !== askId) return;

      status.textContent = '';
      // `remaining` is computed from the plan the device holds, so it is the
      // one sentence here that cannot be wrong. Shown alongside, not instead:
      // the model's reply carries the tone, this carries the fact.
      answer.textContent = reply.remaining ? `${reply.answer} ${reply.remaining}` : reply.answer;
      answer.hidden = false;
      text.value = '';

      if (reply.intent === 'complaint' && reply.bodyPart) {
        // Logged whether or not anything could be substituted: an elbow maps to
        // no swap, and the complaint is still a record worth keeping.
        recordComplaint({
          at: Date.now(),
          part: reply.bodyPart,
          side: reply.side,
          said: trimmed,
          replaced: reply.substitution?.from ?? null,
          replacedWith: reply.substitution?.to ?? null,
        });
      }

      if (reply.substitution && reply.substitutionText) {
        applySubstitution(reply.substitution.from, reply.substitution.to);
        swapHead.textContent = reply.substitutionText;
        swapHow.textContent = reply.substituteHowto ?? '';
        swap.hidden = false;
      }
    } catch (error) {
      if (id !== askId) return;
      status.textContent =
        error instanceof RestChatError ? error.message : 'Pelatih tidak bisa dihubungi.';
    } finally {
      if (id === askId) send.disabled = false;
    }
  }

  mic.addEventListener('click', toggleMic);
  send.addEventListener('click', () => void ask(text.value));
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void ask(text.value);
  });

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

    try {
      const feedback = await requestCoaching(summary);
      // A slow response for a set the user has already moved past must not
      // overwrite the current one.
      if (id !== requestId) return;

      narration.textContent = feedback.narasi;
      focus.textContent = feedback.fokus_set_berikutnya;
      focusWrap.hidden = feedback.fokus_set_berikutnya.length === 0;
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

      // A fresh rest, not a continuation of the last one's conversation.
      status.textContent = '';
      answer.hidden = true;
      swap.hidden = true;
      text.value = '';

      if (!summary) {
        eyebrow.textContent = 'BELUM ADA SET';
        reps.textContent = '0';
        target.textContent = 'repetisi';
        narration.textContent = 'Set belum tercatat.';
        focusWrap.hidden = true;
        errorsWrap.hidden = true;
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
      askId += 1;
      // The microphone must not keep listening into the next set — the light
      // stays on, and the user has no screen left to turn it off from.
      stopListening();
    },
  };
}
