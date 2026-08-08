/**
 * Cron target: fire the reminders that are due.
 *
 * Meant to run every fifteen minutes, triggered from outside Vercel: the Hobby
 * plan caps `crons` in `vercel.json` at once per day, and a single daily firing
 * cannot serve reminders set to different times by different people. See the
 * deploy section of the README for the scheduler and the header it must send.
 *
 * Each run reads every
 * subscription, keeps the ones whose local time has just passed their reminder,
 * and sends a payload-less push. `isDue` accepts a slot up to twenty minutes
 * old so a run landing slightly out of step with the clock does not skip a
 * reminder entirely.
 *
 * Subscriptions the push service reports as gone are deleted here. Nothing else
 * prunes them, and retrying a dead endpoint every quarter hour forever is how a
 * free tier gets exhausted by users who uninstalled months ago.
 */

import { json } from './_llm.ts';
import { isDue, sendPush, subscriptionStore, vapidConfig } from './_push.ts';

export const config = { runtime: 'nodejs' };

/**
 * Vercel signs cron invocations with this header. Without the check the
 * endpoint is a public button anyone can press to spend the push quota.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // Unset in local development.
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export default async function handler(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: 'Tidak diizinkan.' }, 401);

  const vapid = vapidConfig();
  if (!vapid) return json({ error: 'VAPID belum dikonfigurasi.' }, 503);

  const store = subscriptionStore();
  const now = Date.now();

  let due = 0;
  let sent = 0;
  let expired = 0;
  let failed = 0;

  const records = await store.all();

  for (const record of records) {
    if (!isDue(record, now)) continue;
    due += 1;

    const result = await sendPush(record.endpoint, vapid);
    if (result === 'sent') {
      sent += 1;
      await store.put({ ...record, lastSentAt: now });
    } else if (result === 'expired') {
      expired += 1;
      await store.remove(record.id);
    } else {
      failed += 1;
      // Left in place: a transient failure should not cost the user their
      // reminder, and a genuinely dead endpoint reports 404/410 soon enough.
    }
  }

  return json({ checked: records.length, due, sent, expired, failed, storage: store.kind });
}
