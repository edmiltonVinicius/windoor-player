window.WindoorPlayer = window.WindoorPlayer || {};

// Evita que o dispositivo suspenda/desligue a tela enquanto o player roda.
// Nem todo Chromium embarcado tem Wake Lock API, então falha em silêncio
// (nesse caso a supervisão fica por conta do agente de kiosk nativo).
WindoorPlayer.wakelock = (function () {
  let wakeLockRef = null;

  async function request() {
    if (!('wakeLock' in navigator)) {
      if (WindoorPlayer.logger) WindoorPlayer.logger.info('Wake Lock API não suportada neste navegador');
      return;
    }
    try {
      wakeLockRef = await navigator.wakeLock.request('screen');
      wakeLockRef.addEventListener('release', () => { wakeLockRef = null; });
    } catch (error) {
      if (WindoorPlayer.logger) WindoorPlayer.logger.info('Falha ao solicitar wake lock', { error: error.message });
    }
  }

  function start() {
    request();
    // O wake lock é liberado quando a aba perde visibilidade; ao voltar, pede de novo.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') request();
    });
  }

  return { start };
})();
