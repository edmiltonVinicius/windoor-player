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
