// Turns the Soniox real-time token stream into paragraphs that pair the
// spoken text (Polish) with its translation (Spanish) — or both directions
// in two-way conversation mode.
//
// Soniox facts this relies on (docs.soniox.com, real-time translation):
//  * Final tokens are sent once and never change; non-final tokens are
//    re-sent on every response and replaced by the next response.
//  * Each token has translation_status: "original" (will be translated),
//    "none" (not translated) or "translation" (translated text).
//  * Transcription and translation chunks follow each other: a chunk of
//    original tokens, then the translation chunk for it, then the next...
//  * "<end>" (endpoint) and "<fin>" (manual finalize) are final marker tokens.
//
// Strategy: blocks are created/extended by original/none tokens. A
// translation token is attached to the oldest block still waiting for its
// translation ("pending"). When an original token follows translation
// tokens, every earlier original has been translated, so pending is reset.

import { newBlockDefaults } from './transcript.js';

export const SOFT_MAX = 280; // start a new paragraph at a sentence end after this many chars
export const HARD_MAX = 600; // ...or at any chunk boundary after this many
const SENTENCE_END = /[.!?…]["'»”)\]]*\s*$/u;
const MARKERS = new Set(['<end>', '<fin>']);
const NO_SPACE_BEFORE = /^[\s.,;:!?…)\]»”'"%]/u;

export function joinText(prev, text, chunkStart) {
  if (!prev) return text.replace(/^\s+/u, '');
  if (chunkStart && !/\s$/u.test(prev) && !NO_SPACE_BEFORE.test(text)) return prev + ' ' + text;
  return prev + text;
}

function statusOf(tk) {
  if (tk.translation_status === 'original') return 'original';
  if (tk.translation_status === 'translation') return 'translation';
  return 'none';
}

// Core state transition, shared by the committed pass (final tokens) and the
// preview pass (non-final tokens on a copy-on-write view).
export function applyToken(S, tk, opts) {
  const text = tk.text;
  if (MARKERS.has(text)) {
    const last = S.blocks[S.blocks.length - 1];
    if (last && !last.closed) S.mut(last).closed = true;
    return;
  }
  if (!text) return;
  const status = statusOf(tk);

  if (status === 'translation') {
    let target = null;
    if (S.pending.length) {
      target = (tk.source_language && S.pending.find((b) => b.srcLang === tk.source_language)) || S.pending[0];
    } else {
      for (let i = S.blocks.length - 1; i >= 0; i--) {
        if (S.blocks[i].kind === 'orig') {
          target = S.blocks[i];
          break;
        }
      }
    }
    const chunkStart = S.lastStatus !== 'translation';
    const m = target ? S.mut(target) : S.create({ kind: 'orig', m: opts.mode, srcLang: tk.source_language || null });
    m.tgt = joinText(m.tgt, text, chunkStart);
    if (!m.tgtLang && tk.language) m.tgtLang = tk.language;
    if (!m.srcLang && tk.source_language) m.srcLang = tk.source_language;
    S.lastStatus = 'translation';
    return;
  }

  const kind = status === 'original' ? 'orig' : 'none';
  const chunkStart = S.lastStatus === 'translation';
  if (chunkStart) S.pending = [];
  const lang = tk.language || null;
  const last = S.blocks[S.blocks.length - 1] || null;
  let fresh = !last || last.closed || last.kind !== kind;
  if (!fresh && opts.twoWay && lang && last.srcLang && lang !== last.srcLang) fresh = true;
  if (!fresh && chunkStart) {
    const n = last.src.length;
    if (n >= HARD_MAX || (n >= SOFT_MAX && SENTENCE_END.test(last.src))) fresh = true;
  }
  let m;
  if (fresh) {
    if (last && !last.closed) S.mut(last).closed = true;
    m = S.create({ kind, m: opts.mode, srcLang: lang });
  } else {
    m = S.mut(last);
  }
  m.src = joinText(m.src, text, chunkStart && !fresh);
  if (!m.srcLang && lang) m.srcLang = lang;
  if (kind === 'orig' && !S.pending.includes(m)) S.pending.push(m);
  S.lastStatus = status;
}

