/**
 * Workout reminders: the browser side of Web Push.
 *
 * ## What this can and cannot promise
 *
 * A reminder that only fires while the app is open is not a reminder, so this
 * uses real Web Push: the server wakes the service worker at the scheduled
 * time whether or not the app is running. That capability is genuinely uneven
 * across platforms, and the UI reflects it rather than papering over it —
 * `reminderSupport()` reports exactly why it is unavailable when it is.
 *
 * The largest gap is iOS: Safari delivers push only to a PWA that has been
 * added to the Home Screen, never to a normal tab. Telling the user that is
 * more useful than a toggle that silently does nothing.
 */

import { trainingWeekdays, type PlanPreferences } from '../core/plan.ts';

const SUBSCRIPTION_ID_KEY = 'latih.reminder.id.v1';

export type ReminderSupport =
  | { supported: true }
  | { supported: false; reason: string };

/** Why reminders are unavailable, in terms the user can act on. */
export function reminderSupport(): ReminderSupport {
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'Browser ini tidak mendukung service worker.' };
  }
  if (!('PushManager' in window)) {
    return { supported: false, reason: 'Browser ini tidak mendukung notifikasi push.' };
  }
  if (!('Notification' in window)) {
    return { supported: false, reason: 'Browser ini tidak mendukung notifikasi.' };
  }

  // iOS grants push only to an installed PWA. `standalone` is the signal that
  // it was launched from the Home Screen.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;

  if (isIos && !isStandalone) {
    return {
      supported: false,
      reason: 'Di iPhone, pengingat hanya bisa aktif setelah aplikasi ditambahkan ke Layar Utama.',
    };
  }

  return { supported: true };
}

export interface ServerConfig {
  configured: boolean;
  publicKey: string | null;
  storage: 'upstash' | 'memory';
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  const response = await fetch('/api/push');
  if (!response.ok) throw new Error('Konfigurasi pengingat tidak bisa dibaca.');
  return (await response.json()) as ServerConfig;
}

/**
 * VAPID keys travel as base64url; `PushManager` wants raw bytes.
 *
 * Backed by an explicit `ArrayBuffer` rather than `Uint8Array.from`, whose
 * looser `ArrayBufferLike` result the DOM's `BufferSource` will not accept.
 */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class ReminderError extends Error {}

/**
 * Turn reminders on.
 *
 * Must be called from a user gesture — browsers refuse a permission prompt that
 * was not asked for.
 */
export async function enableReminders(preferences: PlanPreferences): Promise<void> {
  const support = reminderSupport();
  if (!support.supported) throw new ReminderError(support.reason);

  const config = await fetchServerConfig();
  if (!config.configured || !config.publicKey) {
    throw new ReminderError('Pengingat belum dikonfigurasi di server.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new ReminderError(
      permission === 'denied'
        ? 'Notifikasi diblokir. Aktifkan lewat pengaturan situs di browser.'
        : 'Izin notifikasi belum diberikan.',
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Required by Chrome: every push must show something to the user.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(config.publicKey),
    }));

  // Reuse the stored id so re-subscribing updates one row rather than adding
  // a new one on every visit.
  const existingId = localStorage.getItem(SUBSCRIPTION_ID_KEY);

  const response = await fetch('/api/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: existingId ?? undefined,
      endpoint: subscription.endpoint,
      timeOfDay: preferences.timeOfDay,
      weekdays: trainingWeekdays(preferences.daysPerWeek),
      // Negated: getTimezoneOffset() counts minutes to *subtract* from local
      // time to reach UTC, which is the opposite sign of what the server adds.
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ReminderError(detail?.error ?? 'Pengingat gagal didaftarkan.');
  }

  const { id } = (await response.json()) as { id: string };
  localStorage.setItem(SUBSCRIPTION_ID_KEY, id);
}

export async function disableReminders(): Promise<void> {
  const id = localStorage.getItem(SUBSCRIPTION_ID_KEY);

  if (id) {
    // Server first: an unsubscribed browser endpoint that the server still
    // holds would be pushed to until the service reports it gone.
    await fetch('/api/push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
    localStorage.removeItem(SUBSCRIPTION_ID_KEY);
  }

  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
}

export async function remindersActive(): Promise<boolean> {
  if (!reminderSupport().supported) return false;
  if (Notification.permission !== 'granted') return false;
  if (!localStorage.getItem(SUBSCRIPTION_ID_KEY)) return false;

  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) !== null;
}
