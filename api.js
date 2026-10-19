window.WindoorPlayer = window.WindoorPlayer || {};

// Único ponto de acesso à rede: monta a URL, injeta Authorization/EXTRA_HEADERS,
// desembrulha o envelope { success, data, errors, meta } e sinaliza 401/403 por
// eventos de janela (windoor:unauthorized / windoor:inactive).
WindoorPlayer.api = (function () {
  class ApiError extends Error {
    constructor(status, errors, traceId) {
      super((errors && errors[0] && errors[0].message) || 'Falha na requisição');
      this.name = 'ApiError';
      this.status = status;
      this.errors = errors || [];
      this.code = this.errors[0] && this.errors[0].code;
      this.traceId = traceId;
    }
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const { API_URL, EXTRA_HEADERS, getToken } = WindoorPlayer.config;
    const headers = Object.assign({ Accept: 'application/json' }, EXTRA_HEADERS);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = opts.auth === false ? null : getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(API_URL + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive: !!opts.keepalive,
    });
    if (res.status === 204) return undefined;

    let json = null;
    try { json = await res.json(); } catch (_) { /* corpo vazio ou não-JSON */ }

    if (!res.ok || (json && json.success === false)) {
      const err = new ApiError(res.status, json && json.errors, json && json.meta && json.meta.traceId);
      if (opts.auth !== false) {
        if (res.status === 401) window.dispatchEvent(new CustomEvent('windoor:unauthorized', { detail: err }));
        if (res.status === 403 && err.code === 'PLAYER_INACTIVE') window.dispatchEvent(new CustomEvent('windoor:inactive', { detail: err }));
      }
      throw err;
    }
    return json ? json.data : undefined;
  }

  return {
    ApiError,
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
  };
})();
