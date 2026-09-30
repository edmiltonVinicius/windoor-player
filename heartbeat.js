const TotemPlayer = window.TotemPlayer || (window.TotemPlayer = {});

TotemPlayer.heartbeat = (function () {
  const INTERVALO_MS = 30000;

  function usoMemoriaMb() {
    // performance.memory só existe em navegadores baseados em Chromium — é o caso
    // esperado no totem (Chrome/Chromium/Edge em modo kiosk).
    if (performance.memory) {
      return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
    }
    return null;
  }

  async function enviar() {
    const { TOTEM_ID, API_URL, VERSAO_PLAYER } = TotemPlayer.config;
    const oferta = TotemPlayer.render.ofertaAtual();

    try {
      await fetch(`${API_URL}/totems/${TOTEM_ID}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerVersion: VERSAO_PLAYER,
          lastOfferId: oferta ? oferta.id : null,
          memoryUsageMb: usoMemoriaMb(),
        }),
      });
    } catch (erro) {
      // Sem internet é esperado às vezes — não precisa virar erro ruidoso,
      // só registra pra eventual auditoria quando a conexão voltar.
      TotemPlayer.logger.info('Heartbeat não enviado (provavelmente offline)', {
        erro: erro.message,
      });
    }
  }

  function iniciar() {
    enviar();
    setInterval(enviar, INTERVALO_MS);
  }

  return { iniciar };
})();