export class SonioxSegmenter {
  constructor(transcript, { twoWay = false, mode = null } = {}) {
    this.tr = transcript;
    this.opts = { twoWay, mode };
    this.lastStatus = null;
    this.pending = [];
    this.lastNonFinal = [];
  }

  configure({ twoWay, mode }) {
    this.opts = { twoWay: !!twoWay, mode: mode || null };
  }

  // Feed one Soniox response's tokens.
  ingest(tokens) {
    const finals = [];
    const nonFinals = [];
    for (const tk of tokens || []) {
      if (!tk || typeof tk.text !== 'string') continue;
      if (this.skipTranslations) {
        if (statusOf(tk) === 'translation') continue;
        if (tk.is_final && !MARKERS.has(tk.text)) this.skipTranslations = false;
      }
      (tk.is_final ? finals : nonFinals).push(tk);
    }
    if (finals.length) this._commit(finals);
    this.lastNonFinal = nonFinals;
    this._preview(nonFinals);
  }

  // The stream ended (stop, reconnect, error). Optionally keep the provisional
  // text that was on screen, then close the paragraph. Returns the blocks
  // whose translation may be incomplete (still pending when the stream died).
  endStream({ keepPreview = false } = {}) {
    if (keepPreview && this.lastNonFinal.length) this._commit(this.lastNonFinal);
    const incomplete = keepPreview ? this.pending.slice() : [];
    const last = this.tr.lastBlock();
    if (last && !last.closed) {
      last.closed = true;
      this.tr.markDirty(last.id);
    }
    this.pending = [];
    this.lastStatus = null;
    this.lastNonFinal = [];
    this.tr.clearPreview();
    return incomplete;
  }

  // The visible transcript was replaced (new session) while listening:
  // translations still in flight belong to the old text, so drop them until
  // new speech arrives.
  resetForNewTranscript() {
    this.pending = [];
    this.lastStatus = null;
    this.lastNonFinal = [];
    this.skipTranslations = true;
  }

  isPending(block) {
    return this.pending.includes(block);
  }

  _commit(tokens) {
    const tr = this.tr;
    const S = {
      blocks: tr.blocks,
      lastStatus: this.lastStatus,
      pending: this.pending,
      mut: (b) => {
        tr.markDirty(b.id);
        return b;
      },
      create: (fields) => tr.createBlock(fields),
    };
    for (const tk of tokens) applyToken(S, tk, this.opts);
    this.lastStatus = S.lastStatus;
    this.pending = S.pending;
  }

  _preview(tokens) {
    if (!tokens.length) {
      this.tr.setPreview(new Map(), []);
      return;
    }
    const blocks = this.tr.blocks.slice();
    const clones = new Map();
    const extra = [];
    const S = {
      blocks,
      lastStatus: this.lastStatus,
      pending: this.pending.slice(),
      mut: (b) => {
        if (b.__pv) return b;
        let c = clones.get(b);
        if (!c) {
          c = { ...b, __pv: true };
          clones.set(b, c);
          const i = blocks.lastIndexOf(b);
          if (i >= 0) blocks[i] = c;
          S.pending = S.pending.map((x) => (x === b ? c : x));
        }
        return c;
      },
      create: (fields) => {
        const nb = { ...newBlockDefaults(), ...fields, id: 'p' + (extra.length + 1), __pv: true };
        blocks.push(nb);
        extra.push(nb);
        return nb;
      },
    };
    for (const tk of tokens) applyToken(S, tk, this.opts);
    const mods = new Map();
    for (const [orig, c] of clones) {
      const srcNF = c.src.slice(orig.src.length);
      const tgtNF = c.tgt.slice(orig.tgt.length);
      if (srcNF || tgtNF) mods.set(orig.id, { srcNF, tgtNF });
    }
    this.tr.setPreview(
      mods,
      extra.map(({ __pv, ...rest }) => rest),
    );
  }
}
