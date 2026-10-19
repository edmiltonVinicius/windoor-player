// node --test test/
// api.js é um módulo de navegador (IIFE em window.WindoorPlayer). Aqui ele é
// avaliado com shims mínimos: window = globalThis, localStorage em memória,
// CustomEvent/dispatchEvent/addEventListener e um fetch falso.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadApi() {
  globalThis.window = globalThis;
  const listeners = {};
  globalThis.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  globalThis.dispatchEvent = (ev) => { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; };
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    };
  }

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(code).call(globalThis);

  globalThis.WindoorPlayer.config = {
    API_URL: 'https://api.test/v1',
    EXTRA_HEADERS: { 'x-extra': '1' },
    getToken: () => store.get('token') || null,
  };

  return { api: globalThis.WindoorPlayer.api, store, listeners };
}

function fakeFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  return calls;
}

const jsonResponse = (status, body) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
});

test('desembrulha o envelope e devolve data', async () => {
  const { api } = loadApi();
  const calls = fakeFetch(jsonResponse(200, { success: true, data: [{ id: 'c1' }], errors: [], meta: { traceId: 't1' } }));
  const data = await api.get('/player/contents');
  assert.deepEqual(data, [{ id: 'c1' }]);
  assert.equal(calls[0].url, 'https://api.test/v1/player/contents');
  assert.equal(calls[0].init.headers['x-extra'], '1');
});

test('204 devolve undefined', async () => {
  const { api } = loadApi();
  fakeFetch({ status: 204, ok: true, json: async () => { throw new Error('sem corpo'); } });
  assert.equal(await api.post('/player/heartbeat', { playerVersion: '2.0.0' }), undefined);
});

test('erro monta ApiError com status, code e traceId', async () => {
  const { api } = loadApi();
  fakeFetch(jsonResponse(410, { success: false, data: {}, errors: [{ code: 'PAIRING_CODE_EXPIRED', message: 'Código expirado' }], meta: { traceId: 'abc' } }));
  await assert.rejects(() => api.post('/player/pair', { code: '000000' }, { auth: false }), (err) => {
    assert.ok(err instanceof api.ApiError);
    assert.equal(err.status, 410);
    assert.equal(err.code, 'PAIRING_CODE_EXPIRED');
    assert.equal(err.traceId, 'abc');
    assert.equal(err.message, 'Código expirado');
    return true;
  });
});

test('401 dispara windoor:unauthorized', async () => {
  const { api } = loadApi();
  let fired = null;
  globalThis.addEventListener('windoor:unauthorized', (ev) => { fired = ev; });
  fakeFetch(jsonResponse(401, { success: false, data: {}, errors: [{ code: 'PLAYER_UNAUTHORIZED', message: 'token inválido' }], meta: {} }));
  await assert.rejects(() => api.get('/player/contents'));
  assert.ok(fired, 'evento windoor:unauthorized não disparou');
  assert.equal(fired.detail.code, 'PLAYER_UNAUTHORIZED');
});

test('403 PLAYER_INACTIVE dispara windoor:inactive', async () => {
  const { api } = loadApi();
  let fired = null;
  globalThis.addEventListener('windoor:inactive', (ev) => { fired = ev; });
  fakeFetch(jsonResponse(403, { success: false, data: {}, errors: [{ code: 'PLAYER_INACTIVE', message: 'desativado' }], meta: {} }));
  await assert.rejects(() => api.get('/player/contents'));
  assert.ok(fired, 'evento windoor:inactive não disparou');
});

test('401 com auth:false não dispara evento de sessão', async () => {
  const { api } = loadApi();
  let fired = false;
  globalThis.addEventListener('windoor:unauthorized', () => { fired = true; });
  fakeFetch(jsonResponse(401, { success: false, data: {}, errors: [{ code: 'PLAYER_UNAUTHORIZED', message: 'x' }], meta: {} }));
  await assert.rejects(() => api.post('/player/pair', { code: '111111' }, { auth: false }));
  assert.equal(fired, false);
});

test('Authorization vai quando há token e não vai com auth:false', async () => {
  const { api, store } = loadApi();
  store.set('token', 'dev-token');

  let calls = fakeFetch(jsonResponse(200, { success: true, data: {}, errors: [], meta: {} }));
  await api.get('/player/contents');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer dev-token');

  calls = fakeFetch(jsonResponse(200, { success: true, data: {}, errors: [], meta: {} }));
  await api.post('/player/pair', { code: '123456' }, { auth: false });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('sem token nenhuma chamada leva Authorization', async () => {
  const { api } = loadApi();
  const calls = fakeFetch(jsonResponse(200, { success: true, data: {}, errors: [], meta: {} }));
  await api.get('/player/contents');
  assert.equal(calls[0].init.headers.Authorization, undefined);
});
