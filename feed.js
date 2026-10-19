// Normalização do feed de `GET /player/contents` e do evento `content:updated`.
// Funções puras, sem DOM: o backend já entrega o que deve ser exibido agora, mas o
// player pode ficar dias offline com o cache local, e aí o descarte de vencidos
// precisa ser refeito aqui. Premissa: o relógio do dispositivo está correto.
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.feed.
(function (root) {
  const LAYOUTS = { fullscreen: ['full'], split_top_bottom: ['top', 'bottom'] };
  const TYPES = ['image', 'video'];

  const DEFAULT_INFO_BAR = { enabled: false, rotationSeconds: 10, messages: [] };

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

  function normalizeInfoBar(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_INFO_BAR };
    const rotation = Number(raw.rotationSeconds);
    return {
      enabled: Boolean(raw.enabled),
      rotationSeconds: Number.isFinite(rotation) && rotation > 0 ? Math.round(rotation) : 10,
      messages: (Array.isArray(raw.messages) ? raw.messages : [])
        .map((message) => String((message && message.text) || '').trim())
        .filter(Boolean),
    };
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

  /** Todas as URLs de imagem do feed (vídeo não é pré-carregado: tocam direto da rede). */
  function imageUrls(feed) {
    const zones = (feed && feed.zones) || [];
    return zones.flatMap((zone) => (zone.items || []).filter((i) => i.type === 'image').map((i) => i.url));
  }

  function totalItems(feed) {
    return ((feed && feed.zones) || []).reduce((total, zone) => total + (zone.items || []).length, 0);
  }

  const api = { normalizeFeed, normalizeInfoBar, isPlayable, imageUrls, totalItems, LAYOUTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WindoorPlayer = root.WindoorPlayer || {}; root.WindoorPlayer.feed = api; }
})(typeof window !== 'undefined' ? window : globalThis);
