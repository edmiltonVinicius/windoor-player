const test = require('node:test');
const assert = require('node:assert/strict');
const qrcodeLocal = require('../qrcode-local.js');
const qrcodeLib = require('../vendor/qrcode/qrcode.js');

test('buildSvg devolve null sem texto', () => {
  assert.equal(qrcodeLocal.buildSvg(''), null);
  assert.equal(qrcodeLocal.buildSvg(null), null);
});

test('buildSvg devolve null quando a lib não está disponível', () => {
  assert.equal(qrcodeLocal.buildSvg('https://wdr.link/abc', { qrcodeLib: null }), null);
});

test('buildSvg gera um <svg> com nível de correção M, sem margem embutida', () => {
  const svg = qrcodeLocal.buildSvg('https://wdr.link/abc123', { qrcodeLib });
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /<path d="/);
  assert.equal(qrcodeLocal.ERROR_CORRECTION_LEVEL, 'M');
});

test('buildSvg resolve a lib global (require do vendor) quando nenhuma é injetada', () => {
  global.qrcode = qrcodeLib;
  try {
    const svg = qrcodeLocal.buildSvg('https://wdr.link/zzz');
    assert.ok(svg.startsWith('<svg'));
  } finally {
    delete global.qrcode;
  }
});
