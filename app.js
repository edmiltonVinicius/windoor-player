(async function iniciar() {
  const { config, cache, render, logger, heartbeat, commands, wakelock, watchdog } = TotemPlayer;

  async function carregarEstadoInicial() {
    try {
      const resp = await fetch(`${config.API_URL}/totems/${config.TOTEM_ID}/offers`);
      if (!resp.ok) throw new Error('resposta não-ok da API');
      const ofertas = await resp.json();
      await cache.salvarOfertas(ofertas);
      render.definirStatus('online');
      render.definirOfertas(ofertas);
    } catch (erro) {
      // Sem API disponível: cai pro cache local. Como o totem pode ficar
      // horas offline, a lista salva pode conter ofertas cujo dayparting
      // já não é mais válido pro horário atual — o backend normalmente
      // cuida disso, mas aqui precisa ser refeito no cliente.
      const ofertasCache = await cache.lerOfertas();
      const ofertas = cache.filtrarPorDayparting(ofertasCache);
      render.definirStatus('offline (usando cache local)');
      render.definirOfertas(ofertas);
      logger.erro('Falha ao carregar ofertas da API, usando cache local', {
        erro: erro.message,
        totalCache: ofertasCache.length,
        totalAposDayparting: ofertas.length,
      });
    }
  }

  function conectarWebSocket() {
    const socket = io(config.API_URL, { query: { totemId: config.TOTEM_ID } });

    socket.on('connect', () => render.definirStatus('online'));

    socket.on('offer:updated', async (payload) => {
      const novaLista = (payload && payload.offers) || [];
      await cache.salvarOfertas(novaLista);
      render.definirOfertas(novaLista);
    });

    socket.on('disconnect', () => render.definirStatus('offline (usando cache local)'));

    commands.iniciar(socket);
  }

  await carregarEstadoInicial();
  conectarWebSocket();
  render.iniciarLoop();
  heartbeat.iniciar();

  // Mantém a tela sempre ligada (quando a API do navegador existir) e
  // recarrega a página sozinho se o loop de exibição travar.
  if (wakelock) wakelock.iniciar();
  if (watchdog) watchdog.iniciar();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
})();
