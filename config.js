window.TotemPlayer = window.TotemPlayer || {};

const API_URL = new URLSearchParams(location.search).get('api');

if (!API_URL) {
  //console.error('API_URL não configurada. Configure a variável de ambiente NEXT_PUBLIC_API_URL no CMS e reimplante o player.');
  window.location.href = 'https://edmiltonvinicius.github.io/windoor-player/?totem=ee0d7fca-7ad2-48e4-af85-6cb2f0c5a084&api=https://835c-2804-14c-15b-81d3-e8f6-a945-4aa1-d8cc.ngrok-free.app';
}

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
