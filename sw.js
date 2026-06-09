// Project Board — service worker
// Strategy:
//   * HTML / navigations  -> network-first  (always get the latest app, fall back to cache offline)
//   * other same-origin   -> stale-while-revalidate (fast, but refreshes in the background)
//   * Supabase + CDN      -> never intercepted (straight to network)
//
// Bump CACHE whenever the asset list changes so old caches are cleared.

const CACHE = 'pb-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './ProjectBoard.png'
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
