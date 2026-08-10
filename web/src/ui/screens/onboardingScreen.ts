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
  type BodySex,
  type EnergyGoal,
} from '../../core/energy.ts';
import {
  EXPERIENCE_LABELS,
  RESTRICTION_LABELS,
  baselineHoldSeconds,
  baselineReps,
  bmi,
  bmiLabel,
  type DietaryRestriction,
  type ExperienceLevel,
  type OnboardingExtras,
} from '../../core/onboarding.ts';
import { CATEGORY_LABELS, PANTRY_CODES, PANTRY_LABELS, type PantryCategory } from '../../core/pantry.ts';
import {
  describeSession,
  estimatedMinutes,
  recommendSplit,
  type WorkoutSplit,
} from '../../core/split.ts';
import {
  MAX_DAYS_PER_WEEK,
  MIN_DAYS_PER_WEEK,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  normaliseWeekdays,
  planWeekdays,
} from '../../core/plan.ts';
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
import { icon, logoImage } from '../icons.ts';
import type { Screen } from '../../app/router.ts';

const STEPS = 6;

/**
 * The working copy of the body answers.
 *
 * `null` means "not answered yet": the fields open empty with a placeholder
 * rather than pretending 65 kg / 170 cm / 25 is someone's real data. Only a
 * stored profile — a returning user re-running onboarding — pre-fills them.
 */
interface BodyDraft {
  weightKg: number | null;
  heightCm: number | null;
  ageYears: number | null;
  sex: BodySex;
  activity: ActivityLevel;
  goal: EnergyGoal;
}

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
 * Goals, with the numbers each produces.
 *
 * The calorie and protein tags are read from `GOAL_ADJUSTMENT` in
 * `core/energy.ts` at render time rather than written out, so a card can never
 * advertise an adjustment the app does not apply.
 */
const GOAL_CHOICES: { value: EnergyGoal; name: string }[] = [
  {
    value: 'lose',
    name: 'Turunkan berat badan',
  },
  {
    value: 'maintain',
    name: 'Jaga berat, tambah kekuatan',
  },
  {
    value: 'gain',
    name: 'Naikkan massa otot',
  },
];

export interface OnboardingDeps {
  history: TrainingHistory;
  onDone: () => void;
  /**
   * The step the session was launched from.
   *
   * The caller rewrites the history entry with it, so the browser back button
   * returns to the closing step rather than to the first question.
   */
  onStartFirstSession: (lastStep: number) => void;
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
  const later = required<HTMLButtonElement>('#onboardLater');

  let step = 1;
  /**
   * Which way the last move went.
   *
   * The one thing a plain fade cannot say is whether you advanced or went back,
   * and on a six-step form that is worth saying.
   */
  let direction: 'forward' | 'back' = 'forward';
  /**
   * Step the slide was last played for.
   *
   * `render` re-runs on every tap, not only when the step advances, so without
   * this the page slid sideways each time somebody picked an option.
   */
  let animatedStep = 0;
  // Working copies. Nothing is persisted until the final step, so abandoning
  // onboarding halfway leaves no half-answered profile behind.
  let draft: BodyDraft = loadProfile() ?? {
    weightKg: null,
    heightCm: null,
    ageYears: null,
    sex: 'male',
    activity: 'moderate',
    goal: 'lose',
  };
  let extras: OnboardingExtras = loadExtras();
  /**
   * The weekdays picked, 0 = Monday.
   *
   * Seeded from whatever the plan would train on today — the stored choice if
   * there is one, the even spread otherwise — so a returning user sees the
   * schedule they are actually on rather than an empty week.
   */
  let trainingDays: number[] = planWeekdays(loadPreferences());

  /* -------------------------------------------------- body-draft helpers */

  function inRange(value: number | null, limits: { min: number; max: number }): value is number {
    return value !== null && Number.isFinite(value) && value >= limits.min && value <= limits.max;
  }

  /**
   * The draft as a real profile, or `null` while any body figure is missing.
   *
   * Everything downstream that computes calories takes a `BodyProfile`; nothing
   * may run on a draft with an unanswered figure.
   */
  function bodyProfile(): BodyProfile | null {
    const { weightKg, heightCm, ageYears } = draft;
    if (!inRange(weightKg, INPUT_LIMITS.weightKg)) return null;
    if (!inRange(heightCm, INPUT_LIMITS.heightCm)) return null;
    if (!inRange(ageYears, INPUT_LIMITS.ageYears)) return null;
    return {
      weightKg,
      heightCm,
      ageYears,
      sex: draft.sex,
      activity: draft.activity,
      goal: draft.goal,
    };
  }

