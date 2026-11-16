// Proof of play agregado (seção 2.6 do documento de Histórico e evidências).
//
// Substitui o `proof-of-play.js` do MVP, que mandava uma linha por exibição. Aqui o
// player soma localmente em buckets de `contentId|playlistId|zone|hora UTC` e envia os
// **totais absolutos** de cada bucket a cada 5 min. O servidor faz upsert com
// GREATEST/LEAST, então reenviar o mesmo bucket não duplica nem regride — é o que torna
// seguro reenviar depois de ficar offline, e o que faz um reload no meio da hora não
// perder a contagem (o bucket vem do IndexedDB e continua de onde estava).
//
// Comunicado, notícia e barra de informações não contam: o `feed.js` intercala
// comunicados como itens normais dentro de `zone.items`, marcados com `isAnnouncement`.
//
// UMD: module.exports (Node/testes) ou window.WindoorPlayer.playlog.
(function (root) {
  const SEND_INTERVAL_MS = 5 * 60 * 1000;
  const MAX_BUCKETS_PER_SEND = 500;
  /** Bucket já confirmado pelo servidor só é descartado depois disso (seção 2.6). */
  const KEEP_CONFIRMED_MS = 48 * 60 * 60 * 1000;
  const STATE_KEY = 'playBuckets';

  /** Hora cheia em UTC — é a granularidade do bucket no servidor. */
  function hourBucketUtc(ms) {
    const date = new Date(ms);
    date.setUTCMinutes(0, 0, 0);
    date.setUTCSeconds(0, 0);
    return date.toISOString();
  }

  function bucketKey(bucket) {
    return `${bucket.contentId}|${bucket.playlistId}|${bucket.zone}|${bucket.hourBucket}`;
  }

  /** Só conteúdo de playlist gera play event. */
  function isCountable(item) {
    if (!item || item.isAnnouncement) return false;
    return Boolean(item.contentId || item.id);
  }

  /**
   * `deps`: `{ now, loadState, saveState, send, logger }`.
   * - `send(buckets)` recebe no máximo `MAX_BUCKETS_PER_SEND` por chamada e deve rejeitar
   *   em falha de rede — é o que mantém o bucket sujo para a próxima tentativa.
   */
  function createPlayLog(deps) {
    const now = deps.now || (() => Date.now());
    // Resolvido a cada chamada: no navegador o `logger` vem de outro script, e assim
    // este módulo não depende da ordem de carga.
    const logger = {
      info: (m, c) => { const l = deps.logger; if (l && l.info) l.info(m, c); },
      warn: (m, c) => { const l = deps.logger; if (l && l.warn) l.warn(m, c); },
      error: (m, c) => { const l = deps.logger; if (l && l.error) l.error(m, c); },
    };
    const buckets = new Map();
    let sending = false;
    let timerId = null;

    function toWire(bucket) {
      return {
        contentId: bucket.contentId,
        playlistId: bucket.playlistId,
        zone: bucket.zone,
        hourBucket: bucket.hourBucket,
        plays: bucket.plays,
        durationMs: bucket.durationMs,
        firstAt: new Date(bucket.firstAtMs).toISOString(),
        lastAt: new Date(bucket.lastAtMs).toISOString(),
      };
    }

    async function persist() {
      if (!deps.saveState) return;
      try {
        await deps.saveState(STATE_KEY, { buckets: Array.from(buckets.values()) });
      } catch (error) {
        // Sem IndexedDB o player ainda conta em memória; só perde a contagem num reload.
        logger.warn('Buckets de exibição não persistidos', { error: error.message });
      }
    }

    /** Lê os buckets gravados e devolve quantos foram recuperados. */
    async function hydrate() {
      if (!deps.loadState) return 0;
      let saved = null;
      try {
        saved = await deps.loadState(STATE_KEY);
      } catch (_) {
        saved = null;
      }
      const list = (saved && Array.isArray(saved.buckets) ? saved.buckets : []).filter(
        (b) => b && b.contentId && b.playlistId && b.zone && b.hourBucket,
      );
      list.forEach((bucket) => buckets.set(bucketKey(bucket), { ...bucket }));
      if (list.length > 0) {
        logger.info('Buckets de exibição recuperados do cache local', {
          buckets: list.length,
          pendentes: list.filter((b) => b.dirty).length,
        });
      }
      return list.length;
    }

    /**
     * Chamado pelo `render.js` quando um item sai de cena, com o tempo que ficou no ar.
     * `ctx`: `{ zone, playlistId }`.
     */
    function report(item, durationMs, ctx) {
      if (!isCountable(item)) return;
      const playlistId = ctx && ctx.playlistId;
      const zone = ctx && ctx.zone;
      // Zona sem playlist não deveria ter item no ar; se acontecer, não há bucket válido.
      if (!playlistId || !zone) return;

      const at = now();
      const contentId = item.contentId || item.id;
      const hourBucket = hourBucketUtc(at);
      const key = bucketKey({ contentId, playlistId, zone, hourBucket });
      const existing = buckets.get(key);
      const added = Math.max(0, Math.round(durationMs) || 0);

      if (existing) {
        existing.plays += 1;
        existing.durationMs += added;
        existing.firstAtMs = Math.min(existing.firstAtMs, at);
        existing.lastAtMs = Math.max(existing.lastAtMs, at);
        existing.dirty = true;
      } else {
        buckets.set(key, {
          contentId,
          playlistId,
          zone,
          hourBucket,
          plays: 1,
          durationMs: added,
          firstAtMs: at,
          lastAtMs: at,
          dirty: true,
        });
      }

      persist();
    }

    /** Buckets alterados desde a última confirmação do servidor. */
    function pending() {
      return Array.from(buckets.values()).filter((bucket) => bucket.dirty);
    }

    /** Remove buckets já confirmados e mais velhos que 48 h. */
    function prune() {
      const limit = now() - KEEP_CONFIRMED_MS;
      let removed = 0;
      buckets.forEach((bucket, key) => {
        if (!bucket.dirty && Date.parse(bucket.hourBucket) < limit) {
          buckets.delete(key);
          removed += 1;
        }
      });
      return removed;
    }

    /**
     * Envia os buckets sujos em lotes de até 500. Um lote que falha deixa os seus buckets
     * sujos para a próxima tentativa (o próximo timer ou a reconexão), sem travar os
     * outros lotes — e sem risco de duplicar, porque o que vai são totais absolutos.
     */
    async function flush() {
      if (sending) return { sent: 0, failed: 0 };
      const dirty = pending();
      if (dirty.length === 0) {
        prune();
        return { sent: 0, failed: 0 };
      }

      sending = true;
      let sent = 0;
      let failed = 0;
      try {
        for (let i = 0; i < dirty.length; i += MAX_BUCKETS_PER_SEND) {
          const batch = dirty.slice(i, i + MAX_BUCKETS_PER_SEND);
          try {
            await deps.send(batch.map(toWire));
            const confirmedAt = now();
            batch.forEach((bucket) => {
              bucket.dirty = false;
              bucket.confirmedAt = confirmedAt;
            });
            sent += batch.length;
          } catch (error) {
            failed += batch.length;
            logger.info('Exibições não enviadas (provavelmente offline)', {
              buckets: batch.length,
              error: error.message,
              code: error.code,
            });
          }
        }
      } finally {
        sending = false;
      }

      prune();
      await persist();
      return { sent, failed };
    }

    function start() {
      if (timerId) clearInterval(timerId);
      timerId = setInterval(() => { flush(); }, SEND_INTERVAL_MS);
    }

    function stop() {
      if (timerId) { clearInterval(timerId); timerId = null; }
    }

    return { hydrate, report, pending, flush, prune, start, stop, toWire, size: () => buckets.size };
  }

  const api = {
    createPlayLog,
    hourBucketUtc,
    bucketKey,
    isCountable,
    SEND_INTERVAL_MS,
    MAX_BUCKETS_PER_SEND,
    KEEP_CONFIRMED_MS,
    STATE_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WindoorPlayer = root.WindoorPlayer || {};
    // Instância única do navegador: as dependências são lidas na hora da chamada, para
    // não depender da ordem de carga dos scripts.
    const instance = createPlayLog({
      now: () => Date.now(),
      loadState: (key) => root.WindoorPlayer.cache.readEvidence(key),
      saveState: (key, value) => root.WindoorPlayer.cache.saveEvidence(key, value),
      send: (buckets) => root.WindoorPlayer.api.post('/player/play-events', { buckets }),
      get logger() { return root.WindoorPlayer.logger; },
    });
    root.WindoorPlayer.playlog = Object.assign(instance, api);
  }
})(typeof window !== 'undefined' ? window : globalThis);
