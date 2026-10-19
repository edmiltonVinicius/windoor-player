window.WindoorPlayer = window.WindoorPlayer || {};

// Resolução da URL da API, em ordem: ?api= (persistido), localStorage,
// <meta name="windoor-api-url">. Sem nenhuma delas, API_URL fica vazia e o
// app mostra a tela de configuração — este módulo NUNCA redireciona.
(function () {
  const KEY = { api: 'windoor.apiUrl', token: 'windoor.deviceToken', player: 'windoor.player' };
  const get = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const del = (k) => { try { localStorage.removeItem(k); } catch (_) {} };

  const params = new URLSearchParams(location.search);
  if (params.get('unpair') === '1') { del(KEY.token); del(KEY.player); }      // recuperação por técnico
  const fromQuery = params.get('api');
  if (fromQuery) set(KEY.api, fromQuery.replace(/\/+$/, ''));

  const meta = document.querySelector('meta[name="windoor-api-url"]');
  const apiUrl = (get(KEY.api) || (meta && meta.content) || '').trim().replace(/\/+$/, '');

  let socketUrl = '';
  try { socketUrl = apiUrl ? new URL(apiUrl).origin : ''; } catch (_) { socketUrl = ''; }

  WindoorPlayer.config = {
    API_URL: socketUrl ? apiUrl : '',
    SOCKET_URL: socketUrl,
    PLAYER_VERSION: '2.0.0',
    CONTENT_DURATION_MS: 8000,
    TRANSITION_MS: 1000,
    HEARTBEAT_INTERVAL_MS: 30000,
    REFRESH_INTERVAL_MS: 5 * 60 * 1000,
    // Túnel ngrok (plano grátis) injeta uma página de aviso em requests de navegador; o header a evita.
    // Só entra quando a API aponta para ngrok (desenvolvimento).
    EXTRA_HEADERS: /ngrok/i.test(apiUrl) ? { 'ngrok-skip-browser-warning': 'true' } : {},
    getToken: () => get(KEY.token),
    setToken: (t) => set(KEY.token, t),
    getPlayerInfo: () => { try { return JSON.parse(get(KEY.player) || 'null'); } catch (_) { return null; } },
    setPlayerInfo: (p) => set(KEY.player, JSON.stringify(p)),
    clearIdentity: () => { del(KEY.token); del(KEY.player); },
  };
})();
