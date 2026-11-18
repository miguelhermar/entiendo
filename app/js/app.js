// Entiendo — main controller.

import {
  APP_VERSION,
  SONIOX_WS_URL,
  SONIOX_USD_PER_HOUR,
  MODES,
  buildSonioxConfig,
  targetLangFor,
} from './config.js';
import {
  loadSettings,
  saveSettings,
  listSessions,
  loadSession,
  saveSession,
  deleteSession,
  deleteAllSessions,
  newSessionId,
  getCurrentSessionId,
  setCurrentSessionId,
} from './storage.js';
import { Transcript } from './transcript.js';
import { SonioxSegmenter } from './segmenter.js';
import { SonioxEngine, testSonioxKey, describeSonioxError } from './soniox.js';
import { FreeEngine, freeEngineSupported } from './free-engine.js';
import { translate } from './translator.js';
import { openMicrophone, stopStream, pickRecorderMime, OpusEncoder, PcmEncoder, LevelMeter } from './audio.js';
import { TranscriptView } from './render.js';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const root = document.documentElement;

// Developer hooks (only when served from this computer): ?ws=ws://localhost:PORT
const params = new URLSearchParams(location.search);
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const WS_URL = (IS_LOCAL && params.get('ws')) || SONIOX_WS_URL;

const settings = loadSettings();
const transcript = new Transcript();

const rt = {
  phase: 'idle', // idle | starting | connecting | live | reconnecting | stopping
  kind: null, // 'soniox' | 'free'
  engine: null,
  stream: null,
  meter: null,
  segmenter: null,
  mode: null,
  runStartedAt: 0,
  sessionMark: 0,
  freeLang: null,
  reloadWhenIdle: false,
};

const view = new TranscriptView({
  container: $('blocks'),
  pvContainer: $('pv'),
  scroller: $('scroller'),
  transcript,
  isLive: () => rt.phase === 'live' || rt.phase === 'reconnecting',
  onAction: onBlockAction,
});

// ------------------------------------------------------------------ utils

