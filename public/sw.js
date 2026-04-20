/**
 * VibeCheck 2.0 service worker.
 *
 * Three jobs:
 *   1. Enable PWA installability (app shell + network-first shell cache).
 *   2. Handle push notifications dispatched by the send-push edge function.
 *   3. Route notification clicks back into the relevant room.
 *
 * The payload is INTENTIONALLY content-free — it only carries a generic
 * title + body + a roomId in the click target. Zero-knowledge: the server
 * never learns what the partner wrote; it only triggers a "something
 * happened" ping when it sees a new blob insert.
 */

const SHELL_CACHE = 'vibecheck-shell-v1';
const SHELL_PATHS = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PATHS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

// Network-first for navigation requests so fresh HTML beats a stale shell;
// fall back to the cached shell when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(() =>
      caches.match(req).then((r) => r ?? caches.match('/')),
    ),
  );
});

// --- Push ------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload — fall back to empty + defaults.
  }
  const title = (data && data.title) || '💫 Something new in your room';
  const body = (data && data.body) || 'Open VibeCheck to see.';
  const roomId = data && data.roomId;
  const url = roomId ? `/rooms/${roomId}` : '/rooms';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: roomId ? `room:${roomId}` : 'vibecheck',
      renotify: false,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(
      (windowClients) => {
        for (const client of windowClients) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) client.navigate(target);
            return;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      },
    ),
  );
});
