window.WindoorPlayer = window.WindoorPlayer || {};

/**
 * Permite desparear o player a partir do próprio totem, sem depender do CMS.
 * Um técnico pressiona e segura o canto inferior direito da tela por alguns
 * segundos (não é um clique comum, para não ser acionado sem querer), confirma
 * num overlay simples, e o player volta à tela de pareamento.
 */
WindoorPlayer.unpair = (function () {
  const HOLD_MS = 3000;

  let holdTimerId = null;
  let overlayEl = null;

  function buildHotspot() {
    const hotspot = document.createElement('div');
    hotspot.id = 'unpair-hotspot';
    hotspot.setAttribute('aria-hidden', 'true');
    hotspot.style.cssText = [
      'position:fixed', 'right:0', 'bottom:0', 'width:64px', 'height:64px',
      'z-index:9998', 'opacity:0', 'touch-action:none',
    ].join(';');
    document.body.appendChild(hotspot);
    return hotspot;
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'unpair-overlay';
    overlay.hidden = true;
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999', 'display:flex',
      'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,.72)', 'font-family:system-ui,sans-serif',
    ].join(';');
    overlay.innerHTML = `
      <div style="background:#1a1a1a;color:#fff;border-radius:12px;padding:28px 32px;max-width:320px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)">
        <p style="margin:0 0 20px;font-size:16px;line-height:1.4">Desparear este player? Ele vai perder a conexão e vai precisar de um novo código para voltar a exibir conteúdo.</p>
        <div style="display:flex;gap:10px;justify-content:center">
          <button type="button" id="unpair-cancel" style="padding:10px 18px;border-radius:8px;border:1px solid #555;background:transparent;color:#fff;font-size:14px">Cancelar</button>
          <button type="button" id="unpair-confirm" style="padding:10px 18px;border-radius:8px;border:none;background:#d33;color:#fff;font-size:14px;font-weight:600">Desparear</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#unpair-cancel').addEventListener('click', hideOverlay);
    overlay.querySelector('#unpair-confirm').addEventListener('click', confirm);
    return overlay;
  }

  function showOverlay() {
    if (!overlayEl) overlayEl = buildOverlay();
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.hidden = true;
  }

  async function confirm() {
    const btn = overlayEl.querySelector('#unpair-confirm');
    btn.disabled = true;
    btn.textContent = 'Despareando…';
    try {
      await WindoorPlayer.api.post('/player/unpair');
    } catch (error) {
      if (WindoorPlayer.logger) {
        WindoorPlayer.logger.warn('Falha ao desparear via totem; limpando identidade local mesmo assim', {
          error: error.message, code: error.code,
        });
      }
    }
    WindoorPlayer.config.clearIdentity();
    location.reload();
  }

  function startHold() {
    if (!WindoorPlayer.config.getToken()) return; // nada pareado para desparear
    clearHold();
    holdTimerId = setTimeout(showOverlay, HOLD_MS);
  }

  function clearHold() {
    if (holdTimerId) { clearTimeout(holdTimerId); holdTimerId = null; }
  }

  function init() {
    const hotspot = buildHotspot();
    hotspot.addEventListener('pointerdown', startHold);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => hotspot.addEventListener(evt, clearHold));
  }

  return { init };
})();
