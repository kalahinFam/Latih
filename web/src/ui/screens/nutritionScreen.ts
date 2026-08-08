/**
 * 7 · Gizi.
 *
 * ## Every number carries its source on the same line
 *
 * Each ingredient shows its TKPI code beside it, not in a footnote — the code
 * is what can be matched against panganku.org, and a citation nobody can find
 * is not a citation.
 *
 * Meal totals are computed on the device from the cited rows, never taken from
 * the model's answer. That is the whole reason the endpoint returns codes and
 * grams rather than prose: a total is a *derived* number, and the grounding
 * verifier — which checks whether a figure appears in the retrieved rows —
 * cannot catch a wrong one.
 *
 * The energy target is a range because Mifflin-St Jeor is not more precise than
 * that.
 */

import {
  InvalidProfileError,
  energyTarget,
  explainTarget as explainEnergy,
  mealBudgets,
  type EnergyTarget,
  type MealSlot,
} from '../../core/energy.ts';
import { buildWeeklyPlan, isTrainingDay } from '../../core/plan.ts';
import { excludedCodes, preferredCodes } from '../../core/onboarding.ts';
import { TrainingHistory } from '../../session/history.ts';
import { loadExtras, loadPreferences, loadProfile } from '../../session/profile.ts';
import { MealsError, requestMeals, type MealOptionView } from '../../meals/mealsClient.ts';
import { el, formatDate, required } from '../dom.ts';
import type { Screen } from '../../app/router.ts';

const SLOT_LABELS: Record<MealSlot, string> = {
  pagi: 'Sarapan',
  siang: 'Makan siang',
  malam: 'Makan malam',
};

export interface NutritionDeps {
  history: TrainingHistory;
  onOpenSettings: () => void;
}

export function createNutritionScreen(deps: NutritionDeps): Screen {
  const date = required('#nutritionDate');
  const body = required('#nutritionBody');
  let loadToken = 0;

  function budgetCard(target: EnergyTarget): HTMLElement {
    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card__eyebrow', text: 'ANGGARAN ENERGI' }),
      el(
        'div',
        { class: 'card__figure' },
        el('span', {
          class: 'card__number card__number--sm',
          text: `${target.range.lowKcal.toLocaleString('id-ID')}–${target.range.highKcal.toLocaleString('id-ID')}`,
        }),
        el('span', { class: 'card__unit', text: 'kkal' }),
      ),
      el(
        'div',
        { class: 'stat-row' },
        el(
          'div',
          { class: 'stat' },
          el('div', { class: 'stat__number', text: `${target.proteinG} g` }),
          el('div', { class: 'stat__label', text: 'target protein' }),
        ),
        el(
          'div',
          { class: 'stat' },
          el('div', { class: 'stat__number', text: String(target.bmr) }),
          el('div', { class: 'stat__label', text: 'metabolisme basal' }),
        ),
      ),
      el('p', { class: 'card__foot', text: explainEnergy(target) }),
    );
  }

  function optionCard(option: MealOptionView): HTMLElement {
    const rows = option.items.map((item) =>
      el(
        'div',
        { class: 'row' },
        el(
          'div',
          { class: 'row__body' },
          el('div', { class: 'row__title', text: item.name }),
          // The code sits with the number it justifies.
          el('div', { class: 'row__sub', text: `TKPI ${item.code} · ${item.grams} g` }),
        ),
        el('div', { class: 'bar__count', text: `${Math.round(item.nutrients.energyKcal)} kkal` }),
      ),
    );

    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card__eyebrow', text: option.name.toUpperCase() }),
      el('div', { class: 'rows' }, ...rows),
      el(
        'p',
        { class: 'card__foot' },
        el('strong', {
          text: `Total ${Math.round(option.total.energyKcal)} kkal · protein ${option.total.proteinG} g`,
        }),
        option.note ? el('span', { text: ` — ${option.note}` }) : null,
      ),
    );
  }

  async function loadMeals(target: EnergyTarget, container: HTMLElement): Promise<void> {
    const token = ++loadToken;
    const budgets = mealBudgets(target.targetKcal);
    const extras = loadExtras();

    // Three independent requests. In sequence they would triple the wait for
    // no benefit.
    const results = await Promise.all(
      (Object.keys(budgets) as MealSlot[]).map(async (slot) => {
        try {
          const response = await requestMeals({
            slot,
            budgetKcal: budgets[slot],
            isTrainingDay: target.isTrainingDay,
            proteinTargetG: target.proteinG,
            // Codes travel, not restrictions: "no seafood" is a fact about the
            // person and a list of food codes is a fact about a menu. Only the
            // second needs to leave the phone.
            excludeCodes: excludedCodes(extras.restrictions),
            preferCodes: preferredCodes(extras.homeFoods),
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

    if (token !== loadToken) return;
    container.replaceChildren();

    for (const result of results) {
      container.append(
        el(
          'div',
          { class: 'section section--divided' },
          el(
            'div',
            { class: 'sheet__head' },
            el('span', { class: 'card__eyebrow', text: SLOT_LABELS[result.slot].toUpperCase() }),
            el('span', { class: 'check__value', text: `target ${budgets[result.slot]} kkal` }),
          ),
          ...(result.options.length === 0
            ? [el('p', { class: 'empty', text: result.message ?? 'Belum ada opsi.' })]
            : result.options.map(optionCard)),
        ),
      );
    }
  }

  return {
    enter() {
      date.textContent = formatDate(Date.now());
      body.replaceChildren();

      const profile = loadProfile();
      if (!profile) {
        // Without body measurements there is no target, and inventing one would
        // be exactly the fabrication this module exists to avoid.
        const cta = el('button', { class: 'btn btn--primary', type: 'button', text: 'Isi data tubuh' });
        cta.addEventListener('click', deps.onOpenSettings);
        body.append(
          el('p', {
            class: 'empty',
            text: 'Kebutuhan energi dihitung dari berat, tinggi, usia, dan tingkat aktivitas. Data itu disimpan di perangkatmu dan tidak pernah dikirim ke mana pun.',
          }),
          cta,
        );
        return;
      }

      const plan = buildWeeklyPlan(loadPreferences(), deps.history.all());

      let target: EnergyTarget;
      try {
        target = energyTarget(profile, isTrainingDay(plan));
      } catch (error) {
        body.append(
          el('p', {
            class: 'empty',
            text:
              error instanceof InvalidProfileError
                ? error.message
                : 'Data tubuh tidak valid. Perbarui di Pengaturan.',
          }),
        );
        return;
      }

      const meals = el('div', {}, el('p', { class: 'empty', text: 'Menyusun menu…' }));
      body.append(budgetCard(target), meals);
      void loadMeals(target, meals);
    },

    leave() {
      // Any in-flight meal request belongs to a screen the user has left.
      loadToken += 1;
    },
  };
}
