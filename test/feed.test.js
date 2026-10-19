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

test('barra de informações: só textos, rodízio saneado', () => {
  const bar = feed.normalizeInfoBar({
    enabled: true,
    rotationSeconds: -5,
    messages: [{ text: ' Olá ' }, { text: '' }, { text: 'Segundo' }],
  });
  assert.equal(bar.rotationSeconds, 10);
  assert.deepEqual(bar.messages, ['Olá', 'Segundo']);
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
