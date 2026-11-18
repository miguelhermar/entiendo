// Source SVGs for the app icon (shared by make-icons.mjs).
const art = `
  <path d="M118 120h178a46 46 0 0 1 46 46v86a46 46 0 0 1-46 46h-94l-56 44v-44h-28a46 46 0 0 1-46-46v-86a46 46 0 0 1 46-46z" fill="#2a3346"/>
  <rect x="112" y="152" width="136" height="18" rx="9" fill="#7d89a3"/>
  <rect x="112" y="186" width="58" height="18" rx="9" fill="#7d89a3"/>
  <path d="M214 204h180a46 46 0 0 1 46 46v94a46 46 0 0 1-46 46h-30v50l-62-50h-88a46 46 0 0 1-46-46v-94a46 46 0 0 1 46-46z" fill="url(#am)"/>
  <rect x="250" y="268" width="24" height="56" rx="12" fill="#1b1405"/>
  <rect x="292" y="244" width="24" height="104" rx="12" fill="#1b1405"/>
  <rect x="334" y="260" width="24" height="72" rx="12" fill="#1b1405"/>`;

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2030"/><stop offset="1" stop-color="#0b0d12"/></linearGradient>
    <linearGradient id="am" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcd62"/><stop offset="1" stop-color="#f0a527"/></linearGradient>
  </defs>`;

export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="114" fill="url(#bg)"/>
  <g transform="translate(-2 -16)">${art}</g>
</svg>`;

// Maskable: full-bleed background, artwork shrunk into the 80% safe zone.
export const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(0.74) translate(-258 -262)">${art}</g>
</svg>`;

// Small mode glyphs for app shortcuts (Lucide, ISC license).
const glyph = {
  misa: '<path d="M10 9h4"/><path d="M12 7v5"/><path d="M14 22v-4a2 2 0 0 0-4 0v4"/><path d="M18 22V5.618a1 1 0 0 0-.553-.894l-4.553-2.277a2 2 0 0 0-1.788 0L6.553 4.724A1 1 0 0 0 6 5.618V22"/><path d="m18 7 3.447 1.724a1 1 0 0 1 .553.894V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.618a1 1 0 0 1 .553-.894L6 7"/>',
  conversar: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  escuchar: '<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>',
};
export const shortcutSvg = (name) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="48" fill="#151a24"/>
  <g transform="translate(24 24) scale(2)" fill="none" stroke="#f4b740" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph[name]}</g>
</svg>`;
