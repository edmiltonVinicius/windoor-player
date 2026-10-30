// Tela e fluxo de pareamento.
// normalizeCode/formatCode/messageForError são puras e exportadas via UMD para testes em Node;
// run() só existe no navegador.
(function (root) {
  const CODE_LENGTH = 6;
  const LOCKOUT_MS = 60000;
  const INACTIVITY_MS = 2 * 60 * 1000; // limpa código parcial após 2 min sem tecla

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

  // ---- estado ----
  let digits = '';
  let busy = false;
  let hasError = false;
  let connected = false;
  let lockedUntil = 0;
  let lockoutTimerId = null;
  let inactivityTimerId = null;
  let resolveRun = null;
  let keyHandler = null;
  let connectivityTimerId = null;

  const el = (id) => document.getElementById(id);

  // ---- grade do teclado para navegação D-pad ----
  // Ordem no DOM: 1 2 3 / 4 5 6 / 7 8 9 / clear 0 backspace
  // grade[row][col] → data-digit ou data-action value
  const KEYPAD_GRID = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['clear', '0', 'backspace'],
  ];

  function keypadButton(digit, action) {
    if (digit != null) return document.querySelector(`#pairing-keypad [data-digit="${digit}"]`);
    return document.querySelector(`#pairing-keypad [data-action="${action}"]`);
  }

  function gridPositionOf(btn) {
    for (let r = 0; r < KEYPAD_GRID.length; r++) {
      for (let c = 0; c < KEYPAD_GRID[r].length; c++) {
        const val = KEYPAD_GRID[r][c];
        const b = /^\d$/.test(val) ? keypadButton(val, null) : keypadButton(null, val);
        if (b === btn) return { r, c };
      }
    }
    return null;
  }

  function buttonAt(r, c) {
    if (r < 0 || r >= KEYPAD_GRID.length) return null;
    const val = KEYPAD_GRID[r][c];
    return /^\d$/.test(val) ? keypadButton(val, null) : keypadButton(null, val);
  }

  // ---- renderização das casas ----
  function renderDigits() {
    const boxes = document.querySelectorAll('#pairing-digits .p-dbox');
    boxes.forEach((box, i) => {
      const ch = digits[i] ?? '';
      box.textContent = ch;

      delete box.dataset.filled;
      delete box.dataset.current;
      delete box.dataset.error;
      delete box.dataset.success;

      if (hasError) {
        box.dataset.error = '';
        return;
      }
      if (ch) {
        box.dataset.filled = '';
      } else if (i === digits.length) {
        box.dataset.current = '';
      }
    });
  }

  function renderConfirmButton() {
    const btn = el('pairing-confirm');
    if (!btn) return;
    const canPair = !busy && !isLocked() && digits.length === CODE_LENGTH && connected && !hasError;
    btn.disabled = !canPair;
    btn.removeAttribute('aria-busy');
  }

  // ---- chip de conexão ----
  function renderChips() {
    ['pairing-chip-pt', 'pairing-chip-ls'].forEach((id) => {
      const chip = el(id);
      if (!chip) return;
      const txtEl = chip.querySelector('.p-chip-txt');
      const isPortrait = id === 'pairing-chip-pt';
      if (connected) {
        chip.dataset.connected = '';
        if (txtEl) txtEl.textContent = isPortrait ? 'Conectado' : 'Conectado ao servidor';
      } else {
        delete chip.dataset.connected;
        if (txtEl) txtEl.textContent = isPortrait ? 'Conectando…' : 'Conectando ao servidor…';
      }
    });
  }

  // ---- mensagem ----
  function setMessage(text, kind) {
    const msg = el('pairing-message');
    if (!msg) return;
    msg.textContent = text || '';
    if (kind) {
      msg.dataset.kind = kind;
    } else {
      delete msg.dataset.kind;
    }
  }

  function buildMessageText() {
    if (busy) return '';
    if (isLocked()) return ''; // lockout timer cuida do texto
    if (hasError) return ''; // erro já está no data-kind=error via setMessage
    if (!connected) return 'Aguardando conexão para parear.';
    const remaining = CODE_LENGTH - digits.length;
    if (remaining === 0) return 'Pronto. Selecione Parear player.';
    if (remaining === 1) return 'Falta 1 número.';
    return `Faltam ${remaining} números.`;
  }

  function refreshMessage() {
    if (hasError) return; // não sobrescreve mensagem de erro
    setMessage(buildMessageText(), digits.length === CODE_LENGTH && !busy ? 'success' : '');
  }

  // ---- teclado bloqueado/habilitado ----
  function isLocked() { return Date.now() < lockedUntil; }

  function setKeypadEnabled(enabled) {
    document.querySelectorAll('#pairing-keypad .key').forEach((k) => { k.disabled = !enabled; });
    renderConfirmButton();
  }

  // ---- inatividade ----
  function resetInactivityTimer() {
    if (inactivityTimerId) clearTimeout(inactivityTimerId);
    if (digits.length === 0) return; // só reinicia quando há dígitos
    inactivityTimerId = setTimeout(() => {
      if (!busy && digits.length > 0 && digits.length < CODE_LENGTH) {
        clearCode();
      }
    }, INACTIVITY_MS);
  }

  function clearInactivityTimer() {
    if (inactivityTimerId) { clearTimeout(inactivityTimerId); inactivityTimerId = null; }
  }

  // ---- conectividade ----
  function setConnected(state) {
    if (connected === state) return;
    connected = state;
    renderChips();
    renderConfirmButton();
    refreshMessage();
  }

  async function checkConnectivity() {
    if (!WindoorPlayer.config || !WindoorPlayer.config.API_URL) {
      setConnected(false);
      return;
    }
    try {
      await WindoorPlayer.api.get('/health', { auth: false, timeout: 5000 }).catch(() => {
        // /health pode não existir; qualquer resposta (mesmo 404) = conectado
      });
      setConnected(true);
    } catch (_) {
      setConnected(false);
    }
  }

  function startConnectivityMonitor() {
    setConnected(navigator.onLine);
    window.addEventListener('online', () => { setConnected(true); });
    window.addEventListener('offline', () => { setConnected(false); });
    // Verifica periodicamente (a conexão pode estar online mas a API indisponível)
    checkConnectivity();
    connectivityTimerId = setInterval(checkConnectivity, 10000);
  }

  function stopConnectivityMonitor() {
    if (connectivityTimerId) { clearInterval(connectivityTimerId); connectivityTimerId = null; }
  }

  // ---- lockout ----
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
        renderConfirmButton();
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      setMessage(`Aguarde 0:${String(seconds).padStart(2, '0')}`, 'warn');
    };
    tick();
    lockoutTimerId = setInterval(tick, 1000);
  }

  // ---- ações de entrada ----
  function clearCode() {
    digits = '';
    hasError = false;
    setMessage('', '');
    renderDigits();
    renderConfirmButton();
    refreshMessage();
    clearInactivityTimer();
  }

  function pressDigit(d) {
    if (busy || isLocked()) return;
    if (hasError) { clearCode(); } // qualquer tecla após erro limpa e recomeça
    if (digits.length >= CODE_LENGTH) return;
    digits = normalizeCode(digits + d);
    hasError = false;
    renderDigits();
    renderConfirmButton();
    refreshMessage();
    resetInactivityTimer();
  }

  function pressBackspace() {
    if (busy || isLocked()) return;
    if (hasError) { clearCode(); return; } // qualquer tecla após erro limpa
    digits = digits.slice(0, -1);
    renderDigits();
    renderConfirmButton();
    refreshMessage();
    resetInactivityTimer();
  }

  async function submit() {
    if (busy || isLocked() || digits.length < CODE_LENGTH || !connected || hasError) return;
    busy = true;
    clearInactivityTimer();
    const btn = el('pairing-confirm');
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      // Troca ícone de link por spinner durante a requisição
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="animation:p-spin 1s linear infinite;width:inherit;height:inherit;flex-shrink:0"><circle cx="12" cy="12" r="10" stroke-opacity=".25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>Parear player`;
    }
    setMessage('Pareando…', '');
    setKeypadEnabled(false);

    try {
      const data = await WindoorPlayer.api.post('/player/pair', { code: digits }, { auth: false });
      WindoorPlayer.config.setToken(data.deviceToken);
      WindoorPlayer.config.setPlayerInfo({
        playerId: data.playerId,
        playerName: data.playerName,
        unitName: data.unitName,
        clientName: data.clientName,
      });
      showSuccess(digits, data.playerName, data.unitName);
      setTimeout(() => {
        teardown();
        if (resolveRun) { const r = resolveRun; resolveRun = null; r(); }
      }, 1500);
    } catch (error) {
      busy = false;
      hasError = true;
      const msg = messageForError(error);
      setMessage(msg, 'error');
      // Restaura botão
      if (btn) {
        btn.removeAttribute('aria-busy');
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>Parear player`;
      }
      if (error && (error.status === 429 || error.code === 'TOO_MANY_ATTEMPTS')) {
        startLockout();
      } else {
        setKeypadEnabled(true);
        renderDigits();
        renderConfirmButton();
      }
    }
  }

  // ---- tela de sucesso ----
  function showSuccess(code, playerName, unitName) {
    const pf = document.querySelector('#pairing .pf');
    const success = el('pairing-success');
    if (pf) pf.style.display = 'none';
    if (!success) return;

    const names = el('ps-names');
    if (names) {
      names.textContent = [playerName, unitName].filter(Boolean).join(' · ') || '';
    }

    // Preenche as casas do código no estado sucesso
    const boxes = success.querySelectorAll('.p-dbox');
    const d = normalizeCode(code);
    boxes.forEach((box, i) => {
      box.textContent = d[i] ?? '';
    });

    success.hidden = false;
  }

  // ---- bindings ----
  function bindKeypad() {
    document.querySelectorAll('#pairing-keypad .key').forEach((key) => {
      key.addEventListener('click', () => {
        const action = key.getAttribute('data-action');
        if (action === 'backspace') pressBackspace();
        else if (action === 'clear') clearCode();
        else pressDigit(key.getAttribute('data-digit') || '');
      });
    });
  }

  function bindPhysicalKeyboard() {
    keyHandler = (event) => {
      if (/^[0-9]$/.test(event.key)) {
        pressDigit(event.key);
        event.preventDefault();
      } else if (event.key === 'Backspace' || event.key === 'GoBack') {
        pressBackspace();
        event.preventDefault();
      } else if (event.key === 'Delete') {
        clearCode();
        event.preventDefault();
      } else if (event.key === 'Enter') {
        // Se o foco está num botão do teclado, o próprio click cuida; senão submete
        const active = document.activeElement;
        if (active && active.closest('#pairing-keypad')) return;
        submit();
        event.preventDefault();
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        handleDpad(event);
      }
    };
    document.addEventListener('keydown', keyHandler);
  }

  // ---- navegação por D-pad ----
  function handleDpad(event) {
    const active = document.activeElement;
    const confirmBtn = el('pairing-confirm');

    // Foco no botão "Parear player"
    if (active === confirmBtn) {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        // Vai para a tecla "0" (row 3, col 1)
        const target = buttonAt(3, 1);
        if (target && !target.disabled) target.focus();
      }
      return;
    }

    // Foco em alguma tecla do teclado
    const pos = active ? gridPositionOf(active) : null;
    if (!pos) {
      // Sem foco no teclado: coloca na tecla 5
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const btn5 = keypadButton('5', null);
        if (btn5 && !btn5.disabled) btn5.focus();
      }
      return;
    }

    event.preventDefault();
    let { r, c } = pos;

    if (event.key === 'ArrowUp') {
      if (r > 0) { const t = buttonAt(r - 1, c); if (t && !t.disabled) t.focus(); }
    } else if (event.key === 'ArrowDown') {
      if (r < KEYPAD_GRID.length - 1) {
        const t = buttonAt(r + 1, c);
        if (t && !t.disabled) t.focus();
      } else {
        // Última linha → vai para "Parear player"
        if (confirmBtn && !confirmBtn.disabled) confirmBtn.focus();
      }
    } else if (event.key === 'ArrowLeft') {
      if (c > 0) { const t = buttonAt(r, c - 1); if (t && !t.disabled) t.focus(); }
    } else if (event.key === 'ArrowRight') {
      if (c < 2) { const t = buttonAt(r, c + 1); if (t && !t.disabled) t.focus(); }
    }
  }

  // ---- paste via input oculto ----
  function bindHiddenInput() {
    const input = el('pairing-input');
    if (!input) return;
    input.addEventListener('input', () => {
      const val = normalizeCode(input.value);
      input.value = val;
      if (hasError) clearCode();
      digits = val;
      hasError = false;
      renderDigits();
      renderConfirmButton();
      refreshMessage();
      resetInactivityTimer();
    });
    // Captura Ctrl+V / Cmd+V globalmente e repassa ao input oculto
    document.addEventListener('paste', (e) => {
      if (busy) return;
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const cleaned = normalizeCode(text);
      if (!cleaned) return;
      if (hasError) clearCode();
      digits = cleaned.slice(0, CODE_LENGTH);
      if (input) input.value = digits;
      hasError = false;
      renderDigits();
      renderConfirmButton();
      refreshMessage();
      resetInactivityTimer();
    });
  }

  // ---- limpeza ----
  function teardown() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (lockoutTimerId) { clearInterval(lockoutTimerId); lockoutTimerId = null; }
    clearInactivityTimer();
    stopConnectivityMonitor();
  }

  // ---- ponto de entrada ----
  function run() {
    return new Promise((resolve) => {
      resolveRun = resolve;

      // Reinicia estado
      digits = '';
      busy = false;
      hasError = false;
      lockedUntil = 0;

      // Versão e dispositivo (aparecem em dois lugares: landscape e portrait)
      const version = `Versão ${WindoorPlayer.config.PLAYER_VERSION}`;
      const versionEl = el('pairing-version');
      const versionPtEl = el('pairing-version-pt');
      if (versionEl) versionEl.textContent = version;
      if (versionPtEl) versionPtEl.textContent = version;

      const info = WindoorPlayer.config.getPlayerInfo ? WindoorPlayer.config.getPlayerInfo() : null;
      const deviceLabel = info && info.playerId
        ? `Dispositivo ${info.playerId.slice(0, 8).toUpperCase()}`
        : '';
      const deviceEl = el('pairing-device');
      const devicePtEl = el('pairing-device-pt');
      if (deviceEl) deviceEl.textContent = deviceLabel || '—';
      if (devicePtEl) devicePtEl.textContent = deviceLabel;

      WindoorPlayer.render.showView('pairing');

      // Garante que a tela de sucesso esteja oculta e .pf visível
      const successEl = el('pairing-success');
      const pfEl = document.querySelector('#pairing .pf');
      if (successEl) successEl.hidden = true;
      if (pfEl) pfEl.style.display = '';

      bindKeypad();
      bindPhysicalKeyboard();
      bindHiddenInput();
      setKeypadEnabled(true);
      renderDigits();
      renderConfirmButton();
      startConnectivityMonitor();
      refreshMessage();

      el('pairing-confirm')?.addEventListener('click', submit);

      // Foco inicial na tecla 5
      const btn5 = keypadButton('5', null);
      if (btn5) setTimeout(() => btn5.focus(), 50);
    });
  }

  root.WindoorPlayer.pairing = Object.assign({}, api, { run });
})(typeof window !== 'undefined' ? window : globalThis);
