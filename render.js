const TotemPlayer = window.TotemPlayer || (window.TotemPlayer = {});

TotemPlayer.render = (function () {
  const TEMPO_POR_OFERTA_MS = 8000;
  let ofertas = [];
  let indiceAtual = 0;
  let intervalId = null;

  // Controle de proof-of-play: guarda qual oferta está no ar e desde quando,
  // para reportar a duração real de exibição assim que ela sair de cena.
  let ofertaEmExibicao = null;
  let exibicaoIniciadaEm = null;

  // Controle do watchdog (ver watchdog.js): timestamp do último "tick" do
  // loop de rotação, mesmo quando a oferta visível não muda (ex: lista com
  // 1 item só). Serve para o watchdog distinguir "JS travado" de "só tem
  // uma oferta pra mostrar".
  let ultimoTickMs = Date.now();

  function definirOfertas(lista) {
    ofertas = lista || [];
    indiceAtual = 0;
    ultimoTickMs = Date.now();

    if (ofertas.length > 0) {
      mostrarOferta(ofertas[0]);
    } else {
      finalizarExibicaoAtual();
      mostrarFallback();
    }
  }

  function finalizarExibicaoAtual() {
    if (ofertaEmExibicao && exibicaoIniciadaEm && TotemPlayer.proofOfPlay) {
      const duracaoMs = Date.now() - exibicaoIniciadaEm;
      TotemPlayer.proofOfPlay.reportar(ofertaEmExibicao, duracaoMs);
    }
    ofertaEmExibicao = null;
    exibicaoIniciadaEm = null;
  }

  function mostrarOferta(oferta) {
    finalizarExibicaoAtual();
    ocultarFallback();

    document.getElementById('oferta').innerHTML =
      `<img src="${oferta.imagemUrl}" alt="${oferta.titulo}">`;

    ofertaEmExibicao = oferta;
    exibicaoIniciadaEm = Date.now();
  }

  // Tela de fallback "branded": usada quando não há ofertas nem da API nem
  // do cache local (ex: primeira execução do totem sem internet).
  function mostrarFallback() {
    const oferta = document.getElementById('oferta');
    const fallback = document.getElementById('fallback');
    if (oferta) oferta.style.display = 'none';
    if (fallback) fallback.style.display = 'flex';
  }

  function ocultarFallback() {
    const fallback = document.getElementById('fallback');
    const oferta = document.getElementById('oferta');
    if (fallback) fallback.style.display = 'none';
    if (oferta) oferta.style.display = 'flex';
  }

  function definirStatus(texto) {
    const el = document.getElementById('status');
    if (el) el.textContent = texto;
  }

  function iniciarLoop() {
    if (intervalId) clearInterval(intervalId);
    ultimoTickMs = Date.now();
    intervalId = setInterval(() => {
      ultimoTickMs = Date.now();
      if (ofertas.length === 0) return;
      indiceAtual = (indiceAtual + 1) % ofertas.length;
      mostrarOferta(ofertas[indiceAtual]);
    }, TEMPO_POR_OFERTA_MS);
  }

  function ofertaAtual() {
    return ofertas[indiceAtual] || null;
  }

  function ultimoTickEm() {
    return ultimoTickMs;
  }

  return {
    definirOfertas,
    definirStatus,
    iniciarLoop,
    ofertaAtual,
    mostrarFallback,
    ocultarFallback,
    ultimoTickEm,
    TEMPO_POR_OFERTA_MS,
  };
})();
