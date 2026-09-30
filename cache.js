const TotemPlayer = window.TotemPlayer || (window.TotemPlayer = {});

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

  return { salvarOfertas, lerOfertas, filtrarPorDayparting, estaDentroDoHorario };
})();
