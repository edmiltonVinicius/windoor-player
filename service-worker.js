const CACHE_NAME = 'totem-shell-v2';
const ARQUIVOS_SHELL = [
  './',
  './index.html',
  './config.js',
  './cache.js',
  './render.js',
  './logger.js',
  './heartbeat.js',
  './commands.js',
  './proof-of-play.js',
  './wakelock.js',
  './watchdog.js',
  './app.js',
];

// Ao instalar, guarda o "esqueleto" da página (HTML/JS) em cache.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS_SHELL))
  );
});

// Remove versões antigas de cache quando um novo Service Worker assume.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes
          .filter((nome) => nome !== CACHE_NAME)
          .map((nome) => caches.delete(nome))
      )
    )
  );
});

// Estratégia "network-first, fallback to cache", só pro shell da própria
// origem (os arquivos em ARQUIVOS_SHELL). Tráfego dinâmico cross-origin
// (API, socket.io, imagens de oferta via blob) passa direto sem interceptar:
// a Cache Storage API só aceita GET, e re-disparar fetch(event.request) pra
// outra origem dentro do SW perde headers/contexto e falha de formas que o
// navegador reporta como "404 (from service worker)" em vez do erro real.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        return resposta;
      })
      .catch(() => caches.match(req))
  );
});
