const CACHE_NAME = 'nn-app-v1';
const APP_SHELL = [
  "/app/analytics.html",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/icons/icon.svg",
  "/app/index.html",
  "/app/manifest.json",
  "/app/offline.html",
  "/app/settings.html",
  "/app/test/avlt.html",
  "/app/test/dsst.html",
  "/app/test/index.html",
  "/app/test/nback.html",
  "/app/test/pvt.html",
  "/app/test/stroop.html",
  "/app/test/tmtb.html"
];
const OFFLINE_FALLBACK = '/app/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  if (!url.pathname.startsWith('/app/')) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      if (request.mode === 'navigate') {
        return (await caches.match(OFFLINE_FALLBACK)) || new Response('Offline', { status: 503 });
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
