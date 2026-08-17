// AWES Service Report — Service Worker
//
// IMPORTANT: bump CACHE_VERSION every time you deploy a new version of the
// app. That's the only thing that makes the phone realize a new version
// exists — otherwise it will happily keep serving the old cached copy
// forever, which is exactly the "changes don't show on mobile" issue this
// was built to fix. A simple date/counter string is fine, e.g. 'v4',
// 'v2026-08-18', etc.
const CACHE_VERSION = 'awes-sr-v1';

// Core files needed for the app to load offline. Keep this list to files
// that actually live next to this service worker on the server.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => { /* offline shell caching is best-effort */ })
  );
  // Take over immediately once told to (see the SKIP_WAITING message
  // handler below) instead of waiting for every open tab to close. This is
  // what lets the in-app "Update available" prompt apply an update right
  // away rather than requiring the user to fully quit and reopen the app.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Lets the page force this waiting worker to activate immediately (used by
// the "Update available — tap to refresh" prompt in index.html).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Strategy:
//  - HTML documents: network-first, falling back to cache when offline.
//    This is the key fix — it means the app always tries to fetch the
//    latest version when the device has a connection, instead of serving
//    a stale cached shell indefinitely.
//  - Everything else (CDN libraries, icons, manifest): cache-first, since
//    those rarely change and cache-first keeps the app fast and usable
//    offline in the field.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
