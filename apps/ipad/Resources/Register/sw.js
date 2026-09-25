/*
 * Bar One — service worker.
 *
 * Strategy:
 *   - App shell: current network code first; cached shell on network failure.
 *   - API: network only; connection failures return an offline JSON envelope.
 *   - Bar mutations retain durable action keys for explicit recovery. The
 *     service worker never stores or blindly replays financial requests.
 *
 * Bump CACHE_NAME on deployment to retire obsolete offline shell entries.
 */

// vvvv  BUMP THIS ON EVERY DEPLOY  vvvv
const CACHE_NAME = 'one-club-shell-v39';
// ^^^^  BUMP THIS ON EVERY DEPLOY  ^^^^

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './brand/one-club-logo.png',
  './js/brand.js',
  './js/drink-recipes.js',
  './js/printing.js',
  './js/app.js',
  './js/auth.js',
  './js/dom.js',
  './js/api.js',
  './js/audio.js',
  './js/offline.js',
  './js/router.js',
  './js/ui.js',
  './js/views/actions.js',
  './js/views/register.js',
  './js/views/bar.js',
  './js/views/scan.js',
  './js/views/stock.js',
  './js/views/counts.js',
  './js/views/transfers.js',
  './js/views/shows.js',
  './js/views/buying.js',
  './js/views/orders.js',
  './js/views/customers.js',
  './js/views/marketing.js',
  './js/views/money.js',
  './js/views/team.js',
  './js/views/settings.js',
  './js/views/imports.js',
  './src/routes.mjs',
  './src/format.mjs',
  './src/gates.mjs',
  './src/money.mjs',
  './src/queue.mjs',
  './src/scan.mjs',
  './src/cart.mjs',
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

  // A register must load the current shell on launch. Cached code is only an
  // offline fallback; serving yesterday's UI against today's API breaks setup.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return network;
    }),
  );
});

// Let the page trigger an immediate activation after a version bump.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
