window.WindoorPlayer = window.WindoorPlayer || {};

// Reporta quanto tempo cada conteúdo ficou de fato na tela. Chamado pelo
// render.js toda vez que um item sai de cena, em qualquer zona (troca da
// sequência ou feed novo chegando pelo socket).
WindoorPlayer.proofOfPlay = (function () {
  function report(item, durationMs) {
    if (!item) return;
    // `contentId` é o conteúdo; `id` é o item dentro da playlist.
    const contentId = item.contentId || item.id;
    if (!contentId) return;
    const { config, api, logger } = WindoorPlayer;
    if (!config.getToken()) return;

    // keepalive: o request tenta sair mesmo se a troca coincidir com reload.
    api.post('/player/proof-of-play', {
      contentId,
      durationMs: Math.max(0, Math.round(durationMs)),
    }, { keepalive: true }).catch((error) => {
      if (logger) logger.info('Proof of play não enviado (provavelmente offline)', { contentId, error: error.message });
    });
  }

  return { report };
})();
