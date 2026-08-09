/**
 * Client for the between-sets coach.
 *
 * What leaves the device is the sentence, the movement just trained, and what
 * today still holds. Not the complaint log: that is written here after the
 * reply lands, and the endpoint never learns what has hurt before.
 */

import { MAX_MESSAGE_CHARS, isRestChatReply, type BodyPart, type BodySide, type RestIntent, type Substitution } from '../core/restChat.ts';
import type { MovementKind } from '../core/types.ts';

export interface RestChatRequest {
  message: string;
  movement: MovementKind;
  today: MovementKind[];
  setsDone: number;
  setsPlanned: number;
}

export interface RestChatAnswer {
  intent: RestIntent;
  bodyPart: BodyPart | null;
  side: BodySide | null;
  answer: string;
  substitution: Substitution | null;
  substitutionText: string | null;
  substituteName: string | null;
  substituteHowto: string | null;
  /** Filled for a question about the plan, computed from the plan itself. */
  remaining: string | null;
}

/**
 * Shorter than the meal planner's window. This is asked mid-rest with a timer
 * running: a reply that arrives after the user has already started the next set
 * is not a reply.
 */
const TIMEOUT_MS = 15_000;

export class RestChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestChatError';
  }
}

export async function askCoach(request: RestChatRequest): Promise<RestChatAnswer> {
  if (!navigator.onLine) {
    throw new RestChatError('Sedang offline — pelatih butuh koneksi untuk menjawab.');
  }
  if (request.message.length > MAX_MESSAGE_CHARS) {
    throw new RestChatError(`Maksimal ${MAX_MESSAGE_CHARS} karakter.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('/api/rest-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new RestChatError(detail?.error ?? 'Pelatih tidak bisa dihubungi.');
    }

    const payload: unknown = await response.json();
    if (!isRestChatReply(payload)) {
      // A malformed reply is not something to render hopefully: the substitution
      // it might carry is a plan change, and a half-understood one is worse than
      // none.
      throw new RestChatError('Jawaban pelatih tidak terbaca. Coba tanyakan lagi.');
    }

    return payload as RestChatAnswer;
  } catch (error) {
    if (error instanceof RestChatError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new RestChatError('Pelatih tidak merespons. Lanjut ke set berikutnya.');
    }
    throw new RestChatError('Pelatih tidak bisa dihubungi.');
  } finally {
    clearTimeout(timer);
  }
}
