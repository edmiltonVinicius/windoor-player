// node --test test/
// capture.js é UMD: em Node vem como module.exports. Os helpers são puros e a fábrica
// `createCapture` recebe canvas, fila e rede injetados — por isso o fluxo inteiro
// (print real → validação de quadro preto → recomposição → fila → upload) roda sem
// navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const capture = require('../capture.js');

const T0 = Date.parse('2026-11-10T17:30:00.000Z');
const MINUTE = 60 * 1000;

// ---------------------------------------------------------------- helpers puros

test('scaleTo reduz para 1280 px mantendo a proporção e nunca amplia', () => {
  assert.deepEqual(capture.scaleTo(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.deepEqual(capture.scaleTo(1080, 1920, 1280), { width: 1080, height: 1920 });
  assert.deepEqual(capture.scaleTo(800, 600, 1280), { width: 800, height: 600 });
});

test('nextBackoffMs segue 5 s, 30 s, 2 min, 10 min e depois fica em 10 min', () => {
  assert.equal(capture.nextBackoffMs(1), 5000);
  assert.equal(capture.nextBackoffMs(2), 30_000);
  assert.equal(capture.nextBackoffMs(3), 120_000);
  assert.equal(capture.nextBackoffMs(4), 600_000);
  assert.equal(capture.nextBackoffMs(9), 600_000);
});

test('shouldThrottle segura capturas automáticas por 60 s e libera on_demand', () => {
  assert.equal(capture.shouldThrottle('interval', T0, T0 + 30_000), true);
  assert.equal(capture.shouldThrottle('first_play', T0, T0 + 30_000), true);
  assert.equal(capture.shouldThrottle('playlist_changed', T0, T0 + 30_000), true);
  assert.equal(capture.shouldThrottle('interval', T0, T0 + 61_000), false);
  // on_demand ignora o intervalo mínimo (seção 2.2).
  assert.equal(capture.shouldThrottle('on_demand', T0, T0 + 1), false);
  // Sem captura anterior nunca segura.
  assert.equal(capture.shouldThrottle('interval', 0, T0), false);
});

test('markFirstPlay marca uma vez por conteúdo e zera na virada do dia', () => {
  let state = null;

  let r = capture.markFirstPlay(state, 'c1', '2026-11-10');
  assert.equal(r.isFirst, true);
  state = r.state;

  r = capture.markFirstPlay(state, 'c1', '2026-11-10');
  assert.equal(r.isFirst, false, 'segunda exibição no mesmo dia não é a primeira');
  state = r.state;

  r = capture.markFirstPlay(state, 'c2', '2026-11-10');
  assert.equal(r.isFirst, true, 'outro conteúdo tem a sua própria primeira exibição');
  state = r.state;

  // Meia-noite no fuso da unidade: o conjunto zera e c1 volta a valer.
  r = capture.markFirstPlay(state, 'c1', '2026-11-11');
  assert.equal(r.isFirst, true);
  assert.equal(r.state.date, '2026-11-11');
  assert.deepEqual(r.state.contentIds, ['c1'], 'o conjunto do dia anterior não é mantido');
});

test('todayInTimeZone usa o fuso da unidade, não UTC', () => {
  // 03:00 UTC de 11/11 ainda é dia 10 em São Paulo (UTC−3).
  const instant = new Date('2026-11-11T02:00:00.000Z');
  assert.equal(capture.todayInTimeZone(instant, 'America/Sao_Paulo'), '2026-11-10');
  assert.equal(capture.todayInTimeZone(instant, 'UTC'), '2026-11-11');
});

/** ImageData sintético: `luma` aplicado a todos os pixels, com `bright` pixels claros. */
function fakeImage(width, height, luma, bright) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = i < (bright || 0) ? 255 : luma;
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

test('blackRatio detecta tela quase toda preta e não acusa tela clara', () => {
  assert.equal(capture.blackRatio(fakeImage(100, 100, 0), 20), 1);
  assert.equal(capture.blackRatio(fakeImage(100, 100, 255), 20), 0);
  assert.equal(capture.blackRatio({ width: 0, height: 0, data: null }, 20), 0);
});

test('trimQueue mantém as 200 mais novas e descarta as mais antigas', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, bytes: 1000 }));
  const { kept, dropped } = capture.trimQueue(items, { maxItems: 200, maxBytes: 50 * 1024 * 1024 });

  assert.equal(kept.length, 200);
  assert.equal(dropped.length, 50);
  // As descartadas são as mais antigas (as primeiras da lista).
  assert.equal(dropped[0].id, 's0');
  assert.equal(dropped[49].id, 's49');
  assert.equal(kept[0].id, 's50');
  assert.equal(kept[199].id, 's249');
});

