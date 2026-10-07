window.TotemPlayer = window.TotemPlayer || {};

// Evita que o dispositivo suspenda/desligue a tela enquanto o totem está
// rodando. Usa a Wake Lock API do navegador — nem todo Chromium embarcado
// (Android TV Box, builds mais antigas) tem suporte, então falha em
// silêncio quando a API não existe (a supervisão de tela nesse caso fica
// por conta do agente de kiosk nativo / configuração do SO).
TotemPlayer.wakelock = (function () {
  let wakeLockRef = null;

  async function solicitar() {
    if (!('wakeLock' in navigator)) {
      if (TotemPlayer.logger) {
        TotemPlayer.logger.info('Wake Lock API não suportada neste navegador');
      }
      return;
    }

    try {
      wakeLockRef = await navigator.wakeLock.request('screen');
      wakeLockRef.addEventListener('release', () => {
        wakeLockRef = null;
      });
    } catch (erro) {
      // Pode falhar por permissão, aba não visível, bateria etc — não é
      // fatal pro player, só registra.
      if (TotemPlayer.logger) {
        TotemPlayer.logger.info('Falha ao solicitar wake lock', { erro: erro.message });
      }
    }
  }

  function iniciar() {
    solicitar();

    // O wake lock é liberado automaticamente pelo navegador quando a aba
    // perde visibilidade (troca de app, tela bloqueada etc). Ao voltar a
    // ficar visível, pede de novo.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        solicitar();
      }
    });
  }

  return { iniciar };
})();
