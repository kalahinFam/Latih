/**
 * Onboarding — six questions, then the arithmetic they produce.
 *
 * ## The closing screen is the point
 *
 * It shows the sum rather than a well done: BMR, the activity multiplier, the
 * adjustment, the result, and where the first rep target came from. That is
 * only worth doing if the numbers are real, so every figure on it is computed
 * by `core/energy.ts` and `core/onboarding.ts` from the answers just given —
 * none of it is written into the markup.
 *
 * If those modules change, this screen changes with them. A summary that has
 * to be kept in sync by hand is a summary that will eventually lie.
 *
 * ## One section, six steps
 *
 * A wizard is a single task. Giving each step a route would let the browser
 * drop somebody into question four with nothing answered behind it, and the
 * back button would exit onboarding from step two.
 */

import {
  ACTIVITY_LABELS,
  INPUT_LIMITS,
  energyTarget,
  explainArithmetic,
  macroTargets,
  type ActivityLevel,
  type BodyProfile,
  type EnergyGoal,
} from '../../core/energy.ts';
import {
  EXPERIENCE_LABELS,
  HOME_PROTEINS,
  RESTRICTION_LABELS,
  baselineHoldSeconds,
  baselineReps,
  bmi,
  bmiLabel,
  type DietaryRestriction,
  type ExperienceLevel,
  type OnboardingExtras,
} from '../../core/onboarding.ts';
import { MAX_DAYS_PER_WEEK, MIN_DAYS_PER_WEEK } from '../../core/plan.ts';
import { TrainingHistory } from '../../session/history.ts';
import {
  loadExtras,
  loadPreferences,
  loadProfile,
  saveExtras,
  savePreferences,
  saveProfile,
} from '../../session/profile.ts';
import { el, required } from '../dom.ts';
import { icon, logoMark } from '../icons.ts';
import type { Screen } from '../../app/router.ts';

const STEPS = 6;

/** Activity levels offered, described by what the day looks like. */
const ACTIVITY_CHOICES: { value: ActivityLevel; name: string; sub: string; factor: string }[] = [
  {
    value: 'sedentary',
    name: 'Duduk hampir sepanjang hari',
    sub: 'Kerja kantor, jarang jalan kaki',
    factor: '×1,2',
  },
  {
    value: 'moderate',
    name: 'Cukup banyak bergerak',
    sub: 'Jalan kaki atau naik turun tangga tiap hari',
    factor: '×1,55',
  },
  {
    value: 'active',
    name: 'Kerja fisik',
    sub: 'Berdiri, angkat beban, di lapangan',
    factor: '×1,725',
  },
];

/**
 * Goals, each stated with what it does.
 *
 * Without the consequence a goal is a label and the user is guessing. The
 * percentages here are read from `GOAL_ADJUSTMENT` in `core/energy.ts` at
 * render time rather than written out, so the card cannot describe a deficit
 * the app is not applying.
 */
const GOAL_CHOICES: { value: EnergyGoal; name: string; why: string }[] = [
  {
    value: 'lose',
    name: 'Turunkan berat badan',
    why: 'Kalori di bawah kebutuhan, protein dijaga tinggi supaya massa otot tidak ikut turun.',
  },
  {
    value: 'maintain',
    name: 'Jaga berat, tambah kekuatan',
    why: 'Kalori setara kebutuhan; target repetisi naik lebih cepat.',
  },
  {
    value: 'gain',
    name: 'Naikkan massa otot',
    why: 'Kalori di atas kebutuhan, porsi karbohidrat sekitar latihan diperbesar.',
  },
];

export interface OnboardingDeps {
  history: TrainingHistory;
  onDone: () => void;
  onStartFirstSession: () => void;
}

