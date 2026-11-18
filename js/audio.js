// Microphone capture, audio encoders and a level meter.

export class MicError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'unsupported' | 'insecure' | 'denied' | 'notfound' | 'busy' | 'unknown'
  }
}

export async function openMicrophone({ processing = false } = {}) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new MicError('insecure', 'La página debe abrirse con https:// para usar el micrófono.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new MicError('unsupported', 'Este navegador no permite usar el micrófono.');
  }
  const audio = {
    channelCount: 1,
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      throw new MicError('denied', 'Permiso de micrófono denegado.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      throw new MicError('notfound', 'No se encontró ningún micrófono.');
    }
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
      throw new MicError('busy', 'Otra app está usando el micrófono.');
    }
    throw new MicError('unknown', (e && e.message) || 'Error de micrófono.');
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
}

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Opus in WebM/Ogg via MediaRecorder: ~32 kbit/s, which keeps mobile data
// use around 15 MB per hour. Soniox auto-detects the container.
export class OpusEncoder {
  constructor(stream, mimeType, { timesliceMs = 100, bitrate = 32000 } = {}) {
    this.stream = stream;
    this.mimeType = mimeType;
    this.timesliceMs = timesliceMs;
    this.bitrate = bitrate;
    this.rec = null;
    this.onChunk = null;
    this.kind = 'opus';
  }

  start(onChunk) {
    this.onChunk = onChunk;
    this._spawn();
  }

  _spawn() {
    let rec;
    try {
      rec = new MediaRecorder(this.stream, { mimeType: this.mimeType, audioBitsPerSecond: this.bitrate });
    } catch {
      rec = new MediaRecorder(this.stream);
    }
    rec.ondataavailable = (e) => {
      if (rec === this.rec && e.data && e.data.size > 0 && this.onChunk) this.onChunk(e.data);
    };
    rec.onerror = () => {
      // A recorder error (rare) — start a fresh one if we are still active.
      if (rec === this.rec) setTimeout(() => rec === this.rec && this.restart(), 200);
    };
    this.rec = rec;
    rec.start(this.timesliceMs);
  }

  // Start a new recorder on the same stream so the next chunk carries a fresh
  // container header (needed for every new server session).
  restart() {
    const old = this.rec;
    this.rec = null;
    if (old && old.state !== 'inactive') {
      try {
        old.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.onChunk) this._spawn();
  }

  // Stop and deliver the final chunk.
  stop() {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') {
      this.rec = null;
      this.onChunk = null;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        if (this.rec === rec) this.rec = null;
        this.onChunk = null;
        resolve();
      };
      rec.addEventListener('stop', done, { once: true });
      setTimeout(done, 1500);
      try {
        rec.stop();
      } catch {
        done();
      }
    });
  }
}

// Fallback when MediaRecorder cannot produce Opus (e.g. Safari): raw 16 kHz
// 16-bit PCM from an AudioWorklet (about 115 MB per hour of mobile data).
export class PcmEncoder {
  constructor(stream) {
    this.stream = stream;
    this.kind = 'pcm';
    this.ctx = null;
    this.onChunk = null;
  }

  async start(onChunk) {
    this.onChunk = onChunk;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16k');
    this.node.port.onmessage = (e) => {
      if (this.onChunk) this.onChunk(e.data);
    };
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  restart() {
    /* raw PCM has no container header */
  }

  async stop() {
    this.onChunk = null;
    try {
      this.src && this.src.disconnect();
      this.node && this.node.disconnect();
      this.sink && this.sink.disconnect();
    } catch {
      /* ignore */
    }
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

// RMS level of the microphone, mapped to 0..1 on a dB scale.
export class LevelMeter {
  constructor(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 1024;
    this.buf = new Float32Array(this.an.fftSize);
    this.src.connect(this.an);
    this.smooth = 0;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  level() {
    if (!this.ctx) return 0;
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const v = Math.min(1, Math.max(0, (db + 60) / 50)); // -60 dB .. -10 dB
    this.smooth = v > this.smooth ? v : this.smooth * 0.85 + v * 0.15;
    return this.smooth;
  }

  close() {
    try {
      this.src.disconnect();
    } catch {
      /* ignore */
    }
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
