const TotemPlayer = window.TotemPlayer || (window.TotemPlayer = {});

TotemPlayer.config = {
  TOTEM_ID: new URLSearchParams(location.search).get('totem') || 'desconhecido',
  API_URL: 'https://api.totens.seudominio.com',
  VERSAO_PLAYER: '1.0.0',
};
