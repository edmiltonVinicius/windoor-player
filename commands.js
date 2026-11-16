window.WindoorPlayer = window.WindoorPlayer || {};

WindoorPlayer.commands = (function () {
  function isSafeUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
    catch (_) { return false; }
  }

  function execute(cmd, socket) {
    const { logger } = WindoorPlayer;
    const ack = (status, result) => {
      try {
        const body = { id: cmd && cmd.id, status };
        if (result) body.result = result;
        socket.emit('command:ack', body);
      } catch (_) {}
    };
    if (!cmd || !cmd.type) { ack('failed'); return; }

    logger.info('Comando remoto recebido', { id: cmd.id, type: cmd.type });

    switch (cmd.type) {
      case 'reload':
        ack('acknowledged');
        setTimeout(() => location.reload(), 200);
        break;

      case 'change_url': {
        const url = cmd.payload && cmd.payload.url;
        if (!isSafeUrl(url)) {   // rejeita javascript:, data:, etc.
          logger.warn('Comando change_url com URL inválida', { id: cmd.id });
          ack('failed');
          return;
        }
        ack('acknowledged');
        setTimeout(() => { location.href = url; }, 200);
        break;
      }

      case 'logout':
        // CMS forçou o despareamento (ex.: suporte precisa reparear a tela). O token já foi
        // invalidado no servidor; aqui só limpamos a identidade local e voltamos ao pareamento.
        ack('acknowledged');
        logger.info('Comando de logout remoto: voltando à tela de pareamento', { id: cmd.id });
        setTimeout(() => {
          WindoorPlayer.config.clearIdentity();
          location.reload();
        }, 200);
        break;

      // "Capturar tela agora" do painel. Ao contrário dos demais, o ack só pode sair
      // DEPOIS da captura, carregando o `screenshotId` — é com ele que o painel fecha o
      // ciclo e mostra a imagem. Por isso não cai no `default`, que confirma na hora.
      case 'screenshot': {
        const { capture } = WindoorPlayer;
        if (!capture) { logger.warn('Comando screenshot sem módulo de captura', { id: cmd.id }); ack('failed'); return; }
        capture.capture('on_demand', { commandId: cmd.id, awaitUpload: true })
          .then((screenshotId) => {
            if (!screenshotId) {
              logger.warn('Captura sob demanda não gerou evidência', { id: cmd.id });
              ack('failed');
              return;
            }
            logger.info('Captura sob demanda concluída', { id: cmd.id, screenshotId });
            ack('acknowledged', { screenshotId });
          })
          .catch((error) => {
            logger.error('Captura sob demanda falhou', { id: cmd.id, error: error.message });
            ack('failed');
          });
        break;
      }

      // 'restart' (reiniciar o dispositivo) e 'update_version' (baixar nova
      // versão) não existem no navegador: quem executa é o agente de kiosk
      // nativo (systemd, Fully Kiosk) exposto como window.WindoorKiosk.
      case 'restart':
      case 'update_version':
      default:
        if (typeof window.WindoorKiosk !== 'undefined' && typeof window.WindoorKiosk[cmd.type] === 'function') {
          try { window.WindoorKiosk[cmd.type](cmd.payload || {}); ack('acknowledged'); }
          catch (error) { logger.error('Agente de kiosk falhou ao executar comando', { type: cmd.type, error: error.message }); ack('failed'); }
        } else {
          logger.info('Comando repassado ao agente de kiosk', { id: cmd.id, type: cmd.type });
          ack('acknowledged');
        }
    }
  }

  function start(socket) {
    socket.on('command', (cmd) => execute(cmd, socket));
  }

  return { start, execute, isSafeUrl };
})();
