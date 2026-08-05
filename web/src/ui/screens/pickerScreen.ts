/**
 * 2 · Pilih gerakan.
 *
 * Push-up and squat are counted per repetition; plank is not, because there are
 * no repetitions to count — it is judged on duration and hip line. The design
 * distinguishes them by the unit on each card rather than flattening them into
 * a uniform list, and that is worth keeping: a card that reads "3 set × 30
 * detik" tells the user what kind of thing they are about to do.
 *
 * Plank is shown and disabled. The movement is in the design and not in the
 * code, and a card marked "segera hadir" is the honest way to say so — quietly
 * dropping it would hide a gap, and enabling it would claim an engine that does
 * not exist.
 */

import { TrainingHistory } from '../../session/history.ts';
import { loadPreferences } from '../../session/profile.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import type { ExerciseKind } from '../../core/types.ts';

interface Movement {
  id: ExerciseKind | 'plank';
  name: string;
  /** How the dose is expressed — the point of the card. */
  unit: 'reps' | 'duration';
  difficulty: string;
  judgedBy: string;
  available: boolean;
}

const MOVEMENTS: Movement[] = [
  {
    id: 'pushup',
    name: 'Push-up',
    unit: 'reps',
    difficulty: 'Sedang',
    judgedBy: 'dihitung per repetisi',
    available: true,
  },
  {
    id: 'squat',
    name: 'Squat',
    unit: 'reps',
    difficulty: 'Mudah',
    judgedBy: 'dihitung per repetisi',
    available: true,
  },
  {
    id: 'plank',
    name: 'Plank',
    unit: 'duration',
    difficulty: 'Sedang',
    judgedBy: 'dinilai dari garis pinggul',
    available: false,
  },
];

export interface PickerDeps {
  history: TrainingHistory;
  onContinue: (exercise: ExerciseKind) => void;
  /** Which movement the home screen offered, so the two screens agree. */
  getSelected: () => ExerciseKind;
  setSelected: (exercise: ExerciseKind) => void;
}

export function createPickerScreen(deps: PickerDeps): Screen {
  const list = required('#pickerList');
  const continueButton = required<HTMLButtonElement>('#pickerContinue');

  continueButton.addEventListener('click', () => deps.onContinue(deps.getSelected()));

  return {
    enter() {
      const prefs = loadPreferences();
      const selected = deps.getSelected();
      list.replaceChildren();

      for (const movement of MOVEMENTS) {
        const isSelected = movement.available && movement.id === selected;

        const head = el('div', { class: 'pick__head' }, el('span', { class: 'pick__name', text: movement.name }));
        if (isSelected) {
          head.append(el('span', { class: 'pick__tag', text: 'TARGET HARI INI' }));
        }
        if (!movement.available) {
          head.append(el('span', { class: 'pick__tag pick__tag--quiet', text: 'SEGERA HADIR' }));
        }
        if (movement.unit === 'duration' && movement.available) {
          head.append(el('span', { class: 'pick__tag pick__tag--quiet', text: 'DURASI' }));
        }

        const dose =
          movement.unit === 'reps' && movement.available
            ? `${prefs.setsPerExercise} set × ${deps.history.currentTarget(movement.id as ExerciseKind).targetReps} repetisi`
            : `${prefs.setsPerExercise} set × 30 detik`;

        const card = el(
          'button',
          {
            class: 'pick',
            type: 'button',
            'aria-pressed': String(isSelected),
            disabled: !movement.available,
          },
          el('span', { class: 'pick__art', text: 'foto' }),
          el(
            'span',
            { class: 'pick__body' },
            head,
            el('span', { class: 'pick__dose', text: dose }),
            el('span', {
              class: 'pick__note',
              text: `${movement.difficulty} · ${movement.judgedBy}`,
            }),
          ),
        );

        if (movement.available) {
          card.addEventListener('click', () => {
            deps.setSelected(movement.id as ExerciseKind);
            this.enter?.({});
          });
        }

        list.append(card);
      }
    },
  };
}