export function createOnboardingScreen(deps: OnboardingDeps): Screen {
  const backButton = required<HTMLButtonElement>('#onboardBack');
  const mark = required('#onboardMark');
  const progress = required('#onboardProgress');
  const count = required('#onboardCount');
  const title = required('#onboardTitle');
  const sub = required('#onboardSub');
  const body = required('#onboardBody');
  const next = required<HTMLButtonElement>('#onboardNext');

  let step = 1;
  // Working copies. Nothing is persisted until the final step, so abandoning
  // onboarding halfway leaves no half-answered profile behind.
  let draft: BodyProfile = loadProfile() ?? {
    weightKg: 65,
    heightCm: 170,
    ageYears: 25,
    sex: 'male',
    activity: 'moderate',
    goal: 'lose',
  };
  let extras: OnboardingExtras = loadExtras();
  let daysPerWeek = loadPreferences().daysPerWeek;

  backButton.append(icon('kembali'));
  mark.append(logoMark(26, false));
  next.addEventListener('click', () => advance());
  backButton.addEventListener('click', () => {
    if (step > 1) {
      step -= 1;
      render();
    }
  });

  /* ------------------------------------------------------------ controls */

  function segment(label: string, active: boolean, onPick: () => void): HTMLElement {
    const node = el('button', {
      class: 'segment',
      type: 'button',
      'aria-pressed': String(active),
      text: label,
    });
    node.addEventListener('click', () => {
      onPick();
      render();
    });
    return node;
  }

  /**
   * A number the user can both type and see.
   *
   * An `<input type="number">` styled to look like the display, rather than a
   * label plus a hidden field: the design makes the chosen number large so a
   * typo is visible before the user moves on, and that only works if the large
   * number is the thing being edited.
   */
  function figure(
    label: string,
    value: number,
    unit: string,
    limits: { min: number; max: number },
    onChange: (next: number) => void,
    options: { note?: string; wide?: boolean; step?: number } = {},
  ): HTMLElement {
    const input = el('input', {
      class: 'figure__number',
      type: 'number',
      inputmode: 'numeric',
      value: String(value),
      min: limits.min,
      max: limits.max,
      step: options.step ?? 1,
      'aria-label': label,
    });

    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
      render();
    });

    return el(
      'div',
      { class: options.wide ? 'figure figure--wide' : 'figure' },
      el(
        'div',
        { class: 'figure__head' },
        el('span', { class: 'figure__label', text: label }),
        options.note ? el('span', { class: 'figure__note', text: options.note }) : null,
      ),
      el(
        'div',
        { class: 'figure__value' },
        input,
        el('span', { class: 'figure__unit', text: unit }),
      ),
    );
  }

  /* --------------------------------------------------------------- steps */

  function renderName(): void {
    title.textContent = 'Siapa nama panggilanmu?';
    sub.textContent = 'Dipakai untuk menyapa di layar dan lewat suara saat latihan.';

    const input = el('input', {
      class: 'nameinput',
      type: 'text',
      value: extras.name,
      maxlength: 40,
      placeholder: 'Nama',
      autocomplete: 'given-name',
      'aria-label': 'Nama panggilan',
    });
    input.addEventListener('input', () => {
      extras = { ...extras, name: input.value };
      next.disabled = input.value.trim().length === 0;
    });

    body.replaceChildren(
      input,
      el('p', { class: 'onboard__sub', text: 'Boleh nama panggilan saja.' }),
    );
    next.disabled = extras.name.trim().length === 0;
    // Focus, so the keyboard is already up: this screen has exactly one thing
    // to do and making the user tap the field first is a wasted tap.
    window.setTimeout(() => input.focus(), 60);
  }

  function renderBody(): void {
    title.textContent = 'Data dasar';
    sub.textContent =
      'Dipakai menghitung kebutuhan kalori harian. Disimpan di ponsel ini, tidak dikirim ke mana pun.';

    const index = bmi(draft.weightKg, draft.heightCm);

    body.replaceChildren(
      el('div', { class: 'fieldlabel', text: 'JENIS KELAMIN' }),
      el(
        'div',
        { class: 'segments' },
        segment('Laki-laki', draft.sex === 'male', () => (draft = { ...draft, sex: 'male' })),
        segment('Perempuan', draft.sex === 'female', () => (draft = { ...draft, sex: 'female' })),
      ),
      el(
        'div',
        { class: 'figures' },
        figure('USIA', draft.ageYears, 'th', INPUT_LIMITS.ageYears, (v) => {
          draft = { ...draft, ageYears: v };
        }),
        figure('TINGGI', draft.heightCm, 'cm', INPUT_LIMITS.heightCm, (v) => {
          draft = { ...draft, heightCm: v };
        }),
      ),
      figure(
        'BERAT',
        draft.weightKg,
        'kg',
        INPUT_LIMITS.weightKg,
        (v) => {
          draft = { ...draft, weightKg: v };
        },
        {
          wide: true,
          step: 0.5,
          // Shown because it makes a typo obvious — 178 kg entered for 78 reads
          // as an index of 59 and nobody misses that.
          note: index === null ? undefined : `IMT ${index.toString().replace('.', ',')} · ${bmiLabel(index)}`,
        },
      ),
      el('p', {
        class: 'notebox',
        text: 'Berat bisa diperbarui kapan saja lewat Pengaturan; target kalori ikut menyesuaikan tanpa mengulang onboarding.',
      }),
    );
    next.disabled = false;
  }

  function renderGoal(): void {
    title.textContent = 'Apa yang ingin dicapai?';
    sub.textContent = 'Menentukan arah kalori dan komposisi menu.';

    // Rendered from a live computation, so a card can never advertise an
    // adjustment the app does not apply.
    const preview = (goal: EnergyGoal) => {
      const target = energyTarget({ ...draft, goal }, false);
      return `${target.targetKcal.toLocaleString('id-ID')} kkal/hari`;
    };

    body.replaceChildren(
      ...GOAL_CHOICES.map((choice) => {
        const card = el(
          'button',
          { class: 'choice', type: 'button', 'aria-pressed': String(draft.goal === choice.value) },
          el(
            'div',
            { class: 'choice__head' },
            el('span', { class: 'choice__name', text: choice.name }),
            el('span', { class: 'choice__tick' }, icon('centang', 13, 2.6)),
          ),
          el('p', { class: 'choice__why', text: choice.why }),
          el(
            'div',
            { class: 'choice__tags' },
            el('span', { class: 'tag', text: preview(choice.value) }),
            el('span', {
              class: 'tag tag--quiet',
              text: `protein ${energyTarget({ ...draft, goal: choice.value }, false).proteinG} g`,
            }),
          ),
        );
        card.addEventListener('click', () => {
          draft = { ...draft, goal: choice.value };
          render();
        });
        return card;
      }),
      el('p', {
        class: 'notebox',
        text: 'Tujuan bisa diganti nanti. Yang tersimpan tetap riwayat latihannya, bukan diulang dari nol.',
      }),
    );
    next.disabled = false;
  }

  function renderActivity(): void {
    title.textContent = 'Seberapa aktif harimu?';
    sub.textContent = 'Di luar latihan LATIH.';

    body.replaceChildren(
      ...ACTIVITY_CHOICES.map((choice) => {
        const card = el(
          'button',
          {
            class: 'choice choice--row',
            type: 'button',
            'aria-pressed': String(draft.activity === choice.value),
            title: ACTIVITY_LABELS[choice.value],
          },
          el(
            'div',
            { class: 'choice__head' },
            el(
              'span',
              { class: 'choice__body' },
              el('span', { class: 'choice__name', text: choice.name }),
              el('span', { class: 'choice__sub', text: choice.sub }),
            ),
            // The multiplier stays visible so the choice can be checked rather
            // than only trusted.
            el('span', { class: 'choice__factor', text: choice.factor }),
          ),
        );
        card.addEventListener('click', () => {
          draft = { ...draft, activity: choice.value };
          render();
        });
        return card;
      }),

      el('div', { class: 'fieldlabel', text: 'PENGALAMAN LATIHAN' }),
      el(
        'div',
        { class: 'segments' },
        ...(Object.keys(EXPERIENCE_LABELS) as ExperienceLevel[]).map((level) =>
          segment(EXPERIENCE_LABELS[level], extras.experience === level, () => {
            extras = { ...extras, experience: level };
          }),
        ),
      ),
      el('p', {
        class: 'onboard__sub',
        text: 'Menentukan target repetisi sesi pertama. Setelah itu targetnya diatur dari hasil, bukan dari jawaban ini.',
      }),

      el('div', { class: 'fieldlabel', text: 'HARI LATIHAN PER MINGGU' }),
      el(
        'div',
        { class: 'segments' },
        ...Array.from({ length: MAX_DAYS_PER_WEEK - MIN_DAYS_PER_WEEK + 1 }, (_, i) => {
          const days = MIN_DAYS_PER_WEEK + i;
          return segment(String(days), daysPerWeek === days, () => {
            daysPerWeek = days;
          });
        }),
      ),
    );
    next.disabled = false;
  }

  function renderFood(): void {
    title.textContent = 'Ada yang tidak dimakan?';
    sub.textContent = 'Bahan yang dipilih tidak akan muncul di menu mana pun.';

    const chips = el('div', { class: 'chipwrap' });
    for (const [value, label] of Object.entries(RESTRICTION_LABELS) as [
      DietaryRestriction,
      string,
    ][]) {
      const chosen = extras.restrictions.includes(value);
      const chip = el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(chosen),
        text: label,
      });
      chip.addEventListener('click', () => {
        extras = {
          ...extras,
          restrictions: chosen
            ? extras.restrictions.filter((r) => r !== value)
            : [...extras.restrictions, value],
        };
        render();
      });
      chips.append(chip);
    }

    const proteins = HOME_PROTEINS.map((protein) => {
      const chosen = extras.homeProteins.includes(protein.id);
      const card = el(
        'button',
        { class: 'choice choice--row', type: 'button', 'aria-pressed': String(chosen) },
        el(
          'div',
          { class: 'choice__head' },
          el('span', { class: 'choice__body' }, el('span', { class: 'choice__name', text: protein.label })),
          // The TKPI codes, shown here for the same reason the nutrition screen
          // shows them: a citation nobody can find is not a citation.
          el('span', { class: 'choice__factor', text: protein.codes.join(' · ') }),
        ),
      );
      card.addEventListener('click', () => {
        extras = {
          ...extras,
          homeProteins: chosen
            ? extras.homeProteins.filter((id) => id !== protein.id)
            : [...extras.homeProteins, protein.id],
        };
        render();
      });
      return card;
    });

    body.replaceChildren(
      chips,
      el('div', { class: 'fieldlabel', text: 'SUMBER PROTEIN YANG BIASA ADA DI RUMAH' }),
      ...proteins,
      el('p', {
        class: 'notebox',
        text: 'Semua takaran menu dihitung dari Tabel Komposisi Pangan Indonesia. Kode bahannya ikut ditampilkan di setiap menu.',
      }),
    );
    next.disabled = false;
  }

  /**
   * The plan: what the answers add up to.
   *
   * Everything here is computed, including the sentence explaining the sum. A
   * closing screen that states numbers the app does not actually use would be
   * the most damaging place in the product to be wrong, because it is the one
   * screen the user reads carefully.
   */
  function renderPlan(): void {
    const name = extras.name.trim();
    title.textContent = name ? `Rencana untuk ${name}` : 'Rencana kamu';

    const goalLabel = GOAL_CHOICES.find((g) => g.value === draft.goal)?.name ?? '';
    sub.textContent = `${goalLabel} · ${daysPerWeek} hari latihan per minggu`;

    const target = energyTarget(draft, false);
    const macros = macroTargets(target);
    const firstReps = baselineReps(extras.experience, 'pushup');
    const sets = loadPreferences().setsPerExercise;

    body.replaceChildren(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'KEBUTUHAN HARIAN' }),
        el(
          'div',
          { class: 'card__figure' },
          el('span', { class: 'card__number', text: target.targetKcal.toLocaleString('id-ID') }),
          el('span', { class: 'card__unit', text: 'kkal' }),
        ),
        el(
          'div',
          { class: 'macrobar' },
          el('span', {
            class: 'macrobar__part macrobar__part--carb',
            style: `width:${(macros.shares.carb * 100).toFixed(1)}%`,
          }),
          el('span', {
            class: 'macrobar__part macrobar__part--protein',
            style: `width:${(macros.shares.protein * 100).toFixed(1)}%`,
          }),
          el('span', {
            class: 'macrobar__part macrobar__part--fat',
            style: `width:${(macros.shares.fat * 100).toFixed(1)}%`,
          }),
        ),
        el(
          'div',
          { class: 'macrolegend' },
          el('span', { text: `Karbo ${macros.carbG} g` }),
          el('span', { text: `Protein ${macros.proteinG} g` }),
          el('span', { text: `Lemak ${macros.fatG} g` }),
        ),
        el('p', { class: 'card__foot', text: explainArithmetic(draft, target) }),
      ),

      el(
        'div',
        { class: 'card figure--wide' },
        el('div', { class: 'card__eyebrow', text: 'SESI PERTAMA' }),
        el(
          'div',
          { class: 'card__figure' },
          el('span', { class: 'card__number', text: String(firstReps) }),
          el('span', { class: 'card__unit', text: `repetisi × ${sets} set` }),
        ),
        el('div', { class: 'card__accent', text: 'Push-up' }),
        el('p', {
          class: 'card__foot',
          text: `Angka awal untuk tingkat "${EXPERIENCE_LABELS[extras.experience].toLowerCase()}". Naik atau turun setelah sesi pertama, tergantung berapa repetisi yang formnya bersih.`,
        }),
      ),
    );

    next.textContent = 'Mulai sesi pertama';
    next.disabled = false;
  }

  /* ------------------------------------------------------------- plumbing */

  function commit(): void {
    saveProfile(draft);
    saveExtras({ ...extras, name: extras.name.trim() });
    savePreferences({ ...loadPreferences(), daysPerWeek });

    // The experience answer becomes the target actually worked to, not a new
    // default — after one set the session loop reads real results and takes
    // over from here.
    deps.history.seedTargets({
      pushup: baselineReps(extras.experience, 'pushup'),
      squat: baselineReps(extras.experience, 'squat'),
      plank: baselineHoldSeconds(extras.experience, 'plank'),
    });
  }

  function advance(): void {
    if (step < STEPS) {
      // Saved at each step as well as at the end, so a phone that dies at
      // question four does not throw away questions one to three.
      if (step === STEPS - 1) commit();
      step += 1;
      render();
      return;
    }

    commit();
    deps.onStartFirstSession();
  }

  function render(): void {
    progress.replaceChildren();
    for (let i = 1; i <= STEPS; i += 1) {
      progress.append(el('span', { class: 'onboard__tick', 'data-done': String(i <= step) }));
    }
    count.textContent = `${step}/${STEPS}`;
    // Nothing to go back to from the first question; the splash is behind it
    // and returning there would look like the app restarting.
    backButton.hidden = step === 1;
    next.textContent = 'Lanjut';

    const steps = [renderName, renderBody, renderGoal, renderActivity, renderFood, renderPlan];
    steps[step - 1]();
  }

  return {
    enter(params) {
      // `?langkah=6` lets Settings send someone straight to the summary. Any
      // other value starts from the beginning.
      const requested = Number(params.langkah);
      step = Number.isInteger(requested) && requested >= 1 && requested <= STEPS ? requested : 1;

      draft = loadProfile() ?? draft;
      extras = loadExtras();
      daysPerWeek = loadPreferences().daysPerWeek;
      render();
    },
  };
}
