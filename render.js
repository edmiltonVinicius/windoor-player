window.WindoorPlayer = window.WindoorPlayer || {};

/**
 * Desenha o layout do player: uma zona (fullscreen) ou duas empilhadas
 * (split_top_bottom), cada uma percorrendo a sua própria playlist com os tempos
 * dos próprios itens, mais a barra de informações da unidade.
 */
WindoorPlayer.render = (function () {
  const VIEWS = ['content', 'fallback', 'pairing', 'setup-error', 'inactive'];

  let feed = null;
  /** Estado por zona: elemento, índice, timer e o que está no ar (proof of play). */
  const zoneStates = new Map();
  let lastTickMs = Date.now();

  // ---------- barra de informações: estado ----------
  let infoBarRotationTimer = null;
  let infoBarClockTimer = null;
  let infoBarClockShowDate = false;
  let infoBarQuotes = null;
  let infoBarWeather = null;
  let infoBarAppliedKey = null;
  const infoBarImageStatus = new Map();   // url -> 'pending' | 'ready' | 'failed'
  const infoBarImageBlobUrls = new Map(); // url -> blob: URL já resolvida
  const infoBarSkipLogAt = new Map();     // `${type}:${id}:${reason}` -> timestamp do último log
  let infoBarEligibleCount = 0;

  // Download de mídia de zona falha mais de uma vez por hora (item que volta no rodízio
  // antes disso): sem limite, um conteúdo quebrado inundaria os logs a cada troca.
  const mediaFailLogAt = new Map(); // contentId -> timestamp do último log

  function logMediaDownloadFailed(item, error, extra) {
    if (!WindoorPlayer.logger) return;
    const key = item.contentId || item.url;
    const now = Date.now();
    const last = mediaFailLogAt.get(key) || 0;
    if (now - last < 60 * 60 * 1000) return;
    mediaFailLogAt.set(key, now);
    WindoorPlayer.logger.error('Falha ao baixar mídia do conteúdo', {
      contentId: item.contentId, url: item.url, type: item.type, error: error.message, ...extra,
    });
  }

  function showView(name) {
    VIEWS.forEach((view) => {
      const el = document.getElementById(view);
      if (el) el.style.display = view === name ? 'flex' : 'none';
    });
  }

  function zonesContainer() {
    return document.getElementById('zones');
  }

  // ---------- proof of play ----------

  function endDisplay(state) {
    if (state.displayed && state.startedAt && WindoorPlayer.proofOfPlay) {
      WindoorPlayer.proofOfPlay.report(state.displayed, Date.now() - state.startedAt);
    }
    state.displayed = null;
    state.startedAt = null;
  }

  // ---------- DOM das zonas ----------

  /** Recria os elementos das zonas quando o layout muda (e só nesse caso). */
  function buildZones(layout, zones) {
    const container = zonesContainer();
    if (!container) return;

    container.dataset.layout = layout;
    container.textContent = '';
    zoneStates.forEach((state) => {
      if (state.timer) clearTimeout(state.timer);
      endDisplay(state);
    });
    zoneStates.clear();

    zones.forEach((zone) => {
      const el = document.createElement('div');
      el.className = 'zone';
      el.dataset.position = zone.position;

      const empty = document.createElement('div');
      empty.className = 'zone-empty';
      empty.textContent = 'Sem playlist nesta zona';
      el.appendChild(empty);

      container.appendChild(el);
      zoneStates.set(zone.position, {
        el,
        emptyEl: empty,
        index: 0,
        timer: null,
        displayed: null,
        startedAt: null,
        currentMediaEl: null,
      });
    });
  }

  /**
   * Nada mudou nesta zona? Compara a playlist e a sequência. A playlist importa
   * mesmo quando as duas listas estão vazias: trocar uma zona sem playlist por
   * uma playlist sem conteúdo exibível muda a mensagem mostrada na tela.
   */
  function sameSequence(position, zone) {
    const previous = feed && feed.zones.find((z) => z.position === position);
    if (!previous) return false;

    const previousPlaylistId = previous.playlist ? previous.playlist.id : null;
    const nextPlaylistId = zone.playlist ? zone.playlist.id : null;
    if (previousPlaylistId !== nextPlaylistId) return false;

    const items = zone.items;
    if (previous.items.length !== items.length) return false;
    return items.every((item, index) => previous.items[index] && previous.items[index].id === item.id);
  }

  // ---------- exibição de um item ----------

  function createMediaElement(item) {
    if (item.type === 'video') {
      const video = document.createElement('video');
      video.muted = true;            // autoplay só é permitido sem som
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      return video;
    }
    const img = document.createElement('img');
    img.alt = '';
    return img;
  }

  /**
   * Coloca o item no ar com cross-fade. Imagem e vídeo vêm do Cache Storage (blob URL):
   * a key de upload nunca se repete, então a URL é imutável e cabe em cache-first mesmo
   * para vídeo (seção 12 do guia de storage). Download que falha não troca a tela —
   * mantém o que está no ar em vez de piscar uma zona vazia — e fica de fora até a
   * próxima vez que entrar no rodízio.
   */
  async function showItem(position, item) {
    const state = zoneStates.get(position);
    if (!state || !item) return;

    let src;
    try {
      src = await WindoorPlayer.cache.getCachedMedia(item.url);
    } catch (error) {
      logMediaDownloadFailed(item, error, { zone: position });
      return;
    }

    const entering = createMediaElement(item);
    entering.src = src;
    entering.className = 'zone-media';
    state.el.appendChild(entering);

    // Força um frame antes de animar, senão a transição não acontece.
    requestAnimationFrame(() => entering.classList.add('visible'));

    const leaving = state.currentMediaEl;
    if (leaving) {
      leaving.classList.remove('visible');
      const oldSrc = leaving.src;
      setTimeout(() => {
        leaving.remove();
        if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
      }, WindoorPlayer.config.TRANSITION_MS + 50);
    }

    state.currentMediaEl = entering;
    state.emptyEl.style.display = 'none';

    // A duração do anterior só é contabilizada depois que o novo está pronto.
    endDisplay(state);
    state.displayed = item;
    state.startedAt = Date.now();
  }

  // ---------- loop por zona ----------

  function scheduleNext(position) {
    const state = zoneStates.get(position);
    const zone = feed && feed.zones.find((z) => z.position === position);
    if (!state || !zone || zone.items.length === 0) return;

    const item = zone.items[state.index];
    const durationMs = Math.max(1, item.durationSeconds) * 1000;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      lastTickMs = Date.now();
      // Uma zona com um item só continua "tiquetaqueando" para o watchdog,
      // mesmo sem troca visível.
      if (zone.items.length > 1) {
        state.index = (state.index + 1) % zone.items.length;
        void showItem(position, zone.items[state.index]);
      }
      scheduleNext(position);
    }, durationMs);
  }

  function startZone(position) {
    const state = zoneStates.get(position);
    const zone = feed && feed.zones.find((z) => z.position === position);
    if (!state || !zone) return;

    if (zone.items.length === 0) {
      if (state.timer) clearTimeout(state.timer);
      endDisplay(state);
      if (state.currentMediaEl) { state.currentMediaEl.remove(); state.currentMediaEl = null; }
      state.emptyEl.style.display = 'flex';
      state.emptyEl.textContent = zone.playlist ? 'Playlist sem conteúdo disponível' : 'Sem playlist nesta zona';
      return;
    }

    state.index = 0;
    void showItem(position, zone.items[0]);
    scheduleNext(position);
  }

  // ---------- barra de informações ----------

  function reducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Troca o conteúdo de `el` com um fade de 300 ms (instantâneo com `prefers-reduced-motion`). */
  function fadeSwap(el, apply) {
    if (!el) return;
    if (reducedMotion()) { apply(); return; }
    el.classList.add('info-bar-fading');
    setTimeout(() => {
      apply();
      el.classList.remove('info-bar-fading');
    }, WindoorPlayer.config.INFO_BAR_TRANSITION_MS);
  }

  /** No máximo um log por item por hora, para não inundar (seção 6.5). */
  function logInfoBarSkip(item, reason) {
    const key = `${item.type}:${item.id}:${reason}`;
    const now = Date.now();
    const last = infoBarSkipLogAt.get(key) || 0;
    if (now - last < 60 * 60 * 1000) return;
    infoBarSkipLogAt.set(key, now);
    WindoorPlayer.logger.info('Item da barra de informações pulado', { itemId: item.id, type: item.type, reason });
  }

  function ensureInfoBarImageRequested(item) {
    if (infoBarImageStatus.has(item.url)) return;
    infoBarImageStatus.set(item.url, 'pending');
    WindoorPlayer.cache.getCachedMedia(item.url)
      .then((blobUrl) => {
        infoBarImageBlobUrls.set(item.url, blobUrl);
        infoBarImageStatus.set(item.url, 'ready');
      })
      .catch((error) => {
        infoBarImageStatus.set(item.url, 'failed');
        logMediaDownloadFailed(item, error, { itemId: item.id, infoBar: true });
      });
  }

  function isInfoBarImageReady(url) { return infoBarImageStatus.get(url) === 'ready'; }

  /** Itens elegíveis agora, disparando o download de imagens novas e logando os pulados. */
  function eligibleInfoBarItems(items, now) {
    items.filter((item) => item.type === 'image').forEach(ensureInfoBarImageRequested);

    const eligible = [];
    items.forEach((item) => {
      if (WindoorPlayer.feed.isInfoBarItemEligible(
        item, now, infoBarQuotes, isInfoBarImageReady, infoBarWeather, WindoorPlayer.config.INFO_BAR_TIMEZONE,
      )) {
        eligible.push(item);
        return;
      }
      if (item.type === 'image') {
        const expired = item.validUntil && Date.parse(item.validUntil) <= now.getTime();
        logInfoBarSkip(item, expired ? 'expired_image' : 'image_failed');
      } else if (item.type === 'quotes') {
        logInfoBarSkip(item, 'stale_quotes');
      } else if (item.type === 'weather') {
        logInfoBarSkip(item, 'stale_weather');
      }
    });
    return eligible;
  }

  function renderInfoBarQuotesContent(item) {
    const wrap = document.createElement('div');
    wrap.className = 'info-bar-quotes';
    const bySymbol = new Map(((infoBarQuotes && infoBarQuotes.items) || []).map((q) => [q.symbol, q]));

    item.symbols.forEach((symbol) => {
      const quote = bySymbol.get(symbol);
      if (!quote) return; // moeda pedida que não veio no cache é omitida

      const bid = Number(quote.bid);
      const changePct = Number(quote.changePct);
      const direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
      const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';

      const span = document.createElement('span');
      span.className = 'info-bar-quote';
      span.innerHTML =
        `<em>${symbol}</em>` +
        `${Number.isFinite(bid) ? bid.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}` +
        `<b class="info-bar-change ${direction}">${arrow}${Number.isFinite(changePct) ? Math.abs(changePct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '0,0'}%</b>`;
      wrap.appendChild(span);
    });

    return wrap;
  }

  // ---------- clima (seção 5 da doc do clima) ----------

  const WEATHER_LABELS = {
    clear: 'Céu limpo', partly_cloudy: 'Parcialmente nublado', cloudy: 'Nublado', fog: 'Neblina',
    drizzle: 'Garoa', rain: 'Chuva', storm: 'Tempestade',
  };
  const WEATHER_SHORT = { partly_cloudy: 'Parc. nublado' };

  const SUN = '#F7C948'; const CLOUD = '#D6D3E3'; const RAIN = '#5AA3DC'; const MUTED = '#B9B5CC';
  const CLOUD_PATH = 'M17.5 20H9a4 4 0 1 1 .8-7.9A5 5 0 0 1 19 13.5a3.3 3.3 0 0 1-1.5 6.5Z';
  const HIGH_CLOUD = 'M17.5 15H8a4 4 0 1 1 .8-7.9A5 5 0 0 1 18 8.5a3.3 3.3 0 0 1-.5 6.5Z';
  const WEATHER_ICONS = {
    clear: `<circle cx="12" cy="12" r="4.5" fill="${SUN}"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round"/>`,
    partly_cloudy: `<circle cx="9" cy="9" r="3.5" fill="${SUN}"/><path d="M9 2.5v1.5M3.5 9H2M4.4 4.4l1 1M13.6 4.4l-1 1" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round"/><path d="${CLOUD_PATH}" fill="${CLOUD}"/>`,
    cloudy: `<path d="M17.5 18H8a4.5 4.5 0 1 1 .9-8.9A5.5 5.5 0 0 1 19 11a3.5 3.5 0 0 1-1.5 7Z" fill="${CLOUD}"/>`,
    fog: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M5 18h14M7 21h10" stroke="${MUTED}" stroke-width="1.8" stroke-linecap="round"/>`,
    drizzle: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M10 18l-.7 2.5M15 18l-.7 2.5" stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round"/>`,
    rain: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round"/>`,
    storm: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M12.5 15.5 10 19.5h3l-1.5 3.5" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  };

  function weatherIcon(condition, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    svg.innerHTML = WEATHER_ICONS[condition] || WEATHER_ICONS.cloudy;
    return svg;
  }

  /** Inteiro + "°"; negativo com "−" (U+2212). */
  function formatTemperature(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return '--°';
    return `${n < 0 ? '\u2212' : ''}${Math.abs(n)}°`;
  }

  function formatWeekday(isoDate) {
    try {
      const raw = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE })
        .format(new Date(`${isoDate}T12:00:00-03:00`)).replace('.', '');
      return raw.charAt(0).toUpperCase() + raw.slice(1, 3);
    } catch (_) { return '---'; }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderInfoBarWeatherContent(item) {
    const weather = infoBarWeather;
    const days = WindoorPlayer.feed.upcomingWeatherDays(weather, new Date(), WindoorPlayer.config.INFO_BAR_TIMEZONE);

    if (item.mode === 'days') {
      const wrap = el('div', 'info-bar-weather-days');
      days.slice(0, 3).forEach((day) => {
        const group = el('span', 'info-bar-weather-day');
        group.appendChild(el('b', '', formatWeekday(day.date)));
        group.appendChild(weatherIcon(day.condition, 'info-bar-weather-icon-sm'));
        group.appendChild(document.createTextNode(formatTemperature(day.max)));
        group.appendChild(el('i', '', formatTemperature(day.min)));
        wrap.appendChild(group);
      });
      return wrap;
    }

    const wrap = el('div', 'info-bar-weather');
    const condition = weather.current.condition;
    wrap.appendChild(weatherIcon(condition, 'info-bar-weather-icon'));
    wrap.appendChild(el('span', 'info-bar-weather-temp', formatTemperature(weather.current.temperature)));
    const label = el('span', 'info-bar-weather-label', item.mode === 'now'
      ? (WEATHER_LABELS[condition] || '')
      : (WEATHER_SHORT[condition] || WEATHER_LABELS[condition] || ''));
    wrap.appendChild(label);

    if (item.mode === 'today' && days[0]) {
      wrap.appendChild(el('span', 'info-bar-weather-dot'));
      const min = el('span', 'info-bar-weather-range');
      min.appendChild(el('em', '', 'Mín'));
      min.appendChild(document.createTextNode(` ${formatTemperature(days[0].min)}`));
      const max = el('span', 'info-bar-weather-range');
      max.appendChild(el('em', '', 'Máx'));
      max.appendChild(document.createTextNode(` ${formatTemperature(days[0].max)}`));
      wrap.appendChild(min);
      wrap.appendChild(max);
    }

    // "Agora" que não cabe: cai para o rótulo curto (seção 5.1); a reticência vem do CSS.
    if (item.mode === 'now' && WEATHER_SHORT[condition]) {
      requestAnimationFrame(() => {
        if (label.scrollWidth > label.clientWidth) label.textContent = WEATHER_SHORT[condition];
      });
    }
    return wrap;
  }

  function renderInfoBarCenterContent(item) {
    const centerEl = document.getElementById('info-bar-center');
    if (!centerEl) return;
    centerEl.textContent = '';
    if (!item) return;

    if (item.type === 'text') {
      const span = document.createElement('span');
      span.className = 'info-bar-text';
      span.textContent = item.text;
      centerEl.appendChild(span);
    } else if (item.type === 'image') {
      const img = document.createElement('img');
      img.className = 'info-bar-image';
      img.alt = '';
      img.src = infoBarImageBlobUrls.get(item.url) || item.url;
      centerEl.appendChild(img);
    } else if (item.type === 'quotes') {
      centerEl.appendChild(renderInfoBarQuotesContent(item));
    } else if (item.type === 'weather') {
      centerEl.appendChild(renderInfoBarWeatherContent(item));
    }
  }

  function showInfoBarItem(item) {
    fadeSwap(document.getElementById('info-bar-center'), () => renderInfoBarCenterContent(item));
  }

  /**
   * Rodízio do centro (seção 6.3): a cada `rotationSeconds`, reavalia os itens elegíveis
   * (imagem pode ter acabado de baixar, cotação pode ter ficado velha) e avança. Sem
   * nenhum elegível, o centro fica vazio — sem mensagem de erro na tela.
   */
  function startInfoBarRotation(infoBar) {
    if (infoBarRotationTimer) { clearInterval(infoBarRotationTimer); infoBarRotationTimer = null; }

    const items = infoBar.items || [];
    const now = new Date();
    let eligible = eligibleInfoBarItems(items, now);
    let index = 0;

    infoBarEligibleCount = eligible.length;
    const appliedKey = `${items.length}:${eligible.length}`;
    if (appliedKey !== infoBarAppliedKey) {
      infoBarAppliedKey = appliedKey;
      WindoorPlayer.logger.info('Configuração da barra de informações aplicada', {
        itemsCount: items.length, eligibleCount: eligible.length,
      });
    }

    showInfoBarItem(eligible[0] || null);
    if (eligible.length <= 1) return;

    const ms = Math.max(1, infoBar.rotationSeconds) * 1000;
    infoBarRotationTimer = setInterval(() => {
      eligible = eligibleInfoBarItems(items, new Date());
      if (eligible.length === 0) { showInfoBarItem(null); return; }
      index = (index + 1) % eligible.length;
      showInfoBarItem(eligible[index]);
    }, ms);
  }

  function renderInfoBar(infoBar) {
    const bar = document.getElementById('info-bar');
    if (!bar) return;

    if (infoBarRotationTimer) { clearInterval(infoBarRotationTimer); infoBarRotationTimer = null; }

    if (!infoBar.enabled) {
      bar.style.display = 'none';
      renderInfoBarCenterContent(null);
      return;
    }
    bar.style.display = 'flex';
    startInfoBarRotation(infoBar);
  }

  /** Cotações recém-buscadas (seção 3.3/6.4): reaplica o rodízio sem reiniciar a barra. */
  function setInfoBarQuotes(quotes) {
    infoBarQuotes = quotes;
    if (feed && feed.infoBar && feed.infoBar.enabled) startInfoBarRotation(feed.infoBar);
  }

  /** Clima recém-buscado do local da barra: reaplica o rodízio sem reiniciar a barra. */
  function setInfoBarWeather(weather) {
    infoBarWeather = weather;
    if (feed && feed.infoBar && feed.infoBar.enabled) startInfoBarRotation(feed.infoBar);
  }

  /** Local do item de clima do feed atual (ou null): o app usa para buscar e filtrar eventos. */
  function infoBarWeatherLocation() {
    const items = (feed && feed.infoBar && feed.infoBar.items) || [];
    const item = items.find((i) => i.type === 'weather');
    return item ? item.location : null;
  }

  // ---------- barra de informações: horário/data (independentes do rodízio do centro) ----------

  function formatInfoBarTime(date) {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE,
      }).format(date);
    } catch (_) { return '--:--'; }
  }

  function formatInfoBarDate(date) {
    try {
      const parts = new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: 'short', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE,
      }).formatToParts(date);
      const day = (parts.find((p) => p.type === 'day') || {}).value || '--';
      const month = ((parts.find((p) => p.type === 'month') || {}).value || '--').replace('.', '');
      return `${day}/${month.charAt(0).toUpperCase()}${month.slice(1)}`;
    } catch (_) { return '--/--'; }
  }

  function applyInfoBarLeft(showDate) {
    const clockGroup = document.getElementById('info-bar-clock-group');
    const dateGroup = document.getElementById('info-bar-date-group');
    const clockText = document.getElementById('info-bar-clock');
    const dateText = document.getElementById('info-bar-date');
    if (!clockGroup || !dateGroup) return;
    const now = new Date();
    if (clockText) clockText.textContent = formatInfoBarTime(now);
    if (dateText) dateText.textContent = formatInfoBarDate(now);
    clockGroup.style.display = showDate ? 'none' : 'flex';
    dateGroup.style.display = showDate ? 'flex' : 'none';
  }

  /** Alterna horário ⇄ data a cada 5 s, nunca os dois juntos, no fuso da unidade. */
  function startInfoBarClock() {
    if (infoBarClockTimer) clearInterval(infoBarClockTimer);
    infoBarClockShowDate = false;
    fadeSwap(document.getElementById('info-bar-left'), () => applyInfoBarLeft(infoBarClockShowDate));
    infoBarClockTimer = setInterval(() => {
      infoBarClockShowDate = !infoBarClockShowDate;
      fadeSwap(document.getElementById('info-bar-left'), () => applyInfoBarLeft(infoBarClockShowDate));
    }, WindoorPlayer.config.INFO_BAR_CLOCK_TICK_MS);
  }

  // ---------- entrada pública ----------

  /** Recebe o feed já normalizado (WindoorPlayer.feed.normalizeFeed). */
  function setFeed(next) {
    if (!next) return;
    lastTickMs = Date.now();

    const layoutChanged = !feed || feed.layout !== next.layout;
    const unchangedZones = !layoutChanged && next.zones.every((zone) => sameSequence(zone.position, zone));

    if (WindoorPlayer.feed.totalItems(next) === 0) {
      feed = next;
      if (layoutChanged) buildZones(next.layout, next.zones);
      next.zones.forEach((zone) => startZone(zone.position));
      renderInfoBar(next.infoBar);
      showFallback();
      return;
    }

    hideFallback();
    renderInfoBar(next.infoBar);

    if (unchangedZones) { feed = next; return; }   // nada mudou: não reinicia as sequências
    if (layoutChanged) buildZones(next.layout, next.zones);

    feed = next;
    next.zones.forEach((zone) => startZone(zone.position));
  }

  function showFallback() { showView('fallback'); }
  function hideFallback() { showView('content'); }

  function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  /** Conteúdo no ar na primeira zona com item — é o que o heartbeat reporta. */
  function currentContent() {
    for (const state of zoneStates.values()) {
      if (state.displayed) return state.displayed;
    }
    return null;
  }

  function lastTickAt() { return lastTickMs; }

  /** Resumo para o heartbeat diagnosticar "barra sem itens na tela" (seção 6.5). */
  function infoBarSummary() {
    const bar = feed && feed.infoBar;
    return {
      enabled: !!(bar && bar.enabled),
      items: bar ? (bar.items || []).length : 0,
      eligible: infoBarEligibleCount,
    };
  }

  /** Compatibilidade com o watchdog, que só precisa saber que o loop está vivo. */
  function startLoop() { startInfoBarClock(); }

  return {
    setFeed,
    setStatus,
    setInfoBarQuotes,
    setInfoBarWeather,
    infoBarWeatherLocation,
    startLoop,
    currentContent,
    infoBarSummary,
    showFallback,
    hideFallback,
    showView,
    lastTickAt,
  };
})();
