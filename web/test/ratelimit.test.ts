/**
 * Spending limits for the billable endpoints.
 *
 * Outside `src/` for the same reason as the push tests: this exercises server
 * code that reaches for Node's crypto, which the browser build must never
 * touch.
 *
 * Worth testing because every failure here is silent in opposite directions. A
 * limiter that is too strict rejects someone mid-session and looks like the
 * coach being broken; one that never fires looks exactly like a working app
 * until the invoice arrives.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkLimit,
  counterFor,
  quotaDay,
  resetMemoryCounters,
  type Counter,
  type LimitPolicy,
} from '../../server/_ratelimit.ts';

const POLICY: LimitPolicy = { bucket: 'test', perHour: 3 };

/** Vercel always sets this; the limiter reads the first entry. */
function request(ip = '203.0.113.5', origin: string | null = 'https://latih.app'): Request {
  const headers = new Headers({ 'x-forwarded-for': ip });
  if (origin) headers.set('origin', origin);
  return new Request('https://latih.app/api/coach', { method: 'POST', headers });
}

/** A Redis stand-in that records what the real one would have been asked. */
function fakeRedis() {
  const store = new Map<string, { count: number; ttl: number }>();
  const calls: string[][] = [];

  const command = async (...args: (string | number)[]): Promise<unknown> => {
    calls.push(args.map(String));
    const [verb, key] = args.map(String);
    if (verb === 'INCR') {
      const entry = store.get(key) ?? { count: 0, ttl: 0 };
      entry.count += 1;
      store.set(key, entry);
      return entry.count;
    }
    if (verb === 'EXPIRE') {
      const entry = store.get(key);
      if (entry) entry.ttl = Number(args[2]);
      return 1;
    }
    throw new Error(`unexpected command ${verb}`);
  };

  return { command, store, calls };
}

beforeEach(() => {
  resetMemoryCounters();
  delete process.env.ALLOWED_ORIGIN;
});

afterEach(() => {
  delete process.env.ALLOWED_ORIGIN;
});

describe('per-client limit', () => {
  it('allows requests up to the limit and refuses the one after', async () => {
    const counter = counterFor(fakeRedis().command);

    for (let i = 0; i < POLICY.perHour; i += 1) {
      expect(await checkLimit(request(), POLICY, { counter })).toBeNull();
    }

    const refused = await checkLimit(request(), POLICY, { counter });
    expect(refused?.status).toBe(429);
    expect((await refused!.json()).error).toMatch(/terlalu banyak/i);
  });

  it('counts each client separately', async () => {
    const counter = counterFor(fakeRedis().command);

    for (let i = 0; i < POLICY.perHour + 1; i += 1) {
      await checkLimit(request('198.51.100.1'), POLICY, { counter });
    }

    // A different address must not inherit the exhausted allowance.
    expect(await checkLimit(request('203.0.113.9'), POLICY, { counter })).toBeNull();
  });

  it('starts a fresh allowance in the next hour', async () => {
    const counter = counterFor(fakeRedis().command);
    const hour = Date.UTC(2026, 7, 8, 10, 0, 0);

    for (let i = 0; i < POLICY.perHour + 1; i += 1) {
      await checkLimit(request(), POLICY, { counter, now: hour });
    }
    expect((await checkLimit(request(), POLICY, { counter, now: hour }))?.status).toBe(429);

    expect(await checkLimit(request(), POLICY, { counter, now: hour + 3_600_000 })).toBeNull();
  });

  it('sets the window expiry once, not on every hit', async () => {
    const redis = fakeRedis();
    const counter = counterFor(redis.command);

    await checkLimit(request(), POLICY, { counter });
    await checkLimit(request(), POLICY, { counter });

    // Re-arming the TTL on each request would slide the window forward for as
    // long as a client keeps knocking, and it would never be let back in.
    const expiries = redis.calls.filter(([verb]) => verb === 'EXPIRE');
    expect(expiries).toHaveLength(2); // one per key: the client bucket and the daily quota
    expect(expiries.every((call) => call[2] === '3600' || call[2] === '86400')).toBe(true);
  });
});

