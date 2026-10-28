const CACHE_NAME = 'windoor-shell-v2';
const IMAGE_CACHE = 'windoor-images-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './config.js',
  './schedule.js',
  './api.js',
  './cache.js',
  './render.js',
  './logger.js',
  './heartbeat.js',
  './commands.js',
  './proof-of-play.js',
  './wakelock.js',
  './watchdog.js',
  './pairing.js',
  './app.js',
  './vendor/socket.io.min.js',
  './assets/logo.png',
  './assets/fonts/pjs-latin.woff2',
  './assets/fonts/pjs-latin-ext.woff2',
  './assets/fonts/pjs-vietnamese.woff2',
  './assets/fonts/pjs-cyrillic-ext.woff2',
];

// Ao instalar, guarda o "esqueleto" da página (HTML/JS/logo/socket.io).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
});

// Remove qualquer cache que não seja o shell atual nem o de imagens — isso
// também elimina os caches legados totem-*.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== IMAGE_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  );
});

// "network-first, fallback to cache", só pro GET da própria origem. Tráfego
// cross-origin (API, socket.io, imagens) passa direto sem interceptar: a
// Cache Storage só aceita GET, e re-disparar o fetch cross-origin dentro do
// SW perde headers/contexto e falha de formas enganosas.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return response;
      })
      .catch(() => caches.match(req))
  );
});
