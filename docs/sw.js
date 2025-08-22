self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

const CACHE = 'cshell-v1';
const ASSETS = ['./','./index.html','./app.js','./supabaseClient.js','./config.js','./manifest.webmanifest'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res && res.status === 200 && new URL(event.request.url).origin === location.origin) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, res.clone());
      }
      return res;
    } catch {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      return cached || new Response('Offline', { status: 200 });
    }
  })());
});