test('trimQueue respeita o teto de bytes', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, bytes: 10 * 1024 * 1024 }));
  const { kept, dropped } = capture.trimQueue(items, { maxItems: 200, maxBytes: 50 * 1024 * 1024 });

  assert.equal(kept.length, 5);
  assert.equal(dropped.length, 5);
  assert.equal(kept[0].id, 's5');
});

test('zonesFromSnapshot monta ScreenshotZone de conteúdo e de comunicado', () => {
  const zones = capture.zonesFromSnapshot({
    zones: [
      {
        position: 'top',
        playlistId: 'pl-1',
        playlistVersion: 14,
        index: 3,
        item: { id: 'item-1', contentId: 'c1' },
      },
      {
        position: 'bottom',
        playlistId: 'pl-2',
        playlistVersion: 2,
        index: 1,
        item: { id: 'announcement:a1:0', contentId: 'c9', isAnnouncement: true, announcementId: 'a1' },
      },
      { position: 'full', item: null },     // zona vazia não entra
    ],
  });

  assert.deepEqual(zones, [
    { position: 'top', playlistId: 'pl-1', playlistVersion: 14, contentId: 'c1', itemIndex: 3 },
    { position: 'bottom', kind: 'announcement', announcementId: 'a1' },
  ]);
});

// ------------------------------------------------------------------ fluxo completo

/**
 * Monta uma instância com todas as dependências falsas. `fully` controla o que
 * `getScreenshotPngBase64` devolve; `videoPlaying` liga a checagem de quadro preto.
 */
