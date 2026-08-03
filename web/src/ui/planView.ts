/**
 * The plan page: schedule, energy needs, and today's menu.
 *
 * Everything numeric on this page is computed on the device — the weekly plan
 * from `core/plan.ts`, the calorie target from `core/energy.ts`. The only thing
 * that crosses the network is a per-meal calorie budget, sent to `/api/meals`
 * so the model can choose foods to fit it. Body measurements stay here.
 */

import {
  ACTIVITY_LABELS,
  InvalidProfileError,
  energyTarget,
  explainTarget as explainEnergy,
  mealBudgets,
  type ActivityLevel,
  type BodyProfile,
  type BodySex,
  type EnergyGoal,
  type EnergyTarget,
  type MealSlot,
} from '../core/energy.ts';
import {
  buildWeeklyPlan,
  explainPlan,
  isTrainingDay,
  type PlanPreferences,
  type WeeklyPlan,
} from '../core/plan.ts';
import { explainTarget as explainReps } from '../core/sessionLoop.ts';
import { TrainingHistory } from '../session/history.ts';
import {
  loadPreferences,
  loadProfile,
  savePreferences,
  saveProfile,
} from '../session/profile.ts';
import { requestMeals, MealsError, type MealOptionView } from '../meals/mealsClient.ts';
import {
  ReminderError,
  disableReminders,
  enableReminders,
  fetchServerConfig,
  reminderSupport,
  remindersActive,
} from '../session/reminders.ts';

const SLOT_LABELS: Record<MealSlot, string> = {
  pagi: 'Sarapan',
  siang: 'Makan siang',
  malam: 'Makan malam',
};

export interface PlanViewElements {
  planForm: HTMLFormElement;
  daysPerWeek: HTMLSelectElement;
  timeOfDay: HTMLInputElement;
  setsPerExercise: HTMLSelectElement;
  planSummary: HTMLElement;
  week: HTMLElement;
  reminder: HTMLElement;
  reminderToggle: HTMLButtonElement;
  reminderStatus: HTMLElement;

  profileForm: HTMLFormElement;
  weightKg: HTMLInputElement;
  heightCm: HTMLInputElement;
  ageYears: HTMLInputElement;
  sex: HTMLSelectElement;
  activity: HTMLSelectElement;
  goal: HTMLSelectElement;
  profileError: HTMLElement;
  energy: HTMLElement;

  mealsIntro: HTMLElement;
  meals: HTMLElement;
}

export class PlanView {
  private readonly el: PlanViewElements;
  private readonly history = new TrainingHistory();
  private preferences: PlanPreferences;
  private plan: WeeklyPlan;
  private remindersOn = false;

