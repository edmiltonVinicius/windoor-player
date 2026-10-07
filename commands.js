window.TotemPlayer = window.TotemPlayer || {};

TotemPlayer.commands = (function () {
  function executar(comando) {
    TotemPlayer.logger.info('Comando remoto recebido', comando);

    switch (comando.type) {
      case 'reload':
        location.reload();
        break;

      case 'change_url':
        if (comando.payload && comando.payload.url) {
          location.href = comando.payload.url;
        }
        break;

      // 'restart' (reiniciar o dispositivo, não só a página) e 'update_version'
      // (baixar nova versão do player) dependem do agente de kiosk de cada SO —
      // aqui o player só confirma o recebimento do comando; quem executa de fato
      // é a camada nativa (Fully Kiosk, systemd, etc.).
      default:
        TotemPlayer.logger.info('Comando repassado ao agente de kiosk', comando);
    }
  }

  function iniciar(socket) {
    socket.on('command', executar);
  }

  return { iniciar };
})();
