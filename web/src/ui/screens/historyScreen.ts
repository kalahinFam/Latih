/**
 * 8 · Riwayat & kemajuan.
 *
 * Two axes and no more: repetitions per session, and mean depth. Everything
 * else the app records is either derived from these or belongs on the summary
 * screen.
 *
 * Amber bars mark sessions where more than a quarter of repetitions were
 * flagged. A session that hit its number by cutting form must not look like
 * progress, because the target did not rise for it either — the same threshold
 * governs both, and `quality.test.ts` asserts they agree.
 *
 * The dashed line is the target at the time, so a bar reads as met or missed
 * without adding a number to the chart.
 */

import { DIRTY_SESSION_SHARE, formatDuration, isDirty, sessionStats } from '../../core/quality.ts';
import { TrainingHistory } from '../../session/history.ts';
import { el, formatDate, formatDateShort, required } from '../dom.ts';
import { MOVEMENT_NAMES } from '../../core/types.ts';
import type { Screen } from '../../app/router.ts';
import type { SessionStats } from '../../core/quality.ts';
import { isHold, type MovementKind } from '../../core/types.ts';

/** Sessions shown. Beyond this the bars stop being individually readable. */
const WINDOW = 8;

const MOVEMENTS: MovementKind[] = ['pushup', 'squat', 'plank'];

export interface HistoryDeps {
  history: TrainingHistory;
}