  constructor(el: PlanViewElements) {
    this.el = el;
    this.preferences = loadPreferences();
    this.plan = this.rebuildPlan();

    this.populateActivityOptions();
    this.restoreForms();
    this.renderPlan();

    el.planForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.savePlanPreferences();
    });

    el.profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.applyProfile();
    });

    el.reminderToggle.addEventListener('click', () => void this.toggleReminders());
    void this.initReminders();

    // Show the energy panel straight away when a profile already exists, so a
    // returning user sees today's numbers without pressing anything.
    const stored = loadProfile();
    if (stored) void this.applyProfile(stored);
  }

  private rebuildPlan(): WeeklyPlan {
    return buildWeeklyPlan(this.preferences, this.history.all());
  }

  private populateActivityOptions(): void {
    for (const [value, label] of Object.entries(ACTIVITY_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.el.activity.append(option);
    }
  }

  private restoreForms(): void {
    this.el.daysPerWeek.value = String(this.preferences.daysPerWeek);
    this.el.timeOfDay.value = this.preferences.timeOfDay;
    this.el.setsPerExercise.value = String(this.preferences.setsPerExercise);

    const profile = loadProfile();
    if (!profile) return;

    this.el.weightKg.value = String(profile.weightKg);
    this.el.heightCm.value = String(profile.heightCm);
    this.el.ageYears.value = String(profile.ageYears);
    this.el.sex.value = profile.sex;
    this.el.activity.value = profile.activity;
    this.el.goal.value = profile.goal;
  }

  private savePlanPreferences(): void {
    this.preferences = {
      ...this.preferences,
      daysPerWeek: Number(this.el.daysPerWeek.value),
      timeOfDay: this.el.timeOfDay.value || '18:00',
      setsPerExercise: Number(this.el.setsPerExercise.value),
    };
    savePreferences(this.preferences);
    this.plan = this.rebuildPlan();
    this.renderPlan();

    // The subscription carries the time and the weekdays, so a schedule change
    // that did not re-register would leave reminders firing on the old one.
    if (this.remindersOn) void this.resubscribe();
  }

  /* ------------------------------------------------------------ reminders */

  private async initReminders(): Promise<void> {
    const support = reminderSupport();
    this.el.reminder.hidden = false;

    if (!support.supported) {
      // Say why, rather than offering a switch that cannot work.
      this.el.reminderToggle.hidden = true;
      this.el.reminderStatus.textContent = support.reason;
      return;
    }

    try {
      const config = await fetchServerConfig();
      if (!config.configured) {
        this.el.reminderToggle.hidden = true;
        this.el.reminderStatus.textContent =
          'Pengingat belum dikonfigurasi di server. Jalankan scripts/gen-vapid.mjs lalu isi VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY.';
        return;
      }

      this.remindersOn = await remindersActive();
      this.renderReminderState(
        config.storage === 'memory'
          ? 'Server belum punya penyimpanan tetap, jadi pengingat akan hilang saat server di-deploy ulang.'
          : null,
      );
    } catch {
      this.el.reminderToggle.hidden = true;
      this.el.reminderStatus.textContent = 'Status pengingat tidak bisa dibaca.';
    }
  }

  private renderReminderState(note: string | null): void {
    this.el.reminderToggle.hidden = false;
    this.el.reminderToggle.textContent = this.remindersOn ? 'Matikan' : 'Aktifkan';
    this.el.reminderToggle.classList.toggle('reminder__toggle--on', this.remindersOn);

    const base = this.remindersOn
      ? `Aktif — ${this.preferences.timeOfDay} pada hari latihan.`
      : 'Belum aktif.';
    this.el.reminderStatus.textContent = note ? `${base} ${note}` : base;
  }

  private async toggleReminders(): Promise<void> {
    this.el.reminderToggle.disabled = true;
    try {
      if (this.remindersOn) {
        await disableReminders();
        this.remindersOn = false;
      } else {
        await enableReminders(this.preferences);
        this.remindersOn = true;
      }
      this.renderReminderState(null);
    } catch (error) {
      this.el.reminderStatus.textContent =
        error instanceof ReminderError ? error.message : 'Pengingat gagal diubah.';
    } finally {
      this.el.reminderToggle.disabled = false;
    }
  }

  private async resubscribe(): Promise<void> {
    try {
      await enableReminders(this.preferences);
      this.renderReminderState(null);
    } catch {
      // The old subscription is still live, so the user keeps a reminder —
      // just on the previous schedule. Saying so beats silence.
      this.el.reminderStatus.textContent =
        'Jadwal tersimpan, tapi pengingat masih memakai jadwal lama. Matikan lalu aktifkan lagi.';
    }
  }

  private renderPlan(): void {
    this.el.planSummary.textContent = explainPlan(this.plan);
    this.el.week.replaceChildren();

    for (const day of this.plan.days) {
      const card = document.createElement('div');
      card.className = 'day';
      if (day.isTraining) card.classList.add('day--training');
      if (day.isToday) card.classList.add('day--today');
      if (day.done) card.classList.add('day--done');

      const name = document.createElement('span');
      name.className = 'day__name';
      name.textContent = day.label;
      card.append(name);

      if (!day.isTraining) {
        const rest = document.createElement('span');
        rest.className = 'day__rest';
        rest.textContent = 'Istirahat';
        card.append(rest);
      } else {
        for (const exercise of day.exercises) {
          const row = document.createElement('span');
          row.className = 'day__exercise';
          row.textContent = `${exercise.sets}×${exercise.targetReps} ${
            exercise.exercise === 'pushup' ? 'push-up' : 'squat'
          }`;
          // The session loop's reasoning, available but not shouted.
          row.title = explainReps({
            exercise: exercise.exercise,
            targetReps: exercise.targetReps,
            reason: exercise.reason,
            basedOnSessions: 0,
          });
          card.append(row);
        }

        if (day.done) {
          const done = document.createElement('span');
          done.className = 'day__done';
          done.textContent = '✓ selesai';
          card.append(done);
        }
      }

      this.el.week.append(card);
    }
  }

  /**
   * Compute today's energy target and fetch a menu for it.
   *
   * @param preset Used on load, when the stored profile is already known good.
   */
  private async applyProfile(preset?: BodyProfile): Promise<void> {
    const profile = preset ?? this.readProfileForm();
    let target: EnergyTarget;

    try {
      target = energyTarget(profile, isTrainingDay(this.plan));
    } catch (error) {
      // The equation was never validated outside these ranges, so refusing is
      // the honest response — see `core/energy.ts`.
      this.el.profileError.hidden = false;
      this.el.profileError.textContent =
        error instanceof InvalidProfileError ? error.message : 'Data tubuh tidak valid.';
      this.el.energy.hidden = true;
      return;
    }

    this.el.profileError.hidden = true;
    if (!preset) saveProfile(profile);
    this.renderEnergy(target);
    await this.loadMeals(target);
  }

  private readProfileForm(): BodyProfile {
    return {
      weightKg: Number(this.el.weightKg.value),
      heightCm: Number(this.el.heightCm.value),
      ageYears: Number(this.el.ageYears.value),
      sex: this.el.sex.value as BodySex,
      activity: this.el.activity.value as ActivityLevel,
      goal: this.el.goal.value as EnergyGoal,
    };
  }

  private renderEnergy(target: EnergyTarget): void {
    this.el.energy.hidden = false;
    this.el.energy.replaceChildren();

    const headline = document.createElement('p');
    headline.className = 'energy__headline';
    headline.textContent = explainEnergy(target);
    this.el.energy.append(headline);

    const stats = document.createElement('dl');
    stats.className = 'energy__stats';
    const rows: [string, string][] = [
      ['Metabolisme basal', `${target.bmr} kkal`],
      ['Kebutuhan harian', `${target.maintenance} kkal`],
      ['Target protein', `${target.proteinG} g`],
      ['Hari ini', target.isTrainingDay ? 'Hari latihan' : 'Hari istirahat'],
    ];

    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      stats.append(dt, dd);
    }
    this.el.energy.append(stats);
  }

  private async loadMeals(target: EnergyTarget): Promise<void> {
    const budgets = mealBudgets(target.targetKcal);
    this.el.mealsIntro.textContent = 'Menyusun menu…';
    this.el.meals.replaceChildren();

    // Three requests in parallel: they are independent, and running them in
    // sequence would triple the wait for no benefit.
    const results = await Promise.all(
      (Object.keys(budgets) as MealSlot[]).map(async (slot) => {
        try {
          const response = await requestMeals({
            slot,
            budgetKcal: budgets[slot],
            isTrainingDay: target.isTrainingDay,
            proteinTargetG: target.proteinG,
          });
          return { slot, options: response.options, message: response.message ?? null };
        } catch (error) {
          return {
            slot,
            options: [] as MealOptionView[],
            message: error instanceof MealsError ? error.message : 'Menu tidak tersedia.',
          };
        }
      }),
    );

    this.el.mealsIntro.textContent = `Target ${target.targetKcal} kkal, dibagi ke tiga waktu makan.`;
    for (const result of results) {
      this.el.meals.append(this.renderSlot(result.slot, budgets[result.slot], result.options, result.message));
    }
  }

  private renderSlot(
    slot: MealSlot,
    budgetKcal: number,
    options: MealOptionView[],
    message: string | null,
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'meal';

    const heading = document.createElement('h3');
    heading.className = 'meal__title';
    heading.textContent = `${SLOT_LABELS[slot]} · target ${budgetKcal} kkal`;
    section.append(heading);

    if (options.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'meal__empty';
      empty.textContent = message ?? 'Belum ada opsi.';
      section.append(empty);
      return section;
    }

    for (const option of options) {
      const card = document.createElement('article');
      card.className = 'option';

      const name = document.createElement('h4');
      name.className = 'option__name';
      name.textContent = option.name;
      card.append(name);

      const list = document.createElement('ul');
      list.className = 'option__items';
      for (const item of option.items) {
        const li = document.createElement('li');
        // Portion and its computed energy together: the figure is checkable
        // against the TKPI row it came from without leaving the page.
        li.textContent = `${item.grams} g ${item.name} — ${item.nutrients.energyKcal} kkal`;
        list.append(li);
      }
      card.append(list);

      const total = document.createElement('p');
      total.className = 'option__total';
      total.textContent = `Total ${option.total.energyKcal} kkal · protein ${option.total.proteinG} g`;
      card.append(total);

      if (option.note) {
        const note = document.createElement('p');
        note.className = 'option__note';
        note.textContent = option.note;
        card.append(note);
      }

      section.append(card);
    }

    return section;
  }
}
