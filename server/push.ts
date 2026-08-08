/**
 * Push subscription management.
 *
 * GET  — the VAPID public key the browser needs to subscribe, plus whether the
 *        server is configured at all. The client asks first so it can hide the
 *        reminder toggle rather than offer a switch that cannot work.
 * POST — register or refresh a subscription.
 * DELETE — unsubscribe.
 */

import { json } from './_llm.ts';
import {
  newSubscriptionId,
  subscriptionStore,
  vapidConfig,
  type PushSubscriptionRecord,
} from './_push.ts';

export const config = { runtime: 'nodejs' };

interface SubscribeBody {
  id?: string;
  endpoint: string;
  timeOfDay: string;
  weekdays: number[];
  utcOffsetMinutes: number;
}

function isValid(value: unknown): value is SubscribeBody {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<SubscribeBody>;

  return (
    typeof b.endpoint === 'string' &&
    // Only real push endpoints. Without this the store becomes an open relay
    // for whatever URL anyone cares to POST.
    /^https:\/\//.test(b.endpoint) &&
    b.endpoint.length < 2000 &&
    typeof b.timeOfDay === 'string' &&
    /^\d{1,2}:\d{2}$/.test(b.timeOfDay) &&
    Array.isArray(b.weekdays) &&
    b.weekdays.length > 0 &&
    b.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    typeof b.utcOffsetMinutes === 'number' &&
    Math.abs(b.utcOffsetMinutes) <= 14 * 60
  );
}

/**
 * Named exports, not default — see the note in `coach.ts`. All three point at
 * the one handler, which already branches on the method.
 */
export { handler as GET, handler as POST, handler as DELETE };

async function handler(request: Request): Promise<Response> {
  const vapid = vapidConfig();

  if (request.method === 'GET') {
    return json({
      configured: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
      // Named so the plan page can warn that reminders will not survive a
      // redeploy when no shared store is attached.
      storage: subscriptionStore().kind,
    });
  }

  if (!vapid) {
    return json(
      { error: 'Pengingat belum dikonfigurasi di server (VAPID_PUBLIC_KEY belum diset).' },
      503,
    );
  }

  const store = subscriptionStore();

  if (request.method === 'DELETE') {
    let id: unknown;
    try {
      ({ id } = (await request.json()) as { id?: unknown });
    } catch {
      return json({ error: 'Body bukan JSON yang sah.' }, 400);
    }
    if (typeof id !== 'string') return json({ error: 'Field "id" wajib diisi.' }, 400);

    await store.remove(id);
    return json({ ok: true });
  }

  if (request.method !== 'POST') return json({ error: 'Gunakan GET, POST, atau DELETE.' }, 405);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  if (!isValid(body)) {
    return json({ error: 'Data langganan pengingat tidak lengkap atau tidak valid.' }, 400);
  }

  const record: PushSubscriptionRecord = {
    // Reusing the client's id makes re-subscribing idempotent: a device that
    // visits daily should refresh one row, not accumulate one per visit.
    id: body.id ?? newSubscriptionId(),
    endpoint: body.endpoint,
    timeOfDay: body.timeOfDay,
    weekdays: [...new Set(body.weekdays)].sort((a, b) => a - b),
    utcOffsetMinutes: body.utcOffsetMinutes,
    createdAt: Date.now(),
  };

  try {
    await store.put(record);
  } catch {
    return json({ error: 'Penyimpanan pengingat sedang tidak bisa dihubungi.' }, 503);
  }

  return json({ ok: true, id: record.id });
}
