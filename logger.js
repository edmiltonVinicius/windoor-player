window.WindoorPlayer = window.WindoorPlayer || {};

// Console sempre; envio remoto só quando já existe deviceToken (antes do
// pareamento não há rota autenticada possível). Nunca loga o token.
WindoorPlayer.logger = (function () {
  const MAX_PER_MINUTE = 20;
  const MAX_CONTEXT_BYTES = 8 * 1024;
  let windowStartedAt = 0;
  let sentInWindow = 0;
  let warnedAboutRateLimit = false;

  function truncateContext(context) {
    let serialized;
    try { serialized = JSON.stringify(context || {}); } catch (_) { return { unserializable: true }; }
    if (serialized.length <= MAX_CONTEXT_BYTES) return context || {};
    return { truncated: true, preview: serialized.slice(0, MAX_CONTEXT_BYTES) };
  }

  // Limite de taxa: no máximo 20 logs/min; o excedente é descartado e avisa
  // uma única vez por janela, pra um erro em loop não virar flood na API.
  function allowRemote() {
    const now = Date.now();
    if (now - windowStartedAt >= 60000) { windowStartedAt = now; sentInWindow = 0; warnedAboutRateLimit = false; }
    if (sentInWindow < MAX_PER_MINUTE) { sentInWindow += 1; return true; }
    if (!warnedAboutRateLimit) { warnedAboutRateLimit = true; console.warn('[warn] Limite de 20 logs/min atingido; logs excedentes descartados'); }
    return false;
  }

  function write(level, message, context) {
    console.log(`[${level}]`, message, context || '');

    const { config, api } = WindoorPlayer;
    if (!config || !config.API_URL || !config.getToken()) return;
    if (!api || !allowRemote()) return;

    try {
      api.post('/player/logs', {
        level,
        message: String(message),
        context: truncateContext(context),
        timestamp: new Date().toISOString(),
      }, { keepalive: true }).catch(() => {});
    } catch (_) { /* log nunca derruba o player */ }
  }

  return {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
})();
