// Project Board — service worker
//
// One version per page load (review fix session 4, 14 Nov 2026; BLD-01, BLD-11).
// The deployed pages load every script and stylesheet as name?v=<CACHE> (build.sh
// stamps the URLs in public/index.html and public/privacy.html with the same value it
// stamps into CACHE below), and the app fetches its bundled data the same way
// (assetUrl() in state.js). So a page and its files pin each other:
//   * HTML / navigations -> network-first with a deadline (NAV_TIMEOUT): if the
//     network hasn't answered and the cache has the page, the cache answers
//     (connected-but-dead gym Wi-Fi used to hang the launch). A page from the network
//     is cached only when it is this worker's version, so the cache never holds a
//     shell whose files it doesn't have.
//   * a versioned file (x.js?v=pb-…) -> the cache first: that exact URL is one
//     version's file, in whichever cache holds it (this version's, or an older one
//     kept for a page still running it). Otherwise the network; the copy is kept only
//     if it is this worker's version. A new shell can never be answered with an old
//     cached script, because the ?v differs. If the network can't give a newer
//     shell's script either, the page is sent back to the cached shell (one whole
//     version) instead of running half of one (rescue()).
//   * an unversioned app file (local preview, manifest.json) -> network-first with a
//     deadline (ASSET_TIMEOUT), then the cache; the deployed worker never stores one
//     at runtime (it can't know which version it is).
//   * other same-origin (icons, images) -> stale-while-revalidate.
//   * Supabase + Cloudflare analytics -> never intercepted (straight to network).
//     (supabase-js itself is vendored same-origin, so it's precached like app code.)
//
// CACHE is stamped by build.sh: 'pb-local' here (local preview: the pages are
// unstamped and everything is keyed by its plain URL), and in the deployed sw.js a
// hash of the shipped files, so it changes on every deploy that changes app code or
// data and on no other. Never edit it by hand.
//
// A deploy's new worker takes over open pages at once (skipWaiting + claim), but it
// keeps an older version's cache while a page running that version is still open
// (a page that held its reload back for unsaved work, a circuit run, the wall in
// use), so that page keeps reading its own version's files. It goes once those
// pages are gone (pruneOld()). The cache's name is the version (the ?v= stamp).

const CACHE = 'pb-local';
const LOCAL = CACHE === 'pb-local';
const META = 'pb-meta';            // a small cache holding which old caches are kept, and for whom
const META_KEY = './__pb-meta';

