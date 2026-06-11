const CACHE_NAME = 'jungle-movie-openrouter-free-v1';
const ASSETS = ['./', './index.html', './style.css?v=openrouter-free-v1', './app.js?v=openrouter-free-v1'];
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