export function createHistoryScreen(deps: HistoryDeps): Screen {
  const chips = required('#historyChips');
  const body = required('#historyBody');
  let selected: MovementKind = 'pushup';

  /** Repetitions, or seconds for a held movement — whichever the work is in. */
  function amountOf(session: SessionStats): number {
    return session.isHold ? session.holdSeconds : session.reps;
  }

  function barChart(stats: SessionStats[], target: number): HTMLElement {
    const peak = Math.max(target, ...stats.map(amountOf), 1);
    const chart = el('div', { class: 'chart' });

    // Positioned from the bottom by the same scale as the bars, so the line
    // and the bars mean the same thing.
    chart.append(
      el('div', {
        class: 'chart__target',
        style: `bottom:${(target / peak) * 100}%`,
        'aria-hidden': 'true',
      }),
    );

    for (const session of stats) {
      chart.append(
        el('div', {
          class: 'chart__bar',
          'data-dirty': String(isDirty(session)),
          style: `height:${Math.max(3, (amountOf(session) / peak) * 100)}%`,
          title: `${formatDate(session.startedAt)} — ${amountOf(session)} ${session.isHold ? 'detik' : 'repetisi'}`,
        }),
      );
    }
    return chart;
  }

  function depthChart(stats: SessionStats[]): HTMLElement {
    const depths = stats.map((s) => s.meanDepthDeg).filter((d): d is number => d !== null);
    const chart = el('div', { class: 'chart chart--short' });
    if (depths.length === 0) return chart;

    // Smaller angle means deeper, so the bar is inverted: taller reads as
    // better, which is the only way a bar chart can be read at a glance.
    const deepest = Math.min(...depths);
    const shallowest = Math.max(...depths);
    const span = Math.max(1, shallowest - deepest);

    stats.forEach((session, i) => {
      const depth = session.meanDepthDeg;
      const height = depth === null ? 3 : 25 + ((shallowest - depth) / span) * 75;
      chart.append(
        el('div', {
          class: `chart__bar ${i === stats.length - 1 ? 'chart__bar--latest' : 'chart__bar--muted'}`,
          style: `height:${height}%`,
          title: depth === null ? 'tidak terukur' : `${Math.round(depth)}°`,
        }),
      );
    });
    return chart;
  }

  function render(): void {
    chips.replaceChildren();
    for (const exercise of MOVEMENTS) {
      const chip = el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(exercise === selected),
        text: MOVEMENT_NAMES[exercise],
      });
      chip.addEventListener('click', () => {
        selected = exercise;
        render();
      });
      chips.append(chip);
    }

    const all = sessionStats(selected, deps.history.all());
    const stats = all.slice(-WINDOW);
    body.replaceChildren();

    if (stats.length === 0) {
      body.append(
        el('p', {
          class: 'empty',
          text: `Belum ada sesi ${MOVEMENT_NAMES[selected].toLowerCase()} tercatat. Riwayat muncul setelah set pertama selesai.`,
        }),
      );
      return;
    }

    // Narrowed through the guard so each branch gets the right target reader.
    const movement = selected;
    const hold = isHold(movement);
    const target = isHold(movement)
      ? deps.history.currentHoldTarget(movement).targetSeconds
      : deps.history.currentTarget(movement).targetReps;

    body.append(
      el(
        'div',
        { class: 'section' },
        el(
          'div',
          { class: 'sheet__head' },
          el('span', {
            class: 'card__eyebrow',
            text: hold ? 'DETIK TERTAHAN PER SESI' : 'REPETISI PER SESI',
          }),
          el('span', { class: 'check__value', text: `${stats.length} sesi terakhir` }),
        ),
        barChart(stats, target),
        el(
          'div',
          { class: 'chart__axis' },
          el('span', { text: formatDateShort(stats[0].startedAt) }),
          el('span', { text: formatDateShort(stats[stats.length - 1].startedAt) }),
        ),
        el(
          'div',
          { class: 'legend' },
          legendItem('dash', `target ${target}`),
          legendItem('sage', hold ? 'tahan bersih' : 'form bersih'),
          legendItem(
            'amber',
            hold ? 'garis badan putus >1×' : `>${Math.round(DIRTY_SESSION_SHARE * 100)}% repetisi ditandai`,
          ),
        ),
      ),
    );

    // Depth is meaningless for a hold — the second chart is about how deep the
    // repetitions went, and there are none.
    const depths = hold
      ? []
      : stats.map((s) => s.meanDepthDeg).filter((d): d is number => d !== null);
    if (depths.length >= 2) {
      const change = depths[0] - depths[depths.length - 1];
      body.append(
        el(
          'div',
          { class: 'section section--divided' },
          el(
            'div',
            { class: 'sheet__head' },
            el('span', { class: 'card__eyebrow', text: 'KEDALAMAN RATA-RATA' }),
            el('span', {
              class: 'stat__delta',
              'data-dir': change > 0 ? 'up' : 'down',
              text:
                change === 0
                  ? 'tidak berubah'
                  : `${Math.abs(Math.round(change))}° lebih ${change > 0 ? 'dalam' : 'dangkal'}`,
            }),
          ),
          depthChart(stats),
          el('p', {
            class: 'sheet__note',
            text: `Batang lebih tinggi berarti turun lebih dalam. Sekarang ${Math.round(depths[depths.length - 1])}°.`,
          }),
        ),
      );
    }

    const rows = el('div', { class: 'rows' });
    for (const session of [...stats].reverse()) {
      rows.append(
        el(
          'div',
          { class: 'row' },
          el(
            'div',
            { class: 'row__body' },
            el('div', { class: 'row__title', text: formatDate(session.startedAt) }),
            el('div', {
              class: 'row__sub',
              text: `${session.sets} set · ${amountOf(session)} ${session.isHold ? 'detik' : 'repetisi'} · ${formatDuration(session.elapsedMs)}`,
            }),
          ),
          el('div', {
            class: 'row__score',
            'data-dirty': String(isDirty(session)),
            text: session.quality === null ? '—' : String(session.quality),
          }),
        ),
      );
    }
    body.append(rows);
  }

  function legendItem(kind: 'dash' | 'sage' | 'amber', text: string): HTMLElement {
    const swatch = el('span', {
      class: kind === 'dash' ? 'legend__swatch legend__swatch--dash' : 'legend__swatch',
      style: kind === 'sage' ? 'background:#549c89' : kind === 'amber' ? 'background:#e0952b' : '',
    });
    return el('span', { class: 'legend__item' }, swatch, el('span', { text }));
  }

  return { enter: render };
}
