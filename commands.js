window.WindoorPlayer = window.WindoorPlayer || {};

WindoorPlayer.commands = (function () {
  function isSafeUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
    catch (_) { return false; }
  }

  function execute(cmd, socket) {
    const { logger } = WindoorPlayer;
    const ack = (status) => { try { socket.emit('command:ack', { id: cmd && cmd.id, status }); } catch (_) {} };
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
