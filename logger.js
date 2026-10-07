window.TotemPlayer = window.TotemPlayer || {};

TotemPlayer.logger = (function () {
  function registrar(nivel, mensagem, contexto) {
    const linha = {
      level: nivel,
      message: mensagem,
      context: contexto || {},
      totemId: TotemPlayer.config.TOTEM_ID,
      timestamp: new Date().toISOString(),
    };

    // Sempre loga localmente — útil pra debug direto no navegador do totem.
    console.log(`[${nivel}]`, mensagem, contexto || '');

    // Envia pro backend, mas nunca deixa uma falha de log travar o player.
    fetch(`${TotemPlayer.config.API_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TotemPlayer.config.EXTRA_HEADERS },
      body: JSON.stringify(linha),
      keepalive: true,
    }).catch(() => {});
  }

  return {
    info: (mensagem, contexto) => registrar('info', mensagem, contexto),
    erro: (mensagem, contexto) => registrar('erro', mensagem, contexto),
  };
})();
