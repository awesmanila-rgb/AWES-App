// Bumped to v16 to force every installed device to drop its old cache and
// re-fetch app.bundle.js / index.html fresh — the batch-sign-multiple-drafts
// feature (new DOM ids + JS) landed without a matching cache-name bump, so
// devices that already had a service worker installed had no forced trigger
// to refresh it.
const CACHE_NAME = 'awes-sr-v16';

// Split into two lists on purpose.
//
// Previously everything below lived in one array passed to cache.addAll(), which
// is atomic: if a SINGLE entry fails, the whole promise rejects and nothing at
// all gets cached. Two entries — icon-192.png and icon-512.png — did not exist
// in the package, so the rejection was guaranteed, and it was swallowed by a
// bare .catch(()=>{}). The result was a service worker that installed
// "successfully" while caching precisely nothing, so the app never actually
// worked offline. It only appeared to, because the runtime fetch handler
// gradually filled the cache while the phone still had signal.
const LOCAL_SHELL = [
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './css/app.css',
  './js/app.bundle.js'
];

const CDN_SHELL = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/signature_pad/5.1.3/signature_pad.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js',
  // Not precached: it's only fetched the first time someone actually taps
  // "Scan Nameplate", and it's multiple MB (JS + WASM + trained data) —
  // precaching it on install would slow first load for everyone to help
  // only the technicians who use that one feature.
];

function isAppShellDoc(url){
  return url.endsWith('index.html') || url.endsWith('manifest.json')
      || url.endsWith('app.bundle.js') || url.endsWith('app.css') || url.endsWith('/');
}

// Caches each entry independently so one bad URL can never wipe out the rest,
// and logs whatever failed instead of hiding it.
async function precache(cache, urls, opts){
  const failed = [];
  await Promise.all(urls.map(async (url)=>{
    try{
      // CDN responses are opaque cross-origin; request them explicitly in
      // no-cors mode so they can still be stored.
      const req = /^https?:\/\//.test(url) ? new Request(url, {mode:'no-cors'}) : url;
      await cache.add(req);
    }catch(e){
      failed.push(url);
    }
  }));
  if(failed.length) console.warn('[sw] could not precache', opts && opts.label, failed);
  return failed;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE_NAME);
    // The local files are what make the app usable offline, so treat a failure
    // here as loud. The CDN libraries are best-effort: the fetch handler will
    // pick them up later if they are missing.
    const missing = await precache(cache, LOCAL_SHELL, {label:'local shell'});
    if(missing.length) console.error('[sw] app shell incomplete, offline use may be degraded:', missing);
    await precache(cache, CDN_SHELL, {label:'CDN libraries'});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// SKIP_WAITING message support — lets index.html's "new version available"
// banner apply an update immediately instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Never touch API traffic. Supabase REST/Auth/Storage/Functions calls and the
  // reverse-geocode lookup must always go to the network: caching them would
  // serve stale reports and stale auth responses, and a cached POST-like GET
  // could show one technician another's data.
  if (/\/(rest|auth|storage|functions|realtime)\/v1\//.test(url)
      || url.includes('nominatim.openstreetmap.org')
      || url.includes('api.emailjs.com')) {
    return;
  }

  if (event.request.mode === 'navigate' || isAppShellDoc(url)) {
    // Network-first for the app shell — always show the latest deploy when
    // online, fall back to cache only when offline.
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(()=>{});
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          // A navigation with nothing cached for that exact URL still needs a
          // document, otherwise the browser shows its own offline error page.
          return cached || await caches.match('./index.html') || Response.error();
        })
    );
    return;
  }

  // Cache-first for CDN libraries — they change rarely, prefer speed/offline.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(()=>{});
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