// The app shell is precached as './' only (Cloudflare 307s /index.html -> /; the
// navigate branch below keeps the shell under './'). precache() makes any other
// redirected entry, such as privacy.html, safe to serve offline.
const ASSETS = [
  './',
  './privacy.html',
  './tokens.css',
  './styles.css',
  './supabase-js-2.116.0.js',
  './state.js',
  './core.js',
  './problems.js',
  './admin.js',
  './account.js',
  './authoring.js',
  './circuits.js',
  './challenge.js',
  './leaderboard.js',
  './wall.js',
  './trace.js',
  './setup.js',
  './holdedit.js',
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

const NAV_TIMEOUT = 5000;      // ms the network gets to answer a page before the cache does
const ASSET_TIMEOUT = 3000;    // …an unversioned app file
const VERSION_TIMEOUT = 8000;  // …a versioned file no cache holds (a newer page's), before rescue()

// The files the deployed pages ask for as name?v=<version>: scripts, stylesheets, the
// bundled data and the fallback board photo. manifest.json keeps its plain URL.
const isVersioned = path => /\.(js|css|json|jpg)$/.test(path) && !/manifest\.json$/.test(path);
const keyOf = path => (!LOCAL && isVersioned(path)) ? `${path}?v=${CACHE}` : path;

// The version a page's HTML names in its script and stylesheet URLs (null: none,
// as in local preview or a page with no stamped files).
const pageVersion = html => { const m = /\?v=(pb-[\w-]+)/.exec(html); return m ? m[1] : null; };

const ownMatch = (req, opts) => caches.open(CACHE).then(c => c.match(req, opts));

// Tell the page when it was served from the cache instead of the network (offline,
// a failed fetch or a timeout), so it knows it may be running old code: app.js then
// takes the reload an update brings instead of skipping it.
function noteCacheFallback(event) {
  const id = event.resultingClientId || event.clientId;
  if (!id) return;
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

// Keep a page from the network only if it is this worker's version (or names none).
async function storePage(key, copy) {
  const v = pageVersion(await copy.clone().text());
  if (v && v !== CACHE) return;   // a newer deploy's page: its own worker will precache it
  const cache = await caches.open(CACHE);
  await cache.put(key, copy);
}

// After a rescue, the next loads (for a minute) take the cached shell straight away,
// so the reload is one whole version and can't be rescued again in a loop.
let shellFromCacheUntil = 0;

// A newer page (from the network) whose files neither the cache nor the network can
// give: reload it onto the cached shell, which is this worker's version and whose
// files are all in its cache, rather than leave it half-loaded.
async function rescue(event) {
  if (Date.now() < shellFromCacheUntil || !event.clientId) return;
  if (!(await ownMatch('./'))) return;
  shellFromCacheUntil = Date.now() + 60000;
  const client = await self.clients.get(event.clientId);
  if (client && 'navigate' in client) client.navigate(client.url).catch(() => {});
}

async function versioned(event, v) {
  const req = event.request;
  const cached = await caches.match(req);   // every cache: this exact URL is one version's file
  if (cached) return cached;
  const network = fetch(req).then(resp => {
    if (resp.ok && v === CACHE) {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return resp;
  });
  try {
    return await Promise.race([network, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), VERSION_TIMEOUT))]);
  } catch (err) {
    // Data (JSON, the photo) isn't code: any version's copy is a fair fallback.
    if (!/\.(js|css)$/.test(new URL(req.url).pathname)) {
      const any = (await ownMatch(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
      if (any) return any;
    } else if (v !== CACHE) {
      event.waitUntil(rescue(event));
    }
    return Response.error();
  }
}

// Like cache.addAll, but never stores a redirect, keys the versioned files by their
// ?v= URL, and refuses a page that isn't this version. Cloudflare 307s every *.html
// URL to its extensionless form (privacy.html -> /privacy), and a response marked
// `redirected` can't answer a navigation, so an offline open of privacy.html would
// fail. A redirected response is re-wrapped as a plain copy of its final body.
async function precache(cache) {
  await Promise.all(ASSETS.map(async path => {
    const key = keyOf(path);
    const resp = await fetch(key, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`precache ${key}: HTTP ${resp.status}`);
    if (path === './' || /\.html$/.test(path)) {
      const v = pageVersion(await resp.clone().text());
      // A deploy landed mid-install: this precache would be two versions. Fail the
      // install; the browser tries again with the newer sw.js.
      if (v && v !== CACHE) throw new Error(`precache ${path}: the page is ${v}, this worker is ${CACHE}`);
    }
    const clean = resp.redirected
      ? new Response(await resp.blob(), { status: resp.status, statusText: resp.statusText, headers: resp.headers })
      : resp;
    await cache.put(key, clean);
  }));
}

// Which old caches are kept, and for which pages (client ids).
async function readMeta() {
  try {
    const r = await (await caches.open(META)).match(META_KEY);
    return r ? await r.json() : null;
  } catch (err) { return null; }
}
async function writeMeta(meta) {
  const cache = await caches.open(META);
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

// Drop the kept caches once none of the pages they were kept for is open. Only the
// caches recorded at activation are ever deleted here: a cache a newer worker is
// installing into right now is never touched.
async function pruneOld() {
  const meta = await readMeta();
  if (!meta) return;
  const open = await Promise.all((meta.clients || []).map(id => self.clients.get(id)));
  if (open.some(Boolean)) return;
  await Promise.all((meta.caches || []).map(k => caches.delete(k)));
  await caches.delete(META);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(precache)
      .then(() => self.skipWaiting())   // activate the new worker immediately
  );
});

// Ask an open page which version it's running (app.js answers with its ?v= stamp,
// or 'pb-local'). null: no answer (a page from before this worker logic, or busy).
function askVersion(client) {
  return new Promise(resolve => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = e => { clearTimeout(timer); resolve((e.data && e.data.version) || null); };
    try { client.postMessage({ type: 'pb-version' }, [ch.port2]); }
    catch (err) { clearTimeout(timer); resolve(null); }
  });
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Pages still running an older version keep that version's cache until they're
    // gone (a page that doesn't answer keeps every old cache). Every other cache (no
    // page left on it, a failed install's) goes now.
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const versions = await Promise.all(pages.map(askVersion));
    const old = (await caches.keys()).filter(k => k !== CACHE && k !== META);
    await self.clients.claim();         // take control of open pages right away
    const behind = pages.filter((p, i) => versions[i] !== CACHE);
    const keep = versions.includes(null) ? old : old.filter(k => versions.includes(k));
    await Promise.all(old.filter(k => !keep.includes(k)).map(k => caches.delete(k)));
    if (behind.length && keep.length) await writeMeta({ caches: keep, clients: behind.map(c => c.id) });
    else await caches.delete(META);
  })());
});

