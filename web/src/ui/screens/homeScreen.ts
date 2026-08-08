/**
 * 1 · Beranda.
 *
 * One decision per screen: start, or not. Everything else is context for that
 * decision, which is why the target carries its own reason — a number that
 * rises without explanation reads as an app making demands rather than a coach
 * making a call.
 *
 * ## Why the week is here
 *
 * The split decides what today contains, and "what today contains" is only
 * meaningful against the week around it: three marks with today in the middle
 * says *this is session two of three* without a sentence. It is also the only
 * place a rest day can be shown as part of the plan rather than as an absence —
 * a screen that says nothing on a Tuesday looks like an app with nothing to
 * say, not like a programme with a rest day in it.
 *
 * The big number stays the first movement of today's session. The design gives
 * one number per screen the job of being read at a glance, and splitting it
 * across three movements would leave three numbers and no glance.
 */

import { buildWeeklyPlan, WEEKDAY_SHORT, type PlanDay } from '../../core/plan.ts';
import { currentStreak, formatDuration, latestQuality, latestSession } from '../../core/quality.ts';
import { explainReason } from '../../core/sessionLoop.ts';
import { estimatedMinutes, sessionFor } from '../../core/split.ts';
import { TrainingHistory } from '../../session/history.ts';
import { currentSplit } from '../../session/planner.ts';
import { loadExtras, loadPreferences } from '../../session/profile.ts';
import { el, formatDate, greetingFor, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import { MOVEMENT_NAMES, type MovementKind } from '../../core/types.ts';

export interface HomeDeps {
  history: TrainingHistory;
  /**
   * Offer the movement the plan puts first today.
   *
   * The home screen is where the plan is read, so it is also where the
   * "Latihan" button should be pointed — otherwise the app shows a session and
   * then starts a different one.
   */
  setExercise: (movement: MovementKind) => void;
}

export function createHomeScreen(deps: HomeDeps): Screen {
  const date = required('#homeDate');
  const greeting = required('#homeGreeting');
  const lastSession = required('#homeLastSession');
  const week = required('#homeWeek');
  const eyebrow = required('#homeTargetEyebrow');
  const targetReps = required('#homeTargetReps');
  const targetSets = required('#homeTargetSets');
  const targetExercise = required('#homeTargetExercise');
  const targetReason = required('#homeTargetReason');
  const sessionRest = required('#homeSessionRest');
  const streak = required('#homeStreak');
  const quality = required('#homeQuality');

  /** Seven marks: planned, done, today. */
  function renderWeek(days: PlanDay[]): void {
    week.replaceChildren(
      ...days.map((day) =>
        el(
          'div',
          {
            class: 'weekstrip__day',
            'data-training': String(day.isTraining),
            'data-done': String(day.done),
            'data-today': String(day.isToday),
            // The dots carry the state visually; the label carries it for a
            // screen reader, which cannot see that one is filled.
            'aria-label': `${day.label}: ${
              day.isTraining ? (day.done ? 'sudah latihan' : 'jadwal latihan') : 'istirahat'
            }`,
          },
          el('span', { class: 'weekstrip__name', text: WEEKDAY_SHORT[day.weekday] }),
          el('span', { class: 'weekstrip__mark' }),
        ),
      ),
    );
  }

  return {
    enter() {
      const now = Date.now();
      const history = deps.history.all();
      const preferences = loadPreferences();
      const split = currentSplit();
      const plan = buildWeeklyPlan(preferences, history, now, split);
      const today = plan.days.find((day) => day.isToday) ?? null;

      date.textContent = formatDate(now);
      // The one thing the name is for. Without it the greeting still reads
      // naturally, which is why the question is skippable.
      const name = loadExtras().name.trim();
      greeting.textContent = name ? `${greetingFor(now)}, ${name}` : greetingFor(now);

      const last = latestSession(history);
      lastSession.textContent = last
        ? `Sesi terakhir ${formatDate(last.startedAt)}, ${last.reps} repetisi dalam ${formatDuration(last.elapsedMs)}.`
        : 'Belum ada sesi tercatat. Mulai yang pertama.';

      renderWeek(plan.days);

      const first = today?.exercises[0] ?? null;

      if (!today?.isTraining || !first) {
        // The next session in the week, wrapping to the start once this week's
        // are behind us — a Sunday evening needs something to point at too.
        const next =
          plan.days.find((day) => day.isTraining && day.weekday > (today?.weekday ?? 0)) ??
          plan.days.find((day) => day.isTraining) ??
          null;

        // The button still starts something: training off-plan is a decision
        // the user is allowed to make, and the next session's opener is the
        // least surprising thing to offer.
        deps.setExercise(next?.exercises[0]?.movement ?? 'pushup');

        eyebrow.textContent = 'HARI ISTIRAHAT';
        targetReps.textContent = '—';
        targetSets.textContent = '';
        targetExercise.textContent = next
          ? `Sesi berikutnya ${next.label}${next.focusLabel ? ` · ${next.focusLabel}` : ''}`
          : 'Belum ada jadwal';
        targetReason.textContent =
          'Pemulihan terjadi di hari istirahat, bukan di sesinya. Tetap boleh latihan hari ini kalau mau — jadwalnya tidak ikut bergeser.';
        sessionRest.replaceChildren();
        streak.textContent = String(currentStreak(history, now));
        const restScore = latestQuality(history);
        quality.textContent = restScore === null ? '—' : String(restScore);
        return;
      }

      deps.setExercise(first.movement);

      const session = sessionFor(split, today.weekday);
      eyebrow.textContent = session ? `HARI INI · ${session.label.toUpperCase()}` : 'TARGET HARI INI';
      targetReps.textContent = String(first.amount);
      targetSets.textContent = `${first.unit === 'seconds' ? 'detik' : 'repetisi'} × ${first.sets} set`;
      targetExercise.textContent = MOVEMENT_NAMES[first.movement];
      targetReason.textContent = explainReason(first.reason, first.unit === 'seconds');

      // Everything after the first movement, stated in its own unit.
      sessionRest.replaceChildren();
      sessionRest.append(
        ...today.exercises.slice(1).map((planned) =>
          el(
            'div',
            { class: 'sessionlist__row' },
            el('span', { class: 'sessionlist__name', text: MOVEMENT_NAMES[planned.movement] }),
            el('span', {
              class: 'sessionlist__dose',
              text: `${planned.sets} × ${planned.amount}${planned.unit === 'seconds' ? ' detik' : ''}`,
            }),
          ),
        ),
      );
      if (session) {
        sessionRest.append(
          el('p', {
            class: 'sessionlist__foot',
            text: `Sekitar ${estimatedMinutes(split, session)} menit · istirahat ${split.restSeconds} detik antar set.`,
          }),
        );
      }

      streak.textContent = String(currentStreak(history, now));
      // An em dash rather than a zero: no sessions yet is not a score of nought.
      const score = latestQuality(history);
      quality.textContent = score === null ? '—' : String(score);
    },
  };
}
