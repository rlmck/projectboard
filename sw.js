// Project Board — TOMBSTONE service worker for the old address (rlmck.github.io/projectboard).
//
// Same filename and scope as the old app's worker, so every existing install picks
// it up automatically: the old app registered sw.js with updateViaCache:'none' and
// calls reg.update() on launch and on focus, and the browser also checks on every
// navigation. Once it activates:
//   * the old app's caches (pb-v*) are deleted, so no old app code can load again;
//   * it claims open pages, so the old app's controllerchange handler reloads them
//     onto the "moved" page (deferred while a create form has unsaved work);
//   * navigations are network-first with the cached "moved" page as the fallback,
//     so even an offline launch of the old icon shows the moved screen.
// Only pb-v* caches are deleted: CacheStorage is shared by everything on the
// rlmck.github.io origin, and other projects there must be left alone.

const CACHE = 'pb-moved-v1';   // deliberately not 'pb-v…', so activate never deletes it
const MOVED = './';            // index.html — the "moved" page

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.add(new Request(MOVED, { cache: 'reload' })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pb-v')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;   // everything else goes straight to the network
  event.respondWith(
    fetch(event.request).catch(() => caches.match(MOVED))
  );
});