describe('global daily quota', () => {
  it('refuses everyone once the day is spent, whatever the address', async () => {
    const counter = counterFor(fakeRedis().command);
    const generous: LimitPolicy = { bucket: 'test', perHour: 100 };
    const deps = { counter, dailyQuota: 3 };

    for (let i = 0; i < 3; i += 1) {
      expect(await checkLimit(request(`198.51.100.${i}`), generous, deps)).toBeNull();
    }

    const refused = await checkLimit(request('203.0.113.77'), generous, deps);
    expect(refused?.status).toBe(429);
    // The message must say the workout still works — the fast loop needs no
    // network at all, and a user who thinks the app is down stops training.
    expect((await refused!.json()).error).toMatch(/kuota harian/i);
  });

  it('rolls over on the Jakarta day, not the UTC one', () => {
    // 23:30 UTC is already the next day in WIB (UTC+7).
    expect(quotaDay(Date.UTC(2026, 7, 8, 23, 30))).toBe('2026-08-09');
    expect(quotaDay(Date.UTC(2026, 7, 8, 10, 0))).toBe('2026-08-08');
  });

  it('does not spend the day’s quota on a client already over its own limit', async () => {
    const redis = fakeRedis();
    const counter = counterFor(redis.command);

    for (let i = 0; i < POLICY.perHour + 5; i += 1) {
      await checkLimit(request(), POLICY, { counter });
    }

    const quotaKey = [...redis.store.keys()].find((key) => key.startsWith('latih:quota:'));
    expect(redis.store.get(quotaKey!)?.count).toBe(POLICY.perHour);
  });
});

describe('origin check', () => {
  it('is skipped when ALLOWED_ORIGIN is unset, so dev keeps working', async () => {
    const counter = counterFor(fakeRedis().command);
    expect(await checkLimit(request('203.0.113.5', null), POLICY, { counter })).toBeNull();
  });

  it('refuses an unknown origin and a request carrying none', async () => {
    process.env.ALLOWED_ORIGIN = 'https://latih.app';
    const counter = counterFor(fakeRedis().command);

    expect((await checkLimit(request('203.0.113.5', 'https://evil.test'), POLICY, { counter }))?.status).toBe(403);
    // A bare curl sends no Origin at all; the app's own fetch always does.
    expect((await checkLimit(request('203.0.113.5', null), POLICY, { counter }))?.status).toBe(403);
    expect(await checkLimit(request('203.0.113.5'), POLICY, { counter })).toBeNull();
  });

  it('accepts any origin in a comma-separated list, for preview deploys', async () => {
    process.env.ALLOWED_ORIGIN = 'https://latih.app, https://latih.vercel.app';
    const counter = counterFor(fakeRedis().command);

    expect(
      await checkLimit(request('203.0.113.5', 'https://latih.vercel.app'), POLICY, { counter }),
    ).toBeNull();
  });
});

describe('when the counter fails', () => {
  it('lets the request through rather than taking the product down', async () => {
    const broken: Counter = async () => {
      throw new Error('Upstash 503');
    };

    // Losing the limiter costs money; refusing every request costs the demo.
    // The provider's own budget cap is still underneath either way.
    expect(await checkLimit(request(), POLICY, { counter: broken })).toBeNull();
  });
});

describe('without Upstash configured', () => {
  it('still counts, in memory, so local development is limited too', async () => {
    const counter = counterFor(null);

    for (let i = 0; i < POLICY.perHour; i += 1) {
      expect(await checkLimit(request(), POLICY, { counter })).toBeNull();
    }
    expect((await checkLimit(request(), POLICY, { counter }))?.status).toBe(429);
  });
});
