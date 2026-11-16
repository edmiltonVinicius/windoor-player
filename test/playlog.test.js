// node --test test/
// playlog.js é UMD: em Node vem como module.exports, com a fábrica `createPlayLog`
// recebendo relógio, persistência e envio injetados.
const test = require('node:test');
const assert = require('node:assert/strict');
const playlog = require('../playlog.js');

const HOUR = 60 * 60 * 1000;
/** 10/11/2026 17:30 UTC — bem no meio de uma hora, para exercitar o truncamento. */
const T0 = Date.parse('2026-11-10T17:30:00.000Z');

function harness(opts) {
  opts = opts || {};
  let clock = opts.start || T0;
  const state = new Map(opts.state || []);
  const sent = [];
  const logs = [];
  let fail = opts.fail || false;

  const log = {
    info: (m, c) => logs.push({ level: 'info', m, c }),
    warn: (m, c) => logs.push({ level: 'warn', m, c }),
    error: (m, c) => logs.push({ level: 'error', m, c }),
  };

  const instance = playlog.createPlayLog({
    now: () => clock,
    loadState: async (key) => state.get(key) || null,
    saveState: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); },
    send: async (buckets) => {
      if (fail) { const e = new Error('offline'); throw e; }
      sent.push(buckets);
    },
    logger: log,
  });

  return {
    instance,
    sent,
    logs,
    state,
    advance: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
    setFail: (v) => { fail = v; },
    now: () => clock,
  };
}

const contentItem = (id) => ({ id: `item-${id}`, contentId: id, isAnnouncement: false });
const ctx = { zone: 'top', playlistId: 'pl-1' };

test('hourBucketUtc trunca na hora cheia em UTC', () => {
  assert.equal(playlog.hourBucketUtc(T0), '2026-11-10T17:00:00.000Z');
  assert.equal(playlog.hourBucketUtc(Date.parse('2026-11-10T17:59:59.999Z')), '2026-11-10T17:00:00.000Z');
  assert.equal(playlog.hourBucketUtc(Date.parse('2026-11-10T18:00:00.000Z')), '2026-11-10T18:00:00.000Z');
});

test('isCountable exclui comunicado e item sem conteúdo', () => {
  assert.equal(playlog.isCountable(contentItem('c1')), true);
  assert.equal(playlog.isCountable({ id: 'x', contentId: 'c1', isAnnouncement: true }), false);
  assert.equal(playlog.isCountable({}), false);
  assert.equal(playlog.isCountable(null), false);
});

test('soma exibições no mesmo bucket e envia totais absolutos', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 8000, ctx);
  h.advance(10_000);
  h.instance.report(contentItem('c1'), 6000, ctx);

  await h.instance.flush();

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, 1);
  const bucket = h.sent[0][0];
  assert.equal(bucket.contentId, 'c1');
  assert.equal(bucket.playlistId, 'pl-1');
  assert.equal(bucket.zone, 'top');
  assert.equal(bucket.hourBucket, '2026-11-10T17:00:00.000Z');
  // Totais absolutos: 2 exibições e 14 s somados, não incrementos.
  assert.equal(bucket.plays, 2);
  assert.equal(bucket.durationMs, 14_000);
  assert.equal(bucket.firstAt, new Date(T0).toISOString());
  assert.equal(bucket.lastAt, new Date(T0 + 10_000).toISOString());
});

test('reenvio depois de novas exibições manda o total acumulado, não a diferença', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent[0][0].plays, 1);

  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent[1][0].plays, 2);
  assert.equal(h.sent[1][0].durationMs, 10_000);
});

test('bucket já confirmado não é reenviado sem exibição nova', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent.length, 1);

  const result = await h.instance.flush();
  assert.equal(result.sent, 0);
  assert.equal(h.sent.length, 1, 'não deveria ter mandado de novo');
});

test('zona e playlist separam buckets do mesmo conteúdo', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, { zone: 'top', playlistId: 'pl-1' });
  h.instance.report(contentItem('c1'), 5000, { zone: 'bottom', playlistId: 'pl-2' });
  await h.instance.flush();
  assert.equal(h.sent[0].length, 2);
});

test('troca de hora abre um bucket novo', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, ctx);
  h.setClock(Date.parse('2026-11-10T18:05:00.000Z'));
  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();

  const buckets = h.sent[0].map((b) => b.hourBucket).sort();
  assert.deepEqual(buckets, ['2026-11-10T17:00:00.000Z', '2026-11-10T18:00:00.000Z']);
});

test('comunicado não gera bucket', async () => {
  const h = harness();
  h.instance.report({ id: 'announcement:a1:0', contentId: 'c9', isAnnouncement: true }, 15_000, ctx);
  const result = await h.instance.flush();
  assert.equal(result.sent, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.instance.size(), 0);
});

test('zona sem playlist não gera bucket', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, { zone: 'full', playlistId: null });
  assert.equal(h.instance.size(), 0);
});

test('falha de envio mantém o bucket pendente para a próxima tentativa', async () => {
  const h = harness({ fail: true });
  h.instance.report(contentItem('c1'), 5000, ctx);

  const first = await h.instance.flush();
  assert.equal(first.failed, 1);
  assert.equal(h.instance.pending().length, 1);

  h.setFail(false);
  const second = await h.instance.flush();
  assert.equal(second.sent, 1);
  assert.equal(h.instance.pending().length, 0);
});

test('reload no meio da hora continua a contagem a partir do que foi persistido', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 8000, ctx);
  h.instance.report(contentItem('c1'), 8000, ctx);
  // `report` persiste de forma assíncrona; o flush garante a gravação final.
  await h.instance.flush();

  // Novo "processo": mesmo estado em disco, instância nova.
  const reloaded = harness({ state: Array.from(h.state.entries()), start: h.now() });
  const recovered = await reloaded.instance.hydrate();
  assert.equal(recovered, 1);

  reloaded.instance.report(contentItem('c1'), 4000, ctx);
  await reloaded.instance.flush();

  const bucket = reloaded.sent[0][0];
  assert.equal(bucket.plays, 3, 'as duas exibições de antes do reload não podem sumir');
  assert.equal(bucket.durationMs, 20_000);
});

test('prune descarta bucket confirmado com mais de 48 h e preserva o pendente', async () => {
  const h = harness();
  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();            // confirmado
  h.advance(49 * HOUR);
  h.instance.report(contentItem('c2'), 5000, ctx);   // pendente, hora atual

  const removed = h.instance.prune();
  assert.equal(removed, 1);
  assert.equal(h.instance.size(), 1);
  assert.equal(h.instance.pending().length, 1);
});

test('bucket pendente com mais de 48 h não é descartado', async () => {
  const h = harness({ fail: true });
  h.instance.report(contentItem('c1'), 5000, ctx);
  await h.instance.flush();            // falhou: segue pendente
  h.advance(49 * HOUR);

  assert.equal(h.instance.prune(), 0);
  assert.equal(h.instance.pending().length, 1);
});

test('envio é fatiado em lotes de 500 buckets', async () => {
  const h = harness();
  for (let i = 0; i < 501; i += 1) {
    h.instance.report(contentItem(`c${i}`), 1000, ctx);
  }
  await h.instance.flush();

  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].length, 500);
  assert.equal(h.sent[1].length, 1);
});

test('hydrate ignora bucket gravado sem os campos da chave', async () => {
  const h = harness({ state: [['playBuckets', { buckets: [{ contentId: 'c1' }, null] }]] });
  assert.equal(await h.instance.hydrate(), 0);
  assert.equal(h.instance.size(), 0);
});
