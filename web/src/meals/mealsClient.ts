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
  /** TKPI codes the user has ruled out. Derived on the device. */
  excludeCodes?: string[];
  /** Codes to reach for first. A preference, never a filter. */
  preferCodes?: string[];
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

/**
 * Successful menu requests live for the lifetime of this page.
 *
 * The nutrition screen is entered repeatedly through the tab bar. Repeating
 * the same three LLM calls on every visit spends tokens without producing new
 * information. A page-lifetime cache is long enough to cover that navigation
 * while naturally clearing on reload, which also gives the user a simple way
 * to ask for a fresh set of suggestions.
 *
 * Promises, rather than only completed responses, are cached so leaving and
 * immediately returning also joins the requests already in flight. Rejections
 * are removed: an offline or transient server failure must remain retryable.
 */
const mealCache = new Map<string, Promise<MealsResponse>>();

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function mealRequestKey(request: MealsRequest): string {
  return JSON.stringify({
    slot: request.slot,
    budgetKcal: request.budgetKcal,
    isTrainingDay: request.isTrainingDay,
    proteinTargetG: request.proteinTargetG ?? null,
    excludeCodes: sortedUnique(request.excludeCodes),
    preferCodes: sortedUnique(request.preferCodes),
  });
}

/** Clear page-lifetime suggestions, primarily for tests and an explicit refresh UI. */
export function clearMealCache(): void {
  mealCache.clear();
}

export function requestMeals(request: MealsRequest): Promise<MealsResponse> {
  const key = mealRequestKey(request);
  const cached = mealCache.get(key);
  if (cached) return cached;

  const pending = requestMealsFromApi(request).catch((error: unknown) => {
    mealCache.delete(key);
    throw error;
  });
  mealCache.set(key, pending);
  return pending;
}

async function requestMealsFromApi(request: MealsRequest): Promise<MealsResponse> {
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
