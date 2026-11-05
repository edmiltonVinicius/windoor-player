// Servidor de desenvolvimento (REST, sem socket) que fala o contrato da
// seção 3 da spec, pra desenvolver o player sem o backend.
//
//   node test/mock-server.js
//   # e abra o player com ?api=http://localhost:4000/v1
//
// Pareamento: 123456 → sucesso; 000000 → 410 expirado; resto → 404 inválido.
const http = require('node:http');

const PORT = Number(process.env.PORT || 4000);
const DEVICE_TOKEN = 'dev-token';

// Feed no formato novo: layout, zonas com suas sequências e a barra da unidade.
// `?layout=split` devolve duas zonas, para exercitar o layout dividido.
const item = (n, seconds, type) => ({
  id: `item-${n}`,
  contentId: `content-${n}`,
  name: `Conteúdo ${n}`,
  type: type || 'image',
  url: `https://picsum.photos/id/10${n}/1920/1080`,
  durationSeconds: seconds,
  validUntil: null,
});

const FEED_FULLSCREEN = {
  playerId: 'player-1',
  layout: 'fullscreen',
  zones: [
    { position: 'full', playlist: { id: 'pl-1', name: 'Avisos do condomínio' }, items: [item(15, 8), item(25, 6), item(39, 10)] },
  ],
  infoBar: {
    enabled: true,
    rotationSeconds: 5,
    items: [
      { id: 'ib-1', type: 'text', text: 'Reunião de condomínio quinta, 19h' },
      { id: 'ib-2', type: 'image', contentId: 'content-90', url: 'https://picsum.photos/id/1011/750/56', validUntil: null },
      { id: 'ib-3', type: 'quotes', symbols: ['USD', 'EUR'] },
      { id: 'ib-4', type: 'weather', mode: 'today', location: { name: 'São Paulo', state: 'SP', latitude: -23.5475, longitude: -46.6361 } },
      { id: 'ib-4', type: 'text', text: 'Manutenção do elevador social sábado' },
    ],
  },
  skippedItems: 0,
};

const FEED_SPLIT = {
  ...FEED_FULLSCREEN,
  layout: 'split_top_bottom',
  zones: [
    { position: 'top', playlist: { id: 'pl-1', name: 'Avisos' }, items: [item(15, 8), item(25, 6)] },
    { position: 'bottom', playlist: { id: 'pl-2', name: 'Campanhas' }, items: [item(39, 5), item(48, 5)] },
  ],
};

const traceId = () => Math.random().toString(16).slice(2, 10);

function send(res, status, payload) {
  if (status === 204) { res.writeHead(204, cors()); res.end(); return; }
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, cors()));
  res.end(body);
}
// CORS liberado só neste mock; o backend real usa PLAYER_ORIGINS.
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
});
const ok = (res, data) => send(res, 200, { success: true, data, errors: [], meta: { traceId: traceId() } });
const fail = (res, status, code, message) =>
  send(res, status, { success: false, data: {}, errors: [{ code, message, field: null }], meta: { traceId: traceId() } });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
  });
}

const authorized = (req) => req.headers.authorization === `Bearer ${DEVICE_TOKEN}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); res.end(); return; }

  if (route === 'POST /v1/player/pair') {
    const body = await readBody(req);
    const code = String(body.code || '');
    if (code === '000000') return fail(res, 410, 'PAIRING_CODE_EXPIRED', 'Código expirado.');
    if (code !== '123456') return fail(res, 404, 'PAIRING_CODE_INVALID', 'Código inválido.');
    console.log('[mock] pair', code);
    return ok(res, { playerId: 'player-1', deviceToken: DEVICE_TOKEN, playerName: 'Elevador Social', unitName: 'Torre A', clientName: 'Condomínio Demo' });
  }

  if (route.startsWith('GET /v1/player/contents') || route.startsWith('POST /v1/player/')) {
    if (!authorized(req)) return fail(res, 401, 'PLAYER_UNAUTHORIZED', 'Token do dispositivo inválido.');
  }

  if (route === 'GET /v1/player/contents') {
    const split = /layout=split/.test(req.url || '');
    return ok(res, split ? FEED_SPLIT : FEED_FULLSCREEN);
  }

  // Simula GET /info-bar/quotes (seção 3.1 da doc) — ainda não existe no backend real.
  if (route.startsWith('GET /v1/info-bar/quotes')) {
    return ok(res, {
      items: [
        { symbol: 'USD', bid: 5.42, changePct: 0.3, sourceUpdatedAt: new Date().toISOString() },
        { symbol: 'EUR', bid: 6.21, changePct: -0.1, sourceUpdatedAt: new Date().toISOString() },
      ],
      fetchedAt: new Date().toISOString(),
    });
  }

  // Simula GET /info-bar/weather?lat=&lon= (doc do clima, seção 3.1).
  if (route.startsWith('GET /v1/info-bar/weather')) {
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    return ok(res, {
      location: { latitude: -23.55, longitude: -46.64 },
      current: { temperature: 24, condition: 'partly_cloudy' },
      days: [
        { date: day(0), condition: 'partly_cloudy', max: 27, min: 18 },
        { date: day(1), condition: 'partly_cloudy', max: 25, min: 17 },
        { date: day(2), condition: 'rain', max: 21, min: 16 },
      ],
      fetchedAt: new Date().toISOString(),
    });
  }

  if (route === 'POST /v1/player/heartbeat' || route === 'POST /v1/player/proof-of-play' || route === 'POST /v1/player/logs') {
    console.log('[mock]', route, await readBody(req));
    return send(res, 204);
  }

  return fail(res, 404, 'NOT_FOUND', `Rota não encontrada: ${route}`);
});

server.listen(PORT, () => {
  console.log(`[mock] ouvindo em http://localhost:${PORT}/v1 (token: ${DEVICE_TOKEN}, código de pareamento: 123456)`);
});
