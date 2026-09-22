// Project Board — service worker
// Strategy:
//   * HTML / navigations + app JS/CSS/JSON (manifest.json too) -> network-first,
//     with a deadline: if the network hasn't answered in NAV_TIMEOUT / ASSET_TIMEOUT
//     and the cache has a copy, the cache answers (connected-but-dead gym Wi-Fi
//     used to hang the launch for the browser's own TCP timeout)
//   * other same-origin (icons, images) -> stale-while-revalidate (fast, refreshes in the background)
//   * Supabase + Cloudflare analytics  -> never intercepted (straight to network)
//     (supabase-js itself is vendored same-origin, so it's precached like app code)
//
// JS/CSS/JSON are network-first so a code OR bundled-data change (hold_map,
// hold_shapes, mirror_map) shows up on the next load — matching how the all-in-one
// index.html used to behave. Data files used to fall into stale-while-revalidate
// below, so a data-only deploy served every installed client the previous file for
// a whole load.
//
// Once any request of a page has fallen back to the cache, the rest of that page's
// app files come from the cache too (fallbackClients), so one load doesn't mix old
// and new copies of the nine scripts, which share one global scope.
// Bump CACHE on EVERY deploy that changes app code or data (CLAUDE.md): the new
// worker's precache is then one consistent version, and old caches are cleared.

const CACHE = 'pb-v106';
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
  './board-fallback.jpg',
  './hold_map.json',
  './hold_shapes.json',
  './mirror_map.json'
];

const NAV_TIMEOUT = 5000;     // ms the network gets to answer a page before the cache does
const ASSET_TIMEOUT = 3000;   // …and an app file

// Pages (client ids) that have had anything served from the cache on this load.
// Their remaining app files come from the cache too. Ids are per document, so a
// fresh load starts clean; the set is capped so it can't grow without bound.
const fallbackClients = new Set();

// Tell the page when it was served from the cache instead of the network (offline,
// a failed fetch or a timeout), so it knows it may be running old code: app.js then
// takes the reload an update brings instead of skipping it.
function noteCacheFallback(event) {
  const id = event.resultingClientId || event.clientId;
  if (!id) return;
  fallbackClients.add(id);
  if (fallbackClients.size > 50) fallbackClients.delete(fallbackClients.values().next().value);
  self.clients.get(id).then(c => c && c.postMessage({ type: 'pb-served-from-cache' }));
}

// Network-first with a deadline. `store(resp)` caches a good response (it keeps
// running after a timeout, so a late answer still refreshes the cache);
// `fromCache()` finds the fallback copy. After `ms`, the cache answers if it has a
// copy; if it has none, the network gets as long as it needs. A network failure
// goes to the cache straight away, and to an error if that's empty too.
function networkFirst(event, ms, store, fromCache) {
  const network = fetch(event.request).then(resp => { store(resp); return resp; });
  return new Promise(resolve => {
    let done = false;
    const finish = resp => { if (!done) { done = true; clearTimeout(timer); resolve(resp); } };
    const tryCache = async () => {
      const cached = await fromCache();
      if (cached && !done) { noteCacheFallback(event); finish(cached); }
      return !!cached;
    };
    const timer = setTimeout(tryCache, ms);
    network.then(finish, async () => {
      if (!(await tryCache())) finish(Response.error());
    });
  });
}

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
    event.respondWith(networkFirst(event, NAV_TIMEOUT,
      resp => {
        // Only a plain same-origin 200 is safe to replay for a navigation later —
        // not an error page, and not a redirect (a navigation's fetch returns an
        // 'opaqueredirect' for Cloudflare's /index.html -> / hop).
        if (resp.ok && resp.type === 'basic' && !resp.redirected) {
          const copy = resp.clone();
          caches.open(CACHE).then(cache => cache.put(isShell ? './' : req, copy));
        }
      },
      async () => {
        if (isShell) return caches.match('./');
        // Cloudflare serves /privacy from privacy.html, so an extensionless page
        // falls back to its precached .html copy if it was never visited online.
        return (await caches.match(req, { ignoreSearch: true })) ||
          (!/\.[a-z0-9]+$/i.test(url.pathname) && (await caches.match(url.pathname + '.html'))) || null;
      }));
    return;
  }

  // Network-first for the app's own JS/CSS and its bundled JSON data too, so code,
  // style and hold-map/shape changes appear on the next load. Falls back to the
  // cache offline or after ASSET_TIMEOUT.
  // Match by file extension AS WELL AS req.destination: iOS/WebKit often leaves
  // request.destination empty (''), which previously dropped app.js/styles.css
  // into the stale-while-revalidate branch below and served phones a stale build
  // (laptop/Chrome was fine because it sets destination correctly).
  if (req.destination === 'script' || req.destination === 'style' || /\.(js|css|json)$/.test(url.pathname)) {
    // Part of this page already came from the cache: keep the rest of it on the
    // same (cached) version rather than mixing in fresh copies.
    if (fallbackClients.has(event.clientId)) {
      event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
      return;
    }
    event.respondWith(networkFirst(event, ASSET_TIMEOUT,
      resp => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
      },
      () => caches.match(req)));
    return;
  }

  // Stale-while-revalidate for everything else (icons, images).
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
