window.WindoorPlayer = window.WindoorPlayer || {};

// Watchdog de travamento em JS: se o loop de rotação (render.js) não "bater"
// por muito mais tempo que o esperado, recarrega a página. Complementa (não
// substitui) o watchdog do agente de kiosk nativo.
// Só é armado depois que o loop de conteúdo começou — nas telas de
// pareamento, configuração e desativado não existe tick e um reload
// apagaria o código que a pessoa está digitando.
WindoorPlayer.watchdog = (function () {
  const TIMEOUT_MULTIPLIER = 3;
  const CHECK_INTERVAL_MS = 5000;
  let timerId = null;

  function check() {
    const { render, logger, config } = WindoorPlayer;
    if (!render) return;

    const expectedMs = config.CONTENT_DURATION_MS * TIMEOUT_MULTIPLIER;
    const elapsedMs = Date.now() - render.lastTickAt();

    if (elapsedMs > expectedMs) {
      if (logger) logger.error('Watchdog detectou loop de exibição travado, recarregando a página', { elapsedMs, expectedMs });
      location.reload();
    }
  }

  function start() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(check, CHECK_INTERVAL_MS);
  }

  function stop() { if (timerId) { clearInterval(timerId); timerId = null; } }

  return { start, stop, check };
})();
