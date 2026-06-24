// Project Board — service worker
// Strategy:
//   * HTML / navigations + app JS/CSS -> network-first  (always get the latest app, fall back to cache offline)
//   * other same-origin (icons/image) -> stale-while-revalidate (fast, refreshes in the background)
//   * Supabase + CDN                   -> never intercepted (straight to network)
//
// JS/CSS are network-first so a code change shows up on the next load without a
// cache-version bump — matching how the all-in-one index.html used to behave.
// Bump CACHE whenever the asset list changes so old caches are cleared.

const CACHE = 'pb-v57';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './state.js',
  './core.js',
  './problems.js',
  './admin.js',
  './account.js',
  './authoring.js',
  './circuits.js',
  './leaderboard.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './ProjectBoard.png',
  './hold_map.json',
  './hold_shapes.json',
  './mirror_map.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())   // activate the new worker immediately
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())  // take control of open pages right away
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Supabase + CDN go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first for the page itself, so a new deploy shows up on next load.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          return resp;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Network-first for the app's own JS/CSS too, so code/style changes appear on
  // the next load (no cache-version bump needed). Falls back to cache offline.
  // Match by file extension AS WELL AS req.destination: iOS/WebKit often leaves
  // request.destination empty (''), which previously dropped app.js/styles.css
  // into the stale-while-revalidate branch below and served phones a stale build
  // (laptop/Chrome was fine because it sets destination correctly).
  if (req.destination === 'script' || req.destination === 'style' || /\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(resp => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Stale-while-revalidate for everything else (icons, image, manifest).
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(resp => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
