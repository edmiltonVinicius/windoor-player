const test = require('node:test');
const assert = require('node:assert/strict');
const newsfeed = require('../newsfeed.js');

const NOW = new Date('2026-11-17T18:00:00.000Z');

const item = (over = {}) => ({
  id: 'news-1',
  title: 'Título da notícia',
  section: 'Economia',
  imageUrl: 'https://cdn/news-1.jpg',
  imageSha256: 'abc',
  photoCredit: 'Fulano/Agência Brasil',
  sourceName: 'Agência Brasil',
  publishedAt: '2026-11-17T12:00:00.000Z',
  expiresAt: '2026-11-18T12:00:00.000Z',
  shortUrl: 'https://wdr.link/abc123',
  ...over,
});

test('normalizeNewsItem descarta item sem id, foto ou título', () => {
  assert.equal(newsfeed.normalizeNewsItem(item({ id: '' })), null);
  assert.equal(newsfeed.normalizeNewsItem(item({ imageUrl: '' })), null);
  assert.equal(newsfeed.normalizeNewsItem(item({ title: '  ' })), null);
  assert.ok(newsfeed.normalizeNewsItem(item()));
});

test('isNewsValid: vencida quando expiresAt já passou, sem expiresAt é inválida', () => {
  assert.equal(newsfeed.isNewsValid(item({ expiresAt: '2026-11-16T00:00:00.000Z' }), NOW), false);
  assert.equal(newsfeed.isNewsValid(item({ expiresAt: '2026-11-18T00:00:00.000Z' }), NOW), true);
  assert.equal(newsfeed.isNewsValid(item({ expiresAt: null }), NOW), false);
});

test('normalizeNewsFeed filtra vencidas, ordena por publishedAt desc e limita a 30', () => {
  const result = newsfeed.normalizeNewsFeed(
    {
      generatedAt: '2026-11-17T18:04:00.000Z',
      items: [
        item({ id: 'velha', publishedAt: '2026-11-16T12:00:00.000Z' }),
        item({ id: 'vencida', expiresAt: '2026-11-16T00:00:00.000Z' }),
        item({ id: 'nova', publishedAt: '2026-11-17T17:00:00.000Z' }),
      ],
    },
    NOW,
  );
  assert.deepEqual(result.items.map((i) => i.id), ['nova', 'velha']);
  assert.equal(result.generatedAt, '2026-11-17T18:04:00.000Z');
});

test('normalizeNewsFeed limita a MAX_ITEMS itens', () => {
  const items = Array.from({ length: 40 }, (_, i) => item({
    id: `n${i}`,
    publishedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
  }));
  const result = newsfeed.normalizeNewsFeed({ items }, NOW);
  assert.equal(result.items.length, newsfeed.MAX_ITEMS);
  assert.equal(result.items[0].id, 'n0');
});

test('toCacheEntry/isCacheFresh: dentro de 48h é fresco, depois não', () => {
  const feedNews = newsfeed.normalizeNewsFeed({ items: [item()] }, NOW);
  const entry = newsfeed.toCacheEntry(feedNews, NOW.getTime());
  assert.equal(newsfeed.isCacheFresh(entry, NOW.getTime() + 47 * 60 * 60 * 1000), true);
  assert.equal(newsfeed.isCacheFresh(entry, NOW.getTime() + 49 * 60 * 60 * 1000), false);
  assert.equal(newsfeed.isCacheFresh(null, NOW.getTime()), false);
});

test('selectNewsSource prioriza o feed atual sobre o cache', () => {
  const feedNews = { items: [item({ id: 'do-feed' })] };
  const cacheEntry = newsfeed.toCacheEntry({ items: [item({ id: 'do-cache' })] }, NOW.getTime());
  const result = newsfeed.selectNewsSource(feedNews, cacheEntry, NOW);
  assert.equal(result.source, 'feed');
  assert.deepEqual(result.items.map((i) => i.id), ['do-feed']);
});

test('selectNewsSource cai no cache (até 48h) quando o feed está vazio', () => {
  const cacheEntry = newsfeed.toCacheEntry({ items: [item({ id: 'do-cache' })] }, NOW.getTime());
  const later = new Date(NOW.getTime() + 10 * 60 * 60 * 1000);
  const result = newsfeed.selectNewsSource({ items: [] }, cacheEntry, later);
  assert.equal(result.source, 'cache');
  assert.deepEqual(result.items.map((i) => i.id), ['do-cache']);
});

test('selectNewsSource não usa cache com mais de 48h nem notícia do cache já vencida', () => {
  const cacheEntry = newsfeed.toCacheEntry({ items: [item({ id: 'do-cache' })] }, NOW.getTime());

  const tooLate = new Date(NOW.getTime() + 49 * 60 * 60 * 1000);
  assert.equal(newsfeed.selectNewsSource({ items: [] }, cacheEntry, tooLate).source, 'none');

  // Dentro das 48h de cache, mas a notícia em si já venceu (expiresAt) nesse meio tempo.
  const expiredCacheEntry = newsfeed.toCacheEntry(
    { items: [item({ id: 'do-cache', expiresAt: '2026-11-18T00:00:00.000Z' })] },
    NOW.getTime(),
  );
  const afterExpiry = new Date(Date.parse('2026-11-18T01:00:00.000Z'));
  assert.equal(newsfeed.selectNewsSource({ items: [] }, expiredCacheEntry, afterExpiry).source, 'none');
});

test('rotate é circular e nunca sai do array', () => {
  const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
  assert.equal(newsfeed.rotate(items, 0).id, 'a');
  assert.equal(newsfeed.rotate(items, 1).id, 'b');
  assert.equal(newsfeed.rotate(items, 3).id, 'a');
  assert.equal(newsfeed.rotate(items, -1).id, 'c');
  assert.equal(newsfeed.rotate([], 0), null);
});
