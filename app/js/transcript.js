// Transcript store: committed blocks + a "preview" overlay of provisional text.
//
// A block is one paragraph (listen modes) or one bubble (conversation):
//   { id, kind: 'orig'|'none', m: mode, src, tgt, srcLang, tgtLang,
//     closed, at, fb (fallback translation), err }
// kind 'orig'  = speech that the engine translates (src -> tgt)
// kind 'none'  = speech the engine leaves untranslated (e.g. already Spanish)
//
// Engines mutate committed blocks and set a preview overlay (non-final text).
// Renderers listen for change notifications and redraw only what changed.

export function newBlockDefaults() {
  return {
    kind: 'orig',
    m: null,
    src: '',
    tgt: '',
    srcLang: null,
    tgtLang: null,
    closed: false,
    at: Date.now(),
    fb: false,
  };
}

export class Transcript {
  constructor() {
    this.blocks = [];
    this.nextId = 1;
    this.pvMods = new Map(); // block id -> { srcNF, tgtNF }
    this.pvExtra = []; // provisional blocks (not committed yet)
    this._listeners = new Set();
    this._dirty = new Set();
    this._pvTouched = new Set(); // ids whose preview changed since last flush
    this._extraChanged = false;
    this._structural = false;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  createBlock(fields = {}) {
    const b = { ...newBlockDefaults(), ...fields, id: this.nextId++ };
    this.blocks.push(b);
    this._dirty.add(b.id);
    return b;
  }

  markDirty(id) {
    this._dirty.add(id);
  }

  getBlock(id) {
    // Blocks are appended in id order; search from the end (recent blocks are hot).
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].id === id) return this.blocks[i];
    }
    return null;
  }

  lastBlock() {
    return this.blocks[this.blocks.length - 1] || null;
  }

  setPreview(mods, extra) {
    const next = mods || new Map();
    for (const id of this.pvMods.keys()) {
      const a = this.pvMods.get(id);
      const b = next.get(id);
      if (!b || a.srcNF !== b.srcNF || a.tgtNF !== b.tgtNF) this._pvTouched.add(id);
    }
    for (const [id, b] of next) {
      const a = this.pvMods.get(id);
      if (!a || a.srcNF !== b.srcNF || a.tgtNF !== b.tgtNF) this._pvTouched.add(id);
    }
    this.pvMods = next;
    const ex = extra || [];
    if (ex.length || this.pvExtra.length) {
      if (!sameExtra(ex, this.pvExtra)) this._extraChanged = true;
    }
    this.pvExtra = ex;
  }

  clearPreview() {
    this.setPreview(new Map(), []);
  }

  hasContent() {
    return this.blocks.some((b) => b.src || b.tgt);
  }

  // Replace everything (load a session from storage, or start a new one).
  load(blocks) {
    this.blocks = (blocks || []).map((b, i) => ({ ...newBlockDefaults(), ...b, id: i + 1, closed: true }));
    this.nextId = this.blocks.length + 1;
    this.pvMods = new Map();
    this.pvExtra = [];
    this._dirty.clear();
    this._pvTouched.clear();
    this._extraChanged = true;
    this._structural = true;
  }

  clear() {
    this.load([]);
  }

  // Notify listeners of everything that changed since the last flush.
  flush() {
    if (!this._structural && !this._dirty.size && !this._pvTouched.size && !this._extraChanged) return false;
    const change = {
      structural: this._structural,
      dirty: new Set(this._dirty),
      preview: new Set(this._pvTouched),
      extraChanged: this._extraChanged,
    };
    this._dirty.clear();
    this._pvTouched.clear();
    this._extraChanged = false;
    this._structural = false;
    for (const fn of this._listeners) fn(change, this);
    return true;
  }

  // Compact serialisation for storage / export.
  toJSON() {
    return this.blocks
      .filter((b) => b.src || b.tgt)
      .map((b) => ({
        kind: b.kind,
        m: b.m,
        src: b.src,
        tgt: b.tgt,
        srcLang: b.srcLang,
        tgtLang: b.tgtLang,
        at: b.at,
        fb: b.fb || undefined,
      }));
  }
}

function sameExtra(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.src !== y.src || x.tgt !== y.tgt || x.kind !== y.kind || x.srcLang !== y.srcLang) return false;
  }
  return true;
}
