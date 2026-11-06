// Normalização do feed de `GET /player/contents` e do evento `content:updated`.
// Funções puras, sem DOM: o backend já entrega o que deve ser exibido agora, mas o
// player pode ficar dias offline com o cache local, e aí o descarte de vencidos
// precisa ser refeito aqui. Premissa: o relógio do dispositivo está correto.
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.feed.
(function (root) {
  const LAYOUTS = { fullscreen: ['full'], split_top_bottom: ['top', 'bottom'] };
  const TYPES = ['image', 'video'];
  const QUOTE_SYMBOLS = ['USD', 'EUR', 'GBP', 'ARS'];
  const INFO_BAR_MAX_ITEMS = 10;
  const INFO_BAR_MAX_QUOTE_SYMBOLS = 2;
  const INFO_BAR_QUOTES_STALE_MS = 6 * 60 * 60 * 1000;

  const DEFAULT_INFO_BAR = { enabled: false, rotationSeconds: 10, items: [] };

  /** Vencido = tem validade e ela já passou. Sem validade, vale para sempre. */
  function isPlayable(item, now) {
    if (!item || !item.url || !TYPES.includes(item.type)) return false;
    if (!item.validUntil) return true;
    const limit = Date.parse(item.validUntil);
    return Number.isNaN(limit) ? true : limit > (now || new Date()).getTime();
  }

  function normalizeItem(item) {
    const seconds = Number(item.durationSeconds);
    return {
      id: String(item.id),
      contentId: String(item.contentId || item.id),
      name: String(item.name || ''),
      type: item.type,
      url: String(item.url),
      // Duração inválida não pode travar a zona num item só: cai no padrão.
      durationSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 10,
      validUntil: item.validUntil || null,
    };
  }

  /** Normaliza um item do centro; `null` quando o tipo é desconhecido ou o item é inútil. */
  function normalizeInfoBarItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!id) return null;

    if (raw.type === 'text') {
      const text = String(raw.text || '').trim();
      return text ? { id, type: 'text', text } : null;
    }

    if (raw.type === 'image') {
      const url = String(raw.url || '');
      if (!url) return null;
      return { id, type: 'image', contentId: String(raw.contentId || id), url, validUntil: raw.validUntil || null };
    }

    if (raw.type === 'quotes') {
      const symbols = (Array.isArray(raw.symbols) ? raw.symbols : [])
        .filter((s) => QUOTE_SYMBOLS.includes(s))
        .slice(0, INFO_BAR_MAX_QUOTE_SYMBOLS);
      return symbols.length > 0 ? { id, type: 'quotes', symbols } : null;
    }

    return null;
  }

  function normalizeInfoBar(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_INFO_BAR, items: [] };
    const rotation = Number(raw.rotationSeconds);
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map(normalizeInfoBarItem)
      .filter(Boolean)
      .slice(0, INFO_BAR_MAX_ITEMS);
    return {
      enabled: Boolean(raw.enabled),
      rotationSeconds: Number.isFinite(rotation) && rotation > 0 ? Math.round(rotation) : 10,
      items,
    };
  }

  /**
   * `type: image` elegível quando não vencido; `quotes`, quando o cache tem pelo menos
   * uma das moedas pedidas e não passou de 6 h desde a última busca do servidor. Imagem
   * também depende de já ter sido baixada (`imageReady`, mantido pelo render.js).
   */
  function isInfoBarItemEligible(item, now, quotes, imageReady) {
    const ref = (now || new Date()).getTime();
    if (!item) return false;
    if (item.type === 'text') return true;
    if (item.type === 'image') {
      if (item.validUntil) {
        const limit = Date.parse(item.validUntil);
        if (!Number.isNaN(limit) && limit <= ref) return false;
      }
      return imageReady ? !!imageReady(item.url) : true;
    }
    if (item.type === 'quotes') {
      if (!quotes || !Array.isArray(quotes.items)) return false;
      const fetchedAt = Number(quotes.fetchedAt);
      if (!Number.isFinite(fetchedAt) || ref - fetchedAt > INFO_BAR_QUOTES_STALE_MS) return false;
      const available = new Set(quotes.items.map((q) => q && q.symbol));
      return item.symbols.some((symbol) => available.has(symbol));
    }
    return false;
  }

  /**
   * Devolve sempre a forma canônica: as zonas exatamente do layout, na ordem de
   * exibição, com os itens exibíveis. Tolera payload antigo (array plano) para
   * não quebrar um cache gravado por uma versão anterior do player.
   */
  function normalizeFeed(raw, now) {
    const ref = now || new Date();

    // Compatibilidade: versões anteriores gravavam uma lista plana de conteúdos.
    if (Array.isArray(raw)) {
      return {
        playerId: null,
        layout: 'fullscreen',
        zones: [{ position: 'full', playlist: null, items: [] }],
        infoBar: { ...DEFAULT_INFO_BAR },
        skippedItems: 0,
        legacy: true,
      };
    }

    const feed = raw && typeof raw === 'object' ? raw : {};
    const layout = LAYOUTS[feed.layout] ? feed.layout : 'fullscreen';
    const byPosition = new Map(
      (Array.isArray(feed.zones) ? feed.zones : []).map((zone) => [zone && zone.position, zone]),
    );

    const zones = LAYOUTS[layout].map((position) => {
      const zone = byPosition.get(position) || {};
      const items = (Array.isArray(zone.items) ? zone.items : [])
        .filter((item) => isPlayable(item, ref))
        .map(normalizeItem);
      return {
        position,
        playlist: zone.playlist && zone.playlist.id ? { id: zone.playlist.id, name: zone.playlist.name || '' } : null,
        items,
      };
    });

    return {
      playerId: feed.playerId || null,
      layout,
      zones,
      infoBar: normalizeInfoBar(feed.infoBar),
      skippedItems: Number(feed.skippedItems) || 0,
      legacy: false,
    };
  }

  /**
   * Todas as URLs de mídia do feed: itens das playlists (imagem e vídeo) + imagens da
   * barra de informações (ela não tem item de vídeo). Pré-carregadas no Cache Storage
   * assim que a configuração chega, antes de entrarem no rodízio — a key de upload
   * nunca se repete, então a URL é imutável e pode viver em cache por muito tempo.
   */
  function mediaUrls(feed) {
    const zones = (feed && feed.zones) || [];
    const fromZones = zones.flatMap((zone) => (zone.items || []).map((i) => i.url));
    const barItems = (feed && feed.infoBar && feed.infoBar.items) || [];
    const fromBar = barItems.filter((i) => i.type === 'image').map((i) => i.url);
    return [...fromZones, ...fromBar];
  }

  function totalItems(feed) {
    return ((feed && feed.zones) || []).reduce((total, zone) => total + (zone.items || []).length, 0);
  }

  const api = {
    normalizeFeed,
    normalizeInfoBar,
    normalizeInfoBarItem,
    isInfoBarItemEligible,
    isPlayable,
    mediaUrls,
    totalItems,
    LAYOUTS,
    QUOTE_SYMBOLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WindoorPlayer = root.WindoorPlayer || {}; root.WindoorPlayer.feed = api; }
})(typeof window !== 'undefined' ? window : globalThis);
