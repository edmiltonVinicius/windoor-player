window.WindoorPlayer = window.WindoorPlayer || {};

WindoorPlayer.cache = (function () {
  const DB_NAME = 'windoor-player';
  const STORE = 'contents';
  const IMAGE_CACHE = 'windoor-images-v1';

  // Resquícios do MVP single-tenant (totem-*): não há migração de dados,
  // só limpeza, para não ocupar espaço no dispositivo indefinidamente.
  (function dropLegacyStorage() {
    try { indexedDB.deleteDatabase('totem-cache'); } catch (_) {}
    try {
      if (typeof caches !== 'undefined' && caches.delete) {
        caches.delete('totem-imagens-v1');
        caches.delete('totem-shell-v2');
      }
    } catch (_) {}
  })();

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // O feed é um documento só (layout + zonas + barra), gravado sob uma chave fixa.
  // Resolve apenas quando a transação termina: alguns fluxos leem de volta logo em
  // seguida, então "salvou" tem que ser verdade.
  const FEED_KEY = 'feed';

  async function saveFeed(feed) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      if (feed) store.put({ ...feed, id: FEED_KEY, cachedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Último feed salvo, ou `null`. O descarte de vencidos é refeito na normalização. */
  async function readFeed() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(FEED_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  // Cache-first: checa o Cache Storage pela URL exata; se não tiver, faz
  // fetch (com EXTRA_HEADERS, por causa do túnel ngrok em dev) e guarda a
  // Response clonada. Devolve um blob URL pronto pra usar em <img>.
  // Nunca envia Authorization: as imagens são públicas.
  async function getCachedImage(url) {
    const cache = await caches.open(IMAGE_CACHE);
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url, { headers: WindoorPlayer.config.EXTRA_HEADERS });
      if (!response.ok) throw new Error(`resposta não-ok ao buscar imagem: ${response.status}`);
      cache.put(url, response.clone());
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  // Pré-carrega em paralelo as imagens do feed, sem bloquear quem chamou
  // (fire-and-forget). Falha de uma imagem não afeta as outras. Vídeo fica de
  // fora de propósito: até 200 MB por arquivo encheria o Cache Storage.
  function preloadImages(feed) {
    WindoorPlayer.feed.imageUrls(feed).forEach((url) => {
      getCachedImage(url).catch((error) => {
        if (WindoorPlayer.logger) {
          WindoorPlayer.logger.error('Falha ao pré-carregar imagem', { url, error: error.message });
        }
      });
    });
  }

  // Remove do Cache Storage imagens fora do feed atual — evita crescimento
  // ilimitado em operação 24/7. Seguro porque cada upload gera um UUID novo:
  // uma URL nunca muda de conteúdo.
  async function pruneImages(feed) {
    const cache = await caches.open(IMAGE_CACHE);
    const valid = new Set(WindoorPlayer.feed.imageUrls(feed));
    const requests = await cache.keys();
    await Promise.all(
      requests.filter((req) => !valid.has(req.url)).map((req) => cache.delete(req))
    );
  }

  return { saveFeed, readFeed, getCachedImage, preloadImages, pruneImages, DB_NAME, STORE, IMAGE_CACHE, FEED_KEY };
})();
