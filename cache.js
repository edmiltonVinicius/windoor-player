window.TotemPlayer = window.TotemPlayer || {};

TotemPlayer.cache = (function () {
  const DB_NAME = 'totem-cache';
  const STORE = 'ofertas';

  function abrirDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function salvarOfertas(lista) {
    const db = await abrirDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    lista.forEach((oferta) => store.put(oferta));
  }

  async function lerOfertas() {
    const db = await abrirDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
    });
  }

  // Converte "HH:MM" ou "HH:MM:SS" em minutos desde a meia-noite.
  function paraMinutos(horaTexto) {
    const partes = String(horaTexto).split(':').map(Number);
    const horas = partes[0] || 0;
    const minutos = partes[1] || 0;
    return horas * 60 + minutos;
  }

  // O backend já filtra por dayparting na resposta de /offers, mas o totem
  // pode ficar horas offline exibindo a lista salva em cache local — nesse
  // caso o filtro precisa ser refeito no cliente, comparando com o horário
  // atual do dispositivo. Ofertas sem daypartingStart/daypartingEnd são
  // sempre consideradas válidas (sem restrição de horário).
  function estaDentroDoHorario(oferta, agora) {
    const inicio = oferta && oferta.daypartingStart;
    const fim = oferta && oferta.daypartingEnd;
    if (!inicio || !fim) return true;

    const agoraMin = agora.getHours() * 60 + agora.getMinutes();
    const inicioMin = paraMinutos(inicio);
    const fimMin = paraMinutos(fim);

    if (inicioMin <= fimMin) {
      // Janela normal dentro do mesmo dia, ex: 08:00–22:00.
      return agoraMin >= inicioMin && agoraMin <= fimMin;
    }
    // Janela que cruza a meia-noite, ex: 22:00–06:00.
    return agoraMin >= inicioMin || agoraMin <= fimMin;
  }

  function filtrarPorDayparting(lista, agora) {
    const referencia = agora || new Date();
    return (lista || []).filter((oferta) => estaDentroDoHorario(oferta, referencia));
  }

  const CACHE_IMAGENS = 'totem-imagens-v1';

  // Cache-first: checa o Cache Storage pela URL exata; se não tiver, faz
  // fetch (com EXTRA_HEADERS, por causa do túnel ngrok em dev) e guarda a
  // Response clonada. Devolve um blob URL pronto pra usar em <img>.
  async function obterImagemCacheada(url) {
    const cache = await caches.open(CACHE_IMAGENS);
    let resposta = await cache.match(url);
    if (!resposta) {
      resposta = await fetch(url, { headers: TotemPlayer.config.EXTRA_HEADERS });
      if (!resposta.ok) throw new Error(`resposta não-ok ao buscar imagem: ${resposta.status}`);
      cache.put(url, resposta.clone());
    }
    const blob = await resposta.blob();
    return URL.createObjectURL(blob);
  }

  // Pré-carrega em paralelo as imagens de uma lista de ofertas, sem bloquear
  // quem chamou (fire-and-forget). Falha de uma imagem não afeta as outras.
  function preCarregarImagens(lista) {
    (lista || []).forEach((oferta) => {
      obterImagemCacheada(oferta.imageUrl).catch((erro) => {
        if (TotemPlayer.logger) {
          TotemPlayer.logger.erro('Falha ao pré-carregar imagem', { url: oferta.imageUrl, erro: erro.message });
        }
      });
    });
  }

  // Remove do Cache Storage imagens que não pertencem a nenhuma oferta da
  // lista atual — evita crescimento ilimitado em operação 24/7. Seguro
  // porque cada upload gera um UUID novo de arquivo: uma imageUrl nunca
  // muda de conteúdo, então "fora da lista atual" == "pode apagar".
  async function limparImagensObsoletas(listaAtual) {
    const cache = await caches.open(CACHE_IMAGENS);
    const urlsValidas = new Set((listaAtual || []).map((o) => o.imageUrl));
    const requests = await cache.keys();
    await Promise.all(
      requests.filter((req) => !urlsValidas.has(req.url)).map((req) => cache.delete(req))
    );
  }

  return {
    salvarOfertas,
    lerOfertas,
    filtrarPorDayparting,
    estaDentroDoHorario,
    obterImagemCacheada,
    preCarregarImagens,
    limparImagensObsoletas,
  };
})();
