// Project Board — service worker
// Strategy:
//   * HTML / navigations + app JS/CSS/JSON -> network-first  (always get the latest app, fall back to cache offline)
//   * other same-origin (icons/image) -> stale-while-revalidate (fast, refreshes in the background)
//   * Supabase + Cloudflare analytics  -> never intercepted (straight to network)
//     (supabase-js itself is vendored same-origin, so it's precached like app code)
//
// JS/CSS/JSON are network-first so a code OR bundled-data change (hold_map,
// hold_shapes, mirror_map) shows up on the next load without a cache-version bump
// — matching how the all-in-one index.html used to behave. Data files used to fall
// into stale-while-revalidate below, so a data-only deploy served every installed
// client the previous file for a whole load.
// Bump CACHE whenever the asset list changes so old caches are cleared.

const CACHE = 'pb-v78';
// The app shell is precached as './' only (Cloudflare 307s /index.html -> /; the
// navigate branch below keeps the shell under './'). precache() makes any other
// redirected entry, such as privacy.html, safe to serve offline.
const ASSETS = [
  './',
  './privacy.html',
  './styles.css',
  './supabase-js-2.116.0.js',
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
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './ProjectBoard.png',
  './hold_map.json',
  './hold_shapes.json',
  './mirror_map.json'
];

// Like cache.addAll, but never stores a redirect. Cloudflare 307s every *.html URL
// to its extensionless form (privacy.html -> /privacy), and a response marked
// `redirected` can't answer a navigation, so an offline open of privacy.html would
// fail. A redirected response is re-wrapped as a plain copy of its final body.
async function precache(cache) {
  await Promise.all(ASSETS.map(async path => {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`precache ${path}: HTTP ${resp.status}`);
    const clean = resp.redirected
      ? new Response(await resp.blob(), { status: resp.status, statusText: resp.statusText, headers: resp.headers })
      : resp;
    await cache.put(path, clean);
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(precache)
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

  // Only handle same-origin GETs. Supabase + Cloudflare analytics go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network-first, so a new deploy shows up on the next load.
  // Only a navigation to the app shell itself (the scope root or index.html, with
  // any query such as ?src=qr or OAuth params) refreshes the cached shell at './'.
  // Every other page (privacy.html) is cached under its OWN URL
  // and falls back to its own copy — so opening one can never overwrite the shell
  // and make an offline launch show the wrong page.
  if (req.mode === 'navigate' || req.destination === 'document') {
    const scopePath = new URL(self.registration.scope).pathname;   // '/' on symmetryboard.co.uk
    const isShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
    event.respondWith(
      fetch(req)
        .then(resp => {
          // Only a plain same-origin 200 is safe to replay for a navigation later —
          // not an error page, and not a redirect (a navigation's fetch returns an
          // 'opaqueredirect' for Cloudflare's /index.html -> / hop).
          if (resp.ok && resp.type === 'basic' && !resp.redirected) {
            const copy = resp.clone();
            caches.open(CACHE).then(cache => cache.put(isShell ? './' : req, copy));
          }
          return resp;
        })
        .catch(async () => {
          if (isShell) return (await caches.match('./')) || Response.error();
          // Cloudflare serves /privacy from privacy.html, so an extensionless page
          // falls back to its precached .html copy if it was never visited online.
          const cached = (await caches.match(req, { ignoreSearch: true })) ||
            (!/\.[a-z0-9]+$/i.test(url.pathname) && (await caches.match(url.pathname + '.html')));
          return cached || Response.error();
        })
    );
    return;
  }

  // Network-first for the app's own JS/CSS and its bundled JSON data too, so code,
  // style and hold-map/shape changes appear on the next load (no cache-version bump
  // needed). Falls back to cache offline.
  // Match by file extension AS WELL AS req.destination: iOS/WebKit often leaves
  // request.destination empty (''), which previously dropped app.js/styles.css
  // into the stale-while-revalidate branch below and served phones a stale build
  // (laptop/Chrome was fine because it sets destination correctly).
  if (req.destination === 'script' || req.destination === 'style' || /\.(js|css|json)$/.test(url.pathname)) {
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
