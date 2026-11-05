const test = require('node:test');
const assert = require('node:assert');
const feed = require('../feed.js');

const NOW = new Date('2026-10-19T12:00:00.000Z');

const item = (over = {}) => ({
  id: 'item-1',
  contentId: 'content-1',
  name: 'Aviso',
  type: 'image',
  url: 'https://cdn/x.png',
  durationSeconds: 10,
  validUntil: null,
  ...over,
});

test('normalizeFeed devolve as zonas do layout, na ordem de exibição', () => {
  const result = feed.normalizeFeed(
    {
      layout: 'split_top_bottom',
      zones: [
        { position: 'bottom', playlist: { id: 'b', name: 'Base' }, items: [item()] },
        { position: 'top', playlist: { id: 't', name: 'Topo' }, items: [item()] },
      ],
    },
    NOW,
  );
  assert.deepEqual(result.zones.map((z) => z.position), ['top', 'bottom']);
  assert.equal(result.zones[0].playlist.name, 'Topo');
});

test('fullscreen tem exatamente uma zona, mesmo se vierem outras', () => {
  const result = feed.normalizeFeed(
    { layout: 'fullscreen', zones: [{ position: 'top', items: [item()] }, { position: 'full', items: [item()] }] },
    NOW,
  );
  assert.deepEqual(result.zones.map((z) => z.position), ['full']);
});

test('layout desconhecido cai em fullscreen', () => {
  assert.equal(feed.normalizeFeed({ layout: 'mosaico', zones: [] }, NOW).layout, 'fullscreen');
});

test('zona ausente no payload vira zona vazia sem playlist', () => {
  const result = feed.normalizeFeed({ layout: 'split_top_bottom', zones: [] }, NOW);
  assert.equal(result.zones.length, 2);
  assert.equal(result.zones[0].playlist, null);
  assert.deepEqual(result.zones[0].items, []);
});

test('descarta item vencido e mantém o sem validade', () => {
  const result = feed.normalizeFeed(
    {
      layout: 'fullscreen',
      zones: [{ position: 'full', items: [
        item({ id: 'vencido', validUntil: '2026-10-18T00:00:00.000Z' }),
        item({ id: 'vale', validUntil: null }),
        item({ id: 'futuro', validUntil: '2026-12-01T00:00:00.000Z' }),
      ] }],
    },
    NOW,
  );
  assert.deepEqual(result.zones[0].items.map((i) => i.id), ['vale', 'futuro']);
});

test('descarta item sem url ou de tipo desconhecido', () => {
  const result = feed.normalizeFeed(
    { layout: 'fullscreen', zones: [{ position: 'full', items: [
      item({ id: 'sem-url', url: '' }),
      item({ id: 'tipo-ruim', type: 'pdf' }),
      item({ id: 'bom' }),
    ] }] },
    NOW,
  );
  assert.deepEqual(result.zones[0].items.map((i) => i.id), ['bom']);
});

test('duração inválida cai no padrão de 10s', () => {
  const result = feed.normalizeFeed(
    { layout: 'fullscreen', zones: [{ position: 'full', items: [item({ durationSeconds: 0 }), item({ id: 'i2', durationSeconds: 'x' })] }] },
    NOW,
  );
  assert.deepEqual(result.zones[0].items.map((i) => i.durationSeconds), [10, 10]);
});

test('barra de informações: itens de texto, rodízio saneado', () => {
  const bar = feed.normalizeInfoBar({
    enabled: true,
    rotationSeconds: -5,
    items: [
      { id: 'i1', type: 'text', text: ' Olá ' },
      { id: 'i2', type: 'text', text: '' },
      { id: 'i3', type: 'text', text: 'Segundo' },
    ],
  });
  assert.equal(bar.rotationSeconds, 10);
  assert.deepEqual(bar.items, [
    { id: 'i1', type: 'text', text: 'Olá' },
    { id: 'i3', type: 'text', text: 'Segundo' },
  ]);
});

