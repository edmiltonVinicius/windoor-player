window.TotemPlayer = window.TotemPlayer || {};

// Watchdog de travamento em JS: se o loop de rotação de ofertas (render.js)
// não "bater" por um tempo muito maior que o esperado, força um reload da
// página. Cobre o caso de o processo do navegador continuar vivo mas o JS
// da página ter travado (loop infinito, exceção não tratada em algum
// callback, etc) — complementa, não substitui, o watchdog do agente de
// kiosk nativo (que cobre o navegador/processo/SO travando por completo).
TotemPlayer.watchdog = (function () {
  const MULTIPLICADOR_TIMEOUT = 3;
  const INTERVALO_VERIFICACAO_MS = 5000;

  function verificar() {
    const { render, logger } = TotemPlayer;
    if (!render) return;

    const tempoEsperadoMs = render.TEMPO_POR_OFERTA_MS * MULTIPLICADOR_TIMEOUT;
    const decorridoMs = Date.now() - render.ultimoTickEm();

    if (decorridoMs > tempoEsperadoMs) {
      if (logger) {
        logger.erro('Watchdog detectou loop de exibição travado, recarregando a página', {
          decorridoMs,
          tempoEsperadoMs,
        });
      }
      location.reload();
    }
  }

  function iniciar() {
    setInterval(verificar, INTERVALO_VERIFICACAO_MS);
  }

  return { iniciar };
})();
