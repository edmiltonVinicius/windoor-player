// Capturas de tela como evidência de exibição (seções 2.2–2.5 do documento de
// Histórico e evidências).
//
// Caminho feliz: o Fully Kiosk expõe `window.fully.getScreenshotPngBase64()`, que devolve
// um print da tela real do dispositivo. Quando isso não existe (navegador comum) ou sai
// preto (alguns TV box desenham vídeo em overlay de hardware, que não entra no print), o
// player **recompõe** a tela num canvas e marca `method = 'recomposed'` — a evidência
// continua existindo, só declarada como reconstruída.
//
// A imagem vai para uma fila no IndexedDB antes de qualquer rede: é isso que faz um player
// que passou horas offline enviar tudo ao voltar. O `id` é gerado aqui e é o mesmo mandado
// ao servidor, o que torna o reenvio idempotente.
//
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.capture.
(function (root) {
  const MAX_WIDTH = 1280;
  const WEBP_QUALITY = 0.8;
  /** Teto do servidor em `POST /player/screenshots/upload-url`. */
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  /** Capturas automáticas respeitam um intervalo mínimo; `on_demand` passa por cima. */
  const MIN_AUTO_GAP_MS = 60 * 1000;
  /** Tempo para o item que acabou de entrar terminar de renderizar antes do print. */
  const SETTLE_MS = 1500;
  const MAX_QUEUE_ITEMS = 200;
  const MAX_QUEUE_BYTES = 50 * 1024 * 1024;
  const BACKOFF_MS = [5000, 30000, 2 * 60 * 1000, 10 * 60 * 1000];
  const AUTO_TRIGGERS = ['first_play', 'interval', 'playlist_changed', 'layout_changed'];
  const TRIGGERS = AUTO_TRIGGERS.concat(['on_demand']);
  /** ~400 pontos numa grade 20×20 (seção 2.2, passo 3). */
  const BLACK_SAMPLE_SIDE = 20;
  /** Luminância abaixo disto conta como "quase preto". */
  const BLACK_LUMA = 10;
  const BLACK_RATIO = 0.98;
  const FIRST_PLAY_KEY = 'firstPlay';
  /** Mesmo mecanismo do `FIRST_PLAY_KEY`, mas por `newsId` (seção 6.4 do plano de Notícias). */
  const NEWS_FIRST_PLAY_KEY = 'newsFirstPlay';
  /** `capture_black_frame` é agregado: no máximo 1 por hora (seção 2.7). */
  const BLACK_FRAME_LOG_MS = 60 * 60 * 1000;
  const DEFAULT_INTERVAL_MINUTES = 30;

  // ---------------------------------------------------------------- puros

  /** Mantém a proporção e nunca amplia: um print de 800 px continua com 800 px. */
  function scaleTo(width, height, maxWidth) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const limit = maxWidth || MAX_WIDTH;
    if (w <= limit) return { width: w, height: h };
    const ratio = limit / w;
    return { width: limit, height: Math.max(1, Math.round(h * ratio)) };
  }

  /** Backoff do documento: 5 s, 30 s, 2 min, 10 min, e depois fica em 10 min. */
  function nextBackoffMs(attempt) {
    const index = Math.max(1, Math.round(attempt)) - 1;
    return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)];
  }

  /**
   * Aplica os tetos da fila (200 itens / 50 MB), descartando as capturas **mais antigas**:
   * numa parada longa, a evidência recente vale mais que a de ontem. `items` vem da mais
   * antiga para a mais nova.
   */
  function trimQueue(items, opts) {
    const maxItems = (opts && opts.maxItems) || MAX_QUEUE_ITEMS;
    const maxBytes = (opts && opts.maxBytes) || MAX_QUEUE_BYTES;
    const kept = [];
    let bytes = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      const size = Number(item.bytes) || 0;
      if (kept.length >= maxItems) break;
      if (kept.length > 0 && bytes + size > maxBytes) break;
      bytes += size;
      kept.unshift(item);
    }
    const keptIds = new Set(kept.map((i) => i.id));
    return { kept, dropped: items.filter((i) => !keptIds.has(i.id)), bytes };
  }

  /**
   * Fração de pontos quase pretos numa amostra em grade. `image` é um ImageData
   * (`{ width, height, data }` em RGBA), o que deixa a função testável sem canvas.
   */
  function blackRatio(image, side) {
    const steps = Math.max(1, side || BLACK_SAMPLE_SIDE);
    const { width, height, data } = image;
    if (!width || !height || !data) return 0;

    let dark = 0;
    let total = 0;
    for (let iy = 0; iy < steps; iy += 1) {
      for (let ix = 0; ix < steps; ix += 1) {
        const x = Math.min(width - 1, Math.floor(((ix + 0.5) / steps) * width));
        const y = Math.min(height - 1, Math.floor(((iy + 0.5) / steps) * height));
        const offset = (y * width + x) * 4;
        // Luminância perceptual (Rec. 601): verde pesa mais que vermelho e azul.
        const luma = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
        if (luma < BLACK_LUMA) dark += 1;
        total += 1;
      }
    }
    return total === 0 ? 0 : dark / total;
  }

  /** Captura automática só passa se já tiver dado o intervalo mínimo. */
  function shouldThrottle(trigger, lastAutoAtMs, nowMs, minGapMs) {
    if (!AUTO_TRIGGERS.includes(trigger)) return false;
    if (!lastAutoAtMs) return false;
    return nowMs - lastAutoAtMs < (minGapMs || MIN_AUTO_GAP_MS);
  }

  /** `YYYY-MM-DD` no fuso da unidade — é o que zera o `first_play` à meia-noite local. */
  function todayInTimeZone(now, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(now);
    } catch (_) {
      return (now || new Date()).toISOString().slice(0, 10);
    }
  }

  /**
   * Decide se este conteúdo ainda não teve a primeira exibição registrada hoje, já
   * devolvendo o estado atualizado. Função pura: quem chama persiste o `state`.
   */
  function markFirstPlay(state, contentId, today) {
    const current = state && state.date === today ? state : { date: today, contentIds: [] };
    if (!contentId) return { state: current, isFirst: false };
    if (current.contentIds.includes(contentId)) return { state: current, isFirst: false };
    return { state: { date: today, contentIds: current.contentIds.concat([contentId]) }, isFirst: true };
  }

  /**
   * As zonas no formato `ScreenshotZone` do contrato (§1.2), estendido para notícia
   * (plano "Trilha D — Player", seção 6.4): quando o item no ar tem `.news` (zona de
   * notícia+comunicado composta em `feed.js`), a mesma posição física gera uma
   * entrada **adicional** `{ position, kind: 'news', newsId, fallback }` — as duas
   * metades da tela (comunicado e notícia) são evidenciadas separadamente, mesmo
   * ocupando o mesmo `position` do layout principal.
   */
  function zonesFromSnapshot(snapshot) {
    const zones = [];
    ((snapshot && snapshot.zones) || []).forEach((zone) => {
      if (!zone || !zone.item) return;
      const item = zone.item;

      if (item.isAnnouncement) {
        zones.push({
          position: zone.position,
          kind: 'announcement',
          announcementId: item.announcementId || null,
        });
      } else {
        zones.push({
          position: zone.position,
          playlistId: zone.playlistId || null,
          playlistVersion: zone.playlistVersion == null ? null : zone.playlistVersion,
          contentId: item.contentId || item.id,
          itemIndex: zone.index == null ? null : zone.index,
        });
      }

      if (item.news) {
        zones.push({
          position: zone.position,
          kind: 'news',
          newsId: item.news.newsId || null,
          fallback: Boolean(item.news.isFallback),
        });
      }
    });
    return zones;
  }

  function buildMetadata(input) {
    return {
      id: input.id,
      capturedAt: new Date(input.capturedAtMs).toISOString(),
      trigger: input.trigger,
      method: input.method,
      commandId: input.commandId || null,
      width: input.width,
      height: input.height,
      sourceWidth: input.sourceWidth == null ? null : input.sourceWidth,
      sourceHeight: input.sourceHeight == null ? null : input.sourceHeight,
      bytes: input.bytes,
      sha256: input.sha256,
      zones: input.zones || [],
      infoBar: { enabled: Boolean(input.infoBarEnabled) },
      playerVersion: input.playerVersion || null,
    };
  }

  // ------------------------------------------------------------ orquestração

  /**
   * `deps` (tudo injetável, por isso o módulo é testável sem navegador):
   * - `now()`, `uuid()`, `delay(ms)`, `logger`
   * - `timeZone`, `playerVersion`
   * - `snapshot()` → estado da tela (vem do `render.js`)
   * - `fullyScreenshot()` → PNG base64 ou `null`
   * - `decodePng(b64)` → `{ canvas, width, height }`
   * - `imageDataOf(canvas)` → ImageData
   * - `recompose(snapshot)` → canvas
   * - `encodeWebp(canvas, width, height, quality)` → Blob
   * - `sha256(blob)` → hex
   * - fila: `listQueue()`, `enqueue(item)`, `deleteQueue(ids)`
   * - estado: `loadState(key)`, `saveState(key, value)`
   * - rede: `requestUploadUrl(body)`, `putObject(url, blob, headers)`, `postMetadata(body)`,
   *   `sendEvents(events)`
   */
  function createCapture(deps) {
    const now = deps.now || (() => Date.now());
    const logger = {
      info: (m, c) => { const l = deps.logger; if (l && l.info) l.info(m, c); },
      warn: (m, c) => { const l = deps.logger; if (l && l.warn) l.warn(m, c); },
      error: (m, c) => { const l = deps.logger; if (l && l.error) l.error(m, c); },
    };

    let lastAutoAtMs = 0;
    let lastScreenshotAtMs = null;
    let queueSize = 0;
    let flushing = false;
    let capturing = false;
    let intervalTimer = null;
    let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
    let lastBlackFrameLogAtMs = 0;
    let firstPlayState = null;
    let newsFirstPlayState = null;

    async function sendEvent(type, data) {
      if (!deps.sendEvents) return;
      try {
        await deps.sendEvents([{ type, occurredAt: new Date(now()).toISOString(), data: data || {} }]);
      } catch (error) {
        // Evento de diagnóstico não pode derrubar a captura; o log local fica de registro.
        logger.info('Evento do player não enviado', { type, error: error.message });
      }
    }

    // ---------------- fila ----------------

    /**
     * Envia o que está na fila. Um erro **sem status** é falta de rede: para o laço, porque
     * os próximos vão falhar igual. Um 4xx é problema daquele item (ex.: bytes divergentes
     * do objeto no R2) — ele ganha backoff e o laço segue, senão uma captura ruim
     * bloquearia a fila inteira para sempre.
     */
    async function flush() {
      if (flushing) return { sent: 0, failed: 0 };
      flushing = true;
      let sent = 0;
      let failed = 0;

      try {
        const all = await deps.listQueue();
        const { kept, dropped, bytes } = trimQueue(all, {
          maxItems: MAX_QUEUE_ITEMS,
          maxBytes: MAX_QUEUE_BYTES,
        });

        if (dropped.length > 0) {
          await deps.deleteQueue(dropped.map((i) => i.id));
          logger.warn('capture.queue_dropped', {
            descartadas: dropped.length,
            restantes: kept.length,
            bytesNaFila: bytes,
            motivo: kept.length >= MAX_QUEUE_ITEMS ? 'limite_de_itens' : 'limite_de_bytes',
          });
        }

        queueSize = kept.length;
        const nowMs = now();
        const done = [];

        for (const item of kept) {
          if (item.nextAttemptAt && item.nextAttemptAt > nowMs) continue;
          try {
            const upload = await deps.requestUploadUrl({
              id: item.id,
              bytes: item.bytes,
              contentType: 'image/webp',
              // O servidor deriva a key do storage a partir desta data
              // (`.../screenshots/2026/11/10/<playerId>/<id>.webp`) e precisa chegar à
              // MESMA key no registro dos metadados. Por isso vai o `capturedAt` original
              // dos metadados, nunca "agora": uma captura tirada 23:59 e enviada 00:01 (ou
              // que passou horas na fila) geraria duas keys diferentes, e o HEAD de
              // conferência do registro não acharia o objeto — a captura ficaria presa
              // na fila para sempre.
              capturedAt: item.metadata.capturedAt,
            });
            await deps.putObject(upload.url, item.blob, upload.headers);
            await deps.postMetadata(item.metadata);
            done.push(item.id);
            sent += 1;
          } catch (error) {
            failed += 1;
            const attempt = (Number(item.attempt) || 0) + 1;
            const waitMs = nextBackoffMs(attempt);
            await deps.enqueue({ ...item, attempt, nextAttemptAt: nowMs + waitMs });
            logger.warn('Falha ao enviar captura', {
              id: item.id,
              tentativa: attempt,
              proximaTentativaEmS: Math.round(waitMs / 1000),
              status: error.status,
              code: error.code,
              error: error.message,
            });
            if (!error.status) break;   // offline: não insiste nos outros agora
          }
        }

        if (done.length > 0) {
          await deps.deleteQueue(done);
          queueSize = Math.max(0, queueSize - done.length);
          logger.info('Capturas enviadas', { enviadas: done.length, restantesNaFila: queueSize });
        }
      } catch (error) {
        logger.error('Falha ao processar a fila de capturas', { error: error.message });
      } finally {
        flushing = false;
      }

      return { sent, failed };
    }

    // ---------------- captura ----------------

    /** Print real do Fully, já validado. `null` quando não deu. */
    async function deviceCapture(snapshot) {
      if (!deps.fullyScreenshot) return { canvas: null, reason: 'fully_unavailable' };

      let png = null;
      try {
        png = deps.fullyScreenshot();
      } catch (error) {
        return { canvas: null, reason: 'fully_threw', detail: error.message };
      }
      if (!png) return { canvas: null, reason: 'fully_unavailable' };

      let decoded;
      try {
        decoded = await deps.decodePng(png);
      } catch (error) {
        return { canvas: null, reason: 'decode_failed', detail: error.message };
      }

      // Só trata preto como falha quando há vídeo no ar: uma imagem legitimamente escura
      // é evidência válida, e descartá-la geraria recomposição sem motivo.
      if (snapshot && snapshot.hasVideoPlaying) {
        try {
          const ratio = blackRatio(deps.imageDataOf(decoded.canvas), BLACK_SAMPLE_SIDE);
          if (ratio > BLACK_RATIO) {
            return { canvas: null, reason: 'black_frame', detail: `${Math.round(ratio * 100)}% quase preto` };
          }
        } catch (error) {
          return { canvas: null, reason: 'sample_failed', detail: error.message };
        }
      }

      return { canvas: decoded.canvas, width: decoded.width, height: decoded.height };
    }

    /**
     * `capture(trigger, { commandId, settle, awaitUpload })` → id da captura, ou `null`
     * quando nada foi gravado (throttle, ou falha também na recomposição).
     */
    async function capture(trigger, opts) {
      opts = opts || {};
      if (!TRIGGERS.includes(trigger)) {
        logger.warn('Trigger de captura desconhecido', { trigger });
        return null;
      }

      const nowMs = now();
      if (shouldThrottle(trigger, lastAutoAtMs, nowMs, MIN_AUTO_GAP_MS)) {
        return null;      // silencioso de propósito: acontece muito e não é problema
      }
      // Duas capturas simultâneas disputariam o mesmo canvas; a segunda espera a próxima.
      if (capturing) return null;
      capturing = true;

      try {
        if (opts.settle !== false && deps.delay) await deps.delay(SETTLE_MS);

        const snapshot = deps.snapshot ? deps.snapshot() : null;
        const device = await deviceCapture(snapshot);
        let canvas = device.canvas;
        let method = 'device';
        let sourceWidth = device.width;
        let sourceHeight = device.height;

        if (!canvas) {
          method = 'recomposed';
          logger.warn('Captura real indisponível, recompondo a tela', {
            trigger,
            motivo: device.reason,
            detalhe: device.detail,
          });

          if (device.reason === 'black_frame' && nowMs - lastBlackFrameLogAtMs > BLACK_FRAME_LOG_MS) {
            lastBlackFrameLogAtMs = nowMs;
            await sendEvent('capture_black_frame', { trigger, detail: device.detail });
          }

          try {
            canvas = deps.recompose(snapshot);
            sourceWidth = snapshot ? snapshot.width : null;
            sourceHeight = snapshot ? snapshot.height : null;
          } catch (error) {
            // Causa mais comum: canvas "tainted" por mídia sem CORS — sem isso o
            // `toBlob` lança SecurityError e não há evidência nenhuma a enviar.
            logger.error('Recomposição da tela falhou: nenhuma evidência gerada', {
              trigger, error: error.message,
            });
            await sendEvent('capture_failed', { trigger, reason: error.message || 'recompose_failed' });
            return null;
          }
        }

        const size = scaleTo(canvas.width, canvas.height, MAX_WIDTH);
        let blob;
        try {
          blob = await deps.encodeWebp(canvas, size.width, size.height, WEBP_QUALITY);
        } catch (error) {
          logger.error('Codificação da captura falhou', { trigger, error: error.message });
          await sendEvent('capture_failed', { trigger, reason: 'encode_failed' });
          return null;
        }
        if (!blob || !blob.size) {
          await sendEvent('capture_failed', { trigger, reason: 'empty_blob' });
          return null;
        }
        if (blob.size > MAX_UPLOAD_BYTES) {
          logger.error('Captura acima do limite de 2 MB, descartada', { trigger, bytes: blob.size });
          await sendEvent('capture_failed', { trigger, reason: 'too_large', bytes: blob.size });
          return null;
        }

        const id = deps.uuid();
        const metadata = buildMetadata({
          id,
          capturedAtMs: nowMs,
          trigger,
          method,
          commandId: opts.commandId,
          width: size.width,
          height: size.height,
          sourceWidth,
          sourceHeight,
          bytes: blob.size,
          sha256: await deps.sha256(blob),
          zones: zonesFromSnapshot(snapshot),
          infoBarEnabled: Boolean(snapshot && snapshot.infoBar && snapshot.infoBar.enabled),
          playerVersion: deps.playerVersion,
        });

        await deps.enqueue({
          id,
          capturedAt: nowMs,
          bytes: blob.size,
          blob,
          metadata,
          attempt: 0,
          nextAttemptAt: 0,
        });

        lastScreenshotAtMs = nowMs;
        queueSize += 1;
        if (AUTO_TRIGGERS.includes(trigger)) lastAutoAtMs = nowMs;
        logger.info('Captura gravada na fila', {
          id, trigger, method, bytes: blob.size, filaAgora: queueSize,
        });

        if (opts.awaitUpload) await flush();
        else flush();

        return id;
      } finally {
        capturing = false;
      }
    }

    // ---------------- gatilhos ----------------

    /**
     * Primeira exibição de cada conteúdo no dia, por player (seção 2.2) — e, agora,
     * também a primeira exibição de cada notícia no dia (seção 6.4 do plano de
     * Notícias). Os dois contadores são independentes: um slot de comunicado com
     * notícia composta (`item.news`, ver `feed.js`) pode disparar por conta da
     * notícia mesmo sendo `isAnnouncement`, que por si só nunca dispara (comunicado
     * não entra no proof of play de conteúdo).
     */
    async function onItemShown(item) {
      if (!item) return;
      let shouldCapture = false;

      if (!item.isAnnouncement) {
        const contentId = item.contentId || item.id;
        if (contentId) {
          if (firstPlayState === null && deps.loadState) {
            try { firstPlayState = await deps.loadState(FIRST_PLAY_KEY); } catch (_) { firstPlayState = null; }
          }
          const today = todayInTimeZone(new Date(now()), deps.timeZone);
          const result = markFirstPlay(firstPlayState, contentId, today);
          firstPlayState = result.state;
          if (result.isFirst) {
            if (deps.saveState) {
              try { await deps.saveState(FIRST_PLAY_KEY, result.state); } catch (_) { /* segue em memória */ }
            }
            shouldCapture = true;
          }
        }
      }

      if (item.news && item.news.newsId) {
        if (newsFirstPlayState === null && deps.loadState) {
          try { newsFirstPlayState = await deps.loadState(NEWS_FIRST_PLAY_KEY); } catch (_) { newsFirstPlayState = null; }
        }
        const today = todayInTimeZone(new Date(now()), deps.timeZone);
        const result = markFirstPlay(newsFirstPlayState, item.news.newsId, today);
        newsFirstPlayState = result.state;
        if (result.isFirst) {
          if (deps.saveState) {
            try { await deps.saveState(NEWS_FIRST_PLAY_KEY, result.state); } catch (_) { /* segue em memória */ }
          }
          shouldCapture = true;
        }
      }

      if (shouldCapture) await capture('first_play');
    }

    /** `kind`: `'playlist_changed'` ou `'layout_changed'`, depois do primeiro render novo. */
    function onConfigChanged(kind) {
      if (kind !== 'playlist_changed' && kind !== 'layout_changed') return;
      capture(kind);
    }

    function setIntervalMinutes(minutes) {
      const value = Number(minutes);
      const next = Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_INTERVAL_MINUTES;
      if (next === intervalMinutes && intervalTimer) return;
      intervalMinutes = next;
      if (intervalTimer) clearInterval(intervalTimer);
      intervalTimer = setInterval(() => { capture('interval'); }, intervalMinutes * 60 * 1000);
      logger.info('Intervalo de captura aplicado', { minutos: intervalMinutes });
    }

    /**
     * Chamado depois do primeiro feed renderizado (inclusive logo após o pareamento,
     * seção 2.1.1). Com playlist, o `first_play` do primeiro item já dispara sozinho pelo
     * `onItemShown`; sem nenhum item, força uma captura para o player aparecer no
     * histórico de qualquer forma.
     */
    async function bootstrap(hasItems) {
      await flush();            // manda o que sobrou de antes de um reload/queda
      setIntervalMinutes(intervalMinutes);
      if (!hasItems) await capture('on_demand');
    }

    /** O que o heartbeat reporta (contrato §1.5). */
    function state() {
      return {
        lastScreenshotAt: lastScreenshotAtMs ? new Date(lastScreenshotAtMs).toISOString() : null,
        queueSize,
        fullyAvailable: Boolean(deps.isFullyAvailable ? deps.isFullyAvailable() : false),
      };
    }

    function stop() {
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    }

    return {
      capture, flush, onItemShown, onConfigChanged, setIntervalMinutes, bootstrap, state, stop,
      // expostos para teste
      _queueSize: () => queueSize,
    };
  }

  const api = {
    createCapture,
    scaleTo,
    nextBackoffMs,
    trimQueue,
    blackRatio,
    shouldThrottle,
    todayInTimeZone,
    markFirstPlay,
    zonesFromSnapshot,
    buildMetadata,
    MAX_WIDTH,
    MAX_UPLOAD_BYTES,
    MIN_AUTO_GAP_MS,
    SETTLE_MS,
    MAX_QUEUE_ITEMS,
    MAX_QUEUE_BYTES,
    BACKOFF_MS,
    AUTO_TRIGGERS,
    TRIGGERS,
    BLACK_RATIO,
    FIRST_PLAY_KEY,
    NEWS_FIRST_PLAY_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WindoorPlayer = root.WindoorPlayer || {};
    root.WindoorPlayer.capture = Object.assign(createCapture(browserDeps(root)), api);
  }

  // ------------------------------------------------------- deps de navegador

  function browserDeps(win) {
    const WP = () => win.WindoorPlayer;

    /**
     * Stub de desenvolvimento (seção 7.5): no navegador comum não existe `window.fully`.
     * Com `?fakeFully=1` devolvemos um PNG gerado na hora, para exercitar o caminho
     * "tela real" sem um TV box. Sem o parâmetro, o player cai na recomposição — que é
     * justamente o fallback que precisa ser testado.
     */
    function fakeScreenshotPng() {
      const canvas = win.document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1A1630';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#EEEDF5';
      ctx.font = 'bold 72px sans-serif';
      ctx.fillText('fakeFully', 80, 160);
      return canvas.toDataURL('image/png').split(',')[1];
    }

    function isDevFakeFully() {
      try { return new URLSearchParams(win.location.search).get('fakeFully') === '1'; }
      catch (_) { return false; }
    }

    function isFullyAvailable() {
      return Boolean(win.fully && typeof win.fully.getScreenshotPngBase64 === 'function');
    }

    function fullyScreenshot() {
      if (isFullyAvailable()) return win.fully.getScreenshotPngBase64();
      if (isDevFakeFully()) return fakeScreenshotPng();
      return null;
    }

    function decodePng(base64) {
      return new Promise((resolve, reject) => {
        const img = new win.Image();
        img.onload = () => {
          const canvas = win.document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          resolve({ canvas, width: canvas.width, height: canvas.height });
        };
        img.onerror = () => reject(new Error('PNG do Fully não decodificou'));
        img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
      });
    }

    function imageDataOf(canvas) {
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    }

    /** Dimensões naturais de <img>/<video>, para o cálculo de `object-fit: contain`. */
    function naturalSize(el) {
      if (!el) return null;
      const w = el.videoWidth || el.naturalWidth || el.width;
      const h = el.videoHeight || el.naturalHeight || el.height;
      return w && h ? { width: w, height: h } : null;
    }

    /** `object-fit: contain`: cabe inteiro na zona, centralizado, sem distorcer. */
    function containRect(natural, rect) {
      const scale = Math.min(rect.width / natural.width, rect.height / natural.height);
      const width = natural.width * scale;
      const height = natural.height * scale;
      return {
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height,
      };
    }

    /**
     * Redesenha a tela a partir do DOM (seção 2.3). Qualquer `drawImage` de mídia sem
     * CORS lança SecurityError aqui e deixa o canvas inutilizável — por isso o
     * `render.js` marca `crossOrigin="anonymous"` nos elementos de zona.
     */
    function recompose(snapshot) {
      if (!snapshot || !snapshot.width || !snapshot.height) {
        throw new Error('sem dimensões de tela para recompor');
      }
      const canvas = win.document.createElement('canvas');
      canvas.width = snapshot.width;
      canvas.height = snapshot.height;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#08060F';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      (snapshot.zones || []).forEach((zone) => {
        if (!zone.rect) return;
        ctx.fillStyle = '#000000';
        ctx.fillRect(zone.rect.x, zone.rect.y, zone.rect.width, zone.rect.height);
        const natural = naturalSize(zone.mediaEl);
        if (!zone.mediaEl || !natural) return;
        const target = containRect(natural, zone.rect);
        ctx.drawImage(zone.mediaEl, target.x, target.y, target.width, target.height);
      });

      const bar = snapshot.infoBar;
      if (bar && bar.enabled && bar.rect) {
        ctx.fillStyle = '#0A0712';
        ctx.fillRect(bar.rect.x, bar.rect.y, bar.rect.width, bar.rect.height);
        ctx.fillStyle = '#FFFFFF';
        const fontPx = Math.max(10, Math.round(bar.rect.height * 0.28));
        ctx.font = `500 ${fontPx}px sans-serif`;
        ctx.textBaseline = 'middle';
        const midY = bar.rect.y + bar.rect.height / 2;
        if (bar.left) ctx.fillText(bar.left, bar.rect.x + fontPx, midY);
        if (bar.center) {
          ctx.textAlign = 'center';
          ctx.fillText(bar.center, bar.rect.x + bar.rect.width / 2, midY);
          ctx.textAlign = 'left';
        }
        if (bar.logo) {
          ctx.textAlign = 'right';
          ctx.fillText(bar.logo, bar.rect.x + bar.rect.width - fontPx, midY);
          ctx.textAlign = 'left';
        }
      }

      return canvas;
    }

    function encodeWebp(canvas, width, height, quality) {
      const target = win.document.createElement('canvas');
      target.width = width;
      target.height = height;
      target.getContext('2d').drawImage(canvas, 0, 0, width, height);
      return new Promise((resolve, reject) => {
        try {
          target.toBlob((blob) => resolve(blob), 'image/webp', quality);
        } catch (error) {
          reject(error);   // canvas "tainted" estoura aqui
        }
      });
    }

    async function sha256(blob) {
      const buffer = await blob.arrayBuffer();
      const digest = await win.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    /** PUT direto no R2 com a URL pré-assinada: sem Authorization, header exato. */
    async function putObject(url, blob, headers) {
      const res = await win.fetch(url, {
        method: 'PUT',
        body: blob,
        headers: headers || { 'Content-Type': 'image/webp' },
      });
      if (!res.ok) {
        const error = new Error(`upload da captura respondeu ${res.status}`);
        error.status = res.status;
        throw error;
      }
    }

    return {
      now: () => Date.now(),
      uuid: () => win.crypto.randomUUID(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      get logger() { return WP().logger; },
      get timeZone() { return WP().config.INFO_BAR_TIMEZONE; },
      get playerVersion() { return WP().config.PLAYER_VERSION; },
      snapshot: () => WP().render.captureSnapshot(),
      isFullyAvailable,
      fullyScreenshot,
      decodePng,
      imageDataOf,
      recompose,
      encodeWebp,
      sha256,
      listQueue: () => WP().cache.listScreenshots(),
      enqueue: (item) => WP().cache.enqueueScreenshot(item),
      deleteQueue: (ids) => WP().cache.deleteScreenshots(ids),
      loadState: (key) => WP().cache.readEvidence(key),
      saveState: (key, value) => WP().cache.saveEvidence(key, value),
      requestUploadUrl: (body) => WP().api.post('/player/screenshots/upload-url', body),
      putObject,
      postMetadata: (body) => WP().api.post('/player/screenshots', body),
      sendEvents: (events) => WP().api.post('/player/events', { events }),
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
