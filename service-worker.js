const CACHE_NAME = 'windoor-shell-v3';
// Nome deve bater com `MEDIA_CACHE` em cache.js — é a mesma Cache Storage, só que
// `cache.js` grava direto, sem passar pelo `fetch` deste worker (mídia é cross-origin).
const MEDIA_CACHE = 'windoor-media-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './config.js',
  './feed.js',
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
  './unpair.js',
  './app.js',
  './vendor/socket.io.min.js',
  './assets/logo.png',
  './assets/fonts/pjs-latin.woff2',
  './assets/fonts/pjs-latin-ext.woff2',
  './assets/fonts/pjs-vietnamese.woff2',
  './assets/fonts/pjs-cyrillic-ext.woff2',
];

// Ao instalar, guarda o "esqueleto" da página (HTML/JS/logo/socket.io). `cache: 'reload'`
// ignora o cache HTTP do navegador/CDN em cada arquivo — sem isso, um `index.html` com
// Cache-Control agressivo no host estático poderia entrar velho na primeira instalação.
// `skipWaiting()` faz essa versão nova assumir assim que termina de instalar, em vez de
// ficar "waiting" pra sempre: um kiosk nunca fecha a aba pra liberar a troca sozinho.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Remove qualquer cache que não seja o shell atual nem o de mídia atual — isso
// também elimina os caches legados totem-* e o `windoor-images-v1` de antes do
// vídeo entrar no cache-first. `clients.claim()` põe esta versão no controle das
// páginas já abertas na hora (continuação do `skipWaiting()` do install).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME && name !== MEDIA_CACHE)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// "network-first, fallback to cache", só pro GET da própria origem. Tráfego
// cross-origin (API, socket.io, imagens) passa direto sem interceptar: a
// Cache Storage só aceita GET, e re-disparar o fetch cross-origin dentro do
// SW perde headers/contexto e falha de formas enganosas. `cache: 'reload'` força
// ida à rede de verdade a cada troca: sem isso, "network-first" podia devolver uma
// resposta velha direto do cache HTTP do navegador/CDN, sem nenhum round-trip real
// (mesmo problema, mesmo fix, do `getCachedMedia` em cache.js).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'reload' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return response;
      })
      .catch(() => caches.match(req))
  );
});
