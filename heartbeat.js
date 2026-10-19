window.WindoorPlayer = window.WindoorPlayer || {};

WindoorPlayer.heartbeat = (function () {
  let timerId = null;

  function memoryUsageMb() {
    // performance.memory só existe em navegadores baseados em Chromium — é o
    // caso esperado no player (Chrome/Chromium em modo kiosk).
    if (typeof performance !== 'undefined' && performance.memory) {
      return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
    }
    return null;
  }

  async function send() {
    const { config, api, render, logger } = WindoorPlayer;
    if (!config.getToken()) return;                 // só depois de pareado
    const content = render && render.currentContent ? render.currentContent() : null;

    try {
      await api.post('/player/heartbeat', {
        playerVersion: config.PLAYER_VERSION,
        // O item traz o id do conteúdo em `contentId`; `id` é o id do item na playlist.
        lastContentId: content ? content.contentId || content.id : null,
        memoryUsageMb: memoryUsageMb(),
      });
    } catch (error) {
      // Sem internet é esperado às vezes — não vira erro ruidoso.
      logger.info('Heartbeat não enviado (provavelmente offline)', { error: error.message, code: error.code });
    }
  }

  function start() {
    if (timerId) clearInterval(timerId);
    send();
    timerId = setInterval(send, WindoorPlayer.config.HEARTBEAT_INTERVAL_MS);
  }

  function stop() { if (timerId) { clearInterval(timerId); timerId = null; } }

  return { start, stop, send };
})();
