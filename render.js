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
  let lastTickMs = Date.now();
  let heartbeatTimer = null;

  // ---------- barra de informações: estado ----------
  let infoBarRotationTimer = null;
  let infoBarClockTimer = null;
  let infoBarClockShowDate = false;
  let infoBarQuotes = null;
  let infoBarWeather = null;
  let infoBarAppliedKey = null;
  const infoBarImageStatus = new Map();   // url -> 'pending' | 'ready' | 'failed'
  const infoBarImageBlobUrls = new Map(); // url -> blob: URL já resolvida
  const infoBarSkipLogAt = new Map();     // `${type}:${id}:${reason}` -> timestamp do último log
  let infoBarEligibleCount = 0;

  // Download de mídia de zona falha mais de uma vez por hora (item que volta no rodízio
  // antes disso): sem limite, um conteúdo quebrado inundaria os logs a cada troca.
  const mediaFailLogAt = new Map(); // contentId -> timestamp do último log

  // ---------- moldura do comunicado: estado ----------
  let announcementFrame = { theme: 'dark', unitName: '' };
  let announcementPositionById = new Map(); // id do comunicado -> posição (1-based) no rodízio ativo
  let announcementTotal = 0;

  // ---------- rotação de notícia: estado ----------
  // `app.js` já roda `feed.attachNewsToAnnouncementSlots`, mas isso só avança a cada
  // atualização de feed (poll de 30min, socket, `content:updated`) — com um slot de
  // comunicado só, o mesmo objeto `item.news` fica preso nesse item até o próximo
  // refresh, então toda vez que o rodízio LOCAL volta nesse slot (cada volta da
  // playlist) aparece sempre a mesma notícia. Esse cursor vive aqui e avança a cada
  // exibição de verdade na tela (`showItem`), não a cada refresh — é o que faz a
  // notícia realmente girar entre as aprovadas enquanto o totem roda.
  let newsRotationPool = { items: [], fallback: null };
  const newsRotationCursorByPosition = new Map(); // posição da zona -> próximo índice no pool

  function setNewsRotationPool(pool) {
    newsRotationPool = pool && Array.isArray(pool.items) ? pool : { items: [], fallback: null };
  }

  /** Próxima notícia da rotação pra este slot, avançando o cursor desta zona. Mantém o
   * fallback de vídeo de marketing como está — não há o que girar nesse caso. */
  function nextNewsForPosition(position, baseNews) {
    const pool = newsRotationPool.items;
    if (baseNews.isFallback || !Array.isArray(pool) || pool.length === 0) return baseNews;
    const cursor = newsRotationCursorByPosition.get(position) || 0;
    newsRotationCursorByPosition.set(position, (cursor + 1) % pool.length);
    const source = pool[cursor % pool.length];
    return {
      newsId: source.id,
      title: source.title,
      section: source.section,
      imageUrl: source.imageUrl,
      type: 'image',
      photoCredit: source.photoCredit,
      sourceName: source.sourceName,
      shortUrl: source.shortUrl,
      position: baseNews.position,
      isFallback: false,
      fromCache: Boolean(source.fromCache),
    };
  }

  function logMediaDownloadFailed(item, error, extra) {
    if (!WindoorPlayer.logger) return;
    const key = item.contentId || item.url;
    const now = Date.now();
    const last = mediaFailLogAt.get(key) || 0;
    if (now - last < 60 * 60 * 1000) return;
    mediaFailLogAt.set(key, now);
    WindoorPlayer.logger.error('Falha ao baixar mídia do conteúdo', {
      contentId: item.contentId, url: item.url, type: item.type, error: error.message, ...extra,
    });
  }

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

  /**
   * Fecha a exibição do item que estava no ar. O bucket do `playlog` precisa da zona e da
   * playlist, não só do conteúdo: o mesmo conteúdo pode rodar em duas zonas ao mesmo tempo
   * e são exibições distintas no histórico. Quando o item carrega notícia (`item.news`,
   * ver `feed.js`), a mesma duração também fecha o bucket de `newslog` — proof of play de
   * notícia é contado à parte do conteúdo/comunicado (seção 6 do plano de Notícias).
   */
  function endDisplay(state) {
    if (state.displayed && state.startedAt) {
      const durationMs = Date.now() - state.startedAt;
      if (WindoorPlayer.playlog) {
        const zone = feed && feed.zones.find((z) => z.position === state.position);
        WindoorPlayer.playlog.report(state.displayed, durationMs, {
          zone: state.position,
          playlistId: zone && zone.playlist ? zone.playlist.id : null,
        });
      }
      if (WindoorPlayer.newslog && state.displayed.news) {
        // `zone` aqui é a metade (`top`/`bottom`) que a notícia ocupa dentro do slot
        // (`unit.newsPosition`, ver `feed.js`), não a zona de layout do player
        // (`state.position`, que pode ser `full` num layout `fullscreen` — valor que o
        // contrato de `POST /player/news-plays` não aceita, `zone: 'top'|'bottom'`).
        WindoorPlayer.newslog.report(state.displayed, durationMs, {
          zone: state.displayed.news.position,
          fromCache: state.displayed.news.fromCache,
        });
      }
    }
    state.displayed = null;
    state.startedAt = null;
  }

  // ---------- DOM das zonas ----------

  /**
   * Monta os elementos decorativos da moldura do comunicado (documento "Comunicados —
   * moldura padrão no player"): luminária, cabeçalho (COMUNICADO · unidade · N de M) e
   * barra de progresso. Ficam sempre no DOM, escondidos via CSS (`.zone.is-announcement`)
   * até o item exibido ser um comunicado — evitam recriar/remover nó a cada troca de item.
   */
  function buildAnnouncementChrome(position) {
    const lamp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lamp.setAttribute('class', 'ann-lamp');
    lamp.setAttribute('viewBox', '-120 0 360 560');
    lamp.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    lamp.setAttribute('aria-hidden', 'true');
    const coneId = `ann-cone-${position}`;
    const haloId = `ann-halo-${position}`;
    lamp.innerHTML = `
      <defs>
        <linearGradient id="${coneId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--ann-beam)" stop-opacity=".16"/>
          <stop offset="1" stop-color="var(--ann-beam)" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="${haloId}" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#FFE7A3" stop-opacity=".5"/>
          <stop offset=".35" stop-color="#F7C948" stop-opacity=".15"/>
          <stop offset="1" stop-color="#F7C948" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <path d="M18 236 L102 236 L240 560 L-120 560 Z" fill="url(#${coneId})"/>
      <line x1="60" y1="0" x2="60" y2="178" stroke="var(--ann-cord)" stroke-width="2"/>
      <rect x="54" y="176" width="12" height="14" rx="2" fill="var(--ann-cap)"/>
      <path d="M50 190 L70 190 L104 236 L16 236 Z" fill="var(--ann-shade)"/>
      <path d="M16 236 L104 236" stroke="var(--ann-rim)" stroke-width="2"/>
      <circle cx="60" cy="240" r="34" fill="url(#${haloId})"/>
      <ellipse cx="60" cy="238" rx="13" ry="8" fill="#FFF4D1"/>
    `;

    const head = document.createElement('div');
    head.className = 'ann-head';
    const kick = document.createElement('span');
    kick.className = 'ann-kick';
    kick.textContent = 'Comunicado';
    const dot = document.createElement('span');
    dot.className = 'ann-dot';
    dot.setAttribute('aria-hidden', 'true');
    const nameEl = document.createElement('span');
    nameEl.className = 'ann-name';
    const countEl = document.createElement('span');
    countEl.className = 'ann-count';
    head.append(kick, dot, nameEl, countEl);

    const progress = document.createElement('div');
    progress.className = 'ann-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Tempo restante deste comunicado');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const barFillEl = document.createElement('div');
    barFillEl.className = 'ann-progress-fill';
    progress.appendChild(barFillEl);

    return { lamp, head, nameEl, countEl, progress, barFillEl };
  }

  /**
   * Monta o painel de notícia (plano "Módulo Notícias", Trilha D — Player, seção 6.3):
   * foto, chip de editoria, título, crédito da foto e QR local. Fica sempre no DOM,
   * escondido via CSS (`.zone.has-news`) até o item exibido carregar `.news` — mesma
   * estratégia do `buildAnnouncementChrome`, para não recriar nó a cada troca de item.
   */
  function buildNewsPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'zone-news';

    const photoWrap = document.createElement('div');
    photoWrap.className = 'news-photo-wrap';
    const photo = document.createElement('img');
    photo.className = 'news-photo';
    photo.alt = '';
    photo.crossOrigin = 'anonymous';
    const credit = document.createElement('span');
    credit.className = 'news-credit';
    photoWrap.append(photo, credit);

    const panel = document.createElement('div');
    panel.className = 'news-panel';

    const chip = document.createElement('span');
    chip.className = 'news-chip';

    const title = document.createElement('h3');
    title.className = 'news-title';

    const footer = document.createElement('div');
    footer.className = 'news-footer';
    const qr = document.createElement('div');
    qr.className = 'news-qr';
    const caption = document.createElement('div');
    caption.className = 'news-caption';
    const captionAction = document.createElement('span');
    captionAction.className = 'news-caption-action';
    const captionSource = document.createElement('span');
    captionSource.className = 'news-caption-source';
    caption.append(captionAction, captionSource);
    footer.append(qr, caption);

    panel.append(chip, title, footer);
    wrap.append(photoWrap, panel);

    return { wrap, photo, chip, title, credit, qr, captionAction, captionSource };
  }

  /** Reinicia a animação da barra de progresso (0 a 100% linear) pela duração do item. */
  function startAnnouncementProgress(state, durationSeconds) {
    const bar = state.annBarFillEl;
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
    // Força um reflow antes de religar a transição, senão o navegador aplica os dois
    // estilos num quadro só e a barra nunca anima.
    void bar.offsetWidth;
    requestAnimationFrame(() => {
      bar.style.transition = `transform ${Math.max(1, durationSeconds)}s linear`;
      bar.style.transform = 'scaleX(1)';
    });
  }

  function resetAnnouncementProgress(state) {
    const bar = state.annBarFillEl;
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
  }

  /** Aplica (ou remove) a moldura de comunicado no item que acabou de entrar na zona. */
  function applyAnnouncementChrome(state, item) {
    const isAnn = Boolean(item.isAnnouncement);
    state.el.classList.toggle('is-announcement', isAnn);
    state.el.classList.toggle('is-fallback', Boolean(item.isFallback));
    // vídeo de comunicado já ocupa a tela com conteúdo próprio: a lâmpada decorativa some
    state.el.classList.toggle('is-announcement-video', isAnn && item.type === 'video');
    if (!isAnn) {
      resetAnnouncementProgress(state);
      return;
    }
    if (state.annNameEl) state.annNameEl.textContent = announcementFrame.unitName;
    if (state.annCountEl) {
      const position = item.announcementId ? announcementPositionById.get(item.announcementId) : null;
      state.annCountEl.style.display = position && announcementTotal > 1 ? '' : 'none';
      state.annCountEl.textContent = position ? `${position} de ${announcementTotal}` : '';
    }
    startAnnouncementProgress(state, item.durationSeconds);
  }

  /**
   * Baixa a foto da notícia pelo mesmo cache-first de mídia de zona (`getCachedMedia`).
   * Falha não troca a tela: a foto anterior (ou nenhuma) continua, e a notícia só não
   * aparece com foto até a próxima vez que entrar no rodízio.
   */
  async function loadNewsPhoto(state, news) {
    try {
      state.newsPhotoEl.src = await WindoorPlayer.cache.getCachedMedia(news.imageUrl);
    } catch (error) {
      if (WindoorPlayer.logger) {
        WindoorPlayer.logger.warn('Falha ao baixar foto da notícia', { url: news.imageUrl, error: error.message });
      }
    }
  }

  /**
   * Aplica (ou remove) o painel de notícia no item que acabou de entrar na zona (seção
   * 6.3 do plano de Notícias). Fallback de vídeo de marketing (`isFallback`, ver
   * `feed.js`) mostra só a foto/vídeo, sem chip/título/crédito/QR — não é notícia de
   * verdade, é só o que ocupa a metade da tela quando não há nenhuma disponível.
   */
  function applyNewsPanel(state, item) {
    const news = item && item.news;
    state.el.classList.toggle('has-news', Boolean(news));
    if (!news) {
      delete state.el.dataset.newsPosition;
      return;
    }
    state.el.dataset.newsPosition = news.position;

    const hasContent = !news.isFallback;
    state.newsChipEl.style.display = hasContent ? '' : 'none';
    state.newsTitleEl.style.display = hasContent ? '' : 'none';
    state.newsCreditEl.style.display = hasContent ? '' : 'none';
    state.newsQrEl.style.display = hasContent ? '' : 'none';
    state.newsCaptionActionEl.style.display = hasContent ? '' : 'none';
    state.newsCaptionSourceEl.style.display = hasContent ? '' : 'none';

    if (hasContent) {
      state.newsChipEl.textContent = news.section || '';
      state.newsTitleEl.textContent = news.title || '';
      state.newsCreditEl.textContent = news.photoCredit || '';
      state.newsCaptionActionEl.textContent = 'Aponte a câmera e leia a matéria';
      state.newsCaptionSourceEl.textContent =
        `Fonte: ${news.sourceName || 'Agência Brasil'}`;

      if (state.newsQrUrl !== news.shortUrl) {
        state.newsQrUrl = news.shortUrl;
        const svg = (WindoorPlayer.qrcodeLocal && news.shortUrl)
          ? WindoorPlayer.qrcodeLocal.buildSvg(news.shortUrl)
          : null;
        state.newsQrEl.innerHTML = svg || '';
      }
    }

    if (state.newsPhotoUrl !== news.imageUrl) {
      state.newsPhotoUrl = news.imageUrl;
      loadNewsPhoto(state, news);
    }
  }

  /** Lê o tema e o nome da unidade do feed, e o índice de cada comunicado ativo (seção 2.4). */
  function applyAnnouncementFrameMeta(announcements) {
    const frame = (announcements && announcements.frame) || { theme: 'dark', unitName: '' };
    announcementFrame = frame;
    const items = (announcements && announcements.items) || [];
    announcementTotal = items.length;
    announcementPositionById = new Map(items.map((item, index) => [item.id, index + 1]));
    const container = zonesContainer();
    if (container) container.dataset.annTheme = frame.theme;
  }

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

      // Mesmo visual pras duas situações (zona sem playlist / playlist sem conteúdo
      // exibível): um spinner sutil em vez de mensagem de erro — não é uma falha pro
      // totem, só não tem nada pra mostrar ainda/agora.
      const empty = document.createElement('div');
      empty.className = 'zone-empty';
      const spinner = document.createElement('div');
      spinner.className = 'zone-empty-spinner';
      const label = document.createElement('span');
      label.className = 'zone-empty-label';
      label.textContent = 'Carregando';
      empty.append(spinner, label);
      el.appendChild(empty);

      // Duas camadas fixas por zona (nunca recriadas) — crossfade entre elas troca
      // moldura + mídia + painel de notícia juntos, de uma vez (ver comentário de
      // `.zone-layer` no CSS e `showItem` abaixo).
      const layers = [0, 1].map((layerIndex) => {
        const layerEl = document.createElement('div');
        layerEl.className = 'zone-layer';

        const ann = buildAnnouncementChrome(`${zone.position}-${layerIndex}`);
        layerEl.appendChild(ann.lamp);
        layerEl.appendChild(ann.head);
        layerEl.appendChild(ann.progress);

        const news = buildNewsPanel();
        layerEl.appendChild(news.wrap);

        el.appendChild(layerEl);

        return {
          el: layerEl,
          currentMediaEl: null,
          annNameEl: ann.nameEl,
          annCountEl: ann.countEl,
          annBarFillEl: ann.barFillEl,
          newsPhotoEl: news.photo,
          newsChipEl: news.chip,
          newsTitleEl: news.title,
          newsCreditEl: news.credit,
          newsQrEl: news.qr,
          newsCaptionActionEl: news.captionAction,
          newsCaptionSourceEl: news.captionSource,
          newsPhotoUrl: null,
          newsQrUrl: null,
        };
      });

      container.appendChild(el);
      zoneStates.set(zone.position, {
        el,
        emptyEl: empty,
        position: zone.position,
        index: 0,
        timer: null,
        displayed: null,
        startedAt: null,
        layers,
        /** Camada (`layers[0|1]`) com o item no ar agora; `null` = nada exibido ainda. */
        activeLayerIndex: null,
        /** Espelho da mídia no ar na camada ativa, só para `captureSnapshot`. */
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

  /**
   * `crossOrigin = 'anonymous'` é o que permite a recomposição da tela (seção 2.3 do
   * documento de evidências) desenhar a mídia num canvas. Hoje o `src` é um `blob:` vindo
   * do Cache Storage, que já é same-origin e não "tainta" o canvas; o atributo é a garantia
   * de que isso continue valendo se algum dia a mídia for apontada direto para o R2.
   */
  function createMediaElement(item) {
    if (item.type === 'video') {
      const video = document.createElement('video');
      video.muted = true;            // autoplay só é permitido sem som
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      return video;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.crossOrigin = 'anonymous';
    return img;
  }

  /**
   * Espera o elemento estar de fato pronto para exibir (imagem decodificada / vídeo com
   * o primeiro frame disponível) antes de entrar na tela. Sem isso, o cross-fade começa
   * em cima de um conteúdo ainda "carregando" (seção do bug: imagem aparece incompleta).
   * Timeout de segurança: nunca trava o rodízio por um load que não dispara.
   */
  function waitMediaReady(mediaEl, item) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      if (item.type === 'video') {
        if (mediaEl.readyState >= 2) { finish(); return; }
        mediaEl.addEventListener('loadeddata', finish, { once: true });
        mediaEl.addEventListener('error', finish, { once: true });
      } else {
        if (mediaEl.complete && mediaEl.naturalWidth > 0) { finish(); return; }
        mediaEl.addEventListener('load', finish, { once: true });
        mediaEl.addEventListener('error', finish, { once: true });
      }
      setTimeout(finish, 5000);
    });
  }

  /**
   * Coloca o item no ar com cross-fade. Imagem e vídeo vêm do Cache Storage (blob URL):
   * a key de upload nunca se repete, então a URL é imutável e cabe em cache-first mesmo
   * para vídeo (seção 12 do guia de storage). Download que falha não troca a tela —
   * mantém o que está no ar em vez de piscar uma zona vazia — e fica de fora até a
   * próxima vez que entrar no rodízio.
   *
   * Só conta a duração do item (e dispara o cross-fade) depois que ele está
   * completamente carregado: do contrário o tempo configurado encolhe pelo tanto que
   * o download/decodificação levou, e a troca acontece antes da hora.
   */
  async function showItem(position, item) {
    const state = zoneStates.get(position);
    if (!state || !item) return;

    let src;
    try {
      src = await WindoorPlayer.cache.getCachedMedia(item.url);
    } catch (error) {
      logMediaDownloadFailed(item, error, { zone: position });
      return;
    }

    // A camada que ENTRA é sempre a outra (ou a 0, na primeira exibição desta zona).
    const enteringIndex = state.activeLayerIndex === null ? 0 : 1 - state.activeLayerIndex;
    const enteringLayer = state.layers[enteringIndex];
    const leavingLayer = state.activeLayerIndex === null ? null : state.layers[state.activeLayerIndex];

    // Defensivo: item com duração muito curta pode fazer esta mesma camada virar "a
    // que entra" de novo antes do cleanup da exibição anterior dela (TRANSITION_MS
    // depois de deixar de ser a ativa) ter rodado. Garante que nunca sobra mídia
    // antiga dentro da camada antes de colocar a nova.
    if (enteringLayer.currentMediaEl) {
      enteringLayer.currentMediaEl.remove();
      enteringLayer.currentMediaEl = null;
    }

    const entering = createMediaElement(item);
    entering.src = src;
    entering.className = 'zone-media';
    enteringLayer.el.appendChild(entering);

    await waitMediaReady(entering, item);

    // Girar a notícia aqui (não em `app.js`/`feed.js`) é o que faz cada exibição real
    // deste slot na tela mostrar a próxima aprovada, mesmo que o feed não tenha sido
    // atualizado entre uma volta e outra da playlist.
    const displayItem = item.news ? { ...item, news: nextNewsForPosition(position, item.news) } : item;

    // Moldura de comunicado e painel de notícia da camada que ENTRA são aplicados
    // antes do fade começar — chegam prontos junto com a mídia, nunca trocando no
    // meio da animação (era isso que fazia o painel de notícia "sumir" e o vídeo do
    // comunicado pular de posição antes da próxima mídia aparecer).
    applyAnnouncementChrome(enteringLayer, displayItem);
    applyNewsPanel(enteringLayer, displayItem);

    // Força um frame antes de animar, senão a transição não acontece.
    requestAnimationFrame(() => enteringLayer.el.classList.add('visible'));

    if (leavingLayer) {
      const leavingMedia = leavingLayer.currentMediaEl;
      leavingLayer.el.classList.remove('visible');
      setTimeout(() => {
        if (leavingMedia) {
          const oldSrc = leavingMedia.src;
          leavingMedia.remove();
          if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
        }
        leavingLayer.currentMediaEl = null;
      }, WindoorPlayer.config.TRANSITION_MS + 50);
    }

    enteringLayer.currentMediaEl = entering;
    state.currentMediaEl = entering; // espelho da camada ativa, só para `captureSnapshot`
    state.activeLayerIndex = enteringIndex;
    state.emptyEl.style.display = 'none';

    // A duração do anterior só é contabilizada depois que o novo está pronto.
    // `displayItem` (não `item`): o proof-of-play de notícia precisa registrar a
    // matéria que de fato girou pra esta exibição, não a que `app.js` tinha baked.
    endDisplay(state);
    state.displayed = displayItem;
    state.startedAt = Date.now();

    // Primeira exibição deste conteúdo no dia rende uma captura de evidência. O módulo
    // decide se é a primeira (e espera o item assentar na tela antes do print).
    if (WindoorPlayer.capture) WindoorPlayer.capture.onItemShown(item);
  }

  // ---------- loop por zona ----------

  /**
   * Conta a duração do item atual a partir do momento em que ele está de fato no ar
   * (já carregado e visível) — não de quando o rodízio decidiu trocar. Senão o tempo
   * configurado (imagem ou vídeo) encolhe pelo tanto que o download/decodificação levou.
   */
  function scheduleNext(position) {
    const state = zoneStates.get(position);
    const zone = feed && feed.zones.find((z) => z.position === position);
    if (!state || !zone || zone.items.length === 0) return;

    const item = zone.items[state.index];
    const durationMs = Math.max(1, item.durationSeconds) * 1000;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      lastTickMs = Date.now();
      // Uma zona com um item só continua "tiquetaqueando" para o watchdog,
      // mesmo sem troca visível.
      if (zone.items.length > 1) {
        state.index = (state.index + 1) % zone.items.length;
        await showItem(position, zone.items[state.index]);
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
      state.layers.forEach((layer) => {
        layer.el.classList.remove('visible');
        if (layer.currentMediaEl) { layer.currentMediaEl.remove(); layer.currentMediaEl = null; }
      });
      state.currentMediaEl = null;
      state.activeLayerIndex = null;
      state.emptyEl.style.display = 'flex';
      return;
    }

    state.index = 0;
    (async () => {
      await showItem(position, zone.items[0]);
      scheduleNext(position);
    })();
  }

  // ---------- barra de informações ----------

  function reducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Troca o conteúdo de `el` com um fade de 300 ms (instantâneo com `prefers-reduced-motion`). */
  function fadeSwap(el, apply) {
    if (!el) return;
    if (reducedMotion()) { apply(); return; }
    el.classList.add('info-bar-fading');
    setTimeout(() => {
      apply();
      el.classList.remove('info-bar-fading');
    }, WindoorPlayer.config.INFO_BAR_TRANSITION_MS);
  }

  /** No máximo um log por item por hora, para não inundar (seção 6.5). */
  function logInfoBarSkip(item, reason) {
    const key = `${item.type}:${item.id}:${reason}`;
    const now = Date.now();
    const last = infoBarSkipLogAt.get(key) || 0;
    if (now - last < 60 * 60 * 1000) return;
    infoBarSkipLogAt.set(key, now);
    WindoorPlayer.logger.info('Item da barra de informações pulado', { itemId: item.id, type: item.type, reason });
  }

  function ensureInfoBarImageRequested(item) {
    if (infoBarImageStatus.has(item.url)) return;
    infoBarImageStatus.set(item.url, 'pending');
    WindoorPlayer.cache.getCachedMedia(item.url)
      .then((blobUrl) => {
        infoBarImageBlobUrls.set(item.url, blobUrl);
        infoBarImageStatus.set(item.url, 'ready');
      })
      .catch((error) => {
        infoBarImageStatus.set(item.url, 'failed');
        logMediaDownloadFailed(item, error, { itemId: item.id, infoBar: true });
      });
  }

  function isInfoBarImageReady(url) { return infoBarImageStatus.get(url) === 'ready'; }

  /** Itens elegíveis agora, disparando o download de imagens novas e logando os pulados. */
  function eligibleInfoBarItems(items, now) {
    items.filter((item) => item.type === 'image').forEach(ensureInfoBarImageRequested);

    const eligible = [];
    items.forEach((item) => {
      if (WindoorPlayer.feed.isInfoBarItemEligible(
        item, now, infoBarQuotes, isInfoBarImageReady, infoBarWeather, WindoorPlayer.config.INFO_BAR_TIMEZONE,
      )) {
        eligible.push(item);
        return;
      }
      if (item.type === 'image') {
        const expired = item.validUntil && Date.parse(item.validUntil) <= now.getTime();
        logInfoBarSkip(item, expired ? 'expired_image' : 'image_failed');
      } else if (item.type === 'quotes') {
        logInfoBarSkip(item, 'stale_quotes');
      } else if (item.type === 'weather') {
        logInfoBarSkip(item, 'stale_weather');
      }
    });
    return eligible;
  }

  // símbolo exibido dentro do ícone de cada moeda (seção 6.1 da doc)
  const QUOTE_ICON_CHAR = { USD: '$', EUR: '€', GBP: '£', ARS: '$' };

  function quoteIcon(symbol) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'info-bar-quote-icon');
    const char = QUOTE_ICON_CHAR[symbol] || symbol.charAt(0);
    svg.innerHTML =
      '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      `<text x="12" y="16.3" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">${char}</text>`;
    return svg;
  }

  function renderInfoBarQuotesContent(item) {
    const wrap = document.createElement('div');
    wrap.className = 'info-bar-quotes';
    const bySymbol = new Map(((infoBarQuotes && infoBarQuotes.items) || []).map((q) => [q.symbol, q]));

    item.symbols.forEach((symbol) => {
      const quote = bySymbol.get(symbol);
      if (!quote) return; // moeda pedida que não veio no cache é omitida

      const bid = Number(quote.bid);
      const changePct = Number(quote.changePct);
      const direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
      const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';

      const span = document.createElement('span');
      span.className = 'info-bar-quote';
      span.appendChild(quoteIcon(symbol));
      span.insertAdjacentHTML('beforeend',
        `<em>${symbol}</em>` +
        `${Number.isFinite(bid) ? bid.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}` +
        `<b class="info-bar-change ${direction}">${arrow}${Number.isFinite(changePct) ? Math.abs(changePct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '0,0'}%</b>`);
      wrap.appendChild(span);
    });

    return wrap;
  }

  /** Envolve o conteúdo (cotações/clima) com a linha "Fonte: X" abaixo (seção 6.1 da doc). */
  function withInfoBarSource(contentEl, sourceName) {
    const wrap = document.createElement('div');
    wrap.className = 'info-bar-with-source';
    wrap.appendChild(contentEl);
    wrap.appendChild(el('span', 'info-bar-source', `Fonte: ${sourceName}`));
    return wrap;
  }

  // ---------- clima (seção 5 da doc do clima) ----------

  const WEATHER_LABELS = {
    clear: 'Céu limpo', partly_cloudy: 'Parcialmente nublado', cloudy: 'Nublado', fog: 'Neblina',
    drizzle: 'Garoa', rain: 'Chuva', storm: 'Tempestade',
  };
  const WEATHER_SHORT = { partly_cloudy: 'Parc. nublado' };

  const SUN = '#F7C948'; const CLOUD = '#D6D3E3'; const RAIN = '#5AA3DC'; const MUTED = '#B9B5CC';
  const CLOUD_PATH = 'M17.5 20H9a4 4 0 1 1 .8-7.9A5 5 0 0 1 19 13.5a3.3 3.3 0 0 1-1.5 6.5Z';
  const HIGH_CLOUD = 'M17.5 15H8a4 4 0 1 1 .8-7.9A5 5 0 0 1 18 8.5a3.3 3.3 0 0 1-.5 6.5Z';
  const WEATHER_ICONS = {
    clear: `<circle cx="12" cy="12" r="4.5" fill="${SUN}"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round"/>`,
    partly_cloudy: `<circle cx="9" cy="9" r="3.5" fill="${SUN}"/><path d="M9 2.5v1.5M3.5 9H2M4.4 4.4l1 1M13.6 4.4l-1 1" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round"/><path d="${CLOUD_PATH}" fill="${CLOUD}"/>`,
    cloudy: `<path d="M17.5 18H8a4.5 4.5 0 1 1 .9-8.9A5.5 5.5 0 0 1 19 11a3.5 3.5 0 0 1-1.5 7Z" fill="${CLOUD}"/>`,
    fog: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M5 18h14M7 21h10" stroke="${MUTED}" stroke-width="1.8" stroke-linecap="round"/>`,
    drizzle: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M10 18l-.7 2.5M15 18l-.7 2.5" stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round"/>`,
    rain: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round"/>`,
    storm: `<path d="${HIGH_CLOUD}" fill="${CLOUD}"/><path d="M12.5 15.5 10 19.5h3l-1.5 3.5" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  };

  function weatherIcon(condition, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    svg.innerHTML = WEATHER_ICONS[condition] || WEATHER_ICONS.cloudy;
    return svg;
  }

  /** Inteiro + "°"; negativo com "−" (U+2212). */
  function formatTemperature(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return '--°';
    return `${n < 0 ? '\u2212' : ''}${Math.abs(n)}°`;
  }

  function formatWeekday(isoDate) {
    try {
      const raw = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE })
        .format(new Date(`${isoDate}T12:00:00-03:00`)).replace('.', '');
      return raw.charAt(0).toUpperCase() + raw.slice(1, 3);
    } catch (_) { return '---'; }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderInfoBarWeatherContent(item) {
    const weather = infoBarWeather;
    const days = WindoorPlayer.feed.upcomingWeatherDays(weather, new Date(), WindoorPlayer.config.INFO_BAR_TIMEZONE);

    if (item.mode === 'days') {
      const wrap = el('div', 'info-bar-weather-days');
      days.slice(0, 3).forEach((day) => {
        const group = el('span', 'info-bar-weather-day');
        group.appendChild(el('b', '', formatWeekday(day.date)));
        group.appendChild(weatherIcon(day.condition, 'info-bar-weather-icon-sm'));
        group.appendChild(document.createTextNode(formatTemperature(day.max)));
        group.appendChild(el('i', '', formatTemperature(day.min)));
        wrap.appendChild(group);
      });
      return wrap;
    }

    const wrap = el('div', 'info-bar-weather');
    const condition = weather.current.condition;
    wrap.appendChild(weatherIcon(condition, 'info-bar-weather-icon'));
    wrap.appendChild(el('span', 'info-bar-weather-temp', formatTemperature(weather.current.temperature)));
    const label = el('span', 'info-bar-weather-label', item.mode === 'now'
      ? (WEATHER_LABELS[condition] || '')
      : (WEATHER_SHORT[condition] || WEATHER_LABELS[condition] || ''));
    wrap.appendChild(label);

    if (item.mode === 'today' && days[0]) {
      wrap.appendChild(el('span', 'info-bar-weather-dot'));
      const min = el('span', 'info-bar-weather-range');
      min.appendChild(el('em', '', 'Mín'));
      min.appendChild(document.createTextNode(` ${formatTemperature(days[0].min)}`));
      const max = el('span', 'info-bar-weather-range');
      max.appendChild(el('em', '', 'Máx'));
      max.appendChild(document.createTextNode(` ${formatTemperature(days[0].max)}`));
      wrap.appendChild(min);
      wrap.appendChild(max);
    }

    // "Agora" que não cabe: cai para o rótulo curto (seção 5.1); a reticência vem do CSS.
    if (item.mode === 'now' && WEATHER_SHORT[condition]) {
      requestAnimationFrame(() => {
        if (label.scrollWidth > label.clientWidth) label.textContent = WEATHER_SHORT[condition];
      });
    }
    return wrap;
  }

  function renderInfoBarCenterContent(item) {
    const centerEl = document.getElementById('info-bar-center');
    if (!centerEl) return;
    centerEl.textContent = '';
    if (!item) return;

    if (item.type === 'text') {
      const span = document.createElement('span');
      span.className = 'info-bar-text';
      span.textContent = item.text;
      centerEl.appendChild(span);
    } else if (item.type === 'image') {
      const img = document.createElement('img');
      img.className = 'info-bar-image';
      img.alt = '';
      img.src = infoBarImageBlobUrls.get(item.url) || item.url;
      centerEl.appendChild(img);
    } else if (item.type === 'quotes') {
      centerEl.appendChild(withInfoBarSource(renderInfoBarQuotesContent(item), 'AwesomeAPI'));
    } else if (item.type === 'weather') {
      centerEl.appendChild(withInfoBarSource(renderInfoBarWeatherContent(item), 'Open-Meteo'));
    }
  }

  function showInfoBarItem(item) {
    fadeSwap(document.getElementById('info-bar-center'), () => renderInfoBarCenterContent(item));
  }

  /**
   * Rodízio do centro (seção 6.3): a cada `rotationSeconds`, reavalia os itens elegíveis
   * (imagem pode ter acabado de baixar, cotação pode ter ficado velha) e avança. Sem
   * nenhum elegível, o centro fica vazio — sem mensagem de erro na tela. Com só um
   * elegível (nada pra alternar com ele), pisca show/esconde no mesmo ritmo em vez de
   * ficar preso na tela pra sempre — é o mesmo `rotationSeconds`, só que alternando com
   * um intervalo vazio no lugar de outro item.
   */
  function startInfoBarRotation(infoBar) {
    if (infoBarRotationTimer) { clearInterval(infoBarRotationTimer); infoBarRotationTimer = null; }

    const items = infoBar.items || [];
    const now = new Date();
    let eligible = eligibleInfoBarItems(items, now);
    let index = 0;
    let blank = false; // só usado quando eligible.length === 1

    infoBarEligibleCount = eligible.length;
    const appliedKey = `${items.length}:${eligible.length}`;
    if (appliedKey !== infoBarAppliedKey) {
      infoBarAppliedKey = appliedKey;
      WindoorPlayer.logger.info('Configuração da barra de informações aplicada', {
        itemsCount: items.length, eligibleCount: eligible.length,
      });
    }

    showInfoBarItem(eligible[0] || null);
    if (eligible.length === 0) return;

    const ms = Math.max(1, infoBar.rotationSeconds) * 1000;
    infoBarRotationTimer = setInterval(() => {
      eligible = eligibleInfoBarItems(items, new Date());
      if (eligible.length === 0) { showInfoBarItem(null); return; }
      if (eligible.length === 1) {
        blank = !blank;
        showInfoBarItem(blank ? null : eligible[0]);
        return;
      }
      blank = false;
      index = (index + 1) % eligible.length;
      showInfoBarItem(eligible[index]);
    }, ms);
  }

  function renderInfoBar(infoBar) {
    const bar = document.getElementById('info-bar');
    if (!bar) return;

    if (infoBarRotationTimer) { clearInterval(infoBarRotationTimer); infoBarRotationTimer = null; }

    if (!infoBar.enabled) {
      bar.style.display = 'none';
      renderInfoBarCenterContent(null);
      return;
    }
    bar.style.display = 'flex';
    startInfoBarRotation(infoBar);
  }

  /** Cotações recém-buscadas (seção 3.3/6.4): reaplica o rodízio sem reiniciar a barra. */
  function setInfoBarQuotes(quotes) {
    infoBarQuotes = quotes;
    if (feed && feed.infoBar && feed.infoBar.enabled) startInfoBarRotation(feed.infoBar);
  }

  /** Clima recém-buscado do local da barra: reaplica o rodízio sem reiniciar a barra. */
  function setInfoBarWeather(weather) {
    infoBarWeather = weather;
    if (feed && feed.infoBar && feed.infoBar.enabled) startInfoBarRotation(feed.infoBar);
  }

  /** Local do item de clima do feed atual (ou null): o app usa para buscar e filtrar eventos. */
  function infoBarWeatherLocation() {
    const items = (feed && feed.infoBar && feed.infoBar.items) || [];
    const item = items.find((i) => i.type === 'weather');
    return item ? item.location : null;
  }

  // ---------- barra de informações: horário/data (independentes do rodízio do centro) ----------

  function formatInfoBarTime(date) {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE,
      }).format(date);
    } catch (_) { return '--:--'; }
  }

  function formatInfoBarDate(date) {
    try {
      const parts = new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: 'short', timeZone: WindoorPlayer.config.INFO_BAR_TIMEZONE,
      }).formatToParts(date);
      const day = (parts.find((p) => p.type === 'day') || {}).value || '--';
      const month = ((parts.find((p) => p.type === 'month') || {}).value || '--').replace('.', '');
      return `${day}/${month.charAt(0).toUpperCase()}${month.slice(1)}`;
    } catch (_) { return '--/--'; }
  }

  function applyInfoBarLeft(showDate) {
    const clockGroup = document.getElementById('info-bar-clock-group');
    const dateGroup = document.getElementById('info-bar-date-group');
    const clockText = document.getElementById('info-bar-clock');
    const dateText = document.getElementById('info-bar-date');
    if (!clockGroup || !dateGroup) return;
    const now = new Date();
    if (clockText) clockText.textContent = formatInfoBarTime(now);
    if (dateText) dateText.textContent = formatInfoBarDate(now);
    clockGroup.style.display = showDate ? 'none' : 'flex';
    dateGroup.style.display = showDate ? 'flex' : 'none';
  }

  /** Alterna horário ⇄ data a cada 5 s, nunca os dois juntos, no fuso da unidade. */
  function startInfoBarClock() {
    if (infoBarClockTimer) clearInterval(infoBarClockTimer);
    infoBarClockShowDate = false;
    fadeSwap(document.getElementById('info-bar-left'), () => applyInfoBarLeft(infoBarClockShowDate));
    infoBarClockTimer = setInterval(() => {
      infoBarClockShowDate = !infoBarClockShowDate;
      fadeSwap(document.getElementById('info-bar-left'), () => applyInfoBarLeft(infoBarClockShowDate));
    }, WindoorPlayer.config.INFO_BAR_CLOCK_TICK_MS);
  }

  // ---------- entrada pública ----------

  /** Recebe o feed já normalizado (WindoorPlayer.feed.normalizeFeed). */
  function setFeed(next) {
    if (!next) return;
    lastTickMs = Date.now();
    applyAnnouncementFrameMeta(next.announcements);

    // Primeira carga não é "mudança de configuração": quem cobre o início é o
    // `first_play` do primeiro item, não um gatilho de playlist/layout alterado.
    const hadFeed = Boolean(feed);
    const layoutChanged = !feed || feed.layout !== next.layout;
    const unchangedZones = !layoutChanged && next.zones.every((zone) => sameSequence(zone.position, zone));

    if (WindoorPlayer.feed.totalItems(next) === 0) {
      // Uma atualização (refresh periódico, reconexão do socket) que chega vazia nunca
      // pode substituir o que já está no ar: a troca tem que ser imperceptível para
      // quem está vendo o totem. Só mostra "sem conteúdo" quando realmente não havia
      // nada antes — do contrário essa tela piscaria por cima de uma exibição normal.
      if (feed && WindoorPlayer.feed.totalItems(feed) > 0) {
        if (WindoorPlayer.logger) {
          WindoorPlayer.logger.info('Atualização sem conteúdo ignorada: mantendo o que está no ar', {});
        }
        return;
      }
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

    // Evidência de que a troca de playlist/layout de fato chegou à tela. Dispara depois
    // do render da configuração nova (seção 2.2), e o próprio módulo respeita o
    // intervalo mínimo entre capturas automáticas.
    if (hadFeed && WindoorPlayer.capture) {
      WindoorPlayer.capture.onConfigChanged(layoutChanged ? 'layout_changed' : 'playlist_changed');
    }
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

  /**
   * Estado da tela para as evidências de exibição: o que está no ar em cada zona, onde
   * cada zona está desenhada e o texto atual da barra. É o único lugar que conhece o DOM
   * do player — o `capture.js` usa isto tanto para montar os metadados da captura quanto
   * para recompor a tela num canvas quando o print real do Fully não sai.
   *
   * As posições vêm de `getBoundingClientRect()` relativas ao `#content`, então a
   * recomposição respeita o layout real (fullscreen ou duas zonas empilhadas) sem
   * reimplementar o CSS.
   */
  function captureSnapshot() {
    const rootEl = document.getElementById('content');
    const rootRect = rootEl
      ? rootEl.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    const relative = (rect) => ({
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    });

    const zones = [];
    zoneStates.forEach((state, position) => {
      const zone = feed && feed.zones.find((z) => z.position === position);
      zones.push({
        position,
        playlistId: zone && zone.playlist ? zone.playlist.id : null,
        playlistVersion: zone && zone.playlist && zone.playlist.version != null ? zone.playlist.version : null,
        item: state.displayed,
        index: state.displayed ? state.index : null,
        mediaEl: state.currentMediaEl,
        rect: state.el ? relative(state.el.getBoundingClientRect()) : null,
      });
    });

    const barEl = document.getElementById('info-bar');
    const barVisible = Boolean(barEl && barEl.style.display !== 'none');
    const textOf = (id) => {
      const el = document.getElementById(id);
      return el ? el.textContent.trim() : '';
    };

    return {
      width: Math.round(rootRect.width),
      height: Math.round(rootRect.height),
      layout: feed ? feed.layout : 'fullscreen',
      zones,
      infoBar: {
        enabled: Boolean(feed && feed.infoBar && feed.infoBar.enabled),
        rect: barVisible ? relative(barEl.getBoundingClientRect()) : null,
        // Na recomposição a barra é redesenhada como texto: o horário/data da esquerda e
        // o item do centro que estiver no ar (cotação, clima ou recado).
        left: infoBarClockShowDate ? textOf('info-bar-date') : textOf('info-bar-clock'),
        center: textOf('info-bar-center'),
        logo: 'Windoor',
      },
      // Só com vídeo no ar um print quase todo preto é considerado falha: é o sintoma do
      // overlay de hardware de alguns TV box (seção 2.1).
      hasVideoPlaying: zones.some(
        (z) => z.mediaEl && z.mediaEl.tagName === 'VIDEO' && !z.mediaEl.paused && !z.mediaEl.ended,
      ),
    };
  }

  /** Resumo para o heartbeat diagnosticar "barra sem itens na tela" (seção 6.5). */
  function infoBarSummary() {
    const bar = feed && feed.infoBar;
    return {
      enabled: !!(bar && bar.enabled),
      items: bar ? (bar.items || []).length : 0,
      eligible: infoBarEligibleCount,
    };
  }

  /**
   * O watchdog só precisa saber que o loop de JS está vivo — antes, quem atualizava
   * `lastTickMs` era só a troca de item em `scheduleNext`, então qualquer item com
   * `durationSeconds` maior que o limite do watchdog (3 × `CONTENT_DURATION_MS`, hoje
   * 24 s) ficava "sem bater" tempo demais no meio da própria exibição — o watchdog
   * achava que tinha travado e recarregava a página, cortando o conteúdo. Esse batimento
   * roda sozinho, sem depender da duração configurada de imagem/vídeo.
   */
  function startTickHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lastTickMs = Date.now();
    heartbeatTimer = setInterval(() => { lastTickMs = Date.now(); }, 5000);
  }

  function startLoop() { startInfoBarClock(); startTickHeartbeat(); }

  return {
    setFeed,
    setStatus,
    setNewsRotationPool,
    setInfoBarQuotes,
    setInfoBarWeather,
    infoBarWeatherLocation,
    startLoop,
    currentContent,
    captureSnapshot,
    infoBarSummary,
    showFallback,
    hideFallback,
    showView,
    lastTickAt,
  };
})();
