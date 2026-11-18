// Soniox real-time engine: streams microphone audio over a WebSocket and
// receives transcription + translation tokens.
//
// Protocol (docs.soniox.com/api-reference/stt/websocket-api):
//  * Browsers authenticate with the protocols list: ['soniox-api-key', KEY].
//  * First message: JSON config. Then binary audio frames.
//  * An empty text frame ends the stream; the server answers {finished:true}.
//  * Errors arrive as {error_code, error_type, error_message}; the server
//    then closes the connection.
//  * A stream is billed for its whole duration and capped at 300 minutes.

import { SONIOX_WS_URL, SONIOX_MODEL } from './config.js';

const FATAL_TYPES = new Set([
  'unauthenticated',
  'organization_balance_exhausted',
  'organization_monthly_budget_exhausted',
  'project_monthly_budget_exhausted',
  'permission_denied',
  'invalid_request',
  'model_not_available',
]);
const FATAL_CODES = new Set([400, 401, 402, 403]);
const RETRY_DELAYS = [0, 600, 1500, 3000, 5000, 8000, 10000];
const MAX_ATTEMPTS = 60; // ~10 minutes of retrying before giving up
const MAX_BUFFER_BYTES = 600 * 1024; // audio kept while reconnecting

export function describeSonioxError(err) {
  const type = err && err.error_type;
  const code = err && Number(err.error_code);
  switch (type) {
    case 'unauthenticated':
      return 'La clave de Soniox no es válida. Revísala en Ajustes.';
    case 'organization_balance_exhausted':
      return 'Tu saldo de Soniox se ha agotado. Recarga en console.soniox.com (Billing).';
    case 'organization_monthly_budget_exhausted':
    case 'project_monthly_budget_exhausted':
      return 'Se alcanzó el presupuesto mensual de tu cuenta de Soniox.';
    case 'permission_denied':
      return 'Esta clave de Soniox no tiene permiso para transcripción en tiempo real.';
    case 'model_not_available':
      return 'El modelo de Soniox no está disponible ahora mismo.';
    case 'invalid_request':
      return 'Soniox rechazó la configuración: ' + (err.error_message || 'solicitud no válida') + '.';
    case 'limit_exceeded':
    case 'max_concurrent_connections_reached':
      return 'Demasiadas conexiones simultáneas con Soniox.';
    default:
      break;
  }
  if (code === 401) return 'La clave de Soniox no es válida. Revísala en Ajustes.';
  if (code === 402) return 'Tu saldo de Soniox se ha agotado.';
  if (code === 'timeout') return 'Soniox no respondió a tiempo.';
  return (err && err.error_message) || 'Error de conexión con Soniox.';
}

function isFatal(err) {
  if (!err) return false;
  if (FATAL_TYPES.has(err.error_type)) return true;
  return !err.error_type && FATAL_CODES.has(Number(err.error_code));
}

function openSocket(url, apiKey) {
  // The key travels in Sec-WebSocket-Protocol. If it contains characters a
  // protocol token cannot hold, fall back to the (deprecated until
  // 2027-01-15) api_key field of the start message.
  try {
    return { ws: new WebSocket(url, ['soniox-api-key', apiKey]), legacy: false };
  } catch (e) {
    if (e && e.name === 'SyntaxError') return { ws: new WebSocket(url), legacy: true };
    throw e;
  }
}

export class SonioxEngine {
  constructor({ apiKey, url = SONIOX_WS_URL, getConfig, encoder, onTokens, onState, onStreamEnd, onFatal, onUsage }) {
    this.apiKey = apiKey;
    this.url = url;
    this.getConfig = getConfig;
    this.encoder = encoder;
    this.onTokens = onTokens || (() => {});
    this.onState = onState || (() => {});
    this.onStreamEnd = onStreamEnd || (() => {});
    this.onFatal = onFatal || (() => {});
    this.onUsage = onUsage || (() => {});
    this.state = 'idle';
    this.ws = null;
    this.wanted = false;
    this.stopping = false;
    this.attempt = 0;
    this.buffer = [];
    this.bufferBytes = 0;
    this.timers = {};
    this._onOnline = () => this._wake('online');
    this._onOffline = () => this._handleOffline();
    this._onVisible = () => document.visibilityState === 'visible' && this._wake('visible');
  }

  _setState(state, info = {}) {
    this.state = state;
    this.onState(state, info);
  }

