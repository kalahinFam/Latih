/**
 * 2 · Pilih gerakan.
 *
 * Push-up and squat are counted per repetition; plank is not, because there are
 * no repetitions to count — it is judged on duration and hip line. The design
 * distinguishes them by the unit on each card rather than flattening them into
 * a uniform list, and that is worth keeping: a card that reads "3 set × 30
 * detik" tells the user what kind of thing they are about to do.
 *
 * Plank runs on its own engine (`core/holdTracker.ts`): there is nothing to
 * count, so the card states seconds and the workout screen shows a clock.
 */

import { TrainingHistory } from '../../session/history.ts';
import { substituteFor } from '../../session/complaints.ts';
import { SUBSTITUTE_NAMES } from '../../core/restChat.ts';
import { currentSplit, todaysMovements } from '../../session/planner.ts';
import { loadPreferences } from '../../session/profile.ts';
import { el, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';
import { isHold, type MovementKind } from '../../core/types.ts';

interface Movement {
  id: MovementKind;
  name: string;
  imageSrc: string;
  /** How the dose is expressed — the point of the card. */
  unit: 'reps' | 'duration';
  available: boolean;
}

const MOVEMENTS: Movement[] = [
  {
    id: 'pushup',
    name: 'Push-up',
    imageSrc: '/icons/push_up.jpg',
    unit: 'reps',
    available: true,
  },
  {
    id: 'squat',
    name: 'Squat',
    imageSrc: '/icons/squat.jpg',
    unit: 'reps',
    available: true,
  },
  {
    id: 'plank',
    name: 'Plank',
    imageSrc: '/icons/plank.jpg',
    unit: 'duration',
    available: true,
  },
];

export interface PickerDeps {
  history: TrainingHistory;
  onContinue: (movement: MovementKind) => void;
  /** Which movement the home screen offered, so the two screens agree. */
  getSelected: () => MovementKind;
  setSelected: (movement: MovementKind) => void;
}

export function createPickerScreen(deps: PickerDeps): Screen {
  const list = required('#pickerList');
  const continueButton = required<HTMLButtonElement>('#pickerContinue');

  continueButton.addEventListener('click', () => deps.onContinue(deps.getSelected()));

  return {
    enter() {
      const prefs = loadPreferences();
      const selected = deps.getSelected();
      const planned = todaysMovements(currentSplit());
      list.replaceChildren();

      for (const movement of MOVEMENTS) {
        const isSelected = movement.available && movement.id === selected;

        const head = el('div', { class: 'pick__head' }, el('span', { class: 'pick__name', text: movement.name }));
        if (!movement.available) {
          head.append(el('span', { class: 'pick__tag pick__tag--quiet', text: 'SEGERA HADIR' }));
        } else if (planned.includes(movement.id)) {
          // What the split put on today. A tag rather than a filter: training
          // something else today is a decision the user is allowed to make, and
          // hiding the other cards would make it look like it is not.
          head.append(el('span', { class: 'pick__tag', text: 'HARI INI' }));
        }

        // A complaint during rest swaps a movement out for the rest of the day.
        // Saying so on the card the user is about to tap is the only place it
        // still matters — a swap they have to remember is a swap that gets
        // ignored on the next set.
        const substitute = substituteFor(movement.id);
        if (substitute) {
          head.append(el('span', { class: 'pick__tag pick__tag--swap', text: 'DIGANTI' }));
        }

        const dose = substitute
          ? `${prefs.setsPerExercise} set — tidak dihitung kamera`
          : isHold(movement.id)
            ? `${prefs.setsPerExercise} set × ${deps.history.currentHoldTarget(movement.id).targetSeconds} detik`
            : `${prefs.setsPerExercise} set × ${deps.history.currentTarget(movement.id).targetReps} repetisi`;

        const card = el(
          'button',
          {
            class: 'pick',
            type: 'button',
            'aria-pressed': String(isSelected),
            disabled: !movement.available,
          },
          el('img', {
            class: 'pick__art',
            src: movement.imageSrc,
            alt: '',
            decoding: 'async',
          }),
          el(
            'span',
            { class: 'pick__body' },
            head,
            el('span', { class: 'pick__dose', text: dose }),
            el('span', {
              class: 'pick__note',
              text: substitute ? `Ganti hari ini: ${SUBSTITUTE_NAMES[substitute]}` : '',
            }),
          ),
        );

        if (movement.available) {
          card.addEventListener('click', () => {
            deps.setSelected(movement.id);
            this.enter?.({});
          });
        }

        list.append(card);
      }
    },
  };
}