test('barra de informações: imagem sem url é descartada, cotações sem moeda válida também', () => {
  const bar = feed.normalizeInfoBar({
    enabled: true,
    rotationSeconds: 10,
    items: [
      { id: 'i1', type: 'image', contentId: 'c1', url: '' },
      { id: 'i2', type: 'quotes', symbols: ['XXX'] },
      { id: 'i3', type: 'image', contentId: 'c2', url: 'https://cdn/bar.png', validUntil: null },
      { id: 'i4', type: 'quotes', symbols: ['USD', 'EUR', 'GBP'] },
      { id: 'i5', type: 'unknown' },
    ],
  });
  assert.deepEqual(bar.items, [
    { id: 'i3', type: 'image', contentId: 'c2', url: 'https://cdn/bar.png', validUntil: null },
    { id: 'i4', type: 'quotes', symbols: ['USD', 'EUR'] },
  ]);
});

test('barra de informações: no máximo 10 itens', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ id: `i${i}`, type: 'text', text: `Item ${i}` }));
  const bar = feed.normalizeInfoBar({ enabled: true, rotationSeconds: 10, items });
  assert.equal(bar.items.length, 10);
});

test('isInfoBarItemEligible: texto sempre elegível', () => {
  assert.equal(feed.isInfoBarItemEligible({ type: 'text', text: 'a' }, new Date()), true);
});

test('isInfoBarItemEligible: imagem vencida é pulada', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const expired = { type: 'image', url: 'x', validUntil: '2026-11-01T00:00:00.000Z' };
  const future = { type: 'image', url: 'y', validUntil: '2026-12-01T00:00:00.000Z' };
  assert.equal(feed.isInfoBarItemEligible(expired, now), false);
  assert.equal(feed.isInfoBarItemEligible(future, now), true);
});

test('isInfoBarItemEligible: imagem ainda não baixada é pulada', () => {
  const item = { type: 'image', url: 'x', validUntil: null };
  assert.equal(feed.isInfoBarItemEligible(item, new Date(), null, () => false), false);
  assert.equal(feed.isInfoBarItemEligible(item, new Date(), null, () => true), true);
});

test('isInfoBarItemEligible: cotações sem cache, com cache velho ou sem a moeda pedida', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const item = { type: 'quotes', symbols: ['USD'] };
  assert.equal(feed.isInfoBarItemEligible(item, now, null), false);
  assert.equal(
    feed.isInfoBarItemEligible(item, now, { items: [{ symbol: 'EUR' }], fetchedAt: now.getTime() }),
    false,
  );
  assert.equal(
    feed.isInfoBarItemEligible(item, now, { items: [{ symbol: 'USD' }], fetchedAt: now.getTime() - 7 * 60 * 60 * 1000 }),
    false,
  );
  assert.equal(
    feed.isInfoBarItemEligible(item, now, { items: [{ symbol: 'USD' }], fetchedAt: now.getTime() - 60 * 60 * 1000 }),
    true,
  );
});

test('sem barra no payload, ela vem desligada', () => {
  assert.equal(feed.normalizeFeed({ layout: 'fullscreen', zones: [] }, NOW).infoBar.enabled, false);
});

test('imageUrls ignora vídeo (não é pré-carregado)', () => {
  const result = feed.normalizeFeed(
    { layout: 'fullscreen', zones: [{ position: 'full', items: [
      item({ id: 'img', url: 'https://cdn/a.png' }),
      item({ id: 'vid', type: 'video', url: 'https://cdn/b.mp4' }),
    ] }] },
    NOW,
  );
  assert.deepEqual(feed.imageUrls(result), ['https://cdn/a.png']);
  assert.equal(feed.totalItems(result), 2);
});

test('imageUrls inclui a imagem da barra de informações', () => {
  const result = feed.normalizeFeed(
    {
      layout: 'fullscreen',
      zones: [{ position: 'full', items: [item({ id: 'img', url: 'https://cdn/a.png' })] }],
      infoBar: {
        enabled: true,
        rotationSeconds: 10,
        items: [{ id: 'bar-1', type: 'image', contentId: 'c1', url: 'https://cdn/bar.png' }],
      },
    },
    NOW,
  );
  assert.deepEqual(feed.imageUrls(result), ['https://cdn/a.png', 'https://cdn/bar.png']);
});

