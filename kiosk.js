// Ponte entre o sistema de comandos do Windoor e o agente de kiosk nativo.
// window.WindoorKiosk é consultado por commands.js para 'restart' e 'update_version'.
// Usa a API HTTP local do Fully Kiosk Browser (Remote Administration, porta 2323).
(function () {
  'use strict';

  const { logger } = WindoorPlayer;

  function fullyRestart(payload) {
    const password = payload && payload.fullyPassword;
    if (!password) {
      logger.warn('Comando restart: fullyPassword ausente no payload, abortando reinício');
      return;
    }

    const url = `http://localhost:2323/?cmd=rebootDevice&password=${encodeURIComponent(password)}&type=json`;
    logger.info('Reiniciando dispositivo via Fully Kiosk Remote Admin');

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.status === 'OK') {
          logger.info('Reinício solicitado com sucesso ao Fully Kiosk');
        } else {
          logger.warn('Fully Kiosk retornou resposta inesperada no reboot', { data });
        }
      })
      .catch((err) => {
        logger.error('Falha ao chamar API do Fully Kiosk', { error: err.message });
      });
  }

  window.WindoorKiosk = {
    restart: fullyRestart,
  };
})();
