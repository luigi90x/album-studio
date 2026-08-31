// Keeps the app usable with no network at all: everything it needs is cached on first visit.
// Bump CACHE when you publish a new build, so phones pick it up instead of the old copy.
const CACHE = 'album-studio-v24';
const FILES = ['.', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Cache first: offline is the normal case here, not the exception. A successful fetch refreshes
// the stored copy so the next launch gets the newer build.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(hit => {
      const live = fetch(event.request)
        .then(response => {
          if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});