test('payload antigo (array plano) não quebra: vira feed vazio marcado como legado', () => {
  const result = feed.normalizeFeed([{ id: 'c1', title: 'antigo', imageUrl: 'x' }], NOW);
  assert.equal(result.legacy, true);
  assert.equal(feed.totalItems(result), 0);
});

test('payload nulo devolve feed vazio em fullscreen', () => {
  const result = feed.normalizeFeed(null, NOW);
  assert.equal(result.layout, 'fullscreen');
  assert.equal(result.zones.length, 1);
  assert.equal(feed.totalItems(result), 0);
});

// ---------- clima (barra de informações) ----------

const WEATHER_ITEM = { id: 'w1', type: 'weather', mode: 'today', location: { name: 'São Paulo', state: 'SP', latitude: -23.5475, longitude: -46.6361 } };
const WEATHER_NOW = new Date('2026-11-05T18:00:00.000Z'); // 15:00 em Brasília
const snapshot = (over = {}) => ({
  location: { latitude: -23.55, longitude: -46.64 },
  current: { temperature: 24, condition: 'partly_cloudy' },
  days: [
    { date: '2026-11-05', condition: 'partly_cloudy', max: 27, min: 18 },
    { date: '2026-11-06', condition: 'partly_cloudy', max: 25, min: 17 },
    { date: '2026-11-07', condition: 'rain', max: 21, min: 16 },
  ],
  fetchedAt: WEATHER_NOW.getTime() - 60 * 60 * 1000,
  ...over,
});
const eligible = (itemOver, snap, now = WEATHER_NOW) =>
  feed.isInfoBarItemEligible({ ...WEATHER_ITEM, ...itemOver }, now, null, null, snap, 'America/Sao_Paulo');

test('normalizeInfoBarItem aceita clima e cai em "today" com formato desconhecido', () => {
  assert.deepStrictEqual(feed.normalizeInfoBarItem({ ...WEATHER_ITEM, mode: 'week' }), { ...WEATHER_ITEM, mode: 'today' });
  assert.strictEqual(feed.normalizeInfoBarItem({ id: 'w', type: 'weather', mode: 'now', location: {} }), null);
});

test('weatherKey agrupa coordenadas próximas como o backend (2 casas)', () => {
  assert.strictEqual(feed.weatherKey(-23.5475, -46.6361), '-23.55:-46.64');
  assert.strictEqual(feed.weatherKey(-23.55, -46.64), '-23.55:-46.64');
});

test('clima elegível com snapshot do mesmo local e até 3 h', () => {
  assert.strictEqual(eligible({}, snapshot()), true);
  assert.strictEqual(eligible({ mode: 'days' }, snapshot()), true);
  assert.strictEqual(eligible({ mode: 'now' }, snapshot()), true);
});

test('clima pulado sem snapshot, de outro local ou com mais de 3 h', () => {
  assert.strictEqual(eligible({}, null), false);
  assert.strictEqual(eligible({}, snapshot({ location: { latitude: -22.91, longitude: -47.06 } })), false);
  const stale = snapshot({ fetchedAt: WEATHER_NOW.getTime() - (3 * 60 + 1) * 60 * 1000 });
  assert.strictEqual(eligible({}, stale), false);
  const fresh = snapshot({ fetchedAt: WEATHER_NOW.getTime() - (2 * 60 + 59) * 60 * 1000 });
  assert.strictEqual(eligible({}, fresh), true);
});

test('virada de dia descarta days[0] de ontem', () => {
  const tomorrow = new Date('2026-11-06T12:00:00.000Z');
  const snap = snapshot({ fetchedAt: tomorrow.getTime() - 60 * 1000 });
  const days = feed.upcomingWeatherDays(snap, tomorrow, 'America/Sao_Paulo');
  assert.deepStrictEqual(days.map((d) => d.date), ['2026-11-06', '2026-11-07']);
  assert.strictEqual(eligible({ mode: 'days' }, snap, tomorrow), true);   // ainda tem 2 dias
  const lastDay = new Date('2026-11-07T12:00:00.000Z');
  assert.strictEqual(eligible({ mode: 'days' }, snapshot({ fetchedAt: lastDay.getTime() }), lastDay), false);
  assert.strictEqual(eligible({ mode: 'today' }, snapshot({ fetchedAt: lastDay.getTime() }), lastDay), true);
});
