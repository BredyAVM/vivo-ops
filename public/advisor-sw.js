const CACHE_NAME = 'vivo-ops-advisor-v3';
const PRECACHE_URLS = [
  '/app/advisor/manifest.webmanifest',
  '/pwa/advisor-180.png',
  '/pwa/advisor-192.png',
  '/pwa/advisor-512.png',
  '/pwa/advisor-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response && response.ok) {
              await cache.put(url, response.clone());
            }
          } catch {
            // Never block activation because of a failed precache asset.
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAdvisorAsset =
    isSameOrigin &&
    (url.pathname.startsWith('/app/advisor') ||
      url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/pwa/'));

  if (!isAdvisorAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const cloned = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'VIVO OPS';
  const options = {
    body: payload.body || 'Tienes una actualizacion nueva.',
    icon: '/pwa/advisor-192.png',
    badge: '/pwa/advisor-192.png',
    renotify: true,
    requireInteraction: Boolean(payload.requireInteraction),
    vibrate: payload.tone === 'critical' ? [120, 60, 120] : [80],
    data: {
      url: payload.url || '/app/advisor/inbox?filter=all',
    },
    tag: payload.tag || 'advisor-notification',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/app/advisor/inbox?filter=all';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client && client.url.includes('/app/advisor')) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }

      return undefined;
    })
  );
});
