const CACHE_NAME = 'ultra-rotina-cockpit-v3.5';

const ASSETS_PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './rotina_timeline.js',
  '/rotina_timeline.js',
  './estacao_soap.js',
  '/estacao_soap.js',
  './pwa-192x192.png',
  './pwa-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        ASSETS_PRECACHE.map((url) => cache.add(url).catch(() => null))
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function fallbackCockpit(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const shell = (await caches.match('./index.html')) || (await caches.match('./'));
  if (shell) return shell;
  return new Response('Cockpit offline indisponível no momento.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/live' || url.pathname === '/webhook') {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => fallbackCockpit(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached || fallbackCockpit(req));
      return cached || net;
    })
  );
});
