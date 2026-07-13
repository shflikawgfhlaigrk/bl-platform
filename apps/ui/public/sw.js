/*
 * Mags Commerce OS — service worker.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/manifest/icons): cache-first, so the owner can
 *     open the app on the show floor with no connection.
 *   - API (`/api/*`): network-first, never cached as authoritative business
 *     data. Offline mutations are NOT handled here — they go through the
 *     IndexedDB queue in js/offline.js (which the app replays on reconnect).
 *
 * ⚠️ STALE-SW TRAP — BUMP `CACHE_NAME` ON EVERY DEPLOY. This one constant is
 * the whole cache-busting story: change the version suffix and the old shell
 * is deleted in `activate`. (See memory: hq-dash stale cache-first SW.)
 */

// vvvv  BUMP THIS ON EVERY DEPLOY  vvvv
const CACHE_NAME = 'mags-os-shell-v2';
// ^^^^  BUMP THIS ON EVERY DEPLOY  ^^^^

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/app.js',
  './js/dom.js',
  './js/api.js',
  './js/audio.js',
  './js/offline.js',
  './js/router.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // addAll is all-or-nothing; tolerate a missing optional asset by adding individually.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept mutations

  const url = new URL(req.url);

  // API: network-first, fall back to a JSON "offline" envelope (never stale data).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(
            JSON.stringify({ error: { message: 'offline', code: 'offline' } }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    return;
  }

  // Shell: cache-first, then network; update the cache opportunistically.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Let the page trigger an immediate activation after a version bump.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
