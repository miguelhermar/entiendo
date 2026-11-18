// Entiendo service worker: the app opens instantly and works offline (the
// speech services themselves of course need internet).
const VERSION = '__BUILD__';
const CACHE = 'entiendo-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/storage.js',
  './js/transcript.js',
  './js/segmenter.js',
  './js/soniox.js',
  './js/free-engine.js',
  './js/translator.js',
  './js/audio.js',
  './js/pcm-worklet.js',
  './js/render.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/shortcut-misa.png',
  './icons/shortcut-conversar.png',
  './icons/shortcut-escuchar.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('entiendo-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch API traffic
  if (req.mode === 'navigate') {
    // The whole app comes from one cache version, so files always match.
    event.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req).catch(() => caches.match('./'))),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
