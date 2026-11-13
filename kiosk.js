// Ponte entre o sistema de comandos do Windoor e o agente de kiosk nativo.
// window.WindoorKiosk é consultado por commands.js para 'restart' e 'update_version'.
// Usa a interface JavaScript do Fully Kiosk Browser (window.fully), que não sofre
// restrições de CORS/mixed-content por rodar dentro do próprio WebView.
// Pré-requisito: Settings → Advanced Web Settings → Enable JavaScript Interface = ON.
(function () {
  'use strict';

  const { logger } = WindoorPlayer;

  function fullyRestart() {
    if (typeof window.fully === 'undefined' || typeof window.fully.restartApp !== 'function') {
      logger.warn('Fully JS interface indisponível (Enable JavaScript Interface desativado?)');
      return;
    }
    logger.info('Reiniciando app via Fully Kiosk JS interface');
    window.fully.restartApp();
  }

  window.WindoorKiosk = {
    restart: fullyRestart,
  };
})();
