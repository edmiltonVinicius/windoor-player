// Ponte entre o sistema de comandos do Windoor e o agente de kiosk nativo.
// window.WindoorKiosk é consultado por commands.js para 'restart' e 'update_version'.
// No Fully Kiosk Browser, window.fully expõe a API de administração local.
(function () {
  'use strict';

  const { logger } = WindoorPlayer;

  function fullyRestart() {
    if (typeof window.fully === 'undefined' || typeof window.fully.rebootDevice !== 'function') {
      logger.warn('Fully Kiosk não disponível: comando restart ignorado');
      return;
    }
    logger.info('Reiniciando dispositivo via Fully Kiosk');
    window.fully.rebootDevice();
  }

  window.WindoorKiosk = {
    restart: fullyRestart,
  };
})();
