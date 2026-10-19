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

  // 2) estado inicial: API → cache local
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

  // 3) tempo real
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
    });

    commands.start(socket);
  }

  // 4) rede de segurança: re-busca periódica, também usada na reconexão e na
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

  await loadInitial();
  connectSocket();
  render.startLoop();
  heartbeat.start();
  setInterval(refresh, config.REFRESH_INTERVAL_MS);
  if (wakelock) wakelock.start();
  if (watchdog) watchdog.start();          // só aqui: o loop de conteúdo já começou
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
})();
