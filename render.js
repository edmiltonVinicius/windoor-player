window.WindoorPlayer = window.WindoorPlayer || {};

/**
 * Desenha o layout do player: uma zona (fullscreen) ou duas empilhadas
 * (split_top_bottom), cada uma percorrendo a sua própria playlist com os tempos
 * dos próprios itens, mais a barra de informações da unidade.
 */
WindoorPlayer.render = (function () {
  const VIEWS = ['content', 'fallback', 'pairing', 'setup-error', 'inactive'];

  let feed = null;
  /** Estado por zona: elemento, índice, timer e o que está no ar (proof of play). */
  const zoneStates = new Map();
  let infoBarTimer = null;
  let infoBarIndex = 0;
  let lastTickMs = Date.now();

  function showView(name) {
    VIEWS.forEach((view) => {
      const el = document.getElementById(view);
      if (el) el.style.display = view === name ? 'flex' : 'none';
    });
  }

  function zonesContainer() {
    return document.getElementById('zones');
  }

  // ---------- proof of play ----------

  function endDisplay(state) {
    if (state.displayed && state.startedAt && WindoorPlayer.proofOfPlay) {
      WindoorPlayer.proofOfPlay.report(state.displayed, Date.now() - state.startedAt);
    }
    state.displayed = null;
    state.startedAt = null;
  }

  // ---------- DOM das zonas ----------

  /** Recria os elementos das zonas quando o layout muda (e só nesse caso). */
  function buildZones(layout, zones) {
    const container = zonesContainer();
    if (!container) return;

    container.dataset.layout = layout;
    container.textContent = '';
    zoneStates.forEach((state) => {
      if (state.timer) clearTimeout(state.timer);
      endDisplay(state);
    });
    zoneStates.clear();

    zones.forEach((zone) => {
      const el = document.createElement('div');
      el.className = 'zone';
      el.dataset.position = zone.position;

      const empty = document.createElement('div');
      empty.className = 'zone-empty';
      empty.textContent = 'Sem playlist nesta zona';
      el.appendChild(empty);

      container.appendChild(el);
      zoneStates.set(zone.position, {
        el,
        emptyEl: empty,
        index: 0,
        timer: null,
        displayed: null,
        startedAt: null,
        currentMediaEl: null,
      });
    });
  }

  /**
   * Nada mudou nesta zona? Compara a playlist e a sequência. A playlist importa
   * mesmo quando as duas listas estão vazias: trocar uma zona sem playlist por
   * uma playlist sem conteúdo exibível muda a mensagem mostrada na tela.
   */
  function sameSequence(position, zone) {
    const previous = feed && feed.zones.find((z) => z.position === position);
    if (!previous) return false;

    const previousPlaylistId = previous.playlist ? previous.playlist.id : null;
    const nextPlaylistId = zone.playlist ? zone.playlist.id : null;
    if (previousPlaylistId !== nextPlaylistId) return false;

    const items = zone.items;
    if (previous.items.length !== items.length) return false;
    return items.every((item, index) => previous.items[index] && previous.items[index].id === item.id);
  }

  // ---------- exibição de um item ----------

  function createMediaElement(item) {
    if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.muted = true;            // autoplay só é permitido sem som
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      return video;
    }
    const img = document.createElement('img');
    img.alt = '';
    return img;
  }

  /**
   * Coloca o item no ar com cross-fade. Imagem vem do cache (blob URL);
   * vídeo toca direto da rede, para não encher o Cache Storage.
   */
  async function showItem(position, item) {
    const state = zoneStates.get(position);
    if (!state || !item) return;

    let src = item.url;
    if (item.type === 'image') {
      try {
        src = await WindoorPlayer.cache.getCachedImage(item.url);
      } catch (error) {
        if (WindoorPlayer.logger) {
          WindoorPlayer.logger.error('Falha ao carregar imagem do conteúdo', {
            url: item.url, zone: position, error: error.message,
          });
        }
        return; // mantém o que está no ar em vez de piscar uma zona vazia
      }
    }

    const entering = createMediaElement(item);
    if (item.type === 'image') entering.src = src;
    entering.className = 'zone-media';
    state.el.appendChild(entering);

    // Força um frame antes de animar, senão a transição não acontece.
    requestAnimationFrame(() => entering.classList.add('visible'));

    const leaving = state.currentMediaEl;
    if (leaving) {
      leaving.classList.remove('visible');
      const oldSrc = leaving.src;
      setTimeout(() => {
        leaving.remove();
        if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
      }, WindoorPlayer.config.TRANSITION_MS + 50);
    }

    state.currentMediaEl = entering;
    state.emptyEl.style.display = 'none';

    // A duração do anterior só é contabilizada depois que o novo está pronto.
    endDisplay(state);
    state.displayed = item;
    state.startedAt = Date.now();
  }

  // ---------- loop por zona ----------

  function scheduleNext(position) {
    const state = zoneStates.get(position);
    const zone = feed && feed.zones.find((z) => z.position === position);
    if (!state || !zone || zone.items.length === 0) return;

    const item = zone.items[state.index];
    const durationMs = Math.max(1, item.durationSeconds) * 1000;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      lastTickMs = Date.now();
      // Uma zona com um item só continua "tiquetaqueando" para o watchdog,
      // mesmo sem troca visível.
      if (zone.items.length > 1) {
        state.index = (state.index + 1) % zone.items.length;
        void showItem(position, zone.items[state.index]);
      }
      scheduleNext(position);
    }, durationMs);
  }

  function startZone(position) {
    const state = zoneStates.get(position);
    const zone = feed && feed.zones.find((z) => z.position === position);
    if (!state || !zone) return;

    if (zone.items.length === 0) {
      if (state.timer) clearTimeout(state.timer);
      endDisplay(state);
      if (state.currentMediaEl) { state.currentMediaEl.remove(); state.currentMediaEl = null; }
      state.emptyEl.style.display = 'flex';
      state.emptyEl.textContent = zone.playlist ? 'Playlist sem conteúdo disponível' : 'Sem playlist nesta zona';
      return;
    }

    state.index = 0;
    void showItem(position, zone.items[0]);
    scheduleNext(position);
  }

  // ---------- barra de informações ----------

  function renderInfoBar(infoBar) {
    const bar = document.getElementById('info-bar');
    const messageEl = document.getElementById('info-bar-message');
    if (!bar || !messageEl) return;

    if (infoBarTimer) { clearInterval(infoBarTimer); infoBarTimer = null; }

    if (!infoBar.enabled) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';

    const messages = infoBar.messages;
    infoBarIndex = 0;
    messageEl.textContent = messages[0] || '';

    if (messages.length > 1) {
      infoBarTimer = setInterval(() => {
        infoBarIndex = (infoBarIndex + 1) % messages.length;
        messageEl.textContent = messages[infoBarIndex];
      }, infoBar.rotationSeconds * 1000);
    }
  }

  function startClock() {
    const el = document.getElementById('info-bar-clock');
    if (!el) return;
    const update = () => {
      el.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };
    update();
    setInterval(update, 15000);
  }

  // ---------- entrada pública ----------

  /** Recebe o feed já normalizado (WindoorPlayer.feed.normalizeFeed). */
  function setFeed(next) {
    if (!next) return;
    lastTickMs = Date.now();

    const layoutChanged = !feed || feed.layout !== next.layout;
    const unchangedZones = !layoutChanged && next.zones.every((zone) => sameSequence(zone.position, zone));

    if (WindoorPlayer.feed.totalItems(next) === 0) {
      feed = next;
      if (layoutChanged) buildZones(next.layout, next.zones);
      next.zones.forEach((zone) => startZone(zone.position));
      renderInfoBar(next.infoBar);
      showFallback();
      return;
    }

    hideFallback();
    renderInfoBar(next.infoBar);

    if (unchangedZones) { feed = next; return; }   // nada mudou: não reinicia as sequências
    if (layoutChanged) buildZones(next.layout, next.zones);

    feed = next;
    next.zones.forEach((zone) => startZone(zone.position));
  }

  function showFallback() { showView('fallback'); }
  function hideFallback() { showView('content'); }

  function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  /** Conteúdo no ar na primeira zona com item — é o que o heartbeat reporta. */
  function currentContent() {
    for (const state of zoneStates.values()) {
      if (state.displayed) return state.displayed;
    }
    return null;
  }

  function lastTickAt() { return lastTickMs; }

  /** Compatibilidade com o watchdog, que só precisa saber que o loop está vivo. */
  function startLoop() { startClock(); }

  return {
    setFeed,
    setStatus,
    startLoop,
    currentContent,
    showFallback,
    hideFallback,
    showView,
    lastTickAt,
  };
})();