  async start() {
    this.wanted = true;
    this.stopping = false;
    this.attempt = 0;
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);
    document.addEventListener('visibilitychange', this._onVisible);
    this._connect();
    try {
      await this.encoder.start((chunk) => this._onChunk(chunk));
    } catch (e) {
      this._fail({ error_code: 'audio', error_message: 'No se pudo iniciar la grabación: ' + ((e && e.message) || e) });
    }
  }

  // Report the end of one server stream (usage + transcript bookkeeping),
  // exactly once per connection.
  _endConn(conn, info) {
    if (!conn || conn.ended) return;
    conn.ended = true;
    if (conn.openedAt) this.onUsage(Date.now() - conn.openedAt);
    this.onStreamEnd(info);
  }

  // ------------------------------------------------------------ connection

  _connect() {
    clearTimeout(this.timers.retry);
    if (!this.wanted) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._setState('reconnecting', { offline: true, attempt: this.attempt });
      this.timers.retry = setTimeout(() => this._connect(), 10000);
      return;
    }
    this._setState(this.attempt ? 'reconnecting' : 'connecting', { attempt: this.attempt });
    let sock;
    try {
      sock = openSocket(this.url, this.apiKey);
    } catch {
      this._scheduleRetry();
      return;
    }
    const ws = sock.ws;
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.conn = { legacy: sock.legacy, started: false, endSent: false, finished: false, error: null, openedAt: 0, createdAt: Date.now(), lastMsgAt: Date.now() };
    const conn = this.conn;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      const cfg = this.getConfig();
      if (conn.legacy) cfg.api_key = this.apiKey;
      try {
        ws.send(JSON.stringify(cfg));
      } catch {
        return;
      }
      conn.started = true;
      conn.openedAt = Date.now();
      conn.lastMsgAt = Date.now();
      for (const chunk of this.buffer) ws.send(chunk);
      this.buffer = [];
      this.bufferBytes = 0;
      if (this.stopping) {
        // Opened while the user was stopping: deliver what was recorded, end.
        this._sendEnd();
        return;
      }
      this._setState('live', { reconnected: this.attempt > 0 });
    };

    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      conn.lastMsgAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return;
      }
      if (msg.error_code != null || msg.error_type) {
        conn.error = msg;
        return; // the server closes the socket right after an error
      }
      if (Array.isArray(msg.tokens)) this.onTokens(msg.tokens, msg); // [] = provisional text gone
      if (msg.finished) {
        conn.finished = true;
        if (this.stopping) this._resolveStop();
      }
    };

    ws.onerror = () => {
      /* onclose follows */
    };

    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this._onClose(conn, ev);
    };

    this._startWatchdog();
  }

  _onClose(conn, ev) {
    this._stopWatchdog();
    if (this.ws && this.conn === conn) this.ws = null;
    if (conn.openedAt && Date.now() - conn.openedAt > 15000) this.attempt = 0; // healthy stream resets backoff
    // Graceful end (user pressed stop).
    if (this.stopping) {
      this._endConn(conn, { unexpected: !conn.finished, error: conn.error });
      this._resolveStop();
      return;
    }
    if (conn.error && isFatal(conn.error)) {
      this._endConn(conn, { unexpected: true, error: conn.error });
      this._fail(conn.error);
      return;
    }
    // Unexpected: network drop, 408/413/429/5xx, watchdog...
    this._endConn(conn, { unexpected: true, error: conn.error, code: ev && ev.code });
    if (!this.wanted) return;
    if (conn.started) {
      // This stream consumed the container header: the next stream needs a
      // fresh one. (If the socket never opened, the buffered audio — which
      // starts with a header — is kept and sent on the next attempt.)
      this.buffer = [];
      this.bufferBytes = 0;
      try {
        this.encoder.restart();
      } catch {
        /* ignore */
      }
    }
    this._scheduleRetry(conn.error);
  }

  _scheduleRetry(err) {
    if (!this.wanted) return;
    if (this.attempt >= MAX_ATTEMPTS) {
      this._fail({ error_code: 'timeout', error_message: 'No se pudo reconectar con Soniox.' });
      return;
    }
    let delay = RETRY_DELAYS[Math.min(this.attempt, RETRY_DELAYS.length - 1)];
    const code = err && Number(err.error_code);
    if (code === 429) delay = Math.max(delay, 5000);
    if (err && err.error_type === 'max_duration_reached') delay = 0;
    this.attempt += 1;
    this._setState('reconnecting', { offline: navigator.onLine === false, attempt: this.attempt, error: err || null });
    this.timers.retry = setTimeout(() => this._connect(), delay);
  }

  _wake(reason) {
    if (this.wanted && !this.stopping && !this.ws && this.state === 'reconnecting') {
      clearTimeout(this.timers.retry);
      this._connect();
    } else if (reason === 'visible' && this.ws && this.conn && this.conn.started) {
      // Coming back from background: if the server went quiet, the socket is
      // probably dead — recycle it now instead of waiting for the watchdog.
      if (Date.now() - this.conn.lastMsgAt > 8000) this._recycle();
    }
  }

  _handleOffline() {
    if (this.ws && this.wanted && !this.stopping) this._recycle();
  }

  _recycle() {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(4000, 'recycle');
    } catch {
      /* ignore */
    }
    // Some browsers delay onclose for a dead TCP connection; do not wait.
    const conn = this.conn;
    this.ws = null; // the late onclose of this socket is ignored
    this._onClose(conn, { code: 4000 });
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.timers.watch = setInterval(() => {
      const ws = this.ws;
      const conn = this.conn;
      if (!ws || !conn || conn.endSent) return;
      if (!conn.started) {
        // A weak signal can stall the TCP/TLS handshake for minutes.
        if (Date.now() - conn.createdAt > 10000) this._recycle();
        return;
      }
      const quiet = Date.now() - conn.lastMsgAt;
      // Audio piling up unsent + server silent = dead connection.
      if ((quiet > 20000 && ws.bufferedAmount > 0) || quiet > 45000) this._recycle();
    }, 3000);
  }

  _stopWatchdog() {
    clearInterval(this.timers.watch);
  }

  // ------------------------------------------------------------ audio

  _onChunk(chunk) {
    const ws = this.ws;
    const conn = this.conn;
    if (ws && conn && conn.started && !conn.endSent && ws.readyState === 1) {
      try {
        ws.send(chunk);
      } catch {
        /* onclose will handle it */
      }
      return;
    }
    if (!this.wanted && !this.stopping) return;
    this.buffer.push(chunk);
    this.bufferBytes += chunk.size || chunk.byteLength || 0;
    if (this.bufferBytes > MAX_BUFFER_BYTES) {
      // Too long offline: drop the backlog and restart the encoder so the
      // stream still starts with a valid header.
      this.buffer = [];
      this.bufferBytes = 0;
      try {
        this.encoder.restart();
      } catch {
        /* ignore */
      }
    }
  }

  _sendEnd() {
    const ws = this.ws;
    const conn = this.conn;
    if (!ws || !conn || conn.endSent || ws.readyState !== 1) return;
    conn.endSent = true;
    try {
      ws.send('');
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ stop / fail

  // Graceful stop: flush the last audio, end the stream, wait for the final
  // tokens (max ~5 s), then close.
  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (!this.wanted && !this.stopping) return Promise.resolve();
    this._stopPromise = this._stop().finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  async _stop() {
    this.wanted = false;
    this.stopping = true;
    clearTimeout(this.timers.retry);
    this._setState('stopping');
    const done = new Promise((resolve) => {
      this._stopResolver = resolve;
    });
    await this.encoder.stop().catch(() => {});
    const ws = this.ws;
    const conn = this.conn;
    if (ws && conn && conn.started && ws.readyState === 1) {
      this._sendEnd();
      this.timers.stop = setTimeout(() => this._resolveStop(), 5000);
      await done;
      this._endConn(conn, { unexpected: !conn.finished, error: conn.error });
    } else {
      // Not connected (connecting or between retries): nothing to wait for.
      this._endConn(conn, { unexpected: true });
      this._resolveStop();
    }
    this._teardown();
  }

  _resolveStop() {
    clearTimeout(this.timers.stop);
    const r = this._stopResolver;
    this._stopResolver = null;
    if (r) r();
  }

  _fail(err) {
    this.wanted = false;
    this.encoder.stop().catch(() => {});
    this._teardown();
    this.onFatal(err);
  }

  _teardown() {
    this._stopWatchdog();
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.stop);
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
    document.removeEventListener('visibilitychange', this._onVisible);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }
    this.buffer = [];
    this.bufferBytes = 0;
    this.stopping = false;
    this._setState('idle');
  }
}

// Check an API key: open a stream, send 100 ms of silence, end it.
// Resolves { ok: true } or { ok: false, message, error }.
export function testSonioxKey(apiKey, url = SONIOX_WS_URL, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = openSocket(url, apiKey.trim());
    } catch (e) {
      resolve({ ok: false, message: 'No se pudo abrir la conexión: ' + e.message });
      return;
    }
    const ws = sock.ws;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, message: 'Soniox no respondió. Revisa tu conexión a internet.' }),
      timeoutMs,
    );
    ws.onopen = () => {
      const cfg = { model: SONIOX_MODEL, audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 };
      if (sock.legacy) cfg.api_key = apiKey.trim();
      ws.send(JSON.stringify(cfg));
      ws.send(new Int16Array(1600).buffer);
      ws.send('');
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.error_code != null || msg.error_type) finish({ ok: false, error: msg, message: describeSonioxError(msg) });
      else if (msg.finished) finish({ ok: true });
    };
    ws.onerror = () => {};
    ws.onclose = () =>
      finish({ ok: false, message: 'La conexión con Soniox se cerró. Revisa tu conexión a internet.' });
  });
}
