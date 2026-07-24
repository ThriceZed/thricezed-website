/* TZHDRI service worker.

   The app's own markup and code are served network-first: when online you
   always get the current deploy, and the cache is only a fallback for offline
   use. The big immutable third-party bundle (Three.js, versioned URL) stays
   cache-first so it is not re-downloaded every load. */

const CACHE = 'tzhdri-v6';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/hdri.css?v=3',
  'js/app.js?v=3',
  'js/capture.js',
  'js/orientation.js',
  'js/stitch.js',
  'js/refine.js',
  'js/viewer.js',
  'js/exporters.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  '../css/style.css?v=7',
  '../js/main.js?v=2',
  '../assets/img/logo.png',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(url => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Third-party CDN bundle: cache-first, it never changes for a given URL.
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreVary: true }).then(hit => hit || fetch(e.request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Our own files: network-first so a fresh deploy always wins when online,
  // falling back to the cached copy only when the network is unavailable.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreVary: true }))
  );
});
