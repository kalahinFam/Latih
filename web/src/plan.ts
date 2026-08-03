import './style.css';
import { registerServiceWorker } from './pwa.ts';
import { PlanView } from './ui/planView.ts';

/** Fail loudly at startup rather than with `null` deref deep in a handler. */
function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}

new PlanView({
  planForm: required<HTMLFormElement>('#planForm'),
  daysPerWeek: required<HTMLSelectElement>('#daysPerWeek'),
  timeOfDay: required<HTMLInputElement>('#timeOfDay'),
  setsPerExercise: required<HTMLSelectElement>('#setsPerExercise'),
  planSummary: required('#planSummary'),
  week: required('#week'),

  profileForm: required<HTMLFormElement>('#profileForm'),
  weightKg: required<HTMLInputElement>('#weightKg'),
  heightCm: required<HTMLInputElement>('#heightCm'),
  ageYears: required<HTMLInputElement>('#ageYears'),
  sex: required<HTMLSelectElement>('#sex'),
  activity: required<HTMLSelectElement>('#activity'),
  goal: required<HTMLSelectElement>('#goal'),
  profileError: required('#profileError'),
  energy: required('#energy'),

  mealsIntro: required('#mealsIntro'),
  meals: required('#meals'),
});

registerServiceWorker();
