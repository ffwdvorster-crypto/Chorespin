self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
// Tiny offline shell (add more later)
const CACHE = 'cshell-v1';
const ASSETS = ['/', '/index.html'];
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    try { return await fetch(event.request); }
    catch { 
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      return cached || new Response('Offline', {status: 200});
    }
  })());
});
