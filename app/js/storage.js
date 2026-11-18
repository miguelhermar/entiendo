// Persistence in localStorage: settings, session index, and per-session blocks.
// Every access is wrapped: storage can be unavailable (private mode, quota).

const NS = 'entiendo:';
const K_SETTINGS = NS + 'settings';
const K_INDEX = NS + 'sessions';
const K_CURRENT = NS + 'current';
const sessionKey = (id) => NS + 'session:' + id;
const MAX_SESSIONS = 120;

export const DEFAULT_SETTINGS = {
  engine: 'soniox', // 'soniox' | 'free'
  apiKey: '',
  mode: 'misa',
  fontSize: 24, // px, translation text
  showSource: true, // show the original (Polish) text
  sourceFirst: true, // original above the translation
  theme: 'dark', // 'dark' | 'light' | 'auto'
  keepAwake: true,
  micProcessing: false, // browser noise suppression / AGC
  usageMs: 0, // total Soniox streaming time
  onboarded: false,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadSettings() {
  const s = read(K_SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
}

export function saveSettings(settings) {
  return write(K_SETTINGS, settings);
}

// ---------------------------------------------------------------- sessions

export function listSessions() {
  const idx = read(K_INDEX, []);
  return Array.isArray(idx) ? idx.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

export function loadSession(id) {
  const meta = listSessions().find((s) => s.id === id);
  const blocks = read(sessionKey(id), null);
  if (!meta || !Array.isArray(blocks)) return null;
  return { ...meta, blocks };
}

export function newSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getCurrentSessionId() {
  return read(K_CURRENT, null);
}

export function setCurrentSessionId(id) {
  if (id) write(K_CURRENT, id);
  else remove(K_CURRENT);
}

function previewOf(blocks) {
  for (const b of blocks) {
    const text = (b.tgt || b.src || '').trim();
    if (text) return text.slice(0, 140);
  }
  return '';
}

// Save (insert or update) a session. Returns false if storage failed even
// after pruning old sessions.
export function saveSession(meta, blocks) {
  if (!meta || !meta.id) return false;
  const idx = listSessions().filter((s) => s.id !== meta.id);
  const entry = {
    id: meta.id,
    mode: meta.mode,
    engine: meta.engine,
    startedAt: meta.startedAt,
    updatedAt: Date.now(),
    durationMs: meta.durationMs || 0,
    count: blocks.length,
    preview: previewOf(blocks),
    modes: meta.modes || undefined,
  };
  idx.unshift(entry);
  while (idx.length > MAX_SESSIONS) {
    const old = idx.pop();
    remove(sessionKey(old.id));
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    if (write(sessionKey(meta.id), blocks) && write(K_INDEX, idx)) return true;
    // Quota exceeded: drop the oldest other session and retry.
    const victim = idx.length > 1 ? idx.pop() : null;
    if (!victim) break;
    remove(sessionKey(victim.id));
  }
  return false;
}

export function deleteSession(id) {
  remove(sessionKey(id));
  write(
    K_INDEX,
    listSessions().filter((s) => s.id !== id),
  );
  if (getCurrentSessionId() === id) setCurrentSessionId(null);
}

export function deleteAllSessions() {
  for (const s of listSessions()) remove(sessionKey(s.id));
  remove(K_INDEX);
  remove(K_CURRENT);
}
