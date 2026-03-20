const CACHE_NAME = 'nexus-pwa-v1';
const SHELL_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/manifest.json',
  '/app/test/',
  '/app/test/index.html',
  '/app/analytics.html',
  '/app/settings.html'
];

const OFFLINE_PAGE = '/app/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll([...SHELL_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match(OFFLINE_PAGE)))
  );
});
