// Teste leve com o test runner nativo do Node (node --test), sem
// dependências externas. Cobre só a parte de cache.js que não depende de
// DOM/IndexedDB: o filtro de dayparting usado quando o totem exibe a lista
// salva em cache local (offline).
//
// Rodar com: node --test test/dayparting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarModuloCache() {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'cache.js'), 'utf8');
  // cache.js espera um `window` global (padrão do projeto: cada módulo se
  // registra em window.TotemPlayer.<nome>) e usa indexedDB só dentro de
  // funções que este teste não chama, então um stub vazio basta.
  const sandbox = { window: { indexedDB: {} }, indexedDB: {} };
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox, { filename: 'cache.js' });
  return sandbox.window.TotemPlayer.cache;
}

const cache = carregarModuloCache();

test('oferta sem daypartingStart/daypartingEnd é sempre válida', () => {
  const oferta = { id: 1 };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 14, 0)), true);
});

test('janela normal (não cruza meia-noite): dentro do horário', () => {
  const oferta = { daypartingStart: '08:00:00', daypartingEnd: '22:00:00' };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 8, 0)), true);
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 22, 0)), true);
});

test('janela normal: fora do horário', () => {
  const oferta = { daypartingStart: '08:00:00', daypartingEnd: '22:00:00' };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 6, 0)), false);
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 23, 0)), false);
});

test('janela que cruza a meia-noite: dentro do horário', () => {
  const oferta = { daypartingStart: '22:00:00', daypartingEnd: '06:00:00' };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 23, 30)), true);
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 1, 0)), true);
});

test('janela que cruza a meia-noite: fora do horário', () => {
  const oferta = { daypartingStart: '22:00:00', daypartingEnd: '06:00:00' };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 12, 0)), false);
});

test('filtrarPorDayparting mantém só ofertas válidas para o horário de referência', () => {
  const lista = [
    { id: 1, daypartingStart: '08:00:00', daypartingEnd: '22:00:00' },
    { id: 2, daypartingStart: '22:00:00', daypartingEnd: '06:00:00' },
    { id: 3 }, // sem restrição
  ];
  const agora = new Date(2026, 0, 1, 10, 0); // 10h da manhã
  const resultado = cache.filtrarPorDayparting(lista, agora);
  assert.deepEqual(resultado.map((o) => o.id), [1, 3]);
});

test('formato HH:MM (sem segundos) também funciona', () => {
  const oferta = { daypartingStart: '08:00', daypartingEnd: '22:00' };
  assert.equal(cache.estaDentroDoHorario(oferta, new Date(2026, 0, 1, 12, 0)), true);
});