  function bodyComplete(): boolean {
    return bodyProfile() !== null;
  }

  /**
   * The split for the answers as they stand right now.
   *
   * Computed from the working copies rather than from storage: the summary is
   * shown before `commit` runs, and reading storage there would preview the
   * previous answers.
   */
  function recommendedSplit(): WorkoutSplit {
    return recommendSplit({
      trainingDays,
      experience: extras.experience,
      goal: draft.goal,
    });
  }

  /** Is the picked week one the plan can actually be built from? */
  function daysComplete(): boolean {
    return trainingDays.length >= MIN_DAYS_PER_WEEK && trainingDays.length <= MAX_DAYS_PER_WEEK;
  }

  backButton.append(icon('kembali'));
  mark.append(logoImage(26));
  next.addEventListener('click', () => advance());
  // "Nanti dulu" — everything is already saved by the time this screen is
  // reachable, so this is a route change, not an abandoned onboarding: the
  // schedule, the calorie target and the first rep target all survive it.
  later.addEventListener('click', () => {
    commit();
    deps.onDone();
  });
  backButton.addEventListener('click', () => {
    if (step > 1) {
      step -= 1;
      direction = 'back';
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
    value: number | null,
    unit: string,
    limits: { min: number; max: number },
    onChange: (next: number | null) => void,
    options: { note?: string; wide?: boolean; step?: number; placeholder?: string } = {},
  ): HTMLElement {
    const input = el('input', {
      class: 'figure__number',
      type: 'number',
      inputmode: 'numeric',
      value: value === null ? undefined : value,
      placeholder: options.placeholder,
      min: limits.min,
      max: limits.max,
      step: options.step ?? 1,
      'aria-label': label,
    });

    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      // An emptied field means "not answered", not zero kilograms.
      onChange(input.value.trim() === '' || !Number.isFinite(parsed) ? null : parsed);
      render();
    });

    return el(
      'div',
      { class: options.wide ? 'figure figure--wide' : 'figure' },
      el(
        'div',
        { class: 'figure__head' },
        el('span', { class: 'figure__label', text: label }),
      ),
      el(
        'div',
        { class: 'figure__value' },
        input,
        el('span', { class: 'figure__unit', text: unit }),
      ),
      options.note
        ? el(
            'div',
            { class: 'figure__note' },
            el('span', { class: 'figure__note-label', text: 'HASIL IMT' }),
            el('span', { class: 'figure__note-value', text: options.note }),
          )
        : null,
    );
  }

  /* --------------------------------------------------------------- steps */

  /** The picker shows the food's base name, without TKPI's state descriptors. */
  function shortFoodName(label: string): string {
    return label.split(',')[0];
  }

  function renderName(): void {
    title.textContent = 'Siapa nama panggilanmu?';
    sub.textContent = '';

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

    body.replaceChildren(input);
    next.disabled = extras.name.trim().length === 0;
    // Focus, so the keyboard is already up: this screen has exactly one thing
    // to do and making the user tap the field first is a wasted tap.
    window.setTimeout(() => input.focus(), 60);
  }

