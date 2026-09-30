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

// Estratégia "network-first, fallback to cache":
// tenta buscar da rede (dado sempre atualizado); se falhar, serve do cache
// (imagens de oferta já baixadas antes, por exemplo).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request))
  );
});
