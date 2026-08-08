/**
 * What the assistant is allowed to know about the person asking.
 *
 * Derived figures only — the daily energy and protein targets this device
 * computed, and whether today is a training day. There is deliberately no path
 * here for weight, height, age or sex: `ChatContext` has nowhere to put them,
 * the same way `MealsRequest` does not.
 *
 * Empty when there is no profile. The assistant still works — it answers from
 * the food table — it simply has no target to relate an answer to, which is
 * exactly what an empty context says.
 */

import { InvalidProfileError, energyTarget } from '../core/energy.ts';
import type { ChatContext } from '../core/nutritionChat.ts';
import { buildWeeklyPlan, isTrainingDay } from '../core/plan.ts';
import type { TrainingHistory } from '../session/history.ts';
import { loadPreferences, loadProfile } from '../session/profile.ts';

export function chatContext(history: TrainingHistory): ChatContext {
  const profile = loadProfile();
  if (!profile) return {};

  try {
    const target = energyTarget(profile, isTrainingDay(buildWeeklyPlan(loadPreferences(), history.all())));
    return {
      targetKcal: target.targetKcal,
      proteinG: target.proteinG,
      isTrainingDay: target.isTrainingDay,
    };
  } catch (error) {
    // A stored profile the equation will not accept. The nutrition screen says
    // so in its own words; here it simply means there is no target to quote.
    if (error instanceof InvalidProfileError) return {};
    throw error;
  }
}
