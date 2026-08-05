/**
 * 6 · Ringkasan sesi.
 *
 * One big number, and it is movement quality rather than repetitions — that is
 * what this product is for. Repetitions sit underneath it.
 *
 * The score is explained on the same card ("5 dari 34 repetisi ditandai") so it
 * is never a number the user cannot trace. Comparison with the previous session
 * uses the same deltas the coach is given, so the screen and the narration
 * cannot disagree.
 */

import { errorLabel, formatDuration, summarizeSession } from '../../core/quality.ts';
import { explainTarget, groupIntoSessions, progressTrend } from '../../core/sessionLoop.ts';
import { TrainingHistory } from '../../session/history.ts';
import { loadPreferences } from '../../session/profile.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import type { ExerciseKind } from '../../core/types.ts';

export interface SummaryDeps {
  history: TrainingHistory;
  getExercise: () => ExerciseKind;
  onDone: () => void;
}

export function createSummaryScreen(deps: SummaryDeps): Screen {
  const meta = required('#summaryMeta');
  const quality = required('#summaryQuality');
  const qualityBar = required('#summaryQualityBar');
  const qualityNote = required('#summaryQualityNote');
  const reps = required('#summaryReps');
  const repsDelta = required('#summaryRepsDelta');
  const depth = required('#summaryDepth');
  const depthDelta = required('#summaryDepthDelta');
  const errorsWrap = required('#summaryErrorsWrap');
  const errors = required('#summaryErrors');
  const nextTarget = required('#summaryNextTarget');
  const nextSets = required('#summaryNextSets');
  const nextReason = required('#summaryNextReason');

  required<HTMLButtonElement>('#summaryDone').addEventListener('click', deps.onDone);

  function setDelta(node: HTMLElement, value: number, suffix: string, betterIsUp: boolean): void {
    if (value === 0) {
      node.textContent = 'sama seperti sesi lalu';
      node.removeAttribute('data-dir');
      return;
    }

    const improved = betterIsUp ? value > 0 : value < 0;
    const magnitude = Math.abs(value);
    node.textContent = betterIsUp
      ? `${value > 0 ? '+' : '−'}${magnitude} ${suffix}`
      : `${magnitude}${suffix} ${value < 0 ? 'lebih dalam' : 'lebih dangkal'}`;
    node.dataset.dir = improved ? 'up' : 'down';
  }

  return {
    enter() {
      const exercise = deps.getExercise();
      const history = deps.history.all();
      const sessions = groupIntoSessions(history.filter((s) => s.exercise === exercise));

      if (sessions.length === 0) {
        meta.textContent = '';
        quality.textContent = '—';
        qualityNote.textContent = 'Belum ada set tercatat di sesi ini.';
        return;
      }

      const stats = summarizeSession(sessions[sessions.length - 1]);
      const prefs = loadPreferences();

      meta.textContent = `${formatDuration(stats.elapsedMs)} · ${stats.sets} set`;

      quality.textContent = stats.quality === null ? '—' : String(stats.quality);
      qualityBar.style.width = `${stats.quality ?? 0}%`;
      qualityNote.textContent =
        stats.quality === null
          ? 'Tidak ada repetisi terhitung di sesi ini.'
          : `${stats.flaggedReps} dari ${stats.reps} repetisi ditandai. Sudut terbaca ${Math.round(stats.trackingQuality * 100)}% frame.`;

      reps.textContent = String(stats.reps);
      depth.textContent = stats.meanDepthDeg === null ? '—' : `${Math.round(stats.meanDepthDeg)}°`;

      // The same numbers the coach was given, so the screen and the narration
      // cannot tell different stories.
      const trend = progressTrend(exercise, history);
      if (trend && trend.sessions >= 2) {
        setDelta(repsDelta, trend.repsDelta, 'repetisi', true);
        setDelta(depthDelta, Math.round(trend.depthDeltaDeg), '°', false);
      } else {
        repsDelta.textContent = '';
        depthDelta.textContent = '';
      }

      const entries = Object.entries(stats.errorCounts).sort((a, b) => b[1] - a[1]);
      errorsWrap.hidden = entries.length === 0;
      errors.replaceChildren();
      const worst = entries[0]?.[1] ?? 1;

      for (const [code, count] of entries) {
        errors.append(
          el(
            'div',
            { class: 'bar' },
            el(
              'div',
              { class: 'bar__head' },
              el('span', { class: 'bar__label', text: errorLabel(code) }),
              el('span', { class: 'bar__count', text: `${count}×` }),
            ),
            el(
              'span',
              { class: 'bar__track' },
              el('span', {
                class: 'bar__fill',
                style: `width:${Math.round((count / worst) * 100)}%`,
              }),
            ),
          ),
        );
      }

      const target = deps.history.currentTarget(exercise);
      nextTarget.textContent = String(target.targetReps);
      nextSets.textContent = `repetisi × ${prefs.setsPerExercise} set`;
      nextReason.textContent = explainTarget(target);
    },
  };
}
