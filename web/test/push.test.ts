/**
 * Reminder scheduling and VAPID signing.
 *
 * Outside `src/` for the same reason as the meal integration tests: this
 * exercises server code that uses Node's crypto, which the browser build must
 * never reach for.
 *
 * The scheduling rules are worth testing precisely because their failures are
 * quiet — a reminder that fires on the wrong day, an hour late, or twice, all
 * look like nothing happening until a user complains.
 */

import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isDue, sendPush, vapidConfig, type PushSubscriptionRecord } from '../../api/_push.ts';

/** Monday 3 August 2026, 11:00 UTC = 18:00 in WIB (UTC+7). */
const MONDAY_11_UTC = Date.UTC(2026, 7, 3, 11, 0, 0);
const WIB = 7 * 60;

function record(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: 'test',
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    timeOfDay: '18:00',
    weekdays: [0, 2, 5],
    utcOffsetMinutes: WIB,
    createdAt: 0,
    ...overrides,
  };
}

describe('isDue', () => {
  it('fires at the scheduled local time', () => {
    expect(isDue(record(), MONDAY_11_UTC)).toBe(true);
  });

  it('reads the schedule in the device’s zone, not the server’s', () => {
    // Same instant, a device in WITA (UTC+8) where it is already 19:00.
    expect(isDue(record({ utcOffsetMinutes: 8 * 60 }), MONDAY_11_UTC)).toBe(false);
    // And one in UTC, where it is only 11:00.
    expect(isDue(record({ utcOffsetMinutes: 0 }), MONDAY_11_UTC)).toBe(false);
  });

  it('does not fire before the scheduled time', () => {
    expect(isDue(record(), MONDAY_11_UTC - 60 * 60 * 1000)).toBe(false);
  });

  it('still fires when the cron lands slightly late', () => {
    // A job on a fifteen-minute cadence will rarely hit the minute exactly;
    // without the grace window every user whose time falls between runs would
    // simply never be reminded.
    expect(isDue(record(), MONDAY_11_UTC + 14 * 60 * 1000)).toBe(true);
  });

  it('gives up once the slot is properly missed', () => {
    expect(isDue(record(), MONDAY_11_UTC + 90 * 60 * 1000)).toBe(false);
  });

  it('skips days that are not training days', () => {
    // Tuesday is weekday 1, which this schedule does not include.
    expect(isDue(record(), MONDAY_11_UTC + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('fires once per day however often the cron runs', () => {
    const sent = record({ lastSentAt: MONDAY_11_UTC });
    expect(isDue(sent, MONDAY_11_UTC + 5 * 60 * 1000)).toBe(false);
  });

  it('fires again the following training day', () => {
    const wednesday = MONDAY_11_UTC + 2 * 24 * 60 * 60 * 1000;
    expect(isDue(record({ lastSentAt: MONDAY_11_UTC }), wednesday)).toBe(true);
  });

  it('handles a schedule that crosses the date line in UTC', () => {
    // 06:00 local in WIB is 23:00 UTC the previous day. Reading the weekday
    // from the UTC instant instead of the shifted one would fire on Sunday.
    const mondayEarly = Date.UTC(2026, 7, 2, 23, 0, 0);
    expect(isDue(record({ timeOfDay: '06:00' }), mondayEarly)).toBe(true);
  });

  it('rejects a malformed time rather than firing at midnight', () => {
    expect(isDue(record({ timeOfDay: 'sore' }), MONDAY_11_UTC)).toBe(false);
  });
});

describe('VAPID signing', () => {
  const original = { ...process.env };

  beforeEach(() => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const priv = privateKey.export({ format: 'jwk' }) as { d: string };

    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(pub.x, 'base64url'),
      Buffer.from(pub.y, 'base64url'),
    ]);

    process.env.VAPID_PUBLIC_KEY = point.toString('base64url');
    process.env.VAPID_PRIVATE_KEY = priv.d;
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('reports itself unconfigured when the keys are absent', () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect(vapidConfig()).toBeNull();
  });

  it('produces a token a push service would accept', async () => {
    const config = vapidConfig()!;
    let captured: { url: string; headers: Headers } | null = null;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: new Headers(init.headers) };
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    try {
      expect(await sendPush('https://fcm.googleapis.com/fcm/send/abc', config)).toBe('sent');
    } finally {
      globalThis.fetch = realFetch;
    }

    const auth = captured!.headers.get('authorization')!;
    expect(auth).toMatch(/^vapid t=.+, k=.+$/);

    const token = auth.slice('vapid t='.length, auth.indexOf(', k='));
    const [header, payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // The audience must be the push service's origin, not ours — a token
    // scoped to the wrong audience is rejected with a 401 and no reminder.
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:test@example.com');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The signature must verify against the advertised public key, in the raw
    // r‖s form JWS requires. Node's default DER encoding would look fine here
    // and be rejected by every push service.
    const point = Buffer.from(process.env.VAPID_PUBLIC_KEY!, 'base64url');
    const key = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
    });

    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(
      verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('reports a dropped subscription separately from a failure', async () => {
    const config = vapidConfig()!;
    const realFetch = globalThis.fetch;

    try {
      // 410 means the browser threw the subscription away. Retrying it every
      // quarter hour forever is how a free tier gets burned by users who
      // uninstalled months ago.
      globalThis.fetch = (async () => new Response(null, { status: 410 })) as typeof fetch;
      expect(await sendPush('https://fcm.googleapis.com/fcm/send/abc', config)).toBe('expired');

      globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
      expect(await sendPush('https://fcm.googleapis.com/fcm/send/abc', config)).toBe('failed');

      globalThis.fetch = (async () => {
        throw new Error('network down');
      }) as typeof fetch;
      expect(await sendPush('https://fcm.googleapis.com/fcm/send/abc', config)).toBe('failed');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
