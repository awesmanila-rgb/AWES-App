// Bumped to v39 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js/css/app.css again — switches the
// app-wide typeface from the system-font stack ("Google Sans" etc.) to
// Fredoka, loaded from Google's font CDN (added to CDN_SHELL below) and
// applied everywhere via app.css. Also adds a font-family/font-weight
// reset for form controls (button, input, select, textarea, optgroup) —
// see the comment on that rule in app.css for why it was missing before
// and why it matters now that a visually distinct font is in use.
//
// Bumped to v38 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js again — tapping a photo (admin grid or
// customer portal gallery) now opens a full-screen swipeable lightbox
// instead of window.open() in a new tab, so browsing through a unit's
// photos no longer means closing each tab to see the next one. New markup
// (#equipPhotoLightbox etc.) in index.html and new lightbox functions in
// equipment-photos.js that v37's cached copies don't have.
//
// Bumped to v37 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js again — the customer portal's photo
// gallery now always shows the folder name above each group of photos
// (previously only shown when a unit had more than one folder), so
// customers always know which folder's photos they're looking at.
//
// Bumped to v36 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js again — adds the Equipment Photos
// feature (upload/view/organize per unit): new markup in index.html
// (equipmentPhotoFileInput etc., cpDetailPhotoGrid) and new functions in
// app.bundle.js (equipment-photos.js module) that v35's cached copies
// don't have. Also includes the fix in doLogout()/openCustomerEquipmentDetail()
// (customer-equipment-history.js) for a previous customer's equipment
// photos briefly flashing on screen after a different customer logs in.
//
// Bumped to v35 to force every installed device to drop its old cache and
// re-fetch app.bundle.js again — v34's fix stopped duplicate rows via
// content-comparison, but that comparison itself could reject (or merge)
// two genuinely different units that happen to share every recorded field.
// Equipment identity is now decided once, explicitly, by which action
// added it (picked from "Select Existing", or freshly typed via "+ Add
// New") and carried forward as a real id from that point on — see
// equipPickedId in app.bundle.js — never re-guessed from field content.
const CACHE_NAME = 'awes-sr-v39';

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
  //
  // Fredoka (app-wide typeface, see app.css) — this precaches the CSS
  // response only; the actual woff2 files it references get cached the
  // first time the browser fetches them (via the generic cache-first
  // fallback below, same as everything else here), since Google serves
  // different font files per requesting browser/UA and precaching one
  // fixed response here could serve the wrong format to a different
  // browser than whichever one happened to install the service worker.
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap',
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