function harness(opts) {
  opts = opts || {};
  let clock = T0;
  const queue = new Map();
  const state = new Map();
  const logs = [];
  const uploads = [];
  const uploadRequests = [];
  const metadata = [];
  const events = [];
  let uuidSeq = 0;
  let network = opts.network || 'ok';

  const log = (level) => (m, c) => logs.push({ level, m, c });

  const snapshot = {
    width: 1920,
    height: 1080,
    layout: 'fullscreen',
    zones: [{ position: 'full', playlistId: 'pl-1', playlistVersion: 3, index: 0, rect: {}, mediaEl: {}, item: { id: 'i1', contentId: 'c1' } }],
    infoBar: { enabled: true, rect: {} },
    hasVideoPlaying: Boolean(opts.videoPlaying),
  };

  function netError(status) {
    const e = new Error(status ? `http ${status}` : 'offline');
    if (status) e.status = status;
    return e;
  }

  const instance = capture.createCapture({
    now: () => clock,
    uuid: () => `shot-${++uuidSeq}`,
    delay: async () => {},
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    timeZone: 'America/Sao_Paulo',
    playerVersion: '2.0.0',
    snapshot: () => snapshot,
    isFullyAvailable: () => opts.fully === 'ok' || opts.fully === 'black',
    fullyScreenshot: () => {
      if (opts.fully === 'ok') return 'png-claro';
      if (opts.fully === 'black') return 'png-preto';
      if (opts.fully === 'throws') throw new Error('fully explodiu');
      return null;
    },
    decodePng: async (png) => {
      if (opts.fully === 'undecodable') throw new Error('não decodificou');
      return { canvas: { width: 1920, height: 1080, kind: png }, width: 1920, height: 1080 };
    },
    imageDataOf: (canvas) => fakeImage(100, 100, canvas.kind === 'png-preto' ? 0 : 200),
    recompose: () => {
      if (opts.recomposeFails) throw new Error('canvas tainted');
      return { width: 1920, height: 1080, kind: 'recomposto' };
    },
    encodeWebp: async (canvas, width, height) => ({
      size: opts.blobBytes || 86_016, width, height, from: canvas.kind,
    }),
    sha256: async () => 'a'.repeat(64),
    listQueue: async () => Array.from(queue.values()).sort((a, b) => a.capturedAt - b.capturedAt),
    enqueue: async (item) => { queue.set(item.id, item); },
    deleteQueue: async (ids) => { ids.forEach((id) => queue.delete(id)); },
    loadState: async (key) => state.get(key) || null,
    saveState: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); },
    requestUploadUrl: async (body) => {
      uploadRequests.push(body);
      if (network === 'offline') throw netError(null);
      if (network === 'upload-url-422') throw netError(422);
      return { url: `https://r2.test/${body.id}`, headers: { 'Content-Type': 'image/webp' } };
    },
    putObject: async (url, blob) => {
      if (network === 'put-fails') throw netError(500);
      uploads.push({ url, bytes: blob.size });
    },
    postMetadata: async (body) => {
      if (network === 'metadata-422') throw netError(422);
      metadata.push(body);
    },
    sendEvents: async (list) => { list.forEach((e) => events.push(e)); },
  });

  return {
    instance, queue, state, logs, uploads, uploadRequests, metadata, events, snapshot,
    advance: (ms) => { clock += ms; },
    setNetwork: (v) => { network = v; },
    now: () => clock,
    logsMatching: (needle) => logs.filter((l) => l.m.includes(needle)),
    /**
     * `capture()` devolve assim que grava na fila e sobe em segundo plano (é o que faz a
     * exibição não travar esperando rede). Quem gatilha a captura indiretamente
     * (`onItemShown`, `bootstrap`) precisa deixar esse envio terminar antes de verificar.
     */
    settle: async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); },
  };
}

test('com Fully disponível a captura sai como tela real', async () => {
  const h = harness({ fully: 'ok' });
  const id = await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(id, 'shot-1');
  assert.equal(h.metadata.length, 1);
  const meta = h.metadata[0];
  assert.equal(meta.method, 'device');
  assert.equal(meta.trigger, 'interval');
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
  assert.equal(meta.sourceWidth, 1920);
  assert.equal(meta.sourceHeight, 1080);
  assert.equal(meta.sha256.length, 64);
  assert.equal(meta.infoBar.enabled, true);
  assert.equal(meta.playerVersion, '2.0.0');
  assert.deepEqual(meta.zones, [
    { position: 'full', playlistId: 'pl-1', playlistVersion: 3, contentId: 'c1', itemIndex: 0 },
  ]);
});

test('sem window.fully a captura cai para recomposta', async () => {
  const h = harness({ fully: 'none' });
  await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(h.metadata[0].method, 'recomposed');
  const warn = h.logsMatching('recompondo a tela');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].c.motivo, 'fully_unavailable');
});

test('quadro preto com vídeo no ar vira recomposta e reporta capture_black_frame', async () => {
  const h = harness({ fully: 'black', videoPlaying: true });
  await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(h.metadata[0].method, 'recomposed');
  assert.equal(h.logsMatching('recompondo a tela')[0].c.motivo, 'black_frame');
  const blackEvents = h.events.filter((e) => e.type === 'capture_black_frame');
  assert.equal(blackEvents.length, 1);
});

