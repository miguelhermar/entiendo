// Free text translation with several providers and automatic fallback.
//
// 1. Chrome's built-in on-device Translator API (desktop Chrome only today).
// 2. Google Translate endpoint used by Google's own Chrome extension
//    (clients5.google.com, CORS-enabled, no key).
// 3. Google Translate "gtx" endpoint (translate.googleapis.com, no key).
// 4. MyMemory (api.mymemory.translated.net, free daily quota).
// A provider that fails is skipped for a while (circuit breaker).

const TIMEOUT_MS = 7000;
const cache = new Map(); // "from|to|text" -> translation
const CACHE_MAX = 400;
const breaker = new Map(); // provider -> { until, fails }

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function isDown(name) {
  const b = breaker.get(name);
  return !!b && b.until > Date.now();
}

function markFail(name) {
  const b = breaker.get(name) || { fails: 0, until: 0 };
  b.fails += 1;
  // 30 s, 2 min, 5 min, then 10 min.
  const waits = [30e3, 120e3, 300e3, 600e3];
  b.until = Date.now() + waits[Math.min(b.fails - 1, waits.length - 1)];
  breaker.set(name, b);
}

function markOk(name) {
  breaker.delete(name);
}

async function fetchWithTimeout(url, init = {}, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ------------------------------------------------------------ providers

const chromeTranslators = new Map();
const chromeUnavailable = new Set(); // language pairs the built-in API cannot do

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(what + ' timed out')), ms);
    }),
  ]);
}

const chromeBuiltin = {
  name: 'chrome',
  available() {
    return typeof self !== 'undefined' && 'Translator' in self;
  },
  async translate(text, from, to) {
    if (from === 'auto') throw new Error('needs source language');
    const key = from + '>' + to;
    if (chromeUnavailable.has(key)) throw new Error('pair unavailable');
    let tr = chromeTranslators.get(key);
    if (!tr) {
      // The built-in API can hang (e.g. waiting for a model download), so
      // every call is time-boxed and a failure disables it for this pair.
      try {
        const avail = await withTimeout(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 1500, 'availability');
        if (avail !== 'available') throw new Error('model not available: ' + avail);
        tr = await withTimeout(self.Translator.create({ sourceLanguage: from, targetLanguage: to }), 3000, 'create');
      } catch (e) {
        chromeUnavailable.add(key);
        throw e;
      }
      chromeTranslators.set(key, tr);
    }
    return withTimeout(tr.translate(text), 4000, 'translate');
  },
};

const googleExtension = {
  name: 'google',
  available: () => true,
  async translate(text, from, to, signal) {
    const url =
      'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' +
      encodeURIComponent(from) +
      '&tl=' +
      encodeURIComponent(to);
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(text),
      },
      signal,
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseGoogleExtension(await res.json());
  },
};

export function parseGoogleExtension(data) {
  // ["texto"] with a fixed source language, [["texto","pl"]] with sl=auto,
  // or older shapes like {sentences:[{trans:"..."}]}.
  if (Array.isArray(data)) {
    const first = data[0];
    if (typeof first === 'string') return first;
    if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  }
  if (data && Array.isArray(data.sentences)) {
    return data.sentences.map((s) => s.trans || '').join('');
  }
  throw new Error('unexpected response');
}

const googleGtx = {
  name: 'gtx',
  available: () => true,
  async translate(text, from, to, signal) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
      encodeURIComponent(from) +
      '&tl=' +
      encodeURIComponent(to) +
      '&q=' +
      encodeURIComponent(text);
    const res = await fetchWithTimeout(url, {}, signal);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected response');
    return data[0].map((p) => (Array.isArray(p) ? p[0] || '' : '')).join('');
  },
};

const myMemory = {
  name: 'mymemory',
  available: () => true,
  async translate(text, from, to, signal) {
    if (from === 'auto') throw new Error('needs source language');
    const url =
      'https://api.mymemory.translated.net/get?langpair=' +
      encodeURIComponent(from + '|' + to) +
      '&q=' +
      encodeURIComponent(text.slice(0, 480));
    const res = await fetchWithTimeout(url, {}, signal);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const out = data && data.responseData && data.responseData.translatedText;
    if (!out || /MYMEMORY WARNING/i.test(out) || Number(data.responseStatus) >= 400) throw new Error('quota or error');
    return out;
  },
};

const PROVIDERS = [chromeBuiltin, googleExtension, googleGtx, myMemory];

// Translate text. Resolves to { text, provider } or rejects if every
// provider failed. `from` may be 'auto'.
export async function translate(text, from, to, { signal } = {}) {
  const clean = (text || '').trim();
  if (!clean) return { text: '', provider: 'none' };
  const key = from + '|' + to + '|' + clean;
  if (cache.has(key)) return { text: cache.get(key), provider: 'cache' };
  let lastErr = null;
  for (const p of PROVIDERS) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!p.available() || isDown(p.name)) continue;
    try {
      const out = await p.translate(clean, from, to, signal);
      if (typeof out === 'string' && out.trim()) {
        markOk(p.name);
        remember(key, out.trim());
        return { text: out.trim(), provider: p.name };
      }
      throw new Error('empty');
    } catch (err) {
      if (err && err.name === 'AbortError' && signal && signal.aborted) throw err;
      lastErr = err;
      markFail(p.name);
    }
  }
  throw lastErr || new Error('no translation provider available');
}

export function _resetTranslatorForTests() {
  cache.clear();
  breaker.clear();
  chromeTranslators.clear();
  chromeUnavailable.clear();
}
