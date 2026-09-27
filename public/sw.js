// The only place the app version lives. Bump it on every deploy
// (sideline-v6 -> sideline-v7); the app shows it and offers the update.
const VERSION = 'sideline-v11';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' skips the host's HTTP cache so we never store stale files
    await cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })));
    // First install takes over straight away. Later versions wait for the
    // app to say "update now" so nothing changes mid-screen.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'version') {
    const reply = VERSION.replace('sideline-', '');
    if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
  }
});

// Cache first, from this version's own cache: works fully offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(e.request); }
    catch (err) { return (await cache.match('./index.html')) || Response.error(); }
  })());
});