test('quadro preto sem vídeo no ar é evidência válida e segue como tela real', async () => {
  const h = harness({ fully: 'black', videoPlaying: false });
  await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(h.metadata[0].method, 'device', 'imagem escura legítima não deve virar recomposta');
  assert.equal(h.events.filter((e) => e.type === 'capture_black_frame').length, 0);
});

test('capture_black_frame é agregado em no máximo 1 por hora', async () => {
  const h = harness({ fully: 'black', videoPlaying: true });
  await h.instance.capture('on_demand');
  await h.instance.capture('on_demand');
  assert.equal(h.events.filter((e) => e.type === 'capture_black_frame').length, 1);

  h.advance(61 * MINUTE);
  await h.instance.capture('on_demand');
  assert.equal(h.events.filter((e) => e.type === 'capture_black_frame').length, 2);
});

test('Fully que lança exceção não impede a evidência', async () => {
  const h = harness({ fully: 'throws' });
  await h.instance.capture('interval', { awaitUpload: true });
  assert.equal(h.metadata[0].method, 'recomposed');
  assert.equal(h.logsMatching('recompondo a tela')[0].c.motivo, 'fully_threw');
});

test('recomposição que falha reporta capture_failed e não envia imagem', async () => {
  const h = harness({ fully: 'none', recomposeFails: true });
  const id = await h.instance.capture('interval');

  assert.equal(id, null);
  assert.equal(h.metadata.length, 0);
  assert.equal(h.uploads.length, 0);
  const failed = h.events.filter((e) => e.type === 'capture_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.reason, 'canvas tainted');
});

test('captura acima de 2 MB é descartada com capture_failed', async () => {
  const h = harness({ fully: 'ok', blobBytes: 3 * 1024 * 1024 });
  const id = await h.instance.capture('interval');

  assert.equal(id, null);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.events.filter((e) => e.type === 'capture_failed')[0].data.reason, 'too_large');
});

test('intervalo mínimo de 60 s vale entre capturas automáticas', async () => {
  const h = harness({ fully: 'ok' });
  assert.ok(await h.instance.capture('interval', { awaitUpload: true }));

  h.advance(30_000);
  assert.equal(await h.instance.capture('interval'), null, 'antes de 60 s não deveria capturar');

  h.advance(31_000);
  assert.ok(await h.instance.capture('interval', { awaitUpload: true }), 'passados 61 s deveria capturar');
  assert.equal(h.metadata.length, 2);
});

test('on_demand passa por cima do intervalo mínimo', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.capture('interval', { awaitUpload: true });
  h.advance(1000);

  const id = await h.instance.capture('on_demand', { commandId: 'cmd-1', awaitUpload: true });
  assert.ok(id);
  assert.equal(h.metadata[1].trigger, 'on_demand');
  assert.equal(h.metadata[1].commandId, 'cmd-1', 'o commandId fecha o ciclo do painel');
});

test('on_demand não atualiza o relógio do intervalo automático', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.capture('on_demand', { awaitUpload: true });
  // Captura automática logo depois ainda deve passar: on_demand não conta como automática.
  assert.ok(await h.instance.capture('interval', { awaitUpload: true }));
});

test('onItemShown dispara first_play uma vez por conteúdo no dia', async () => {
  const h = harness({ fully: 'ok' });

  await h.instance.onItemShown({ id: 'i1', contentId: 'c1' });
  await h.settle();
  assert.equal(h.metadata.length, 1);
  assert.equal(h.metadata[0].trigger, 'first_play');

  h.advance(2 * MINUTE);          // passa do intervalo mínimo, para isolar o first_play
  await h.instance.onItemShown({ id: 'i1', contentId: 'c1' });
  await h.settle();
  assert.equal(h.metadata.length, 1, 'mesmo conteúdo no mesmo dia não captura de novo');

  await h.instance.onItemShown({ id: 'i2', contentId: 'c2' });
  await h.settle();
  assert.equal(h.metadata.length, 2, 'conteúdo novo tem a sua primeira exibição');
});