  function renderBody(): void {
    title.textContent = 'Data dasar';
    sub.textContent = '';

    const profile = bodyProfile();
    const index = profile ? bmi(profile.weightKg, profile.heightCm) : null;

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
        }, { placeholder: '25' }),
        figure('TINGGI', draft.heightCm, 'cm', INPUT_LIMITS.heightCm, (v) => {
          draft = { ...draft, heightCm: v };
        }, { placeholder: '170' }),
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
          placeholder: '65',
          // Shown because it makes a typo obvious — 178 kg entered for 78 reads
          // as an index of 59 and nobody misses that.
          note:
            index === null
              ? undefined
              : `${index.toString().replace('.', ',')} · ${bmiLabel(index)}`,
        },
      ),
    );
    // Nothing to compute with until the figures are real.
    next.disabled = !bodyComplete();
  }

  function renderGoal(): void {
    title.textContent = 'Apa yang ingin dicapai?';
    sub.textContent = '';

    // Reachable only with a complete body (the next button says so), but the
    // computation below cannot run on a draft with an unanswered figure.
    const profile = bodyProfile();

    // Rendered from a live computation, so a card can never advertise an
    // adjustment the app does not apply.
    const preview = (goal: EnergyGoal) => {
      if (!profile) return '—';
      const target = energyTarget({ ...profile, goal }, false);
      return `${target.targetKcal.toLocaleString('id-ID')} kkal/hari`;
    };
    const proteinPreview = (goal: EnergyGoal) =>
      profile ? `${energyTarget({ ...profile, goal }, false).proteinG} g` : '—';

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
          el(
            'div',
            { class: 'choice__tags' },
            el('span', { class: 'tag', text: preview(choice.value) }),
            el('span', { class: 'tag tag--quiet', text: `protein ${proteinPreview(choice.value)}` }),
          ),
        );
        card.addEventListener('click', () => {
          draft = { ...draft, goal: choice.value };
          render();
        });
        return card;
      }),
    );
    next.disabled = false;
  }

  function renderActivity(): void {
    title.textContent = 'Seberapa aktif harimu?';
    sub.textContent = '';

    const note = daysNote();
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

      el('p', {
        class: 'notebox',
        text: 'Angka ini adalah pengali kebutuhan kalori istirahatmu (BMR): kebutuhan harian = BMR × pengali, lalu disesuaikan dengan tujuanmu.',
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

      el('div', { class: 'fieldlabel', text: 'HARI LATIHAN' }),
      el(
        'div',
        { class: 'chipwrap' },
        ...WEEKDAY_SHORT.map((label, weekday) => {
          const chosen = trainingDays.includes(weekday);
          const chip = el('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(chosen),
            'aria-label': `Latihan hari ${WEEKDAY_LABELS[weekday]}`,
            text: label,
          });
          chip.addEventListener('click', () => {
            trainingDays = normaliseWeekdays(
              chosen ? trainingDays.filter((d) => d !== weekday) : [...trainingDays, weekday],
            );
            render();
          });
          return chip;
        }),
      ),
      ...(note ? [el('p', { class: 'onboard__sub', text: note })] : []),
    );
    // The plan needs a week it can actually be built from: below two sessions
    // the progression rules have nothing to read, and seven leaves no rest day.
    next.disabled = !daysComplete();
  }

  /** What is still wrong with the picked week, or `null` once it is valid. */
  function daysNote(): string | null {
    if (trainingDays.length < MIN_DAYS_PER_WEEK) {
      return `Pilih minimal ${MIN_DAYS_PER_WEEK} hari. Di bawah itu belum cukup untuk menaikkan target.`;
    }
    if (trainingDays.length > MAX_DAYS_PER_WEEK) {
      return 'Sisakan minimal satu hari istirahat — pemulihan terjadi di antara sesi, bukan setelahnya.';
    }
    return null;
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

    // Foods usually at home: a searchable multi-select over the pantry. Names
    // only — the TKPI codes underneath are what the meal planner needs, and
    // showing them here would read as gibberish.
    const search = el('input', {
      class: 'searchbox',
      type: 'search',
      placeholder: 'Cari bahan…',
      'aria-label': 'Cari bahan',
    });
    const list = el('div', { class: 'foodlist' });

    function renderFoods(): void {
      const query = search.value.trim().toLowerCase();
      list.replaceChildren();
      for (const category of Object.keys(PANTRY_CODES) as PantryCategory[]) {
        const codes = PANTRY_CODES[category].filter(
          (code) => !query || PANTRY_LABELS[code].toLowerCase().includes(query),
        );
        if (codes.length === 0) continue;
        list.append(
          el('div', { class: 'foodgroup__head', text: CATEGORY_LABELS[category] }),
          ...codes.map((code) => {
            const chosen = extras.homeFoods.includes(code);
            const row = el(
              'button',
              {
                class: 'fooditem',
                type: 'button',
                'aria-pressed': String(chosen),
              },
              el('span', { class: 'fooditem__name', text: shortFoodName(PANTRY_LABELS[code]) }),
              el('span', { class: 'fooditem__check' }, icon('centang', 13, 2.6)),
            );
            row.addEventListener('click', () => {
              extras = {
                ...extras,
                homeFoods: chosen
                  ? extras.homeFoods.filter((c) => c !== code)
                  : [...extras.homeFoods, code],
              };
              renderFoods();
            });
            return row;
          }),
        );
      }
    }

    search.addEventListener('input', renderFoods);

    body.replaceChildren(
      chips,
      el('div', { class: 'fieldlabel', text: 'BAHAN YANG BIASA ADA DI RUMAH' }),
      search,
      list,
    );
    renderFoods();
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

    const profile = bodyProfile();
    if (!profile) return;

    sub.textContent = '';

    const target = energyTarget(profile, false);
    const macros = macroTargets(target);
    const firstReps = baselineReps(extras.experience, 'pushup');
    // The split's recommendation, not the stored preference: this screen is
    // where that recommendation is made, and `commit` writes the same number.
    const split = recommendedSplit();
    const sets = split.setsPerExercise;

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
        el('p', { class: 'card__foot', text: explainArithmetic(profile, target) }),
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
      ),

      // What the week looks like. Built from the days just picked, the
      // experience answer and the goal — the same function the home screen
      // reads, so the plan previewed here is the plan that will be run.
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card__eyebrow', text: 'RENCANA MINGGUAN' }),
        el(
          'div',
          { class: 'splitlist' },
          ...split.sessions.map((session) =>
            el(
              'div',
              { class: 'splitlist__row' },
              el('span', { class: 'splitlist__day', text: WEEKDAY_SHORT[session.weekday] }),
              el(
                'span',
                { class: 'splitlist__body' },
                el('span', { class: 'splitlist__focus', text: session.label }),
                el('span', { class: 'splitlist__moves', text: describeSession(session) }),
              ),
              el('span', {
                class: 'splitlist__time',
                text: `±${estimatedMinutes(split, session)}′`,
              }),
            ),
          ),
        ),
      ),
    );

    next.textContent = 'Mulai sesi pertama';
    next.disabled = false;
  }

  /* ------------------------------------------------------------- plumbing */

  function commit(): void {
    const profile = bodyProfile();
    if (!profile) return;
    saveProfile(profile);
    saveExtras({ ...extras, name: extras.name.trim() });
    // Only a week the plan can be built from. An out-of-range pick is not
    // written at all, so the previous schedule keeps working rather than being
    // replaced by one with no rest day or no stimulus.
    if (daysComplete()) {
      savePreferences({
        ...loadPreferences(),
        daysPerWeek: trainingDays.length,
        trainingDays,
        // The recommended volume, written once here. Pengaturan can override
        // it afterwards, and from then on the override is what the plan uses.
        setsPerExercise: recommendedSplit().setsPerExercise,
      });
    }

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
    // Step two can be revisited after later steps; clearing a figure there
    // must halt the walk forward, not skip past an unanswered question.
    if (step === 2 && !bodyComplete()) {
      render();
      return;
    }
    // Same rule for the schedule: a week with fewer than two sessions, or with
    // no rest day, is not a plan this app knows how to run.
    if (step === 4 && !daysComplete()) {
      render();
      return;
    }
    if (step < STEPS) {
      // Saved at each step as well as at the end, so a phone that dies at
      // question four does not throw away questions one to three.
      if (step === STEPS - 1) commit();
      step += 1;
      direction = 'forward';
      render();
      return;
    }

    commit();
    deps.onStartFirstSession(step);
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
    // Offered only on the last step. Earlier it would read as "skip the rest of
    // the questions", which is what the splash screen's "Lewati dulu" is for.
    later.hidden = step !== STEPS;

    const steps = [renderName, renderBody, renderGoal, renderActivity, renderFood, renderPlan];
    steps[step - 1]();

    // Only when the step actually changed.
    //
    // `render` runs again on every tap — picking a sex, a goal, a chip — so
    // replaying unconditionally slid the whole page sideways each time
    // somebody chose an option. The animation is meant to say "this is a
    // different question", and a selection within the same question is not
    // that.
    if (step !== animatedStep) {
      animatedStep = step;
      // Rebuilt rather than toggled: a CSS animation does not restart on an
      // element that already carries the class, and reading `offsetWidth`
      // forces the style flush that makes the removal take effect first.
      body.classList.remove('onboard__step');
      void body.offsetWidth;
      body.dataset.dir = direction;
      body.classList.add('onboard__step');
    }
  }

  return {
    enter(params) {
      // `?langkah=6` lets Settings send someone straight to the summary. Any
      // other value starts from the beginning.
      // Re-entering resets it, so arriving at the screen always animates once.
      animatedStep = 0;
      const requested = Number(params.langkah);
      step = Number.isInteger(requested) && requested >= 1 && requested <= STEPS ? requested : 1;

      draft = loadProfile() ?? draft;
      extras = loadExtras();
      trainingDays = planWeekdays(loadPreferences());
      // The goal previews and the summary compute real calories; without a
      // complete body the arithmetic has nothing to run on, so a deep link
      // lands on the question that needs answering.
      if (step > 2 && !bodyComplete()) step = 2;
      render();
    },
  };
}
