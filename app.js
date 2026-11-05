// Orquestrador: configuração → identidade → estado inicial → tempo real.
(async function start() {
  const { config, api, cache, feed, render, logger, heartbeat, commands, proofOfPlay, wakelock, watchdog, pairing } = WindoorPlayer;

  let inactiveRetryId = null;

  // 0) estado terminal de configuração: sem API_URL não há nada a fazer.
  if (!config.API_URL) { render.showView('setup-error'); return; }

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

  // 4) estado inicial: API → cache local
  async function loadInitial() {
    try {
      const normalized = feed.normalizeFeed(await api.get('/player/contents'));
      await cache.saveFeed(normalized);
      cache.pruneImages(normalized);
      cache.preloadImages(normalized);
      render.setStatus('online');
      render.setFeed(normalized);
    } catch (error) {
      if (error && error.status === 403) return;            // tela #inactive cuida disso
      // Offline: o feed salvo pode conter conteúdo que venceu desde então.
      const cached = feed.normalizeFeed(await cache.readFeed());
      render.setStatus('offline (usando cache local)');
      render.setFeed(cached);
      logger.error('Falha ao carregar o feed da API, usando cache local', {
        error: error.message, code: error.code, totalItens: feed.totalItems(cached),
      });
    }
  }

  // 5) tempo real
  function connectSocket() {
    if (typeof io !== 'function') {
      logger.warn('socket.io indisponível; player segue só com HTTP');
      return;
    }
    const socket = io(config.SOCKET_URL, { auth: { token: config.getToken() }, extraHeaders: config.EXTRA_HEADERS });

    socket.on('connect', () => { render.setStatus('online'); refresh(); });
    socket.on('disconnect', () => render.setStatus('offline (usando cache local)'));
    socket.on('connect_error', (e) => {
      if (e && e.message === 'unauthorized') window.dispatchEvent(new CustomEvent('windoor:unauthorized'));
      else render.setStatus('offline (usando cache local)');
    });
    socket.on('content:updated', async (payload) => {
      // O evento carrega o mesmo formato de GET /player/contents.
      const normalized = feed.normalizeFeed(payload && payload.contents);
      await cache.saveFeed(normalized);
      cache.pruneImages(normalized);
      cache.preloadImages(normalized);
      render.setFeed(normalized);
      refreshWeather();   // o local do clima pode ter mudado junto com a barra
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

    commands.start(socket);
  }

  // 6) rede de segurança: re-busca periódica, também usada na reconexão e na
  // tela de player desativado.
  async function refresh() {
    try {
      const normalized = feed.normalizeFeed(await api.get('/player/contents'));
      await cache.saveFeed(normalized);
      cache.preloadImages(normalized);
      render.setStatus('online');
      render.setFeed(normalized);
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
  await loadInitial();
  connectSocket();
  render.startLoop();
  heartbeat.start();
  setInterval(refresh, config.REFRESH_INTERVAL_MS);
  refreshQuotes();
  setInterval(refreshQuotes, config.INFO_BAR_QUOTES_REFRESH_MS);
  refreshWeather();
  setInterval(refreshWeather, config.INFO_BAR_WEATHER_REFRESH_MS);
  if (wakelock) wakelock.start();
  if (watchdog) watchdog.start();          // só aqui: o loop de conteúdo já começou
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
})();