test('first_play zera na virada do dia no fuso da unidade', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.onItemShown({ id: 'i1', contentId: 'c1' });
  await h.settle();
  assert.equal(h.metadata.length, 1);

  // 10/11 17:30 UTC → avança para 11/11 04:00 UTC, que já é dia 11 em São Paulo.
  h.advance(10 * 60 * MINUTE + 30 * MINUTE);
  await h.instance.onItemShown({ id: 'i1', contentId: 'c1' });
  await h.settle();
  assert.equal(h.metadata.length, 2, 'no dia seguinte o mesmo conteúdo captura outra vez');
});

test('comunicado no ar não dispara first_play', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.onItemShown({ id: 'announcement:a1:0', contentId: 'c9', isAnnouncement: true });
  assert.equal(h.metadata.length, 0);
});

test('fila com 250 capturas mantém 200 e loga o descarte', async () => {
  const h = harness({ fully: 'ok', network: 'offline' });
  for (let i = 0; i < 250; i += 1) {
    h.queue.set(`old-${i}`, {
      id: `old-${i}`, capturedAt: T0 - (250 - i) * 1000, bytes: 1000,
      blob: { size: 1000 }, metadata: { id: `old-${i}` }, attempt: 0, nextAttemptAt: 0,
    });
  }

  await h.instance.flush();

  assert.equal(h.queue.size, 200);
  const dropped = h.logsMatching('capture.queue_dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].c.descartadas, 50);
  assert.equal(dropped[0].c.restantes, 200);
  // Sobraram as mais novas.
  assert.ok(h.queue.has('old-249'));
  assert.ok(!h.queue.has('old-0'));
});

test('offline mantém a fila e o reenvio depois não duplica', async () => {
  const h = harness({ fully: 'ok', network: 'offline' });
  const id = await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(h.queue.size, 1, 'a captura fica na fila enquanto não há rede');
  assert.equal(h.metadata.length, 0);
  const falha = h.logsMatching('Falha ao enviar captura');
  assert.equal(falha.length, 1);
  assert.equal(falha[0].c.tentativa, 1);
  assert.equal(falha[0].c.proximaTentativaEmS, 5);

  // Voltou a rede, mas o backoff ainda não venceu.
  h.setNetwork('ok');
  await h.instance.flush();
  assert.equal(h.metadata.length, 0, 'backoff de 5 s ainda não venceu');

  h.advance(6000);
  await h.instance.flush();
  assert.equal(h.metadata.length, 1);
  assert.equal(h.metadata[0].id, id);
  assert.equal(h.queue.size, 0, 'só sai da fila depois do 200/201');

  // Um flush extra não reenvia: a fila está vazia.
  await h.instance.flush();
  assert.equal(h.metadata.length, 1, 'não deveria duplicar no servidor');
});

test('upload-url pede a URL com o mesmo capturedAt que vai no registro', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.capture('interval', { awaitUpload: true });

  assert.equal(h.uploadRequests.length, 1);
  assert.deepEqual(h.uploadRequests[0], {
    id: 'shot-1',
    bytes: 86_016,
    contentType: 'image/webp',
    capturedAt: new Date(T0).toISOString(),
  });
  // A key do storage sai desta data: as duas chamadas têm de concordar.
  assert.equal(h.uploadRequests[0].capturedAt, h.metadata[0].capturedAt);
});

test('captura que esperou horas na fila reenvia o capturedAt original, não "agora"', async () => {
  const h = harness({ fully: 'ok', network: 'offline' });
  await h.instance.capture('interval', { awaitUpload: true });

  const original = new Date(T0).toISOString();
  assert.equal(h.uploadRequests[0].capturedAt, original);
  assert.equal(h.queue.size, 1);

  // Três horas offline; o backoff já venceu e a rede voltou.
  h.advance(3 * 60 * MINUTE);
  h.setNetwork('ok');
  await h.instance.flush();

  assert.equal(h.uploadRequests.length, 2);
  assert.equal(
    h.uploadRequests[1].capturedAt,
    original,
    'a key mudaria entre a tentativa que falhou e a seguinte, e o HEAD do registro não acharia o objeto',
  );
  assert.equal(h.metadata[0].capturedAt, original);
  assert.equal(h.queue.size, 0);
});

