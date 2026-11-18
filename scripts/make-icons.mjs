// Renders the app icons to PNG with headless Chromium.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { iconSvg, maskableSvg, shortcutSvg } from './icon-src.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const out = new URL('../app/icons/', import.meta.url);
writeFileSync(new URL('icon.svg', out), iconSvg);

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svg, size, file, transparent = true) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(file, out).pathname, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}
await render(iconSvg, 192, 'icon-192.png');
await render(iconSvg, 512, 'icon-512.png');
await render(maskableSvg, 512, 'maskable-512.png', false);
await render(maskableSvg, 180, 'apple-touch-icon.png', false);
for (const m of ['misa', 'conversar', 'escuchar']) await render(shortcutSvg(m), 96, `shortcut-${m}.png`);
await browser.close();
console.log('icons written');
