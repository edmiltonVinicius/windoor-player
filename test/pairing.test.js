// node --test test/
// normalizeCode/formatCode são puras e exportadas por UMD em pairing.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const pairing = require('../pairing.js');

test('normalizeCode remove letras e símbolos', () => {
  assert.equal(pairing.normalizeCode('4a8-2 9/1'), '48291');
  assert.equal(pairing.normalizeCode(''), '');
  assert.equal(pairing.normalizeCode(null), '');
  assert.equal(pairing.normalizeCode(undefined), '');
});

test('normalizeCode corta em 6 dígitos', () => {
  assert.equal(pairing.normalizeCode('1234567890'), '123456');
  assert.equal(pairing.normalizeCode(482915), '482915');
});

test('formatCode insere o hífen a partir do quarto dígito', () => {
  assert.equal(pairing.formatCode(''), '');
  assert.equal(pairing.formatCode('48'), '48');
  assert.equal(pairing.formatCode('482'), '482');
  assert.equal(pairing.formatCode('4829'), '482-9');
  assert.equal(pairing.formatCode('482915'), '482-915');
});

test('messageForError mapeia os códigos da seção 3.2', () => {
  assert.match(pairing.messageForError({ status: 404, code: 'PAIRING_CODE_INVALID' }), /inválido/);
  assert.match(pairing.messageForError({ status: 410, code: 'PAIRING_CODE_EXPIRED' }), /expirado/);
  assert.match(pairing.messageForError({ status: 429, code: 'TOO_MANY_ATTEMPTS' }), /Muitas tentativas/);
  assert.match(pairing.messageForError({ message: 'Failed to fetch' }), /Sem conexão/);
});
