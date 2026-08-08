/**
 * Spending limits for the four endpoints that cost money.
 *
 * ## Why this exists
 *
 * `coach`, `nutrition` and `meals` are unauthenticated by design — the
 * product has no accounts, and adding them to protect a key would be a large
 * feature answering a small question. But unauthenticated plus billable means
 * anyone who reads the network tab in DevTools can spend the project's OpenAI
 * budget in a loop, and the deployed URL gets handed to strangers.
 *
 * ## Why two layers rather than one
 *
 * They fail differently, so neither replaces the other:
 *
 * - **Per client, per hour** stops the ordinary case — one person, one script,
 *   one afternoon. Generous enough that a real training session never touches
 *   it: a session is a handful of sets, and each set is one coach call plus one
 *   narration.
 * - **Global per day** is the one that bounds the bill. Per-client limits do
 *   nothing against requests spread over many addresses, and the whole point of
 *   a cap is that the worst case is a number chosen in advance rather than a
 *   number discovered on an invoice.
 *
 * A third layer lives outside this repo and matters more than either: a hard
 * budget limit on the OpenAI key itself. Code can fail; the provider's ceiling
 * cannot be reasoned around.
 *
 * ## Degrading without Redis
 *
 * Counters need to survive across serverless invocations, so they live in the
 * same Upstash instance as the push subscriptions. With none configured they
 * fall back to per-instance memory — weak, because instances multiply and cold
 * starts forget, but it keeps local development running and it is never worse
 * than the no-limit behaviour it replaces.
 */

import { createHash } from 'node:crypto';
import { redisCommand, type RedisCommand } from './_redis.ts';
import { json } from './_llm.ts';

export interface LimitPolicy {
  /** Namespaces the counter, so a busy nutrition chat cannot starve coaching. */
  bucket: string;
  /** Requests allowed from one client in one clock hour. */
  perHour: number;
}

/**
 * Per-endpoint allowances.
 *
 * Sized against what one real session spends. A set produces exactly one
 * `/api/coach` call, so thirty is roughly six full sessions in an hour — far
 * past the point of exercise, and still short of anything that costs real
 * money.
 */
export const LIMITS: Record<string, LimitPolicy> = {
  coach: { bucket: 'coach', perHour: 30 },
  nutrition: { bucket: 'nutrition', perHour: 30 },
  meals: { bucket: 'meals', perHour: 30 },
};

/** Total billable calls per day across every endpoint and every client. */
export const DAILY_QUOTA = Number(process.env.LLM_DAILY_QUOTA ?? 1500);

/* ----------------------------------------------------------------- counters */

/** Increment a key inside a window, returning the new count. */
export type Counter = (key: string, ttlSeconds: number) => Promise<number>;

const memory = new Map<string, { count: number; expiresAt: number }>();

const memoryCounter: Counter = async (key, ttlSeconds) => {
  const now = Date.now();
  const existing = memory.get(key);
  if (!existing || existing.expiresAt <= now) {
    memory.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
};

function redisCounter(command: RedisCommand): Counter {
  return async (key, ttlSeconds) => {
    const count = Number(await command('INCR', key));
    // Only the first hit of a window sets the expiry. Re-setting it on every
    // request would slide the window forward for as long as someone keeps
    // knocking, which is exactly backwards: a client at the limit would keep
    // its counter alive forever and never be let back in.
    if (count === 1) await command('EXPIRE', key, ttlSeconds);
    return count;
  };
}

export function counterFor(command = redisCommand()): Counter {
  return command ? redisCounter(command) : memoryCounter;
}

/** Test seam: forget in-memory counters between cases. */
export function resetMemoryCounters(): void {
  memory.clear();
}

/* -------------------------------------------------------------------- keys */

/**
 * A stable identifier for one caller, derived from the address Vercel reports.
 *
 * Hashed, and only the first 16 hex characters kept. A rate limiter needs to
 * recognise a repeat visitor, not to know who they are — and this product tells
 * users their camera frames and body measurements stay on the device, so
 * storing their IP addresses in a database would be a strange exception to make
 * for a counter.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/**
 * The current day in WIB, `YYYY-MM-DD`.
 *
 * UTC would roll the quota over at 07:00 Jakarta time — in the middle of a
 * morning, which is a confusing thing for both a user hitting the cap and the
 * person watching the spend.
 */
export function quotaDay(now = Date.now()): string {
  return new Date(now + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The clock hour a request falls in, used as the per-client window. */
function hourStamp(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/* ------------------------------------------------------------------ origin */

/**
 * Reject calls that did not come from the app.
 *
 * Browsers attach `Origin` to every POST, so the app's own requests always
 * carry one and a bare `curl` does not. This stops nothing determined — the
 * header is trivially forged — but it closes the entire category of "someone
 * found the URL and started poking", which is the realistic threat for a link
 * shared with judges.
 *
 * Unset `ALLOWED_ORIGIN` disables the check, because development runs from
 * localhost, a LAN address, and a rotating tunnel hostname on the same day.
 */
export function originAllowed(request: Request): boolean {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return true;

  const origin = request.headers.get('origin');
  if (!origin) return false;

  return allowed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(origin);
}

/* ------------------------------------------------------------------- check */

export interface LimitDeps {
  counter?: Counter;
  now?: number;
  dailyQuota?: number;
}

/**
 * Gate one request.
 *
 * Returns the refusal to send back, or `null` to continue. Callers run this
 * before reading the body, so a rejected request never costs the time to parse
 * a payload that was not going to be answered.
 *
 * A counter that throws — Upstash down, network gone — lets the request
 * through. The limiter protects a budget; taking the product offline to defend
 * it would trade a cost problem for an availability one, and the provider's own
 * budget cap is still underneath.
 */
export async function checkLimit(
  request: Request,
  policy: LimitPolicy,
  deps: LimitDeps = {},
): Promise<Response | null> {
  if (!originAllowed(request)) {
    return json({ error: 'Permintaan ditolak.' }, 403);
  }

  const count = deps.counter ?? counterFor();
  const now = deps.now ?? Date.now();
  const quota = deps.dailyQuota ?? DAILY_QUOTA;

  try {
    const hits = await count(
      `latih:rl:${policy.bucket}:${clientKey(request)}:${hourStamp(now)}`,
      3600,
    );
    if (hits > policy.perHour) {
      return json(
        { error: 'Terlalu banyak permintaan ke pelatih AI. Coba lagi beberapa menit lagi.' },
        429,
      );
    }

    // Counted after the per-client check, so one client hammering the endpoint
    // burns its own allowance rather than the day's.
    const daily = await count(`latih:quota:${quotaDay(now)}`, 86_400);
    if (daily > quota) {
      return json(
        {
          error:
            'Kuota harian pelatih AI sudah habis. Latihan tetap berjalan penuh — ' +
            'hitungan repetisi dan koreksi form tidak butuh jaringan.',
        },
        429,
      );
    }
  } catch (error) {
    console.error('[ratelimit]', error instanceof Error ? error.message : String(error));
  }

  return null;
}
