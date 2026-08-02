/**
 * Client for the slow loop.
 *
 * The set summary is the only thing that leaves the device — see the privacy
 * contract in `core/setSummary.ts`, which this re-checks before sending. The
 * check is cheap and the failure it prevents is silent, so it runs on every
 * call rather than in tests alone.
 */

import { assertNoRawPoseData, type SetSummary } from '../core/setSummary.ts';

export interface CoachFeedback {
  narasi: string;
  cue_utama: string;
  fokus_set_berikutnya: string;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  latencyMs?: number;
}

/**
 * Between sets the user is resting, so a couple of seconds is fine — but an
 * unbounded wait is not: a hung request would leave the panel spinning with no
 * way back to training.
 */
const TIMEOUT_MS = 15_000;

export class CoachError extends Error {
  readonly kind: 'offline' | 'timeout' | 'server';

  constructor(kind: 'offline' | 'timeout' | 'server', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'CoachError';
  }
}

export async function requestCoaching(summary: SetSummary): Promise<CoachFeedback> {
  // Throws if a future change ever puts image-shaped data in the payload.
  assertNoRawPoseData(summary);

  if (!navigator.onLine) {
    throw new CoachError('offline', 'Sedang offline — umpan balik pelatih dilewati.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new CoachError(
        'server',
        (detail as { error?: string } | null)?.error ?? 'Pelatih AI sedang tidak bisa dihubungi.',
      );
    }

    return (await response.json()) as CoachFeedback;
  } catch (error) {
    if (error instanceof CoachError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CoachError('timeout', 'Pelatih AI tidak merespons. Lanjut ke set berikutnya.');
    }
    throw new CoachError('server', 'Pelatih AI sedang tidak bisa dihubungi.');
  } finally {
    clearTimeout(timer);
  }
}
