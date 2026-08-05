/**
 * 1 · Beranda.
 *
 * One decision per screen: start, or not. Everything else is context for that
 * decision, which is why the target carries its own reason — a number that
 * rises without explanation reads as an app making demands rather than a coach
 * making a call.
 */

import { currentStreak, formatDuration, latestQuality, latestSession } from '../../core/quality.ts';
import { explainTarget } from '../../core/sessionLoop.ts';
import { TrainingHistory } from '../../session/history.ts';
import { loadPreferences } from '../../session/profile.ts';
import { EXERCISE_NAMES, formatDate, greetingFor, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import { isHold, type MovementKind } from '../../core/types.ts';

export interface HomeDeps {
  history: TrainingHistory;
  /** Movement the home screen offers first. */
  defaultExercise: MovementKind;
  onStart: () => void;
  onSettings: () => void;
}

export function createHomeScreen(deps: HomeDeps): Screen {
  const date = required('#homeDate');
  const greeting = required('#homeGreeting');
  const lastSession = required('#homeLastSession');
  const targetReps = required('#homeTargetReps');
  const targetSets = required('#homeTargetSets');
  const targetExercise = required('#homeTargetExercise');
  const targetReason = required('#homeTargetReason');
  const streak = required('#homeStreak');
  const quality = required('#homeQuality');

  required<HTMLButtonElement>('#homeStart').addEventListener('click', deps.onStart);
  required<HTMLButtonElement>('#homeSettings').addEventListener('click', deps.onSettings);

  return {
    enter() {
      const now = Date.now();
      const history = deps.history.all();
      const movement = deps.defaultExercise;
      const target = isHold(movement)
        ? deps.history.currentHoldTarget(movement)
        : deps.history.currentTarget(movement);
      const prefs = loadPreferences();

      date.textContent = formatDate(now);
      greeting.textContent = greetingFor(now);

      const last = latestSession(history);
      lastSession.textContent = last
        ? `Sesi terakhir ${formatDate(last.startedAt)}, ${last.reps} repetisi dalam ${formatDuration(last.elapsedMs)}.`
        : 'Belum ada sesi tercatat. Mulai yang pertama.';

      targetReps.textContent = String(
        'targetReps' in target ? target.targetReps : target.targetSeconds,
      );
      targetSets.textContent = `${isHold(movement) ? 'detik' : 'repetisi'} × ${prefs.setsPerExercise} set`;
      targetExercise.textContent = EXERCISE_NAMES[movement] ?? movement;
      targetReason.textContent = explainTarget(target);

      streak.textContent = String(currentStreak(history, now));
      // An em dash rather than a zero: no sessions yet is not a score of nought.
      const score = latestQuality(history);
      quality.textContent = score === null ? '—' : String(score);
    },
  };
}
