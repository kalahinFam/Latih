/**
 * Client for the grounded nutrition assistant.
 *
 * Note what the request type has nowhere to put: weight, height, age, sex. The
 * device computes the energy and protein targets from those and sends only the
 * results — the same trade `MealsRequest` makes, enforced the same way, by the
 * type rather than by a rule somebody has to remember.
 */

import type { ChatContext, ChatTurn } from '../core/nutritionChat.ts';

export interface Citation {
  code: string;
  name: string;
  basisG: number;
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG?: number;
  source: string;
  verified: boolean;
}

export interface NutritionAnswer {
  answer: string;
  citations: Citation[];
  /** What the numeric verifier found. Shown to the user, pass or fail. */
  verification: { passed: boolean; checked: number; unmatched: string[]; regenerated: boolean };
  dataWarning: string | null;
}

export interface AskRequest {
  question: string;
  /** Earlier turns, so a follow-up can leave the noun out. */
  history: ChatTurn[];
  context?: ChatContext;
}

/**
 * Shorter than the meal planner's window: this is one question with one
 * possible rewrite behind it, and a chat that hangs for half a minute reads as
 * broken rather than thorough.
 */
const TIMEOUT_MS = 20_000;

export class NutritionChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NutritionChatError';
  }
}

export async function askNutrition(request: AskRequest): Promise<NutritionAnswer> {
  if (!navigator.onLine) {
    throw new NutritionChatError('Sedang offline — asisten gizi butuh koneksi.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('/api/nutrition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new NutritionChatError(detail?.error ?? 'Asisten gizi tidak bisa dihubungi.');
    }

    return (await response.json()) as NutritionAnswer;
  } catch (error) {
    if (error instanceof NutritionChatError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NutritionChatError('Asisten gizi tidak merespons.');
    }
    throw new NutritionChatError('Asisten gizi tidak bisa dihubungi.');
  } finally {
    clearTimeout(timer);
  }
}
