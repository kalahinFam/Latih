/**
 * Client for the meal suggester.
 *
 * Note what is *not* in the request type: no weight, no height, no age, no sex.
 * The device computes the calorie budget from those and sends only the budget.
 * The privacy property is enforced by this type having nowhere to put them, the
 * same way `SetSummary` has nowhere to put a video frame.
 */

import type { MealSlot } from '../core/energy.ts';

export interface MealsRequest {
  slot: MealSlot;
  budgetKcal: number;
  isTrainingDay: boolean;
  proteinTargetG?: number;
}

export interface MealItemView {
  code: string;
  name: string;
  grams: number;
  nutrients: { energyKcal: number; proteinG: number; fatG: number; carbG: number };
}

export interface MealOptionView {
  name: string;
  items: MealItemView[];
  total: { energyKcal: number; proteinG: number; fatG: number; carbG: number };
  note?: string;
  budgetDeltaKcal: number;
}

export interface MealsResponse {
  options: MealOptionView[];
  rejected: string[];
  regenerated: boolean;
  message?: string;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  latencyMs?: number;
}

/**
 * Longer than the coach's window: this call may include a regeneration, and
 * three of them run in parallel. Still bounded — a hung request would leave the
 * page saying "Menyusun menu…" forever.
 */
const TIMEOUT_MS = 25_000;

export class MealsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MealsError';
  }
}

export async function requestMeals(request: MealsRequest): Promise<MealsResponse> {
  if (!navigator.onLine) {
    throw new MealsError('Sedang offline — saran menu butuh koneksi.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('/api/meals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new MealsError(
        (detail as { error?: string } | null)?.error ?? 'Perencana menu tidak bisa dihubungi.',
      );
    }

    return (await response.json()) as MealsResponse;
  } catch (error) {
    if (error instanceof MealsError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new MealsError('Perencana menu tidak merespons.');
    }
    throw new MealsError('Perencana menu tidak bisa dihubungi.');
  } finally {
    clearTimeout(timer);
  }
}
