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
import { isLowConfidence, listen, speechSupport, type Listening } from '../../audio/speech.ts';
import { REFERRAL_TEXT, needsReferral } from '../../core/referral.ts';
import { applySubstitution, loadComplaints, recordComplaint } from '../../session/complaints.ts';
import { el, required } from '../dom.ts';
import { icon } from '../icons.ts';
import type { Screen } from '../../app/router.ts';
import type { SetSummary } from '../../core/setSummary.ts';
import type { BodyPart, BodySide, SubstituteMovement } from '../../core/restChat.ts';
import type { MovementKind } from '../../core/types.ts';

/** Rest between sets, per the design. Counts down and then simply reads zero. */
const REST_SECONDS = 60;

/**
 * A swap the coach has offered and the user has not yet answered.
 *
 * Held rather than applied, and carrying enough of the complaint to log it
 * either way — see the note on `decideSwap`.
 */
interface PendingSwap {
  from: MovementKind;
  to: SubstituteMovement;
  part: BodyPart;
  side: BodySide | null;
  /** What the user actually said, kept verbatim for the log. */
  said: string;
}

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
  const text = required<HTMLInputElement>('#restText');
  const send = required<HTMLButtonElement>('#restSend');
  const status = required('#restStatus');
  const answer = required('#restAnswer');
  const swap = required('#restSwap');
  const swapHead = required('#restSwapHead');
  const swapHow = required('#restSwapHow');
  const swapActions = required('#restSwapActions');
  const swapYes = required<HTMLButtonElement>('#restSwapYes');
  const swapNo = required<HTMLButtonElement>('#restSwapNo');
  const referral = required('#restReferral');
  const disclosure = required('#restDisclosure');

  let restTimer: number | null = null;
  let requestId = 0;
  let askId = 0;
  let listening: Listening | null = null;
  /** The offered swap, until the user accepts or declines it. */
  let pendingSwap: PendingSwap | null = null;

  next.addEventListener('click', deps.onNext);
  finish.addEventListener('click', deps.onFinish);

  /* ---------------------------------------------------- ask during rest */

  mic.append(icon('suara', 20));
  send.append(icon('kirim', 19));

  const support = speechSupport();
  // Only the reason, and only when there is one. The privacy sentence this line
  // used to carry now lives solely in the settings screen: it is a paragraph,
  // and a paragraph under a microphone on a screen with a rest timer running is
  // a paragraph nobody reads.
  disclosure.textContent = support.supported ? '' : support.reason;
  disclosure.hidden = support.supported;
  mic.hidden = !support.supported;

  /** The button is the only indicator that the microphone is open. */
  function showListening(live: boolean): void {
    mic.classList.toggle('restask__mic--live', live);
    mic.setAttribute('aria-pressed', String(live));
    mic.setAttribute('aria-label', live ? 'Selesai bicara' : 'Bicara ke pelatih');
  }

  function stopListening(): void {
    listening?.cancel();
    listening = null;
    showListening(false);
  }

  function toggleMic(): void {
    if (listening) {
      // Second tap means "I'm done", not "cancel" — let the final result land.
      listening.stop();
      listening = null;
      showListening(false);
      return;
    }

    status.textContent = 'Mendengarkan…';
    clearExchange();

    listening = listen({
      onInterim: (partial) => {
        // Shown as it arrives so the user can see it is hearing them, rather
        // than staring at a button and wondering.
        text.value = partial;
      },
      onFinal: (final, confidence) => {
        listening = null;
        showListening(false);
        text.value = final;

        // A transcript the recogniser is unsure of is put in front of the user
        // instead of acted on. Nothing new is needed to say yes to it: the text
        // field and the send button are already there, and they are the same
        // fallback somebody with no working microphone uses.
        if (isLowConfidence(confidence)) {
          status.textContent =
            'Kurang jelas terdengarnya. Cek teksnya lalu tekan Kirim, atau ketik ulang.';
          text.focus();
          return;
        }

        void ask(final);
      },
      onError: (message) => {
        listening = null;
        showListening(false);
        status.textContent = message;
      },
    });

    if (!listening) {
      status.textContent = 'Mikrofon tidak bisa dipakai sekarang. Ketik saja.';
      return;
    }
    showListening(true);
  }

  /** Everything the last exchange put on screen, and the offer it left open. */
  function clearExchange(): void {
    answer.hidden = true;
    swap.hidden = true;
    referral.hidden = true;
    pendingSwap = null;
  }

  /**
   * Accept or decline the offered swap, and log the complaint either way.
   *
   * The complaint is recorded here rather than when the reply arrives, so what
   * the log says happened is what actually happened. `complaints.ts` keeps this
   * record precisely so somebody can show it to a person who does make medical
   * judgements; a row claiming the squat was replaced on a day the user said no
   * would make it worth less than nothing.
   */
  function decideSwap(accepted: boolean): void {
    const proposal = pendingSwap;
    if (!proposal) return;
    pendingSwap = null;

    if (accepted) applySubstitution(proposal.from, proposal.to);

    recordComplaint({
      at: Date.now(),
      part: proposal.part,
      side: proposal.side,
      said: proposal.said,
      replaced: accepted ? proposal.from : null,
      replacedWith: accepted ? proposal.to : null,
    });

    swapActions.hidden = true;
    if (accepted) {
      // The card stays as confirmation — it holds the instructions for a
      // movement the camera will not be counting.
      status.textContent = '';
    } else {
      swap.hidden = true;
      status.textContent = 'Oke, rencananya tidak diubah.';
    }
  }

  swapYes.addEventListener('click', () => decideSwap(true));
  swapNo.addEventListener('click', () => decideSwap(false));

  /**
   * Send one message and act on the reply.
   *
   * The substitution is decided here rather than in the client, because
   * changing what the user will be asked to do next belongs where the rest of
   * the screen's decisions are visible — and, since it arrived through a
   * microphone held by somebody out of breath, it is offered rather than
   * applied.
   */
  async function ask(message: string): Promise<void> {
    const id = ++askId;
    const trimmed = message.trim();
    if (!trimmed) return;

    status.textContent = 'Pelatih sedang menjawab…';
    clearExchange();
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
        // Read the log before writing to it — `needsReferral` adds the current
        // complaint itself, and calling it after the write would count it twice.
        const repeated = needsReferral(loadComplaints(), reply.bodyPart, Date.now());

        if (reply.substitution && reply.substitutionText) {
          // Offered, not applied. The complaint is logged when the user answers.
          pendingSwap = {
            from: reply.substitution.from,
            to: reply.substitution.to,
            part: reply.bodyPart,
            side: reply.side,
            said: trimmed,
          };
          swapHead.textContent = reply.substitutionText;
          swapHow.textContent = reply.substituteHowto ?? '';
          swapActions.hidden = false;
          swap.hidden = false;
        } else {
          // Nothing to offer — an elbow displaces nothing this app trains. The
          // complaint is still a record worth keeping, so it is written now.
          recordComplaint({
            at: Date.now(),
            part: reply.bodyPart,
            side: reply.side,
            said: trimmed,
            replaced: null,
            replacedWith: null,
          });
        }

        if (repeated) {
          // Added to the answer, never instead of it: a pattern worth mentioning
          // is not a reason to stop helping with today's set. Fixed wording from
          // `core/referral.ts`, decided on the device — the model is never asked
          // to write this sentence.
          referral.textContent = REFERRAL_TEXT;
          referral.hidden = false;
        }
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

  /** What the primary action reads once the rest is over. */
  function readyLabel(): string {
    return deps.hasMoreSets() ? 'Lanjut ke set berikutnya' : 'Tambah satu set lagi';
  }

  /**
   * The countdown, shown on the button it is about.
   *
   * Disabling rather than merely counting: a live primary button during rest is
   * an invitation to skip it, and the rest between sets is part of the training,
   * not a pause in it. `Selesai latihan` stays enabled throughout — stopping is
   * never something to be locked out of.
   */
  function showRest(secondsLeft: number): void {
    const resting = secondsLeft > 0;
    next.disabled = resting;
    next.textContent = resting ? `Istirahat ${secondsLeft} s` : readyLabel();
  }

  function startRest(): void {
    let left = REST_SECONDS;
    showRest(left);

    if (restTimer !== null) window.clearInterval(restTimer);
    restTimer = window.setInterval(() => {
      left -= 1;
      showRest(left);
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
      // Sets the label too — until the countdown reaches zero it reads as the
      // rest, and `readyLabel()` decides what it becomes afterwards.
      startRest();

      // A fresh rest, not a continuation of the last one's conversation.
      status.textContent = '';
      clearExchange();
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
      // Walking away is not consent. The swap is dropped, but the complaint is
      // still logged — with nothing replaced, which is what happened.
      decideSwap(false);
      // The microphone must not keep listening into the next set — the light
      // stays on, and the user has no screen left to turn it off from.
      stopListening();
    },
  };
}
