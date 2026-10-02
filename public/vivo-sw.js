const CACHE_NAME = 'vivo-ops-app-v2';
const IS_ADMIN_WORKER = self.VIVO_PUSH_WORKSPACE === 'admin';
const DEFAULT_PUSH_URL = IS_ADMIN_WORKER ? '/app/admin/operaciones' : '/app/master/dashboard';
const PRECACHE_URLS = [
  '/pwa/advisor-180.png',
  '/pwa/advisor-192.png',
  '/pwa/advisor-512.png',
  '/pwa/advisor-512-maskable.png',
  '/pwa/kitchen-180.png',
  '/pwa/kitchen-192.png',
  '/pwa/kitchen-512.png',
  '/pwa/kitchen-512-maskable.png',
  '/pwa/admin-180.png',
  '/pwa/admin-192.png',
  '/pwa/admin-512.png',
  '/pwa/admin-512-maskable.png',
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
      Promise.all(keys.filter((key) => key.startsWith('vivo-ops-app-') && key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isStaticAsset =
    isSameOrigin &&
    (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/pwa/'));

  if (!isStaticAsset) return;

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
  const targetUrl = notificationTarget(payload.url);
  const isKitchenPush = String(targetUrl).startsWith('/app/kitchen');
  const icon = IS_ADMIN_WORKER || String(targetUrl).startsWith('/app/admin')
    ? '/pwa/admin-192.png' : isKitchenPush ? '/pwa/kitchen-192.png' : '/pwa/advisor-192.png';
  const vibration = isKitchenPush
    ? payload.tone === 'critical'
      ? [260, 90, 260, 90, 460]
      : payload.tone === 'warning'
        ? [210, 80, 210]
        : [140, 70, 140]
    : payload.tone === 'critical'
      ? [120, 60, 120]
      : [80];
  const options = {
    body: payload.body || 'Tienes una actualizacion nueva.',
    icon,
    badge: icon,
    renotify: true,
    silent: false,
    requireInteraction: Boolean(payload.requireInteraction),
    vibrate: vibration,
    data: {
      url: targetUrl,
    },
    tag: payload.tag || 'vivo-notification',
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          if (!matchesWorkspace(client)) return;
          client.postMessage({
            type: 'vivo-push',
            payload,
          });
        });
      }),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = notificationTarget(event.notification?.data?.url);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client && matchesWorkspace(client)) {
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

function notificationTarget(value) {
  try {
    const url = new URL(value || DEFAULT_PUSH_URL, self.location.origin);
    if (url.origin !== self.location.origin) return DEFAULT_PUSH_URL;
    if (IS_ADMIN_WORKER && url.pathname !== '/app/admin' && !url.pathname.startsWith('/app/admin/')) return DEFAULT_PUSH_URL;
    if (!url.pathname.startsWith('/app/')) return DEFAULT_PUSH_URL;
    return url.pathname + url.search + url.hash;
  } catch { return DEFAULT_PUSH_URL; }
}

function matchesWorkspace(client) {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && (IS_ADMIN_WORKER
      ? url.pathname === '/app/admin' || url.pathname.startsWith('/app/admin/')
      : url.pathname.startsWith('/app/'));
  } catch { return false; }
}
