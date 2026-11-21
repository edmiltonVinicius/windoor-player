// node --test test/
// newslog.js é UMD, mesmo mecanismo de playlog.js: em Node vem como module.exports, com
// a fábrica `createNewsLog` recebendo relógio, persistência e envio injetados.
const test = require('node:test');
const assert = require('node:assert/strict');
const newslog = require('../newslog.js');

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

  const instance = newslog.createNewsLog({
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

const newsItem = (id, over = {}) => ({ id: `item-${id}`, news: { newsId: id, isFallback: false, ...over } });
const ctx = { zone: 'top' };

test('hourBucketUtc trunca na hora cheia em UTC', () => {
  assert.equal(newslog.hourBucketUtc(T0), '2026-11-10T17:00:00.000Z');
  assert.equal(newslog.hourBucketUtc(Date.parse('2026-11-10T17:59:59.999Z')), '2026-11-10T17:00:00.000Z');
  assert.equal(newslog.hourBucketUtc(Date.parse('2026-11-10T18:00:00.000Z')), '2026-11-10T18:00:00.000Z');
});

test('isCountable exclui item sem notícia e o fallback de vídeo de marketing', () => {
  assert.equal(newslog.isCountable(newsItem('n1')), true);
  assert.equal(newslog.isCountable({ id: 'x', news: { newsId: null, isFallback: true } }), false);
  assert.equal(newslog.isCountable({ id: 'x', news: { newsId: 'n1', isFallback: true } }), false);
  assert.equal(newslog.isCountable({ id: 'x' }), false);
  assert.equal(newslog.isCountable(null), false);
});

test('soma exibições no mesmo bucket e envia totais absolutos', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 8000, ctx);
  h.advance(10_000);
  h.instance.report(newsItem('n1'), 6000, ctx);

  await h.instance.flush();

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, 1);
  const bucket = h.sent[0][0];
  assert.equal(bucket.newsId, 'n1');
  assert.equal(bucket.zone, 'top');
  assert.equal(bucket.hourBucket, '2026-11-10T17:00:00.000Z');
  assert.equal(bucket.fromCache, false);
  // Totais absolutos: 2 exibições e 14 s somados, não incrementos.
  assert.equal(bucket.plays, 2);
  assert.equal(bucket.durationMs, 14_000);
  assert.equal(bucket.firstAt, new Date(T0).toISOString());
  assert.equal(bucket.lastAt, new Date(T0 + 10_000).toISOString());
});

test('fromCache fica marcado assim que uma exibição vier do cache local', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, { zone: 'top', fromCache: false });
  h.instance.report(newsItem('n1'), 5000, { zone: 'top', fromCache: true });
  await h.instance.flush();
  assert.equal(h.sent[0][0].fromCache, true);
});

test('reenvio depois de novas exibições manda o total acumulado, não a diferença', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent[0][0].plays, 1);

  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent[1][0].plays, 2);
  assert.equal(h.sent[1][0].durationMs, 10_000);
});

test('bucket já confirmado não é reenviado sem exibição nova', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();
  assert.equal(h.sent.length, 1);

  const result = await h.instance.flush();
  assert.equal(result.sent, 0);
  assert.equal(h.sent.length, 1, 'não deveria ter mandado de novo');
});

test('zona separa buckets da mesma notícia', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, { zone: 'top' });
  h.instance.report(newsItem('n1'), 5000, { zone: 'bottom' });
  await h.instance.flush();
  assert.equal(h.sent[0].length, 2);
});

test('troca de hora abre um bucket novo', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, ctx);
  h.setClock(Date.parse('2026-11-10T18:05:00.000Z'));
  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();

  const buckets = h.sent[0].map((b) => b.hourBucket).sort();
  assert.deepEqual(buckets, ['2026-11-10T17:00:00.000Z', '2026-11-10T18:00:00.000Z']);
});

test('fallback de vídeo de marketing não gera bucket', async () => {
  const h = harness();
  h.instance.report({ id: 'x', news: { newsId: null, isFallback: true } }, 15_000, ctx);
  const result = await h.instance.flush();
  assert.equal(result.sent, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.instance.size(), 0);
});

test('zona ausente não gera bucket', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, { zone: null });
  assert.equal(h.instance.size(), 0);
});

test('falha de envio mantém o bucket pendente para a próxima tentativa', async () => {
  const h = harness({ fail: true });
  h.instance.report(newsItem('n1'), 5000, ctx);

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
  h.instance.report(newsItem('n1'), 8000, ctx);
  h.instance.report(newsItem('n1'), 8000, ctx);
  await h.instance.flush();

  const reloaded = harness({ state: Array.from(h.state.entries()), start: h.now() });
  const recovered = await reloaded.instance.hydrate();
  assert.equal(recovered, 1);

  reloaded.instance.report(newsItem('n1'), 4000, ctx);
  await reloaded.instance.flush();

  const bucket = reloaded.sent[0][0];
  assert.equal(bucket.plays, 3, 'as duas exibições de antes do reload não podem sumir');
  assert.equal(bucket.durationMs, 20_000);
});

test('prune descarta bucket confirmado com mais de 48 h e preserva o pendente', async () => {
  const h = harness();
  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();            // confirmado
  h.advance(49 * HOUR);
  h.instance.report(newsItem('n2'), 5000, ctx);   // pendente, hora atual

  const removed = h.instance.prune();
  assert.equal(removed, 1);
  assert.equal(h.instance.size(), 1);
  assert.equal(h.instance.pending().length, 1);
});

test('bucket pendente com mais de 48 h não é descartado', async () => {
  const h = harness({ fail: true });
  h.instance.report(newsItem('n1'), 5000, ctx);
  await h.instance.flush();            // falhou: segue pendente
  h.advance(49 * HOUR);

  assert.equal(h.instance.prune(), 0);
  assert.equal(h.instance.pending().length, 1);
});

test('envio é fatiado em lotes de 500 buckets', async () => {
  const h = harness();
  for (let i = 0; i < 501; i += 1) {
    h.instance.report(newsItem(`n${i}`), 1000, ctx);
  }
  await h.instance.flush();

  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].length, 500);
  assert.equal(h.sent[1].length, 1);
});

test('hydrate ignora bucket gravado sem os campos da chave', async () => {
  const h = harness({ state: [['newsBuckets', { buckets: [{ newsId: 'n1' }, null] }]] });
  assert.equal(await h.instance.hydrate(), 0);
  assert.equal(h.instance.size(), 0);
});