test('erro 4xx de um item não bloqueia os outros da fila', async () => {
  const h = harness({ fully: 'ok', network: 'metadata-422' });
  // Dois itens na fila, ambos com metadados recusados (bytes divergentes, por exemplo).
  h.queue.set('a', { id: 'a', capturedAt: T0 - 2000, bytes: 10, blob: { size: 10 }, metadata: { id: 'a' }, attempt: 0, nextAttemptAt: 0 });
  h.queue.set('b', { id: 'b', capturedAt: T0 - 1000, bytes: 10, blob: { size: 10 }, metadata: { id: 'b' }, attempt: 0, nextAttemptAt: 0 });

  await h.instance.flush();

  // Os dois foram tentados (não parou no primeiro), ambos continuam na fila com backoff.
  assert.equal(h.uploads.length, 2);
  assert.equal(h.queue.size, 2);
  assert.equal(h.queue.get('a').attempt, 1);
  assert.equal(h.queue.get('b').attempt, 1);
});

test('falha de rede para o laço e não insiste nos outros itens', async () => {
  const h = harness({ fully: 'ok', network: 'offline' });
  h.queue.set('a', { id: 'a', capturedAt: T0 - 2000, bytes: 10, blob: { size: 10 }, metadata: { id: 'a' }, attempt: 0, nextAttemptAt: 0 });
  h.queue.set('b', { id: 'b', capturedAt: T0 - 1000, bytes: 10, blob: { size: 10 }, metadata: { id: 'b' }, attempt: 0, nextAttemptAt: 0 });

  await h.instance.flush();

  assert.equal(h.queue.get('a').attempt, 1, 'o primeiro ganhou backoff');
  assert.equal(h.queue.get('b').attempt, 0, 'o segundo não foi nem tentado');
});

test('state() reporta o que o heartbeat precisa', async () => {
  const h = harness({ fully: 'ok', network: 'offline' });
  assert.deepEqual(h.instance.state(), { lastScreenshotAt: null, queueSize: 0, fullyAvailable: true });

  await h.instance.capture('interval');
  const state = h.instance.state();
  assert.equal(state.lastScreenshotAt, new Date(T0).toISOString());
  assert.equal(state.queueSize, 1);
});

test('state() avisa quando o Fully não foi detectado', () => {
  const h = harness({ fully: 'none' });
  assert.equal(h.instance.state().fullyAvailable, false);
});

test('bootstrap sem itens na playlist força uma captura', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.bootstrap(false);
  await h.settle();
  h.instance.stop();

  assert.equal(h.metadata.length, 1);
  assert.equal(h.metadata[0].trigger, 'on_demand');
});

test('bootstrap com itens na playlist deixa o first_play cuidar da captura', async () => {
  const h = harness({ fully: 'ok' });
  await h.instance.bootstrap(true);
  await h.settle();
  h.instance.stop();

  assert.equal(h.metadata.length, 0, 'quem captura é o onItemShown do primeiro item');
});

test('trigger desconhecido é recusado com log', async () => {
  const h = harness({ fully: 'ok' });
  assert.equal(await h.instance.capture('inventado'), null);
  assert.equal(h.logsMatching('Trigger de captura desconhecido').length, 1);
});

test('onConfigChanged só aceita playlist_changed e layout_changed', async () => {
  const h = harness({ fully: 'ok' });
  h.instance.onConfigChanged('qualquer_coisa');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.metadata.length, 0);
});
