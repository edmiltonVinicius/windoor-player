window.TotemPlayer = window.TotemPlayer || {};

// Reporta ao backend quanto tempo cada oferta ficou de fato na tela.
// Chamado pelo render.js toda vez que uma oferta sai de cena (seja pela
// troca automática do loop, seja por uma nova lista chegando via WebSocket).
TotemPlayer.proofOfPlay = (function () {
  function reportar(oferta, duracaoMs) {
    if (!oferta || !oferta.id) return;

    const { TOTEM_ID, API_URL, EXTRA_HEADERS } = TotemPlayer.config;

    fetch(`${API_URL}/totems/${TOTEM_ID}/proof-of-play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...EXTRA_HEADERS },
      body: JSON.stringify({
        offerId: oferta.id,
        durationMs: Math.max(0, Math.round(duracaoMs)),
      }),
      // keepalive garante que o request tenta sair mesmo se a troca de
      // oferta coincidir com um unload/reload da página.
      keepalive: true,
    }).catch((erro) => {
      // Sem internet é esperado às vezes — não deixa o proof-of-play
      // derrubar o player, só registra pra auditoria.
      if (TotemPlayer.logger) {
        TotemPlayer.logger.info('Proof of play não enviado (provavelmente offline)', {
          ofertaId: oferta.id,
          erro: erro.message,
        });
      }
    });
  }

  return { reportar };
})();
