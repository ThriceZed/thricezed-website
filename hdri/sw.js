/* TZHDRI service worker: precaches the app shell so capture sessions keep
   working offline once the tool has been opened at least once. */

const CACHE = 'tzhdri-v2';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/hdri.css?v=2',
  'js/app.js?v=2',
  'js/capture.js',
  'js/orientation.js',
  'js/stitch.js',
  'js/viewer.js',
  'js/exporters.js',
  'js/store.js',
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

/* Cache first with background refresh for everything we serve. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreVary: true }).then(hit => {
      const refresh = fetch(e.request)
        .then(res => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
