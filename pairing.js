// Tela e fluxo de pareamento. normalizeCode/formatCode são puras e saem por
// UMD pra serem testadas em Node; run() só existe no navegador.
(function (root) {
  const CODE_LENGTH = 6;
  const LOCKOUT_MS = 60000;

  function normalizeCode(input) {
    return String(input == null ? '' : input).replace(/\D+/g, '').slice(0, CODE_LENGTH);
  }

  function formatCode(digits) {
    const d = normalizeCode(digits);
    if (d.length <= 3) return d;
    return `${d.slice(0, 3)}-${d.slice(3)}`;
  }

  const ERROR_MESSAGES = {
    PAIRING_CODE_INVALID: 'Código inválido. Confira os números.',
    PAIRING_CODE_EXPIRED: 'Código expirado. Gere um novo no painel.',
    TOO_MANY_ATTEMPTS: 'Muitas tentativas. Aguarde um minuto.',
  };

  function messageForError(error) {
    if (!error) return 'Não foi possível parear. Tente novamente.';
    if (error.code && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
    if (error.status === 404) return ERROR_MESSAGES.PAIRING_CODE_INVALID;
    if (error.status === 410) return ERROR_MESSAGES.PAIRING_CODE_EXPIRED;
    if (error.status === 429) return ERROR_MESSAGES.TOO_MANY_ATTEMPTS;
    if (!error.status) return 'Sem conexão com o servidor. Tente novamente.';
    return error.message || 'Não foi possível parear. Tente novamente.';
  }

  const api = { normalizeCode, formatCode, messageForError, CODE_LENGTH, LOCKOUT_MS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.WindoorPlayer = root.WindoorPlayer || {};

  let digits = '';
  let busy = false;
  let lockedUntil = 0;
  let lockoutTimerId = null;
  let resolveRun = null;
  let keyHandler = null;

  const el = (id) => document.getElementById(id);

  function renderDisplay() {
    const display = el('pairing-code');
    if (!display) return;
    const padded = digits.padEnd(CODE_LENGTH, '•');
    // Marca cada caractere faltante em cor apagada sem usar innerHTML com
    // dados do servidor (aqui só há dígitos digitados e '•').
    display.innerHTML = '';
    padded.split('').forEach((ch, i) => {
      if (i === 3) { const sep = document.createElement('span'); sep.textContent = '-'; display.appendChild(sep); }
      const span = document.createElement('span');
      span.textContent = ch;
      if (ch === '•') span.className = 'placeholder';
      display.appendChild(span);
    });

    const confirm = el('pairing-confirm');
    if (confirm) confirm.disabled = busy || isLocked() || digits.length < CODE_LENGTH;
  }

  function setMessage(text, kind) {
    const msg = el('pairing-message');
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = 'pairing-message' + (kind ? ' ' + kind : '');
  }

  function isLocked() { return Date.now() < lockedUntil; }

  function setKeypadEnabled(enabled) {
    document.querySelectorAll('#pairing .key').forEach((key) => { key.disabled = !enabled; });
    renderDisplay();
  }

  function startLockout() {
    lockedUntil = Date.now() + LOCKOUT_MS;
    setKeypadEnabled(false);
    if (lockoutTimerId) clearInterval(lockoutTimerId);
    const tick = () => {
      const remaining = Math.max(0, lockedUntil - Date.now());
      if (remaining === 0) {
        clearInterval(lockoutTimerId);
        lockoutTimerId = null;
        setKeypadEnabled(true);
        setMessage('', '');
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      setMessage(`Aguarde 0:${String(seconds).padStart(2, '0')}`, 'error');
    };
    tick();
    lockoutTimerId = setInterval(tick, 1000);
  }

  function pressDigit(d) {
    if (busy || isLocked()) return;
    digits = normalizeCode(digits + d);
    setMessage('', '');
    renderDisplay();
  }

  function pressBackspace() {
    if (busy || isLocked()) return;
    digits = digits.slice(0, -1);
    setMessage('', '');
    renderDisplay();
  }

  async function submit() {
    if (busy || isLocked() || digits.length < CODE_LENGTH) return;
    busy = true;
    setKeypadEnabled(false);
    setMessage('Pareando…', '');

    try {
      const data = await WindoorPlayer.api.post('/player/pair', { code: digits }, { auth: false });
      WindoorPlayer.config.setToken(data.deviceToken);
      WindoorPlayer.config.setPlayerInfo({
        playerId: data.playerId,
        playerName: data.playerName,
        unitName: data.unitName,
        clientName: data.clientName,
      });
      setMessage(`Pareado! ${data.playerName || ''} · ${data.unitName || ''}`, 'success');
      setTimeout(() => {
        teardown();
        if (resolveRun) { const r = resolveRun; resolveRun = null; r(); }
      }, 1500);
    } catch (error) {
      busy = false;
      setMessage(messageForError(error), 'error');
      if (error && (error.status === 429 || error.code === 'TOO_MANY_ATTEMPTS')) startLockout();
      else setKeypadEnabled(true);          // não limpa o código digitado
    }
  }

  function bindKeypad() {
    document.querySelectorAll('#pairing .key').forEach((key) => {
      key.addEventListener('click', () => {
        const action = key.getAttribute('data-action');
        if (action === 'backspace') pressBackspace();
        else if (action === 'confirm') submit();
        else pressDigit(key.getAttribute('data-digit') || '');
      });
    });
  }

  function bindPhysicalKeyboard() {
    keyHandler = (event) => {
      if (/^[0-9]$/.test(event.key)) { pressDigit(event.key); event.preventDefault(); }
      else if (event.key === 'Backspace') { pressBackspace(); event.preventDefault(); }
      else if (event.key === 'Enter') { submit(); event.preventDefault(); }
    };
    document.addEventListener('keydown', keyHandler);
  }

  function teardown() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (lockoutTimerId) { clearInterval(lockoutTimerId); lockoutTimerId = null; }
  }

  // A tela fica ativa indefinidamente (sem timeout); o watchdog não roda aqui.
  function run() {
    return new Promise((resolve) => {
      resolveRun = resolve;
      digits = '';
      busy = false;
      lockedUntil = 0;
      const version = el('pairing-version');
      if (version) version.textContent = 'versão ' + WindoorPlayer.config.PLAYER_VERSION;
      WindoorPlayer.render.showView('pairing');
      bindKeypad();
      bindPhysicalKeyboard();
      setKeypadEnabled(true);
      setMessage('', '');
      renderDisplay();
    });
  }

  root.WindoorPlayer.pairing = Object.assign({}, api, { run });
})(typeof window !== 'undefined' ? window : globalThis);
