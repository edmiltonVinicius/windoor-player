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
  const INFO_BAR_WEATHER_STALE_MS = 3 * 60 * 60 * 1000;
  const WEATHER_MODES = ['now', 'today', 'days'];
  const WEATHER_CONDITIONS = ['clear', 'partly_cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'storm'];

  const DEFAULT_INFO_BAR = { enabled: false, rotationSeconds: 10, items: [] };
  const DEFAULT_ANNOUNCEMENTS = { enabled: false, everyNMedia: 3, durationSeconds: 15, items: [] };

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
      // Preservado para o feed salvo em cache (já intercalado) poder ser re-normalizado
      // sem duplicar comunicados — ver `interleaveAnnouncements`.
      isAnnouncement: Boolean(item.isAnnouncement),
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

    if (raw.type === 'weather') {
      const loc = raw.location || {};
      const latitude = Number(loc.latitude);
      const longitude = Number(loc.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        id,
        type: 'weather',
        mode: WEATHER_MODES.includes(raw.mode) ? raw.mode : 'today',
        location: { name: String(loc.name || ''), state: String(loc.state || ''), latitude, longitude },
      };
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
  /**
   * Mesma chave do backend (coordenadas em 2 casas): é como o player sabe se um evento
   * `info_bar.weather.updated` é do seu local.
   */
  function weatherKey(latitude, longitude) {
    const lat = Math.round(Number(latitude) * 100) / 100;
    const lon = Math.round(Number(longitude) * 100) / 100;
    return `${lat.toFixed(2)}:${lon.toFixed(2)}`;
  }

  /** `YYYY-MM-DD` de hoje no fuso da unidade. */
  function todayInTimeZone(now, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch (_) {
      return (now || new Date()).toISOString().slice(0, 10);
    }
  }

  /**
   * Dias a partir de hoje (seção 5.2): um snapshot de ontem ainda tem `days[0]` no
   * passado, então descartamos os dias anteriores a hoje no fuso da unidade.
   */
  function upcomingWeatherDays(weather, now, timeZone) {
    const days = (weather && Array.isArray(weather.days) ? weather.days : [])
      .filter((d) => d && typeof d.date === 'string' && WEATHER_CONDITIONS.includes(d.condition));
    const today = todayInTimeZone(now || new Date(), timeZone);
    return days.filter((d) => d.date >= today);
  }

  /**
   * `type: image` elegível quando não vencido; `quotes`, quando o cache tem pelo menos
   * uma das moedas pedidas e não passou de 6 h desde a última busca do servidor. Imagem
   * também depende de já ter sido baixada (`imageReady`, mantido pelo render.js).
   * `weather`, quando há snapshot do mesmo local com até 3 h e dias suficientes para o formato.
   */
  function isInfoBarItemEligible(item, now, quotes, imageReady, weather, timeZone) {
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
    if (item.type === 'weather') {
      if (!weather || !weather.current || !weather.location) return false;
      if (weatherKey(weather.location.latitude, weather.location.longitude) !==
          weatherKey(item.location.latitude, item.location.longitude)) return false;
      const fetchedAt = Number(weather.fetchedAt);
      if (!Number.isFinite(fetchedAt) || ref - fetchedAt > INFO_BAR_WEATHER_STALE_MS) return false;
      if (!Number.isFinite(Number(weather.current.temperature))) return false;
      if (item.mode === 'now') return true;
      const days = upcomingWeatherDays(weather, now, timeZone || 'America/Sao_Paulo');
      return item.mode === 'today' ? days.length >= 1 : days.length >= 2;
    }
    return false;
  }

  /** `null` quando o tipo é desconhecido ou falta a URL — nunca entra no rodízio. */
  function normalizeAnnouncementItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    const url = String(raw.url || '');
    if (!id || !url || !TYPES.includes(raw.type)) return null;
    return { id, contentId: String(raw.contentId || id), type: raw.type, url };
  }

  function normalizeAnnouncements(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_ANNOUNCEMENTS, items: [] };
    const everyNMedia = Number(raw.everyNMedia);
    const durationSeconds = Number(raw.durationSeconds);
    const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeAnnouncementItem).filter(Boolean);
    return {
      enabled: Boolean(raw.enabled) && items.length > 0,
      everyNMedia: Number.isFinite(everyNMedia) && everyNMedia > 0 ? Math.round(everyNMedia) : DEFAULT_ANNOUNCEMENTS.everyNMedia,
      durationSeconds:
        Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : DEFAULT_ANNOUNCEMENTS.durationSeconds,
      items,
    };
  }

  /**
   * Intercala um comunicado a cada `everyNMedia` itens reais da playlist (seção 6 do
   * documento de Comunicados). O resultado é determinístico — mesma entrada, mesma
   * saída — para não reiniciar o rodízio da zona a cada atualização do feed
   * (`sameSequence`, em `render.js`, compara os `id`s item a item).
   *
   * Como a zona já roda em loop (módulo do tamanho do array, em `render.js`), repetir
   * a playlist base o suficiente para caber pelo menos um `everyNMedia` cheio garante
   * que o comunicado apareça mesmo em playlists menores que a frequência configurada.
   */
  function interleaveAnnouncements(items, announcements) {
    if (!announcements || !announcements.enabled || items.length === 0 || announcements.items.length === 0) return items;

    const everyNMedia = announcements.everyNMedia;
    const repeat = Math.max(1, Math.ceil(everyNMedia / items.length));
    const result = [];
    let mediaCount = 0;
    let announcementIndex = 0;
    let slot = 0;

    for (let lap = 0; lap < repeat; lap += 1) {
      for (const item of items) {
        result.push(item);
        mediaCount += 1;
        if (mediaCount === everyNMedia) {
          mediaCount = 0;
          const source = announcements.items[announcementIndex % announcements.items.length];
          announcementIndex += 1;
          result.push({
            id: `announcement:${source.id}:${slot}`,
            contentId: source.contentId,
            name: '',
            type: source.type,
            url: source.url,
            durationSeconds: announcements.durationSeconds,
            validUntil: null,
            isAnnouncement: true,
          });
          slot += 1;
        }
      }
    }
    return result;
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
        announcements: { ...DEFAULT_ANNOUNCEMENTS },
        skippedItems: 0,
        legacy: true,
      };
    }

    const feed = raw && typeof raw === 'object' ? raw : {};
    const layout = LAYOUTS[feed.layout] ? feed.layout : 'fullscreen';
    const byPosition = new Map(
      (Array.isArray(feed.zones) ? feed.zones : []).map((zone) => [zone && zone.position, zone]),
    );
    const announcements = normalizeAnnouncements(feed.announcements);

    const zones = LAYOUTS[layout].map((position) => {
      const zone = byPosition.get(position) || {};
      const items = (Array.isArray(zone.items) ? zone.items : [])
        .filter((item) => isPlayable(item, ref))
        .map(normalizeItem)
        // Um feed salvo em cache já vem com comunicados intercalados: remove antes de
        // intercalar de novo, senão dobra a cada normalização (ver cache local offline).
        .filter((item) => !item.isAnnouncement);
      return {
        position,
        playlist: zone.playlist && zone.playlist.id ? { id: zone.playlist.id, name: zone.playlist.name || '' } : null,
        items: interleaveAnnouncements(items, announcements),
      };
    });

    return {
      playerId: feed.playerId || null,
      layout,
      zones,
      infoBar: normalizeInfoBar(feed.infoBar),
      announcements,
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
    normalizeAnnouncements,
    normalizeAnnouncementItem,
    interleaveAnnouncements,
    normalizeInfoBar,
    normalizeInfoBarItem,
    isInfoBarItemEligible,
    isPlayable,
    mediaUrls,
    totalItems,
    LAYOUTS,
    QUOTE_SYMBOLS,
    weatherKey,
    upcomingWeatherDays,
    INFO_BAR_WEATHER_STALE_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WindoorPlayer = root.WindoorPlayer || {}; root.WindoorPlayer.feed = api; }
})(typeof window !== 'undefined' ? window : globalThis);