function saveSettingsSoon() {
  clearTimeout(saveSettingsSoon.t);
  saveSettingsSoon.t = setTimeout(() => saveSettings(settings), 300);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtDuration(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const dateFmt = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const longFmt = new Intl.DateTimeFormat('es', { dateStyle: 'full', timeStyle: 'short' });

function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  const time = timeFmt.format(d);
  if (d.toDateString() === today.toDateString()) return `Hoy, ${time}`;
  if (d.toDateString() === yest.toDateString()) return `Ayer, ${time}`;
  const s = dateFmt.format(d);
  return `${s.charAt(0).toUpperCase() + s.slice(1)}, ${time}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

let bannerAction = null;
function showBanner(text, action = null, kind = 'error') {
  $('bannerText').textContent = text;
  $('banner').classList.toggle('info', kind === 'info');
  const btn = $('bannerAction');
  bannerAction = action;
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  $('banner').hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
  bannerAction = null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
  }
  toast('Copiado');
}

// ------------------------------------------------------------------ rendering

let renderQueued = false;
let lastFallbackScan = 0;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    transcript.flush();
    updateContentState();
    if (Date.now() - lastFallbackScan > 1200) {
      lastFallbackScan = Date.now();
      queueFallbackTranslations();
    }
  });
}

function updateContentState() {
  const has = transcript.blocks.length > 0 || transcript.pvExtra.length > 0;
  appEl.classList.toggle('has-content', has);
  if (!has) $('jump').hidden = true;
}

function applyReading() {
  root.style.setProperty('--fs', settings.fontSize + 'px');
  for (const id of ['blocks', 'pv', 'sessBlocks', 'sessPv']) {
    const c = $(id);
    c.classList.toggle('hide-src', !settings.showSource);
    c.classList.toggle('src-after', !settings.sourceFirst);
  }
  root.dataset.theme = settings.theme;
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && !window.matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0b0d12' : '#f6f4ef';
  $('popFont').value = settings.fontSize;
  $('setFont').value = settings.fontSize;
  $('fontOut').textContent = settings.fontSize + ' px';
  $('popShowSrc').checked = settings.showSource;
  $('setShowSrc').checked = settings.showSource;
  $('popSrcFirst').checked = settings.sourceFirst;
  $('setSrcFirst').checked = settings.sourceFirst;
}

function renderModes() {
  for (const b of document.querySelectorAll('#modes [data-mode]')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === settings.mode));
  }
  const conv = settings.mode === 'conversar';
  const eng = settings.engine === 'soniox' ? 'Soniox' : 'Gratis';
  $('engineLabel').textContent = `${conv ? 'Polaco ⇄ Español' : 'Polaco → Español'} · ${eng}`;
}

function renderEmpty() {
  const m = MODES[settings.mode];
  $('emptyIcon').setAttribute('href', '#i-' + m.icon);
  let hint = m.hint;
  let tip = m.tip;
  if (settings.engine === 'free' && m.id === 'conversar') {
    hint = 'Toca PL cuando te hablen en polaco y ES cuando hables tú. Vuelve a tocar para parar.';
    tip = 'Toca una de tus frases para mostrarla en grande.';
  }
  if (settings.engine === 'soniox' && !settings.apiKey) {
    tip = 'Primero añade tu clave de Soniox en Ajustes (o elige el motor gratuito).';
  }
  $('emptyHint').textContent = hint;
  $('emptyTip').textContent = tip;
}

function updateDuo() {
  const duo = settings.engine === 'free' && settings.mode === 'conversar';
  $('duo').hidden = !duo;
  $('btnMic').hidden = duo;
  for (const b of document.querySelectorAll('.duo-btn')) {
    b.classList.toggle('active', rt.kind === 'free' && rt.phase !== 'idle' && rt.freeLang === b.dataset.lang);
  }
}

// ------------------------------------------------------------------ phase / status

function statusText(phase, info = {}) {
  switch (phase) {
    case 'starting':
      return 'Micrófono…';
    case 'connecting':
      return 'Conectando…';
    case 'live':
      return 'En vivo';
    case 'reconnecting':
      return info.offline ? 'Sin conexión' : 'Reconectando…';
    case 'stopping':
      return 'Terminando…';
    default:
      return 'Listo';
  }
}

function setPhase(phase, info = {}) {
  rt.phase = phase;
  appEl.dataset.phase = phase;
  const listening = phase !== 'idle';
  $('micIcon').setAttribute('href', listening ? '#i-stop' : '#i-mic');
  $('btnMic').setAttribute('aria-label', listening ? 'Detener' : 'Empezar a escuchar');
  $('stText').textContent = statusText(phase, info);
  if (phase === 'reconnecting' && info.offline) {
    showBanner('Sin conexión a internet. Seguiré intentándolo y continuaré en cuanto vuelva la señal.', null, 'info');
  } else if (phase === 'live' && !$('banner').hidden && $('banner').classList.contains('info')) {
    hideBanner();
  }
  updateDuo();
  view.refreshPendingMarks();
}

let clockTimer = null;
function startClock() {
  rt.runStartedAt = Date.now();
  rt.sessionMark = Date.now();
  clearInterval(clockTimer);
  const tick = () => ($('stTime').textContent = fmtClock(Date.now() - rt.runStartedAt));
  tick();
  clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  $('stTime').textContent = '';
}
function accountDuration() {
  if (session && rt.sessionMark) {
    session.durationMs = (session.durationMs || 0) + (Date.now() - rt.sessionMark);
    rt.sessionMark = Date.now();
  }
}

let levelRaf = 0;
function startLevelLoop() {
  cancelAnimationFrame(levelRaf);
  const ring = $('btnMic');
  const loop = () => {
    const lvl = rt.meter && rt.phase === 'live' ? rt.meter.level() : 0;
    ring.style.setProperty('--lvl', lvl.toFixed(3));
    levelRaf = requestAnimationFrame(loop);
  };
  levelRaf = requestAnimationFrame(loop);
}
function stopLevelLoop() {
  cancelAnimationFrame(levelRaf);
  $('btnMic').style.setProperty('--lvl', '0');
}

// Screen wake lock while listening.
let wakeWanted = false;
let wakeSentinel = null;
async function keepAwake(on) {
  wakeWanted = !!on && settings.keepAwake;
  if (wakeWanted) {
    if (wakeSentinel || !('wakeLock' in navigator)) return;
    try {
      wakeSentinel = await navigator.wakeLock.request('screen');
      wakeSentinel.addEventListener('release', () => (wakeSentinel = null));
    } catch {
      /* not allowed now (e.g. page hidden) */
    }
  } else if (wakeSentinel) {
    const s = wakeSentinel;
    wakeSentinel = null;
    s.release().catch(() => {});
  }
}

// ------------------------------------------------------------------ sessions

let session = null;
let saveTimer = null;

function markSessionDirty() {
  if (!session) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentSession, 2000);
}

function saveCurrentSession() {
  clearTimeout(saveTimer);
  if (!session || !transcript.hasContent()) return;
  accountDuration();
  session.updatedAt = Date.now();
  if (!saveSession(session, transcript.toJSON())) {
    toast('No se pudo guardar el historial (almacenamiento lleno).', 3500);
  }
}

function ensureSession(mode) {
  const now = Date.now();
  // A long break (e.g. the next Mass) starts a new session automatically.
  if (session && transcript.hasContent() && now - (session.updatedAt || session.startedAt) > 2 * 3600e3) {
    saveCurrentSession();
    session = null;
    transcript.clear();
    scheduleRender();
  }
  if (!session) {
    session = { id: newSessionId(), mode, engine: settings.engine, startedAt: now, updatedAt: now, durationMs: 0 };
    setCurrentSessionId(session.id);
  }
}

function newSession() {
  saveCurrentSession();
  if (rt.segmenter) rt.segmenter.resetForNewTranscript();
  session = null;
  setCurrentSessionId(null);
  transcript.clear();
  view.selected = null;
  view.follow = true;
  if (rt.phase !== 'idle') {
    ensureSession(rt.mode || settings.mode);
    rt.sessionMark = Date.now();
  }
  scheduleRender();
  toast('Nueva sesión');
}

function restoreSession() {
  const id = getCurrentSessionId();
  if (!id) return;
  const s = loadSession(id);
  if (!s) {
    setCurrentSessionId(null);
    return;
  }
  const { blocks, ...meta } = s;
  session = meta;
  transcript.load(blocks);
}

// ------------------------------------------------------------------ translations (fallback / free)

function translateBlock(b, from, to, { fallback = false } = {}) {
  if (b.trBusy) return;
  b.trBusy = true;
  translate(b.src, from || 'auto', to)
    .then((r) => {
      b.tgt = r.text;
      b.tgtLang = to;
      b.tgtProvisional = false;
      b.err = false;
      if (fallback) b.fb = true;
    })
    .catch(() => {
      if (!b.tgt) b.err = true;
    })
    .finally(() => {
      b.trBusy = false;
      b.retr = false;
      transcript.markDirty(b.id);
      scheduleRender();
      markSessionDirty();
    });
}

// Text Soniox left untranslated (another language, or a stream that ended
// before its translation arrived) gets a free fallback translation; a
// paragraph cut off by a dropped connection is re-translated in full.
function queueFallbackTranslations() {
  const blocks = transcript.blocks;
  for (let i = Math.max(0, blocks.length - 12); i < blocks.length; i++) {
    const b = blocks[i];
    if ((b.tgt && !b.retr) || b.err || b.trBusy || !b.src || !b.closed) continue;
    if (rt.segmenter && rt.segmenter.isPending(b)) continue;
    if (b.kind === 'orig' && rt.kind === 'free') continue; // handled by onFreeFinal
    const to = targetLangFor(b);
    if (!to || to === b.srcLang) {
      b.retr = false;
      continue;
    }
    translateBlock(b, b.srcLang || 'auto', to, { fallback: true });
  }
}

// ------------------------------------------------------------------ listening

async function toggleMic() {
  if (rt.phase === 'idle') return startListening();
  if (rt.phase === 'stopping') return;
  return stopListening();
}

async function startListening({ lang } = {}) {
  if (rt.phase !== 'idle') return;
  hideBanner();
  const mode = settings.mode;
  if (settings.engine === 'soniox') {
    if (!settings.apiKey) {
      openSheet('sheetSetup');
      return;
    }
    return startSoniox(mode);
  }
  return startFree(mode, lang || 'pl-PL');
}

async function startSoniox(mode) {
  setPhase('starting');
  let stream;
  try {
    stream = await openMicrophone({ processing: settings.micProcessing });
  } catch (e) {
    setPhase('idle');
    showMicError(e);
    return;
  }
  if (rt.phase !== 'starting') {
    stopStream(stream); // cancelled while the permission prompt was open
    return;
  }
  ensureSession(mode);
  const mime = pickRecorderMime();
  const audio = mime ? { format: 'auto' } : { format: 'pcm', sampleRate: 16000 };
  const encoder = mime ? new OpusEncoder(stream, mime) : new PcmEncoder(stream);
  const segmenter = new SonioxSegmenter(transcript, { twoWay: MODES[mode].twoWay, mode });
  const engine = new SonioxEngine({
    apiKey: settings.apiKey.trim(),
    url: WS_URL,
    getConfig: () => buildSonioxConfig(mode, { audio }),
    encoder,
    onTokens: (tokens) => {
      if (rt.engine !== engine) return;
      segmenter.ingest(tokens);
      scheduleRender();
      markSessionDirty();
    },
    onState: (st, info) => {
      if (rt.engine !== engine) return;
      if (st === 'connecting' || st === 'live' || st === 'reconnecting' || st === 'stopping') setPhase(st, info);
      if (st === 'live' && info.reconnected) toast('Conexión recuperada');
    },
    onStreamEnd: ({ unexpected }) => {
      // A dropped connection can leave a half-translated paragraph: mark it
      // so the fallback translator redoes the whole paragraph.
      for (const b of segmenter.endStream({ keepPreview: unexpected })) b.retr = true;
      scheduleRender();
      markSessionDirty();
      setTimeout(queueFallbackTranslations, 50);
    },
    onFatal: (err) => {
      if (rt.engine !== engine) return;
      handleFatal(describeSonioxError(err), err);
    },
    onUsage: (ms) => {
      settings.usageMs = (settings.usageMs || 0) + ms;
      saveSettingsSoon();
    },
  });
  rt.kind = 'soniox';
  rt.engine = engine;
  rt.stream = stream;
  rt.mode = mode;
  rt.segmenter = segmenter;
  try {
    rt.meter = new LevelMeter(stream);
  } catch {
    rt.meter = null;
  }
  startClock();
  startLevelLoop();
  keepAwake(true);
  engine.start();
}

function startFree(mode, lang) {
  if (!freeEngineSupported()) {
    showBanner('Este navegador no tiene reconocimiento de voz gratuito. Usa Chrome o cambia a Soniox en Ajustes.', {
      label: 'Ajustes',
      run: () => openSheet('sheetSettings'),
    });
    return;
  }
  ensureSession(mode);
  const engine = new FreeEngine({
    onInterim: (text, l) => rt.engine === engine && onFreeInterim(text, l),
    onFinal: (text, l) => rt.engine === engine && onFreeFinal(text, l),
    onState: (st, info) => {
      if (rt.engine !== engine) return;
      if (st === 'live' || st === 'connecting' || st === 'reconnecting') setPhase(st, info);
    },
    onFatal: (err) => {
      if (rt.engine !== engine) return;
      handleFatal(err.message || 'Error del reconocimiento de voz.');
    },
  });
  rt.kind = 'free';
  rt.engine = engine;
  rt.mode = mode;
  rt.freeLang = lang;
  setPhase('connecting');
  startClock();
  keepAwake(true);
  engine.start(lang);
}

async function stopListening() {
  if (rt.phase === 'idle' || rt.phase === 'stopping') return;
  if (rt.phase === 'starting') {
    setPhase('idle');
    return;
  }
  const engine = rt.engine;
  setPhase('stopping');
  try {
    if (rt.kind === 'soniox') await engine.stop();
    else if (engine) engine.stop();
  } catch {
    /* ignore */
  }
  finishRun();
}

function finishRun() {
  stopLevelLoop();
  if (rt.meter) rt.meter.close();
  rt.meter = null;
  stopStream(rt.stream);
  rt.stream = null;
  accountDuration();
  stopClock();
  keepAwake(false);
  rt.engine = null;
  rt.kind = null;
  rt.segmenter = null;
  rt.freeLang = null;
  freeInterim = null;
  transcript.clearPreview();
  setPhase('idle');
  scheduleRender();
  saveCurrentSession();
  setTimeout(queueFallbackTranslations, 50);
  maybeReload();
}

function handleFatal(message, err) {
  let action = { label: 'Reintentar', run: () => startListening() };
  const type = err && err.error_type;
  if (type === 'unauthenticated' || type === 'permission_denied' || Number(err && err.error_code) === 401) {
    action = { label: 'Ajustes', run: () => openSheet('sheetSettings') };
  } else if (type && /balance|budget/.test(type)) {
    action = { label: 'Recargar', run: () => window.open('https://console.soniox.com/', '_blank', 'noopener') };
  }
  finishRun();
  showBanner(message, action);
}

function showMicError(e) {
  if (e && e.code === 'denied') {
    showBanner(
      'Entiendo necesita el micrófono. Permítelo en Chrome: ⋮ → Configuración → Configuración de sitios → Micrófono (o mantén pulsado el icono de la app → Información → Permisos).',
      { label: 'Reintentar', run: () => startListening() },
    );
  } else {
    showBanner((e && e.message) || 'No se pudo usar el micrófono.', { label: 'Reintentar', run: () => startListening() });
  }
}

// Free engine: interim text + debounced live translation.
let freeInterim = null; // { text, srcLang, tgtLang }
let interimTr = { text: '', tr: '' };
let interimTimer = null;
let interimBusy = false;

function renderFreePreview() {
  if (!freeInterim || !freeInterim.text) {
    transcript.setPreview(new Map(), []);
  } else {
    transcript.setPreview(new Map(), [
      {
        kind: 'orig',
        m: rt.mode,
        src: capitalize(freeInterim.text),
        srcLang: freeInterim.srcLang,
        tgtLang: freeInterim.tgtLang,
        tgt: interimTr.tr || '',
      },
    ]);
  }
  scheduleRender();
}

function scheduleInterimTranslation() {
  if (interimTimer || interimBusy) return;
  interimTimer = setTimeout(async () => {
    interimTimer = null;
    const cur = freeInterim;
    if (!cur || !cur.text) return;
    interimBusy = true;
    try {
      const r = await translate(cur.text, cur.srcLang, cur.tgtLang);
      interimTr = { text: cur.text, tr: r.text };
    } catch {
      /* the final translation will retry */
    }
    interimBusy = false;
    if (freeInterim && freeInterim.text) {
      renderFreePreview();
      if (freeInterim.text !== interimTr.text) scheduleInterimTranslation();
    }
  }, 650);
}

function onFreeInterim(text, lang) {
  const srcLang = lang.slice(0, 2);
  const tgtLang = srcLang === 'es' ? 'pl' : 'es';
  if (!text) {
    freeInterim = null;
    renderFreePreview();
    return;
  }
  freeInterim = { text, srcLang, tgtLang };
  renderFreePreview();
  scheduleInterimTranslation();
}

function onFreeFinal(text, lang) {
  const srcLang = lang.slice(0, 2);
  const tgtLang = srcLang === 'es' ? 'pl' : 'es';
  const provisional = interimTr.tr && text.startsWith(interimTr.text.slice(0, 12)) ? interimTr.tr : '';
  freeInterim = null;
  interimTr = { text: '', tr: '' };
  const b = transcript.createBlock({
    kind: 'orig',
    m: rt.mode,
    src: capitalize(text),
    srcLang,
    tgtLang,
    closed: true,
    tgt: provisional,
    tgtProvisional: !!provisional,
  });
  transcript.setPreview(new Map(), []);
  scheduleRender();
  markSessionDirty();
  translateBlock(b, srcLang, tgtLang);
}

async function onDuo(lang) {
  if (rt.phase === 'stopping' || rt.phase === 'starting') return;
  if (rt.phase === 'idle') {
    await startListening({ lang });
  } else if (rt.kind === 'free' && rt.freeLang === lang) {
    await stopListening();
  } else if (rt.kind === 'free') {
    rt.freeLang = lang;
    rt.engine.switchLang(lang);
    setPhase('live');
  }
  updateDuo();
}

async function setMode(mode) {
  if (!MODES[mode] || mode === settings.mode) return;
  const wasListening = rt.phase !== 'idle';
  if (wasListening) await stopListening();
  settings.mode = mode;
  saveSettings(settings);
  renderModes();
  renderEmpty();
  updateDuo();
  if (wasListening && !(settings.engine === 'free' && mode === 'conversar')) startListening();
}

async function setEngine(engine) {
  if (engine === settings.engine) return;
  if (rt.phase !== 'idle') await stopListening();
  settings.engine = engine;
  saveSettings(settings);
  renderModes();
  renderEmpty();
  updateDuo();
  renderSettings();
}

// ------------------------------------------------------------------ block actions & big view

function onBlockAction(act, b) {
  if (act === 'copy') copyText([b.src, b.tgt].filter(Boolean).join('\n'));
  if (act === 'big') showBig(b.tgt || b.src, b.tgt ? b.src : '');
}

function fitBigText() {
  const t = $('bigText');
  const sub = $('bigSub');
  const box = $('bigInner');
  let size = 72;
  t.style.fontSize = size + 'px';
  const fits = () => t.scrollHeight + sub.offsetHeight + 60 <= box.clientHeight && t.scrollWidth <= box.clientWidth;
  while (size > 18 && !fits()) {
    size -= 2;
    t.style.fontSize = size + 'px';
  }
}

function showBig(main, sub) {
  $('bigText').textContent = main;
  $('bigSub').textContent = sub || '';
  $('bigView').classList.remove('rot');
  openSheet('bigView');
  requestAnimationFrame(fitBigText);
}

// ------------------------------------------------------------------ sheets (+ Android back button)

const sheetStack = [];
let ignorePop = 0;

function openSheet(id) {
  const el = $(id);
  if (!el.hidden) return;
  el.hidden = false;
  el.style.zIndex = String((id === 'bigView' ? 70 : 50) + sheetStack.length);
  sheetStack.push(id);
  history.pushState({ sheet: id }, '');
  if (id === 'sheetSettings') renderSettings();
  if (id === 'sheetHistory') renderHistory();
  if (id === 'sheetSetup') renderSetup();
  $('popText').hidden = true;
}

function closeSheet(id, fromPop = false) {
  const el = $(id);
  if (el.hidden) return;
  el.hidden = true;
  const i = sheetStack.lastIndexOf(id);
  if (i >= 0) sheetStack.splice(i, 1);
  if (!fromPop) {
    ignorePop += 1;
    history.back();
  }
  if (id === 'sheetSession' && sessionView) {
    sessionView.destroy();
    sessionView = null;
  }
  maybeReload();
}

window.addEventListener('popstate', () => {
  if (ignorePop > 0) {
    ignorePop -= 1;
    return;
  }
  if (!$('popText').hidden) $('popText').hidden = true;
  const top = sheetStack[sheetStack.length - 1];
  if (top) closeSheet(top, true);
});

// ------------------------------------------------------------------ setup (first run)

function renderSetup() {
  const engine = settings.engine === 'free' ? 'free' : 'soniox';
  for (const r of document.querySelectorAll('input[name="setupEngine"]')) r.checked = r.value === engine;
  $('setupKey').value = settings.apiKey || '';
  $('setupMsg').textContent = '';
  $('setupMsg').className = 'msg';
  updateSetupKeyBox();
  const freeRadio = document.querySelector('input[name="setupEngine"][value="free"]');
  freeRadio.disabled = !freeEngineSupported();
}

function updateSetupKeyBox() {
  const v = document.querySelector('input[name="setupEngine"]:checked').value;
  $('setupKeyBox').hidden = v !== 'soniox';
}

async function checkAndSaveKey(key, msgEl, button) {
  msgEl.className = 'msg';
  msgEl.textContent = 'Comprobando la clave…';
  button.disabled = true;
  const res = await testSonioxKey(key, WS_URL);
  button.disabled = false;
  if (res.ok) {
    settings.apiKey = key;
    saveSettings(settings);
    msgEl.className = 'msg ok';
    msgEl.textContent = 'Clave correcta. ¡Todo listo!';
    return true;
  }
  const type = res.error && res.error.error_type;
  if (type && /balance|budget/.test(type)) {
    settings.apiKey = key;
    saveSettings(settings);
    msgEl.className = 'msg err';
    msgEl.textContent = 'La clave es válida pero tu cuenta no tiene saldo. Recarga en console.soniox.com → Billing.';
    return true;
  }
  if (!res.error) {
    // Could not reach Soniox: keep the key, it will be checked on first use.
    settings.apiKey = key;
    saveSettings(settings);
    msgEl.className = 'msg err';
    msgEl.textContent = res.message + ' La clave se ha guardado igualmente.';
    return true;
  }
  msgEl.className = 'msg err';
  msgEl.textContent = res.message;
  return false;
}

async function onSetupGo() {
  const engine = document.querySelector('input[name="setupEngine"]:checked').value;
  if (engine === 'free') {
    settings.engine = 'free';
    settings.onboarded = true;
    saveSettings(settings);
    finishSetup();
    return;
  }
  const key = $('setupKey').value.trim();
  if (!key) {
    $('setupMsg').className = 'msg err';
    $('setupMsg').textContent = 'Pega tu clave de Soniox para continuar.';
    $('setupKey').focus();
    return;
  }
  const ok = await checkAndSaveKey(key, $('setupMsg'), $('setupGo'));
  if (!ok) return;
  settings.engine = 'soniox';
  settings.onboarded = true;
  saveSettings(settings);
  setTimeout(finishSetup, 700);
}

function finishSetup() {
  closeSheet('sheetSetup');
  renderModes();
  renderEmpty();
  updateDuo();
  toast('Listo: elige un modo y pulsa el micrófono', 3000);
}

// ------------------------------------------------------------------ settings

function renderSettings() {
  for (const b of document.querySelectorAll('#setEngine [data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === settings.engine));
  for (const b of document.querySelectorAll('#setTheme [data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === settings.theme));
  $('keyGroup').hidden = settings.engine !== 'soniox';
  $('engineHint').textContent =
    settings.engine === 'soniox'
      ? 'Soniox: traducción palabra a palabra y detección automática de polaco/español. De pago (unos 0,12–0,25 US$ por hora).'
      : freeEngineSupported()
        ? 'Gratis: reconocimiento de voz de Google en Chrome y traductor gratuito. Puede perder palabras en las pausas.'
        : 'Este navegador no tiene reconocimiento de voz gratuito. Usa Chrome.';
  if (document.activeElement !== $('setKey')) $('setKey').value = settings.apiKey || '';
  $('keyMsg').textContent = settings.apiKey ? 'Clave guardada en este teléfono.' : 'Aún no hay ninguna clave.';
  $('keyMsg').className = 'msg';
  $('setAwake').checked = settings.keepAwake;
  $('setNoise').checked = settings.micProcessing;
  const ms = settings.usageMs || 0;
  const cost = (ms / 3600e3) * SONIOX_USD_PER_HOUR;
  $('usageText').textContent = ms
    ? `Has escuchado ${fmtDuration(ms)} con Soniox (≈ ${cost.toFixed(2).replace('.', ',')} US$, aproximado).`
    : 'Todavía no has usado Soniox desde este teléfono.';
  $('aboutText').textContent = `Entiendo ${APP_VERSION} · Voz y traducción: Soniox (stt-rt-v6) o Google. Tus transcripciones se guardan solo en este teléfono.`;
  applyReading();
}

// ------------------------------------------------------------------ history

const MODE_ICON = { misa: 'church', escuchar: 'ear', conversar: 'messages-square' };

function renderHistory() {
  const list = $('histList');
  list.textContent = '';
  const items = listSessions();
  $('histEmpty').hidden = items.length > 0;
  for (const s of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'h-icon';
    icon.innerHTML = `<svg class="ic"><use href="#i-${MODE_ICON[s.mode] || 'ear'}"/></svg>`;
    const main = document.createElement('span');
    main.className = 'h-main';
    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = `${(MODES[s.mode] && MODES[s.mode].label) || 'Sesión'} · ${fmtWhen(s.startedAt)}`;
    const sub = document.createElement('span');
    sub.className = 'h-sub';
    sub.textContent = `${fmtDuration(s.durationMs)} · ${s.count} ${s.count === 1 ? 'frase' : 'frases'}`;
    const prev = document.createElement('span');
    prev.className = 'h-prev';
    prev.textContent = s.preview || '';
    main.append(title, sub, prev);
    btn.append(icon, main);
    btn.addEventListener('click', () => openSessionView(s.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

let sessionView = null;
let viewing = null;

function openSessionView(id) {
  if (session && id === session.id) saveCurrentSession();
  const s = loadSession(id);
  if (!s) {
    toast('No se encontró la sesión');
    return;
  }
  viewing = s;
  const tr = new Transcript();
  tr.load(s.blocks);
  $('sessTitle').textContent = `${(MODES[s.mode] && MODES[s.mode].label) || 'Sesión'} · ${fmtWhen(s.startedAt)}`;
  $('sessSub').textContent = `${fmtDuration(s.durationMs)} · ${s.blocks.length} ${s.blocks.length === 1 ? 'frase' : 'frases'}`;
  openSheet('sheetSession');
  if (sessionView) sessionView.destroy();
  sessionView = new TranscriptView({
    container: $('sessBlocks'),
    pvContainer: $('sessPv'),
    scroller: $('sessScroller'),
    transcript: tr,
    readOnly: true,
  });
  sessionView.follow = false;
  sessionView.renderAll();
  $('sessScroller').scrollTop = 0;
}

function sessionText(s) {
  const label = (MODES[s.mode] && MODES[s.mode].label) || 'Sesión';
  const lines = [`Entiendo · ${label} · ${longFmt.format(new Date(s.startedAt))}`];
  if (s.durationMs) lines.push(`Duración: ${fmtDuration(s.durationMs)}`);
  lines.push('');
  for (const b of s.blocks) {
    const sl = (b.srcLang || 'pl').toUpperCase();
    const tl = (b.tgtLang || (sl === 'ES' ? 'pl' : 'es')).toUpperCase();
    if (b.src) lines.push(`[${sl}] ${b.src}`);
    if (b.tgt) lines.push(`[${tl}] ${b.tgt}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

function sessionFilename(s) {
  const d = new Date(s.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `entiendo-${s.mode || 'sesion'}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}

// ------------------------------------------------------------------ PWA

let installEvt = null;
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || (IS_LOCAL && params.has('nosw'))) return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    rt.reloadWhenIdle = true;
    maybeReload();
  });
  let lastCheck = Date.now();
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // An installed app can stay open for days: look for updates when it
      // comes back to the foreground (at most every 30 minutes).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30 * 60e3) {
          lastCheck = Date.now();
          reg.update().catch(() => {});
        }
      });
    })
    .catch(() => {});
}

function maybeReload() {
  if (rt.reloadWhenIdle && rt.phase === 'idle' && sheetStack.length === 0) {
    saveCurrentSession();
    location.reload();
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('btnInstall').hidden = false;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('entiendo:installDismissed') === '1';
  } catch {
    /* ignore */
  }
  if (!dismissed && settings.onboarded && $('banner').hidden) {
    showBanner('Instala Entiendo en tu pantalla de inicio para abrirlo como una app.', { label: 'Instalar', run: promptInstall }, 'info');
  }
});
window.addEventListener('appinstalled', () => {
  $('btnInstall').hidden = true;
  installEvt = null;
  toast('App instalada');
});

async function promptInstall() {
  if (!installEvt) {
    toast('Usa el menú ⋮ de Chrome → «Instalar app»', 3500);
    return;
  }
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('btnInstall').hidden = true;
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('btnMic').addEventListener('click', () => {
    if (rt.meter) rt.meter.resume();
    toggleMic();
  });
  for (const b of document.querySelectorAll('.duo-btn')) b.addEventListener('click', () => onDuo(b.dataset.lang));
  $('btnNew').addEventListener('click', () => {
    if (!transcript.hasContent()) {
      toast('La sesión ya está vacía');
      return;
    }
    newSession();
  });
  for (const b of document.querySelectorAll('#modes [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

  $('btnSettings').addEventListener('click', () => openSheet('sheetSettings'));
  $('btnHistory').addEventListener('click', () => openSheet('sheetHistory'));
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => closeSheet(b.closest('.sheet').id));
  }

  // banner
  $('bannerClose').addEventListener('click', () => {
    if ($('bannerAction').textContent === 'Instalar') {
      try {
        localStorage.setItem('entiendo:installDismissed', '1');
      } catch {
        /* ignore */
      }
    }
    hideBanner();
  });
  $('bannerAction').addEventListener('click', () => {
    const a = bannerAction;
    hideBanner();
    if (a) a.run();
  });

  // scrolling / jump to live
  $('scroller').addEventListener(
    'scroll',
    () => {
      const near = view.nearBottom();
      view.follow = near;
      $('jump').hidden = near || !transcript.blocks.length;
    },
    { passive: true },
  );
  $('jump').addEventListener('click', () => {
    view.follow = true;
    view.scrollToEnd();
    $('jump').hidden = true;
  });

  // text popover
  $('btnText').addEventListener('click', (e) => {
    e.stopPropagation();
    $('popText').hidden = !$('popText').hidden;
  });
  document.addEventListener('click', (e) => {
    const pop = $('popText');
    if (!pop.hidden && !pop.contains(e.target) && !$('btnText').contains(e.target)) pop.hidden = true;
  });
  const setFont = (v) => {
    settings.fontSize = Math.max(16, Math.min(44, Math.round(v)));
    applyReading();
    saveSettingsSoon();
    if (view.follow) view.scrollToEnd();
  };
  $('fontDown').addEventListener('click', () => setFont(settings.fontSize - 2));
  $('fontUp').addEventListener('click', () => setFont(settings.fontSize + 2));
  $('popFont').addEventListener('input', (e) => setFont(Number(e.target.value)));
  $('setFont').addEventListener('input', (e) => setFont(Number(e.target.value)));
  const bindToggle = (ids, key) => {
    for (const id of ids) {
      $(id).addEventListener('change', (e) => {
        settings[key] = e.target.checked;
        applyReading();
        saveSettingsSoon();
      });
    }
  };
  bindToggle(['popShowSrc', 'setShowSrc'], 'showSource');
  bindToggle(['popSrcFirst', 'setSrcFirst'], 'sourceFirst');

  // big view
  $('bigClose').addEventListener('click', () => closeSheet('bigView'));
  $('bigRotate').addEventListener('click', () => $('bigView').classList.toggle('rot'));
  $('bigCopy').addEventListener('click', () => copyText($('bigText').textContent));
  window.addEventListener('resize', () => !$('bigView').hidden && fitBigText());

  // reveal key buttons
  for (const b of document.querySelectorAll('[data-reveal]')) {
    b.addEventListener('click', () => {
      const input = $(b.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    });
  }

  // setup
  for (const r of document.querySelectorAll('input[name="setupEngine"]')) r.addEventListener('change', updateSetupKeyBox);
  $('setupGo').addEventListener('click', onSetupGo);
  $('setupKey').addEventListener('keydown', (e) => e.key === 'Enter' && onSetupGo());

  // settings
  for (const b of document.querySelectorAll('#setEngine [data-v]')) b.addEventListener('click', () => setEngine(b.dataset.v));
  for (const b of document.querySelectorAll('#setTheme [data-v]')) {
    b.addEventListener('click', () => {
      settings.theme = b.dataset.v;
      saveSettings(settings);
      renderSettings();
    });
  }
  $('btnTestKey').addEventListener('click', async () => {
    const key = $('setKey').value.trim();
    if (!key) {
      $('keyMsg').className = 'msg err';
      $('keyMsg').textContent = 'Pega primero tu clave.';
      return;
    }
    const ok = await checkAndSaveKey(key, $('keyMsg'), $('btnTestKey'));
    if (ok) {
      settings.onboarded = true;
      saveSettings(settings);
      renderEmpty();
    }
  });
  $('setAwake').addEventListener('change', (e) => {
    settings.keepAwake = e.target.checked;
    saveSettings(settings);
    if (rt.phase !== 'idle') keepAwake(true);
  });
  $('setNoise').addEventListener('change', (e) => {
    settings.micProcessing = e.target.checked;
    saveSettings(settings);
    if (rt.phase !== 'idle') toast('Se aplicará la próxima vez que empieces a escuchar', 3000);
  });
  $('btnResetUsage').addEventListener('click', () => {
    settings.usageMs = 0;
    saveSettings(settings);
    renderSettings();
  });
  $('btnInstall').addEventListener('click', promptInstall);
  $('btnSetupAgain').addEventListener('click', () => openSheet('sheetSetup'));
  $('btnClearHistory').addEventListener('click', () => {
    if (!confirm('¿Borrar todas las sesiones guardadas? No se puede deshacer.')) return;
    deleteAllSessions();
    if (rt.phase === 'idle') {
      session = null;
      transcript.clear();
      scheduleRender();
    } else if (session) {
      setCurrentSessionId(session.id);
    }
    toast('Historial borrado');
  });

  // session viewer
  $('sessBack').addEventListener('click', () => closeSheet('sheetSession'));
  $('sessCopy').addEventListener('click', () => viewing && copyText(sessionText(viewing)));
  $('sessShare').addEventListener('click', async () => {
    if (!viewing) return;
    const text = sessionText(viewing);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Entiendo', text });
      } catch {
        /* cancelled */
      }
    } else {
      copyText(text);
    }
  });
  $('sessDownload').addEventListener('click', () => {
    if (!viewing) return;
    const blob = new Blob([sessionText(viewing)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sessionFilename(viewing);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  });
  $('sessDelete').addEventListener('click', () => {
    if (!viewing || !confirm('¿Borrar esta sesión?')) return;
    const id = viewing.id;
    deleteSession(id);
    if (session && session.id === id) {
      if (rt.phase === 'idle') {
        session = null;
        transcript.clear();
        scheduleRender();
      } else {
        setCurrentSessionId(id);
      }
    }
    closeSheet('sheetSession');
    renderHistory();
    toast('Sesión borrada');
  });

  // lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (wakeWanted && !wakeSentinel) keepAwake(true);
      scheduleRender();
    } else {
      saveCurrentSession();
    }
  });
  window.addEventListener('pagehide', saveCurrentSession);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyReading);
}

// ------------------------------------------------------------------ init

function handleLaunchParams() {
  const mode = params.get('mode');
  if (mode && MODES[mode] && mode !== settings.mode) {
    settings.mode = mode;
    saveSettings(settings);
  }
  const autostart = params.get('start') === '1';
  if (params.has('mode') || params.has('start') || params.has('source')) {
    const keep = new URLSearchParams();
    for (const k of ['ws', 'nosw']) if (params.has(k)) keep.set(k, params.get(k));
    const q = keep.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
  }
  if (autostart && settings.onboarded && (settings.engine === 'free' || settings.apiKey)) {
    setTimeout(() => startListening(), 300);
  }
}

function init() {
  history.replaceState({ base: true }, '');
  applyReading();
  renderModes();
  renderEmpty();
  restoreSession();
  setPhase('idle');
  view.renderAll();
  updateContentState();
  wire();
  if (!settings.onboarded) openSheet('sheetSetup');
  handleLaunchParams();
  registerServiceWorker();
  // Expose a tiny debug handle for automated tests.
  if (IS_LOCAL) window.__entiendo = { rt, transcript, settings, view };
}

init();
