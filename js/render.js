// Renders a Transcript into the DOM. Only blocks that changed are redrawn,
// so a one-hour homily stays smooth on a phone.

import { LANG_LABEL } from './config.js';

const ICON = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function langLabel(code) {
  return LANG_LABEL[code] || (code ? code.toUpperCase() : '');
}

export class TranscriptView {
  // container: element holding committed blocks; pvContainer: provisional ones;
  // scroller: the scrolling element.
  constructor({ container, pvContainer, scroller, transcript, isLive, isPending, onAction, readOnly = false }) {
    this.c = container;
    this.pv = pvContainer;
    this.scroller = scroller;
    this.tr = transcript;
    this.isLive = isLive || (() => false);
    this.isPending = isPending || (() => false);
    this.onAction = onAction || (() => {});
    this.readOnly = readOnly;
    this.nodes = new Map(); // id -> element
    this.selected = null;
    this.follow = true; // auto-scroll to the newest text
    this.unsub = transcript.onChange((change) => this.apply(change));
    container.addEventListener('click', (e) => this._onClick(e));
  }

  destroy() {
    this.unsub();
  }

  setTranscript(tr) {
    this.unsub();
    this.tr = tr;
    this.unsub = tr.onChange((change) => this.apply(change));
    this.renderAll();
  }

  nearBottom() {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  scrollToEnd() {
    const s = this.scroller;
    s.scrollTop = s.scrollHeight;
  }

  renderAll() {
    this.c.textContent = '';
    this.nodes.clear();
    const frag = document.createDocumentFragment();
    for (const b of this.tr.blocks) {
      if (!b.src && !b.tgt) continue;
      const node = this._blockNode(b, this.tr.pvMods.get(b.id));
      this.nodes.set(b.id, node);
      frag.appendChild(node);
    }
    this.c.appendChild(frag);
    this._renderExtra();
    this._markLive();
    if (this.follow) this.scrollToEnd();
  }

  apply(change) {
    if (change.structural) {
      this.renderAll();
      return;
    }
    const stick = this.follow || this.nearBottom();
    const ids = new Set([...change.dirty, ...change.preview]);
    for (const id of ids) {
      const b = this.tr.getBlock(id);
      if (!b) continue;
      const old = this.nodes.get(id);
      if (!b.src && !b.tgt && !this.tr.pvMods.get(id)) {
        if (old) old.remove();
        this.nodes.delete(id);
        continue;
      }
      const node = this._blockNode(b, this.tr.pvMods.get(id));
      if (old) old.replaceWith(node);
      else this.c.appendChild(node);
      this.nodes.set(id, node);
    }
    if (change.extraChanged) this._renderExtra();
    this._markLive();
    if (stick) this.scrollToEnd();
  }

  refreshPendingMarks() {
    // Re-render blocks whose "waiting for translation" state may have changed.
    for (const b of this.tr.blocks.slice(-4)) this.tr.markDirty(b.id);
    this.tr.flush();
  }

  _markLive() {
    const live = this.isLive();
    let last = null;
    for (const [, node] of this.nodes) last = node;
    for (const node of this.c.querySelectorAll('.is-live')) if (node !== last || !live) node.classList.remove('is-live');
    if (live && last && !this.pv.childElementCount) last.classList.add('is-live');
  }

  _renderExtra() {
    this.pv.textContent = '';
    for (const b of this.tr.pvExtra) {
      if (!b.src && !b.tgt) continue;
      const node = this._blockNode(b, { srcNF: b.src, tgtNF: b.tgt }, true);
      node.classList.add('is-live');
      this.pv.appendChild(node);
    }
  }

  _blockNode(b, pv, provisional = false) {
    const conv = b.m === 'conversar';
    const mine = conv && b.srcLang === 'es';
    const node = el('article', conv ? 'bub ' + (mine ? 'mine' : 'theirs') : 'blk');
    if (b.kind === 'none') node.classList.add('untranslated');
    if (!provisional) node.dataset.id = b.id;

    const srcF = provisional ? '' : b.src;
    const srcNF = pv ? pv.srcNF || '' : '';
    const tgtF = provisional ? '' : b.tgt;
    const tgtNF = pv ? pv.tgtNF || '' : '';

    if (conv) {
      const meta = el('div', 'meta');
      const from = langLabel(b.srcLang);
      const to = langLabel(b.tgtLang || (b.srcLang === 'es' ? 'pl' : 'es'));
      meta.textContent = b.kind === 'none' && !b.tgt ? from : from && to ? `${from} → ${to}` : from || '';
      if (meta.textContent) node.appendChild(meta);
    } else if (b.kind === 'none' && b.srcLang && b.srcLang !== 'pl') {
      node.appendChild(el('div', 'meta', langLabel(b.srcLang)));
    }

    const src = el('p', 'src');
    if (b.srcLang) src.lang = b.srcLang;
    src.appendChild(el('span', null, srcF));
    if (srcNF) src.appendChild(el('span', 'nf', srcF ? srcNF : srcNF.replace(/^\s+/u, '')));

    const tgt = el('p', 'tgt');
    if (b.tgtLang) tgt.lang = b.tgtLang;
    const hasTgt = !!(tgtF || tgtNF);
    if (hasTgt) {
      tgt.appendChild(el('span', b.tgtProvisional ? 'nf' : null, tgtF));
      if (tgtNF) tgt.appendChild(el('span', 'nf', tgtF ? tgtNF : tgtNF.replace(/^\s+/u, '')));
      if (b.fb) tgt.title = 'Traducción automática de respaldo';
    } else if (b.kind === 'orig') {
      // Translation still coming (or failed).
      if (b.err && !provisional) {
        tgt.classList.add('missing');
        tgt.textContent = 'Sin traducción';
      } else {
        tgt.classList.add('waiting');
        tgt.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      }
    }

    node.appendChild(src);
    if (hasTgt || b.kind === 'orig') node.appendChild(tgt);
    if (b.kind === 'none' && !hasTgt) node.classList.add('src-only');

    if (!provisional && !this.readOnly && this.selected === b.id) {
      node.classList.add('selected');
      const bar = el('div', 'acts');
      bar.innerHTML =
        `<button type="button" data-act="big">${ICON('maximize-2')}<span>Ampliar</span></button>` +
        `<button type="button" data-act="copy">${ICON('copy')}<span>Copiar</span></button>`;
      node.appendChild(bar);
    }
    return node;
  }

  _onClick(e) {
    if (this.readOnly) return;
    const actBtn = e.target.closest('[data-act]');
    const node = e.target.closest('[data-id]');
    if (!node) return;
    const id = Number(node.dataset.id);
    const b = this.tr.getBlock(id);
    if (!b) return;
    if (actBtn) {
      e.stopPropagation();
      this.onAction(actBtn.dataset.act, b);
      return;
    }
    // Don't toggle while the user is selecting text.
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.type === 'Range' && String(sel).length > 0) return;
    const prev = this.selected;
    this.selected = prev === id ? null : id;
    if (prev != null && prev !== id) this.tr.markDirty(prev);
    this.tr.markDirty(id);
    this.follow = false;
    this.tr.flush();
  }
}
