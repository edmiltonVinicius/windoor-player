// Normalização do feed de `GET /player/news` e do evento `news.feed.updated`
// (contrato em `documentation/plans/noticias/contratos.md`). Funções puras, sem DOM:
// o backend já manda só notícia válida (seção 6.2 do plano), mas o player pode ficar
// dias offline com o cache local, e aí o descarte de vencidas precisa ser refeito
// aqui — mesma premissa de `feed.js`: o relógio do dispositivo está correto.
//
// Zona de notícia (seção 6 do plano "Trilha D — Player"): uma notícia por vez, com
// rotação circular; sem notícia válida, cai no cache local por até 48h; esgotado o
// cache, cai no vídeo de marketing (mesmo mecanismo do `fallback` de comunicados em
// `feed.js`, reaproveitado aqui — não duplicado).
//
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.newsfeed.
(function (root) {
  const MAX_ITEMS = 30;
  /** Cache local de notícia só é usado por até 48h (seção "Regras importantes" do plano). */
  const CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

  /** Vencida = `expiresAt` já passou. Sem `expiresAt`, é descartada (contrato sempre o manda). */
  function isNewsValid(item, now) {
    if (!item || !item.expiresAt) return false;
    const limit = Date.parse(item.expiresAt);
    if (Number.isNaN(limit)) return false;
    return limit > (now || new Date()).getTime();
  }

  /** `null` quando faltar algo essencial para exibir (id, foto ou título). */
  function normalizeNewsItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    const imageUrl = String(raw.imageUrl || '');
    const title = String(raw.title || '').trim();
    if (!id || !imageUrl || !title) return null;
    return {
      id,
      title,
      section: String(raw.section || ''),
      imageUrl,
      imageSha256: raw.imageSha256 ? String(raw.imageSha256) : null,
      photoCredit: String(raw.photoCredit || ''),
      sourceName: String(raw.sourceName || ''),
      publishedAt: raw.publishedAt || null,
      expiresAt: raw.expiresAt || null,
      shortUrl: raw.shortUrl ? String(raw.shortUrl) : null,
    };
  }

  /**
   * Devolve `{ generatedAt, items }`: itens válidos agora, ordenados por
   * `publishedAt desc` (contrato §`GET /player/news`), limitados a 30.
   */
  function normalizeNewsFeed(raw, now) {
    const ref = now || new Date();
    const feed = raw && typeof raw === 'object' ? raw : {};
    const items = (Array.isArray(feed.items) ? feed.items : [])
      .map(normalizeNewsItem)
      .filter(Boolean)
      .filter((item) => isNewsValid(item, ref))
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .slice(0, MAX_ITEMS);

    const generatedAtMs = Date.parse(feed.generatedAt);
    return {
      generatedAt: Number.isNaN(generatedAtMs) ? ref.toISOString() : feed.generatedAt,
      items,
    };
  }

  /** O que vai para o cache local: os itens válidos + o instante em que foram salvos. */
  function toCacheEntry(feedNews, now) {
    return { items: (feedNews && feedNews.items) || [], cachedAtMs: (now || Date.now()) };
  }

  /** `true` quando o cache ainda está dentro da janela de 48h. */
  function isCacheFresh(cacheEntry, nowMs) {
    if (!cacheEntry || !Number.isFinite(cacheEntry.cachedAtMs)) return false;
    return (nowMs || Date.now()) - cacheEntry.cachedAtMs <= CACHE_MAX_AGE_MS;
  }

  /**
   * Decide a fonte das notícias a exibir, na ordem do plano: feed atual → cache local
   * (até 48h, e ainda filtrando `expiresAt`) → nenhuma (quem chama decide o vídeo de
   * marketing). `source` é só para log/diagnóstico.
   */
  function selectNewsSource(feedNews, cacheEntry, now) {
    const ref = now || new Date();
    const feedItems = (feedNews && feedNews.items) || [];
    if (feedItems.length > 0) return { items: feedItems, source: 'feed' };

    if (isCacheFresh(cacheEntry, ref.getTime())) {
      const stillValid = (cacheEntry.items || []).filter((item) => isNewsValid(item, ref));
      if (stillValid.length > 0) return { items: stillValid, source: 'cache' };
    }

    return { items: [], source: 'none' };
  }

  /** Rotação circular pura: índice qualquer (inclusive negativo/fora de faixa) sempre cai num item válido. */
  function rotate(items, index) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const i = ((index % items.length) + items.length) % items.length;
    return items[i];
  }

  const api = {
    normalizeNewsItem,
    normalizeNewsFeed,
    isNewsValid,
    toCacheEntry,
    isCacheFresh,
    selectNewsSource,
    rotate,
    MAX_ITEMS,
    CACHE_MAX_AGE_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WindoorPlayer = root.WindoorPlayer || {};
    root.WindoorPlayer.newsfeed = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