// app.js says 'pb-loaded' once a page has loaded: a held-back page that has now
// reloaded is gone, so its old cache may be too.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'pb-loaded') event.waitUntil(pruneOld());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Supabase + Cloudflare analytics go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network-first, so a new deploy shows up on the next load.
  // Only a navigation to the app shell itself (the scope root or index.html, with
  // any query such as ?wall or ?src=qr) refreshes the cached shell at './'.
  // Every other page (privacy.html) is cached under its OWN URL
  // and falls back to its own copy — so opening one can never overwrite the shell
  // and make an offline launch show the wrong page.
  if (req.mode === 'navigate' || req.destination === 'document') {
    const scopePath = new URL(self.registration.scope).pathname;   // '/' on symmetryboard.co.uk
    const isShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
    event.waitUntil(pruneOld());
    if (isShell && Date.now() < shellFromCacheUntil) {
      event.respondWith(ownMatch('./').then(cached => {
        if (!cached) return fetch(req);
        noteCacheFallback(event);
        return cached;
      }));
      return;
    }
    event.respondWith(networkFirst(event, NAV_TIMEOUT,
      resp => {
        // Only a plain same-origin 200 is safe to replay for a navigation later —
        // not an error page, and not a redirect (a navigation's fetch returns an
        // 'opaqueredirect' for Cloudflare's /index.html -> / hop).
        if (resp.ok && resp.type === 'basic' && !resp.redirected) {
          storePage(isShell ? './' : req, resp.clone()).catch(() => {});
        }
      },
      async () => {
        if (isShell) return ownMatch('./');
        // Cloudflare serves /privacy from privacy.html, so an extensionless page
        // falls back to its precached .html copy if it was never visited online.
        return (await ownMatch(req, { ignoreSearch: true })) ||
          (!/\.[a-z0-9]+$/i.test(url.pathname) && (await ownMatch('.' + url.pathname + '.html'))) || null;
      }));
    return;
  }

  // A versioned file: that version's copy, from whichever cache holds it.
  if (url.searchParams.has('v') && isVersioned(url.pathname)) {
    event.respondWith(versioned(event, url.searchParams.get('v')));
    return;
  }

  // An unversioned app file (local preview, manifest.json). Match by file extension
  // AS WELL AS req.destination: iOS/WebKit often leaves request.destination empty
  // (''), which once dropped app.js/styles.css into stale-while-revalidate below.
  if (req.destination === 'script' || req.destination === 'style' || /\.(js|css|json)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event, ASSET_TIMEOUT,
      resp => {
        if (LOCAL && resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
      },
      async () => (await caches.match(req)) || (await ownMatch(keyOf('.' + url.pathname)))));
    return;
  }

  // Stale-while-revalidate for everything else (icons, images).
  event.respondWith(
    ownMatch(req).then(own => own || caches.match(req)).then(cached => {
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
