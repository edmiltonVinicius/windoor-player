window.TotemPlayer = window.TotemPlayer || {};

TotemPlayer.render = (function () {
  const TEMPO_POR_OFERTA_MS = 8000;
  const DURACAO_TRANSICAO_MS = 1000;
  let ofertas = [];
  let indiceAtual = 0;
  let intervalId = null;

  // Dois <img> empilhados (ver index.html) que alternam de papel a cada
  // troca de oferta, pra permitir cross-fade via CSS entre a imagem que
  // sai e a que entra, em vez do replace brusco de innerHTML.
  let imgAtivaEl = null;
  let imgInativaEl = null;

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

  function obterElementosImagem() {
    if (!imgAtivaEl) {
      imgAtivaEl = document.getElementById('img-a');
      imgInativaEl = document.getElementById('img-b');
    }
  }

  async function mostrarOferta(oferta) {
    // Guard: lista com 1 item (ou chamada repetida) não deve re-renderizar/
    // re-transicionar a mesma oferta que já está em exibição.
    if (ofertaEmExibicao && ofertaEmExibicao.id === oferta.id) return;

    obterElementosImagem();
    ocultarFallback();

    // Cache-first (ver cache.js): na maioria das trocas a imagem já foi
    // pré-carregada por definirOfertas, então isto resolve quase na hora.
    let blobUrl;
    try {
      blobUrl = await TotemPlayer.cache.obterImagemCacheada(oferta.imageUrl);
    } catch (erro) {
      if (TotemPlayer.logger) {
        TotemPlayer.logger.erro('Falha ao carregar imagem da oferta', { url: oferta.imageUrl, erro: erro.message });
      }
      return; // mantém a imagem atual visível em vez de quebrar a tela
    }

    // Só troca ofertaEmExibicao/dispara proof-of-play DEPOIS que a imagem já
    // está pronta — finalizarExibicaoAtual continua contabilizando a duração
    // real da oferta anterior, sem gap nem falso-positivo de oferta quebrada.
    finalizarExibicaoAtual();

    const elEntrando = imgInativaEl;
    const elSaindo = imgAtivaEl;

    elEntrando.alt = oferta.title;
    elEntrando.src = blobUrl;
    elEntrando.classList.add('visivel');
    elSaindo.classList.remove('visivel');

    // Revoga a blob URL antiga só depois da transição CSS terminar, pra não
    // cortar a imagem que está saindo no meio do fade (e evitar o vazamento
    // de memória de blob URLs nunca revogadas).
    const urlAntiga = elSaindo.src;
    setTimeout(() => {
      if (urlAntiga && urlAntiga.startsWith('blob:')) URL.revokeObjectURL(urlAntiga);
    }, DURACAO_TRANSICAO_MS + 50);

    imgAtivaEl = elEntrando;
    imgInativaEl = elSaindo;

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
    DURACAO_TRANSICAO_MS,
  };
})();
