/**
 * Web Push: VAPID signing, subscription storage, and delivery.
 *
 * ## Why this is hand-rolled rather than a library
 *
 * The usual dependency (`web-push`) exists mostly to encrypt the *payload*,
 * which is genuinely fiddly crypto. This sends payload-less pushes, so none of
 * that applies: what remains is an ES256 JWT, and Node signs those natively
 * with `dsaEncoding: 'ieee-p1363'` — the raw signature format JWT wants, with
 * no DER unpacking. Sixty lines against a dependency, for a project that has
 * two.
 *
 * Payload-less has a second benefit worth stating plainly: the push service —
 * Google's or Mozilla's, depending on the browser — relays a wake-up with no
 * content. The reminder text lives in the service worker and is composed on the
 * device. Nothing about the user's schedule passes through a third party.
 *
 * ## Storage
 *
 * Serverless functions keep no state, so subscriptions live in Upstash Redis,
 * reached over its REST API with plain `fetch`. No SDK. When it is not
 * configured, an in-memory store takes over so local development and the tests
 * still exercise the whole path — it forgets everything when the instance
 * recycles, which is fine for a dev machine and useless in production, and the
 * health endpoint says which one is live.
 */

import { createPrivateKey, createSign, randomUUID } from 'node:crypto';

/** How the client describes a push endpoint, per the Push API. */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  /** Local time of day the user wants reminding, "HH:MM". */
  timeOfDay: string;
  /** Weekdays to fire on, 0 = Monday. */
  weekdays: number[];
  /** Minutes to add to UTC to get the device's local time. */
  utcOffsetMinutes: number;
  createdAt: number;
  /** Epoch ms of the last reminder sent, so one fires at most once per slot. */
  lastSentAt?: number;
}

const KEY_PREFIX = 'latih:push:';
const INDEX_KEY = 'latih:push:index';

/* ------------------------------------------------------------------ storage */

interface Store {
  readonly kind: 'upstash' | 'memory';
  put(record: PushSubscriptionRecord): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<PushSubscriptionRecord[]>;
}

const memory = new Map<string, PushSubscriptionRecord>();

const memoryStore: Store = {
  kind: 'memory',
  async put(record) {
    memory.set(record.id, record);
  },
  async remove(id) {
    memory.delete(id);
  },
  async all() {
    return [...memory.values()];
  },
};

function upstashStore(url: string, token: string): Store {
  async function command(...args: (string | number)[]): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Upstash ${response.status}`);
    return ((await response.json()) as { result: unknown }).result;
  }

  return {
    kind: 'upstash',
    async put(record) {
      await command('SET', KEY_PREFIX + record.id, JSON.stringify(record));
      await command('SADD', INDEX_KEY, record.id);
    },
    async remove(id) {
      await command('DEL', KEY_PREFIX + id);
      await command('SREM', INDEX_KEY, id);
    },
    async all() {
      const ids = (await command('SMEMBERS', INDEX_KEY)) as string[] | null;
      if (!ids || ids.length === 0) return [];

      const raw = (await command('MGET', ...ids.map((id) => KEY_PREFIX + id))) as (string | null)[];
      const records: PushSubscriptionRecord[] = [];
      for (const entry of raw) {
        if (!entry) continue;
        try {
          records.push(JSON.parse(entry) as PushSubscriptionRecord);
        } catch {
          // A single unreadable record must not take the whole reminder run
          // down with it.
        }
      }
      return records;
    },
  };
}

export function subscriptionStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore(url, token) : memoryStore;
}

export function newSubscriptionId(): string {
  return randomUUID();
}

/* --------------------------------------------------------------------- vapid */

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Rebuild a signing key from the two values in the environment.
 *
 * The conventional VAPID format stores the private key as the raw 32-byte
 * scalar and the public key as an uncompressed P-256 point (0x04 ‖ X ‖ Y).
 * Neither is a format Node's crypto reads directly, but both map onto a JWK.
 */
function privateKeyFrom(publicKey: string, privateKey: string) {
  const point = Buffer.from(publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 point.');
  }

  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
      d: privateKey.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''),
    },
  });
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;

  return {
    publicKey,
    privateKey,
    // Push services require a contact. A mailto is the convention.
    subject: process.env.VAPID_SUBJECT ?? 'mailto:latih@example.com',
  };
}

/** Twelve hours. Push services reject anything beyond 24. */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function signVapidToken(endpoint: string, config: VapidConfig): string {
  const audience = new URL(endpoint).origin;
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
        sub: config.subject,
      }),
    ),
  );

  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();

  // 'ieee-p1363' yields the raw r‖s pair JWS wants. The default DER encoding
  // would be silently rejected by every push service.
  const signature = signer.sign({
    key: privateKeyFrom(config.publicKey, config.privateKey),
    dsaEncoding: 'ieee-p1363',
  });

  return `${header}.${payload}.${base64url(signature)}`;
}

export type DeliveryResult = 'sent' | 'expired' | 'failed';

/**
 * Deliver one payload-less push.
 *
 * `expired` is distinct from `failed` on purpose: a 404 or 410 means the
 * browser has thrown the subscription away, and the record should be deleted
 * rather than retried forever.
 */
export async function sendPush(
  endpoint: string,
  config: VapidConfig,
  ttlSeconds = 3 * 60 * 60,
): Promise<DeliveryResult> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${signVapidToken(endpoint, config)}, k=${config.publicKey}`,
        ttl: String(ttlSeconds),
        'content-length': '0',
      },
    });

    if (response.status === 404 || response.status === 410) return 'expired';
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/* ------------------------------------------------------------------ schedule */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this subscription due right now?
 *
 * ## Time zones, without storing one
 *
 * The device sends its UTC offset rather than an IANA zone name. Shifting `now`
 * by that offset gives the user's wall clock, which is what "18:00" means to
 * them. This is deliberately simple and has a known limit: an offset captured
 * before a daylight-saving change is wrong after it. Indonesia observes no DST,
 * so for this product it is exact; elsewhere it can drift by an hour until the
 * client re-subscribes, which it does on every visit.
 *
 * @param windowMinutes How late a reminder may still fire. Sized to the cron
 *   interval — a job running every 15 minutes must accept a slot it lands just
 *   after, or reminders would be missed whenever the two fall out of step.
 */
export function isDue(
  record: PushSubscriptionRecord,
  now: number,
  windowMinutes = 20,
): boolean {
  const local = new Date(now + record.utcOffsetMinutes * 60 * 1000);
  // getUTCDay() on the shifted instant reads the local calendar day.
  const weekday = (local.getUTCDay() + 6) % 7;
  if (!record.weekdays.includes(weekday)) return false;

  const [hours, minutes] = record.timeOfDay.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;

  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes();
  const elapsed = minutesNow - (hours * 60 + minutes);
  if (elapsed < 0 || elapsed > windowMinutes) return false;

  // At most one reminder per day, however often the cron runs.
  return record.lastSentAt === undefined || now - record.lastSentAt > DAY_MS / 2;
}
