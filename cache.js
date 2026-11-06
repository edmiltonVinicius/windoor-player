window.WindoorPlayer = window.WindoorPlayer || {};

WindoorPlayer.cache = (function () {
  const DB_NAME = 'windoor-player';
  const DB_VERSION = 2;
  const STORE = 'contents';
  const QUOTES_STORE = 'quotes';
  // v1 só guardava imagem; vídeo agora também é imutável (uma key nunca é reaproveitada,
  // seção 0 do guia de storage), então cabe no mesmo cache-first. Nome novo para que o
  // `activate` do service worker apague o cache antigo sem precisar de migração.
  const MEDIA_CACHE = 'windoor-media-v1';

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
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(QUOTES_STORE)) db.createObjectStore(QUOTES_STORE, { keyPath: 'id' });
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

  // Última cotação conhecida da barra de informações: `{ items: [{symbol,bid,changePct}], fetchedAt }`.
  // Guardada à parte do feed porque é atualizada pelo servidor a cada 15 min, independente
  // de mudanças no conteúdo ou na configuração da barra.
  const QUOTES_KEY = 'quotes';

  async function saveQuotes(quotes) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QUOTES_STORE, 'readwrite');
      tx.objectStore(QUOTES_STORE).put({ ...quotes, id: QUOTES_KEY });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function readQuotes() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(QUOTES_STORE, 'readonly');
      const req = tx.objectStore(QUOTES_STORE).get(QUOTES_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  // Último clima do local da barra: `{ location, current, days, fetchedAt }` (fetchedAt numérico).
  // Mesmo store das cotações, com outra chave, para não precisar subir a versão do banco.
  const WEATHER_KEY = 'weather';

  async function saveWeather(weather) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QUOTES_STORE, 'readwrite');
      tx.objectStore(QUOTES_STORE).put({ ...weather, id: WEATHER_KEY });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function readWeather() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(QUOTES_STORE, 'readonly');
      const req = tx.objectStore(QUOTES_STORE).get(WEATHER_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  // Cache-first: checa o Cache Storage pela URL exata; se não tiver, faz
  // fetch (`mode: 'cors'` explícito — resposta opaca não deixa saber se o
  // download deu certo nem quanto ocupou da cota — com EXTRA_HEADERS, por
  // causa do túnel ngrok em dev) e guarda a Response clonada. `cache: 'reload'`
  // ignora o cache HTTP do navegador: a mídia sai do storage com `Cache-Control:
  // immutable`, então uma resposta buscada antes de uma regra de CORS nova (ou
  // antes do domínio público mudar) fica presa lá para sempre — o navegador nunca
  // revalida um `immutable`. Sem custo extra: só roda na primeira vez por URL,
  // porque a partir daqui quem decide repetir ou não é o Cache Storage acima, que
  // não tem esse problema. Devolve um blob URL pronto pra usar em <img> ou
  // <video>. Nunca envia Authorization: a mídia publicada é pública. Cada chamada
  // gera um blob URL novo (ainda que o arquivo já esteja no Cache Storage); quem
  // chama revoga ao trocar.
  async function getCachedMedia(url) {
    const cache = await caches.open(MEDIA_CACHE);
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url, { headers: WindoorPlayer.config.EXTRA_HEADERS, mode: 'cors', cache: 'reload' });
      if (!response.ok) throw new Error(`resposta não-ok ao buscar mídia: ${response.status}`);
      cache.put(url, response.clone());
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  // Pré-carrega em paralelo toda a mídia do feed (imagem e vídeo), sem bloquear
  // quem chamou (fire-and-forget) e antes de entrar no rodízio (seção 12 do guia
  // de storage). Falha de um arquivo não afeta os outros; cada upload é limitado a
  // 200 MB e a key nunca se repete, o que torna o cache seguro em operação 24/7.
  function preloadMedia(feed) {
    WindoorPlayer.feed.mediaUrls(feed).forEach((url) => {
      getCachedMedia(url).catch((error) => {
        if (WindoorPlayer.logger) {
          WindoorPlayer.logger.error('Falha ao pré-carregar mídia', { url, error: error.message });
        }
      });
    });
  }

  // Remove do Cache Storage mídia fora do feed atual — evita crescimento
  // ilimitado em operação 24/7. Seguro porque cada upload gera um UUID novo:
  // uma URL nunca muda de conteúdo.
  async function pruneMedia(feed) {
    const cache = await caches.open(MEDIA_CACHE);
    const valid = new Set(WindoorPlayer.feed.mediaUrls(feed));
    const requests = await cache.keys();
    await Promise.all(
      requests.filter((req) => !valid.has(req.url)).map((req) => cache.delete(req))
    );
  }

  return {
    saveFeed,
    readFeed,
    saveQuotes,
    readQuotes,
    saveWeather,
    readWeather,
    getCachedMedia,
    preloadMedia,
    pruneMedia,
    DB_NAME,
    STORE,
    QUOTES_STORE,
    MEDIA_CACHE,
    FEED_KEY,
  };
})();
