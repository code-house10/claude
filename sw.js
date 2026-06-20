const CACHE_NAME = 'jungle-movie-pwa-v31';
const ASSETS = ['./', './index.html', './style.css?v=pwa-v31', './app.js?v=pwa-v31', './vocab-data.js?v=pwa-v31',
  './manifest.webmanifest?v=pwa-v31', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-64.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const clone = response.clone();
    if (response.ok && url.origin === location.origin) caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
    return response;
  }).catch(() => cached)));
});
