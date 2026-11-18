// Free engine: the browser's built-in speech recognition (Chrome sends the
// audio to Google), restarted automatically so it keeps listening.
// Translation is done separately (translator.js).

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

export function freeEngineSupported() {
  return !!SR;
}

const FATAL = {
  'not-allowed': 'Permiso de micrófono denegado.',
  'service-not-allowed': 'El reconocimiento de voz del navegador no está disponible. Prueba con Chrome.',
  'audio-capture': 'No se puede acceder al micrófono (¿lo está usando otra app?).',
  'language-not-supported': 'Tu navegador no reconoce este idioma.',
};

export class FreeEngine {
  constructor({ onInterim, onFinal, onState, onFatal }) {
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onFatal = onFatal || (() => {});
    this.rec = null;
    this.lang = null;
    this.wanted = false;
    this.netFails = 0;
    this.quickEnds = 0;
    this.timer = null;
  }

  get active() {
    return this.wanted;
  }

  start(lang) {
    if (!SR) {
      this.onFatal({ message: 'Este navegador no tiene reconocimiento de voz. Usa Chrome.' });
      return;
    }
    this.lang = lang;
    this.wanted = true;
    this.netFails = 0;
    this.quickEnds = 0;
    this.onState('connecting', { lang });
    this._spawn();
  }

  // Switch language without leaving the listening state.
  switchLang(lang) {
    if (lang === this.lang && this.wanted) return;
    this.lang = lang;
    if (!this.wanted) return this.start(lang);
    this._flushInterim();
    this._kill();
    this._spawn();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    this._flushInterim();
    this._kill();
    this.onState('idle', {});
  }

  _flushInterim() {
    // Chrome drops interim text when recognition is aborted; keep what the
    // user already saw on screen.
    if (this.interim) {
      const text = this.interim;
      this.interim = '';
      this.onInterim('', this.lang);
      this.onFinal(text, this.lang);
    }
  }

  _kill() {
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = rec.onstart = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
  }

  _spawn() {
    clearTimeout(this.timer);
    if (!this.wanted) return;
    const rec = new SR();
    rec.lang = this.lang;
    // Android's continuous mode repeats earlier results; one utterance per
    // session plus an instant restart is more reliable there.
    rec.continuous = !IS_ANDROID;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const startedAt = Date.now();
    this.interim = '';

    rec.onstart = () => {
      if (rec !== this.rec) return;
      this.onState('live', { lang: this.lang });
    };

    rec.onresult = (e) => {
      if (rec !== this.rec) return;
      this.netFails = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0] && r[0].transcript) || '';
        if (r.isFinal) {
          if (text.trim()) this.onFinal(text.trim(), this.lang);
        } else {
          interim += text;
        }
      }
      this.interim = interim.trim();
      this.onInterim(this.interim, this.lang);
    };

    rec.onerror = (e) => {
      if (rec !== this.rec) return;
      const code = e && e.error;
      if (FATAL[code]) {
        this.wanted = false;
        this._kill();
        this.onFatal({ code, message: FATAL[code] });
        this.onState('idle', {});
        return;
      }
      if (code === 'network') {
        this.netFails += 1;
        this.onState('reconnecting', { offline: navigator.onLine === false });
      }
      // 'no-speech', 'aborted': normal; onend restarts.
    };

    rec.onend = () => {
      if (rec !== this.rec) return;
      this._flushInterim();
      this.rec = null;
      if (!this.wanted) return;
      const lived = Date.now() - startedAt;
      this.quickEnds = lived < 1000 ? this.quickEnds + 1 : 0;
      let delay = 60;
      if (this.netFails) delay = Math.min(1000 * 2 ** (this.netFails - 1), 10000);
      else if (this.quickEnds > 3) delay = Math.min(250 * this.quickEnds, 3000);
      this.timer = setTimeout(() => this._spawn(), delay);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.timer = setTimeout(() => this._spawn(), 500);
    }
  }
}
