// QR code local da zona de notícia (seção 6.3): o player nunca busca o QR num serviço
// externo — gera localmente, a partir do `shortUrl` que já vem no item do feed
// (`newsfeed.js`). Nível de correção M, fixo (seção "Regras importantes" do plano).
//
// Usa a lib vendorizada `vendor/qrcode/qrcode.js` (kazuhikoarase/qrcode-generator,
// MIT), carregada antes deste arquivo e exposta como `window.qrcode` (ou
// `global.qrcode`/`require('./vendor/qrcode/qrcode.js')` em teste). Função pura: não
// toca o DOM, só devolve o markup SVG — a margem branca de 10px (fundo branco com
// margem, seção "Regras importantes") é responsabilidade do CSS do wrapper em
// `render.js`, não deste módulo (a margem embutida na lib fica em módulos do próprio
// QR, não em px, então não dá para garantir "10px" nela).
//
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.qrcodeLocal.
(function (root) {
  const ERROR_CORRECTION_LEVEL = 'M';
  /** Auto-detecção do menor tamanho de QR que caiba no conteúdo (seção da lib). */
  const AUTO_TYPE_NUMBER = 0;

  /**
   * `opts.qrcodeLib` explícito (mesmo `null`, para testar "lib indisponível") sempre
   * ganha; sem a chave, resolve do ambiente — é o que permite injetar a lib nos testes
   * sem depender de `window`/`global`.
   */
  function resolveQrcodeLib(opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'qrcodeLib')) return opts.qrcodeLib;
    if (typeof root !== 'undefined' && root.qrcode) return root.qrcode;
    if (typeof global !== 'undefined' && global.qrcode) return global.qrcode;
    try { return require('./vendor/qrcode/qrcode.js'); } catch (_) { return null; }
  }

  /**
   * Markup SVG (string) do QR do `text` (tipicamente o `shortUrl` da notícia), sem
   * margem embutida (`margin: 0`) — quem desenha decide o tamanho final e a margem em
   * px. `null` quando falta texto ou a lib não está disponível (chamador decide o
   * fallback: não mostrar QR em vez de travar a zona).
   */
  function buildSvg(text, opts) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return null;

    const lib = resolveQrcodeLib(opts);
    if (!lib) return null;

    try {
      const qr = lib(AUTO_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
      qr.addData(value);
      qr.make();
      const cellSize = (opts && opts.cellSize) || 4;
      return qr.createSvgTag({ cellSize, margin: 0, scalable: true });
    } catch (error) {
      return null;
    }
  }

  const api = { buildSvg, ERROR_CORRECTION_LEVEL, AUTO_TYPE_NUMBER };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WindoorPlayer = root.WindoorPlayer || {};
    root.WindoorPlayer.qrcodeLocal = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
