window.TotemPlayer = window.TotemPlayer || {};

const API_URL = new URLSearchParams(location.search).get('api') || 'https://api.totens.seudominio.com';

TotemPlayer.config = {
  TOTEM_ID: new URLSearchParams(location.search).get('totem') || 'desconhecido',
  // ?api= permite apontar pra qualquer backend (ex: URL do ngrok) sem precisar
  // editar este arquivo e reimplantar o player a cada teste.
  API_URL,
  VERSAO_PLAYER: '1.0.0',
  // Túnel ngrok (plano grátis) mostra uma página de aviso pra qualquer request
  // que "parece" vir de um navegador — inclusive fetch, não só navegação —
  // a menos que esse header esteja presente. Inofensivo em qualquer outro
  // backend, então só entra quando API_URL aponta pra um domínio ngrok.
  EXTRA_HEADERS: API_URL.includes('ngrok') ? { 'ngrok-skip-browser-warning': 'true' } : {},
};
