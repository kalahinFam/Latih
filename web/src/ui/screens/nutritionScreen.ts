/**
 * 7 · Gizi.
 *
 * TKPI codes remain in the response and validation pipeline, but the meal cards
 * keep that implementation detail out of the interface and show only the
 * ingredient name, portion, and computed energy.
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
import { openingQuestions } from '../../core/nutritionQuestions.ts';
import type { ChatContext } from '../../core/nutritionChat.ts';
import { hasConversation, queueQuestion } from './nutritionChatScreen.ts';
import { el, formatDate, required } from '../dom.ts';
import { icon } from '../icons.ts';
import type { Screen } from '../../app/router.ts';

const SLOT_LABELS: Record<MealSlot, string> = {
  pagi: 'Sarapan',
  siang: 'Makan siang',
  malam: 'Makan malam',
};

export interface NutritionDeps {
  history: TrainingHistory;
  onOpenSettings: () => void;
  onOpenChat: () => void;
}

export function createNutritionScreen(deps: NutritionDeps): Screen {
  const date = required('#nutritionDate');
  const body = required('#nutritionBody');
  let loadToken = 0;
  /** Rotates the offered questions between visits, without reading a clock. */
  let visit = 0;

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
          el('div', { class: 'row__sub', text: `${item.grams} g` }),
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

  /**
   * The way into "Tanya gizi" — a few questions rather than a door.
   *
   * A button labelled "Tanya gizi" asks the user to think of a question before
   * they have seen what the thing can answer. Offering three instead means one
   * tap lands them in a conversation that has already started; the same
   * catalogue the chat screen uses, so nothing here can suggest a question the
   * table cannot answer.
   */
  function chatCard(context: ChatContext): HTMLElement {
    const card = el(
      'section',
      // The one tinted card on a screen of white ones. Sage, not amber: amber
      // means a detected form error in this product and nothing else, and
      // spending it on decoration here would cost it that meaning over on the
      // workout screen.
      { class: 'card card--chat' },
      el('div', { class: 'card__eyebrow', text: 'TANYA GIZI' }),
      el('p', {
        class: 'chatcard__blurb',
        text: 'Dijawab dari Tabel Komposisi Pangan Indonesia, lengkap dengan baris tabelnya supaya bisa kamu cek sendiri.',
      }),
    );

    // Three, not five: this is a card on a screen that is mostly about menus.
    for (const question of openingQuestions(context, visit).slice(0, 3)) {
      const button = el(
        'button',
        { class: 'chatsuggest__item chatsuggest__item--pop', type: 'button' },
        el('span', { class: 'chatsuggest__text', text: question }),
        // The back arrow, flipped: it points the way this button goes, and it
        // is the same stroke weight as every other icon in the app.
        icon('kembali', 15, 2),
      );
      button.addEventListener('click', () => {
        queueQuestion(question);
        deps.onOpenChat();
      });
      card.append(button);
    }

    const open = el('button', {
      class: 'chatcard__more',
      type: 'button',
      text: hasConversation() ? 'Lanjutkan percakapan →' : 'Tanya yang lain →',
    });
    open.addEventListener('click', deps.onOpenChat);
    card.append(open);

    return card;
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
      visit += 1;
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
          // The assistant works without a profile — it answers from the food
          // table, and the daily targets are only context. Hiding the way in
          // would withhold the one thing on this screen that still works for
          // somebody who skipped onboarding.
          chatCard({}),
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
      // A door, not the room. The conversation grows and the menus below are
      // what most visits here are for, so the assistant gets its own screen.
      body.append(
        budgetCard(target),
        // The targets are context the assistant may quote back; they were
        // computed on this device and are printed just above.
        chatCard({
          targetKcal: target.targetKcal,
          proteinG: target.proteinG,
          isTrainingDay: target.isTrainingDay,
        }),
        meals,
      );
      void loadMeals(target, meals);
    },

    leave() {
      // Any in-flight meal request belongs to a screen the user has left.
      loadToken += 1;
    },
  };
}
