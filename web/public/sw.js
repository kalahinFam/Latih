/**
 * Service worker: makes LATIH installable and usable with the network off.
 *
 * Offline is not a nice-to-have here. The fast loop — pose estimation, rep
 * counting, corrective cues — is the part of the product that must never stall,
 * and it runs entirely on device. Venue wifi failing during the demo should
 * cost the between-set narration and nothing else.
 *
 * ## Why nothing large is precached
 *
 * The model weights and WASM runtime are ~17 MB. Precaching them on install
 * would block the first launch behind a download the user did not ask for, on
 * a phone that may be on mobile data. They are cached on first use instead: the
 * first session needs the network, every session after it does not.
 */

const VERSION = 'v4';
const SHELL_CACHE = `latih-shell-${VERSION}`;
const ASSET_CACHE = `latih-assets-${VERSION}`;

/** Enough to boot the UI; hashed bundles are picked up at runtime. */
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

/** Big, content-addressed, and never mutated in place — safe to serve from cache first. */
const CACHE_FIRST_PREFIXES = ['/models/', '/mediapipe/', '/assets/', '/icons/', '/cues/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one 404 during development does not abort the whole
      // install and leave the app with no worker at all.
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

function isCacheFirst(url) {
  return CACHE_FIRST_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** Serve from cache when present; otherwise fetch and store for next time. */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Only store real successes. Caching an error or an opaque cross-origin
  // response would pin a broken asset until the cache version is bumped.
  if (response.ok && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

/** Prefer fresh HTML, fall back to the cached shell when offline. */
async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      // Cache under the requested URL, not a fixed path: the build has more
      // than one HTML entry, and pinning to index.html would serve the wrong
      // page for any of the others when offline.
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match(request)) ??
      (await cache.match('/index.html')) ??
      (await cache.match('/'));
    if (cached) return cached;
    throw new Error('Offline and no cached shell available');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything but same-origin GETs. The coaching endpoint is a POST
  // to the API and must always go to the network — a cached coaching response
  // would be worse than none.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  if (isCacheFirst(url)) {
    event.respondWith(cacheFirst(request));
  }
});

/* ---------------------------------------------------------------------------
 * Workout reminders.
 *
 * The push carries no payload. The server sends a bare wake-up, and the text
 * below is composed here, on the device — so the push service relays a
 * notification whose content it never sees. That keeps the reminder consistent
 * with the rest of the product: the schedule is the user's, and it stays on
 * their phone.
 * ------------------------------------------------------------------------ */

const REMINDER_TAG = 'latih-reminder';

self.addEventListener('push', (event) => {
  // `userVisibleOnly: true` was promised at subscribe time: every push must
  // produce a visible notification or the browser revokes the permission.
  event.waitUntil(
    self.registration.showNotification('Waktunya latihan', {
      body: 'Set hari ini sudah menunggu. Buka LATIH dan mulai.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Same tag every time, so a missed reminder is replaced rather than
      // stacked into a pile of identical notifications.
      tag: REMINDER_TAG,
      renotify: true,
      data: { url: '/#/beranda' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus an open tab rather than opening a second one.
      for (const client of clients) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
