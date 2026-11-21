// Orquestrador: configuração → identidade → estado inicial → tempo real.
(async function start() {
  const {
    config, api, cache, feed, render, logger, heartbeat, commands, playlog, capture, wakelock, watchdog,
    pairing, unpair, newsfeed, newslog,
  } = WindoorPlayer;

  let inactiveRetryId = null;
  /** Itens exibíveis no último feed aplicado — decide a captura inicial do player novo. */
  let lastFeedItems = 0;

  // 0) estado terminal de configuração: sem API_URL não há nada a fazer.
  if (!config.API_URL) { render.showView('setup-error'); return; }

  // Disponível em qualquer tela (pareamento ou conteúdo): técnico segura o canto
  // inferior direito para desparear o totem manualmente.
  if (unpair) unpair.init();

  // 1) identidade
  window.addEventListener('windoor:unauthorized', () => {
    // Token revogado (player excluído/repareado): apaga e volta ao pareamento.
    config.clearIdentity();
    location.reload();
  });
  window.addEventListener('windoor:inactive', () => {
    render.showView('inactive');
    scheduleInactiveRetry();
  });

  if (!config.getToken()) {
    render.showView('pairing');
    await pairing.run();
  }

  // 2) cotações da barra de informações: cache local primeiro, depois a API
  // (`GET /info-bar/quotes`, atualizada pelo backend a cada 45 min). Falha aqui
  // (ex.: backend fora do ar) é tolerada e só mantém o cache como está.
  async function loadQuotesFromCache() {
    try {
      const cached = await cache.readQuotes();
      if (cached) render.setInfoBarQuotes(cached);
    } catch (_) { /* sem IndexedDB, segue sem cotações */ }
  }

  async function refreshQuotes() {
    try {
      const data = await api.get('/info-bar/quotes');
      if (data && Array.isArray(data.items)) {
        const fetchedAt = Date.parse(data.fetchedAt);
        const quotes = { items: data.items, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now() };
        await cache.saveQuotes(quotes);
        render.setInfoBarQuotes(quotes);
      }
    } catch (error) {
      logger.info('Cotações da barra de informações não atualizadas (serviço ainda não disponível)', {
        error: error.message, code: error.code,
      });
    }
  }

  // 3) clima da barra: mesmo padrão das cotações, mas por local (o do item de clima do
  // feed). Sem item de clima, não busca nada.
  function toWeatherState(data) {
    const fetchedAt = Date.parse(data.fetchedAt);
    return { ...data, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now() };
  }

  async function loadWeatherFromCache() {
    try {
      const cached = await cache.readWeather();
      if (cached) render.setInfoBarWeather(cached);
    } catch (_) { /* sem IndexedDB, segue sem clima */ }
  }

  async function refreshWeather() {
    const loc = render.infoBarWeatherLocation();
    if (!loc) return;
    try {
      const data = await api.get(`/info-bar/weather?lat=${encodeURIComponent(loc.latitude)}&lon=${encodeURIComponent(loc.longitude)}`);
      if (data && data.current) {
        const weather = toWeatherState(data);
        await cache.saveWeather(weather);
        render.setInfoBarWeather(weather);
      }
    } catch (error) {
      // 404 = o servidor ainda não buscou este local; o item fica fora do rodízio até chegar.
      logger.info('Clima da barra de informações não atualizado', { error: error.message, code: error.code });
    }
  }

  // 3.5) notícias (seção 6.1/9.1 do plano de Notícias): `GET /player/news`, normalizado
  // por `newsfeed.js`; a posição (`unit.newsPosition`) viaja junto de `GET /player/contents`
  // (contrato em `contratos.md`) — `// TODO(produto):` o backend real desta sessão ainda não
  // manda esse campo (nem em `GET /player/contents`, nem em `PUT /units/:id/announcement-settings`
  // — conferido em `src/domain/clients/entities/unit_announcement_settings.ts` e no use case
  // `list_active_contents_for_player.usecase.ts`), então por ora `config.getNewsPosition()`
  // sempre volta `null` e a notícia nunca aparece — sinalizar para o time de backend corrigir.
  const NEWS_CACHE_KEY = 'newsCache';
  const NEWS_POLL_MS = 30 * 60 * 1000;         // rede de segurança (seção "Regras importantes")
  const NEWS_JITTER_MAX_MS = 60 * 1000;        // jitter 0–60s antes de refazer o GET após o evento
  /** Último feed de comunicado/playlist normalizado — a notícia é sobreposta nele antes de renderizar. */
  let lastNormalizedFeed = null;
  /** Último `GET /player/news` normalizado com sucesso (não persiste falha de rede). */
  let lastNewsFeed = { generatedAt: new Date().toISOString(), items: [] };
  /** Última entrada de cache local de notícia (`{ items, cachedAtMs }`), para o fallback de 48h. */
  let lastNewsCacheEntry = null;
  /** Cursor da rotação circular de notícia (seção 6 do plano): precisa sobreviver entre
   * chamadas de `renderWithNews`, senão toda atualização de feed (poll de 30min, socket,
   * `content:updated`) reiniciava o round robin em 0 — com um só slot de comunicado na
   * zona, a 2ª notícia aprovada nunca entrava no ar. */
  let newsRotationIndex = 0;

  function applyNewsPositionFromContents(raw) {
    config.setNewsPosition(raw && raw.newsPosition);
  }

  /** Sobrepõe a rotação de notícia nos slots de comunicado do último feed carregado e renderiza. */
  function renderWithNews() {
    if (!lastNormalizedFeed) return;
    const newsPosition = config.getNewsPosition();
    if (!newsPosition) { render.setFeed(lastNormalizedFeed); return; }

    const selection = newsfeed.selectNewsSource(lastNewsFeed, lastNewsCacheEntry, new Date());
    const rotation = { items: selection.items, fallback: lastNormalizedFeed.announcements && lastNormalizedFeed.announcements.fallback };
    // O `render.js` gira de novo a cada exibição real na tela (ver `showItem`) — isto
    // aqui só garante que ele sempre tenha a lista atual de notícias válidas.
    render.setNewsRotationPool(rotation);
    let cursor = newsRotationIndex;
    const withNews = {
      ...lastNormalizedFeed,
      zones: lastNormalizedFeed.zones.map((zone) => {
        const items = feed.attachNewsToAnnouncementSlots(zone.items, newsPosition, rotation, cursor);
        cursor += items.filter((item) => item && item.isAnnouncement).length;
        return { ...zone, items };
      }),
    };
    newsRotationIndex = rotation.items.length > 0 ? cursor % rotation.items.length : 0;
    render.setFeed(withNews);
  }

  async function loadNewsFromCache() {
    try {
      lastNewsCacheEntry = await cache.readEvidence(NEWS_CACHE_KEY);
    } catch (_) { lastNewsCacheEntry = null; }
  }

  async function refreshNews() {
    try {
      const normalized = newsfeed.normalizeNewsFeed(await api.get('/player/news'));
      lastNewsFeed = normalized;
      lastNewsCacheEntry = newsfeed.toCacheEntry(normalized);
      await cache.saveEvidence(NEWS_CACHE_KEY, lastNewsCacheEntry);
      renderWithNews();
      return true;
    } catch (error) {
      logger.info('Feed de notícias não atualizado (serviço ainda não disponível ou offline)', {
        error: error.message, code: error.code,
      });
      return false;
    }
  }

  // 4) estado inicial: API → cache local
  async function loadInitial() {
    try {
      const raw = await api.get('/player/contents');
      applyNewsPositionFromContents(raw);
      const normalized = feed.normalizeFeed(raw);
      await cache.saveFeed(normalized);
      cache.pruneMedia(normalized);
      cache.preloadMedia(normalized);
      render.setStatus('online');
      lastNormalizedFeed = normalized;
      renderWithNews();
      applyEvidenceSettings(normalized);
    } catch (error) {
      if (error && error.status === 403) return;            // tela #inactive cuida disso
      // Offline: o feed salvo pode conter conteúdo que venceu desde então.
      const cached = feed.normalizeFeed(await cache.readFeed());
      render.setStatus('offline (usando cache local)');
      lastNormalizedFeed = cached;
      renderWithNews();
      applyEvidenceSettings(cached);
      logger.error('Falha ao carregar o feed da API, usando cache local', {
        error: error.message, code: error.code, totalItens: feed.totalItems(cached),
      });
    }
  }

  // 4.1) evidências de exibição: o intervalo de captura vem na config do cliente, junto
  // com o feed (e também pelo socket, quando a equipe Windoor muda no painel).
  function applyEvidenceSettings(normalized) {
    if (!normalized) return;
    lastFeedItems = feed.totalItems(normalized);
    if (!capture || !normalized.evidenceSettings) return;
    capture.setIntervalMinutes(normalized.evidenceSettings.screenshotIntervalMinutes);
  }

  // 5) tempo real
  function connectSocket() {
    if (typeof io !== 'function') {
      logger.warn('socket.io indisponível; player segue só com HTTP');
      return;
    }
    const socket = io(config.SOCKET_URL, { auth: { token: config.getToken() }, extraHeaders: config.EXTRA_HEADERS });

    socket.on('connect', () => {
      render.setStatus('online');
      refresh();
      // Voltou a rede: manda o que acumulou offline (seções 2.5 e 2.6).
      if (capture) capture.flush();
      if (playlog) playlog.flush();
      if (newslog) newslog.flush();
    });
    socket.on('disconnect', () => render.setStatus('offline (usando cache local)'));
    socket.on('connect_error', (e) => {
      if (e && e.message === 'unauthorized') window.dispatchEvent(new CustomEvent('windoor:unauthorized'));
      else render.setStatus('offline (usando cache local)');
    });
    socket.on('content:updated', async (payload) => {
      // O evento carrega o mesmo formato de GET /player/contents.
      applyNewsPositionFromContents(payload && payload.contents);
      const normalized = feed.normalizeFeed(payload && payload.contents);
      await cache.saveFeed(normalized);
      cache.pruneMedia(normalized);
      cache.preloadMedia(normalized);
      lastNormalizedFeed = normalized;
      renderWithNews();
      applyEvidenceSettings(normalized);
      refreshWeather();   // o local do clima pode ter mudado junto com a barra
    });
    socket.on('client.evidence_settings.updated', (payload) => {
      if (!capture || !payload) return;
      logger.info('Intervalo de captura atualizado pelo painel', {
        minutos: payload.screenshotIntervalMinutes,
      });
      capture.setIntervalMinutes(payload.screenshotIntervalMinutes);
    });
    socket.on('info_bar.weather.updated', async (payload) => {
      // O evento vai para todos os players; cada um só aplica o do seu local.
      const loc = render.infoBarWeatherLocation();
      if (!loc || !payload || !payload.snapshot) return;
      if (feed.weatherKey(payload.lat, payload.lon) !== feed.weatherKey(loc.latitude, loc.longitude)) return;
      const weather = toWeatherState(payload.snapshot);
      await cache.saveWeather(weather);
      render.setInfoBarWeather(weather);
    });
    socket.on('info_bar.quotes.updated', async (payload) => {
      // O backend manda `fetchedAt` em ISO 8601; a elegibilidade (seção 6.4) compara
      // contra um timestamp numérico, por isso convertemos aqui.
      if (!payload || !Array.isArray(payload.items)) return;
      const fetchedAt = Date.parse(payload.fetchedAt);
      const quotes = { items: payload.items, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now() };
      await cache.saveQuotes(quotes);
      render.setInfoBarQuotes(quotes);
    });
    socket.on('news.feed.updated', () => {
      // Jitter 0–60s (seção 6.1 do plano de Notícias): evita que todos os players da
      // base refaçam o GET no mesmo instante quando a coleta termina.
      const jitterMs = Math.floor(Math.random() * NEWS_JITTER_MAX_MS);
      setTimeout(refreshNews, jitterMs);
    });

    commands.start(socket);
  }

  // 6) rede de segurança: re-busca periódica, também usada na reconexão e na
  // tela de player desativado.
  async function refresh() {
    try {
      const raw = await api.get('/player/contents');
      applyNewsPositionFromContents(raw);
      const normalized = feed.normalizeFeed(raw);
      await cache.saveFeed(normalized);
      cache.preloadMedia(normalized);
      render.setStatus('online');
      lastNormalizedFeed = normalized;
      renderWithNews();
      applyEvidenceSettings(normalized);
      return true;
    } catch (_) { return false; }
  }

  function scheduleInactiveRetry() {
    if (inactiveRetryId) return;
    inactiveRetryId = setInterval(async () => {
      const ok = await refresh();
      if (ok) {
        clearInterval(inactiveRetryId);
        inactiveRetryId = null;
        render.showView('content');
      }
    }, 60000);
  }

  await loadQuotesFromCache();
  await loadWeatherFromCache();
  await loadNewsFromCache();
  await loadInitial();

  // 7) evidências: recupera o que não foi confirmado antes do último reload e volta a
  // contar/capturar. `bootstrap` também cobre o player recém-pareado (seção 2.1.1): com
  // playlist, o `first_play` do primeiro item dispara sozinho; sem nenhum item, ele força
  // uma captura para o player aparecer no histórico de qualquer forma.
  if (playlog) { await playlog.hydrate(); playlog.start(); }
  if (newslog) { await newslog.hydrate(); newslog.start(); }
  if (capture) await capture.bootstrap(lastFeedItems > 0);

  connectSocket();
  render.startLoop();
  heartbeat.start();
  setInterval(refresh, config.REFRESH_INTERVAL_MS);
  refreshQuotes();
  setInterval(refreshQuotes, config.INFO_BAR_QUOTES_REFRESH_MS);
  refreshWeather();
  setInterval(refreshWeather, config.INFO_BAR_WEATHER_REFRESH_MS);
  refreshNews();
  setInterval(refreshNews, NEWS_POLL_MS);
  if (wakelock) wakelock.start();
  if (watchdog) watchdog.start();          // só aqui: o loop de conteúdo já começou
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
})();
