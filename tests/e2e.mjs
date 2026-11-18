// End-to-end test in real Chromium with a fake microphone and the mock
// Soniox server. Run: node tests/e2e.mjs [--shots]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { startStatic } from '../scripts/serve.mjs';
import { startMock } from './mock-soniox.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SHOTS = process.argv.includes('--shots');
const shotDir = new URL('../shots/', import.meta.url).pathname;
if (SHOTS) mkdirSync(shotDir, { recursive: true });
const STATIC_PORT = 8080;
const MOCK_PORT = 8787;
const BASE = `http://localhost:${STATIC_PORT}/`;
const WS = `ws://localhost:${MOCK_PORT}/transcribe-websocket`;
const appUrl = (extra = '') => `${BASE}?ws=${encodeURIComponent(WS)}&nosw=1${extra}`;
const audio = new URL('./fixtures/tone.wav', import.meta.url).pathname;

let failures = 0;
let passes = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passes += 1;
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const stats = async () => (await fetch(`http://localhost:${MOCK_PORT}/control/stats`)).json();
const control = (path) => fetch(`http://localhost:${MOCK_PORT}/control/${path}`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(350); // let sheet/popover animations finish
  await page.screenshot({ path: `${shotDir}${name}.png` });
}

const staticServer = await startStatic(new URL('../app/', import.meta.url).pathname.replace(/\/$/, ''), STATIC_PORT);
const mock = await startMock(MOCK_PORT);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${audio}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

function newContext(extra = {}) {
  return browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    isMobile: true,
    hasTouch: true,
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
    ...extra,
  });
}

// Free translation endpoints are never hit for real in tests.
async function mockTranslation(ctx, fn) {
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com|mymemory\.translated\.net/, async (route) => {
    const body = route.request().postData() || '';
    const q = decodeURIComponent((body.match(/q=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
    const url = route.request().url();
    const tl = (url.match(/tl=([a-z]+)/) || [])[1] || 'es';
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify([fn ? fn(q, tl) : `[${tl}] ${q}`]),
    });
  });
}

console.log('E2E: Entiendo');
const ctx = await newContext();
await mockTranslation(ctx);
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

await step('first run shows the setup sheet', async () => {
  await page.goto(appUrl());
  await page.waitForSelector('#sheetSetup:not([hidden])', { timeout: 5000 });
  assert(await page.isVisible('#setupKeyBox'), 'key box visible for Soniox');
  await shot(page, '01-setup');
});

await step('invalid key is rejected and not saved', async () => {
  await page.fill('#setupKey', 'bad');
  await page.click('#setupGo');
  await page.waitForFunction(() => /no es válida/.test(document.getElementById('setupMsg').textContent), null, { timeout: 6000 });
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:settings') || '{}'));
  assert(!s.apiKey, 'bad key must not be saved');
});

await step('valid key passes the check and closes the setup', async () => {
  await page.fill('#setupKey', 'test-key');
  await page.click('#setupGo');
  await page.waitForSelector('#sheetSetup', { state: 'hidden', timeout: 6000 });
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:settings')));
  assert(s.apiKey === 'test-key' && s.onboarded === true && s.engine === 'soniox', 'settings saved');
  assert(await page.isVisible('#empty'), 'empty state visible');
  await shot(page, '02-empty-misa');
});

await step('Misa: live Polish text with Spanish translation', async () => {
  await control('reset');
  assert((await page.getAttribute('[data-mode="misa"]', 'aria-selected')) === 'true', 'misa selected by default');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.getElementById('stText').textContent === 'En vivo', null, { timeout: 6000 });
  await page.waitForSelector('#pv .blk .nf, #blocks .blk .nf', { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#blocks .blk .tgt')].some((e) => /Evangelio de hoy/.test(e.textContent)), null, { timeout: 15000 });
  const first = await page.evaluate(() => {
    const b = document.querySelector('#blocks .blk');
    return { src: b.querySelector('.src').textContent, tgt: b.querySelector('.tgt').textContent };
  });
  assert(first.src.startsWith('Drodzy bracia i siostry, dzisiejsza Ewangelia'), 'polish: ' + first.src);
  assert(first.tgt.startsWith('Queridos hermanos y hermanas'), 'spanish: ' + first.tgt);
  const st = await stats();
  const cfg = st.configs[0];
  assert(cfg.model === 'stt-rt-v6' && cfg.audio_format === 'auto', 'model/audio');
  assert(cfg.translation.type === 'one_way' && cfg.translation.target_language === 'es', 'one-way to es');
  assert(cfg.language_hints[0] === 'pl' && cfg.context && cfg.context.translation_terms.length > 10, 'hints + context');
  assert(!cfg.api_key, 'key is not sent in the start message');
  assert(st.keys[0] === 'test-key', 'key sent via protocols list');
  assert(st.streams[0].firstChunkHex === '1a45dfa3', 'audio starts with a WebM header: ' + st.streams[0].firstChunkHex);
  await sleep(1200);
  await shot(page, '03-misa-live');
});

await step('network drop: reconnects with a fresh audio header and keeps the text', async () => {
  const before = await page.$$eval('#blocks .blk', (n) => n.length);
  await control('drop');
  await page.waitForFunction(() => /Reconectando|Sin conexión|Conectando/.test(document.getElementById('stText').textContent) || true, null, { timeout: 3000 });
  await page.waitForFunction(() => document.getElementById('stText').textContent === 'En vivo', null, { timeout: 8000 });
  await sleep(2500);
  const st = await stats();
  assert(st.connections >= 2, 'reconnected: ' + st.connections);
  const s2 = st.streams[st.streams.length - 1];
  assert(s2.firstChunkHex === '1a45dfa3', 'new stream starts with WebM header, got ' + s2.firstChunkHex);
  assert(s2.bytes > 0, 'audio flows after reconnect');
  const after = await page.$$eval('#blocks .blk', (n) => n.length);
  assert(after >= before, 'transcript kept');
});

await step('server error 503: retries automatically', async () => {
  const n = (await stats()).connections;
  await control('error?type=service_unavailable&code=503');
  await page.waitForFunction(() => document.getElementById('stText').textContent === 'En vivo', null, { timeout: 8000 });
  await sleep(500);
  assert((await stats()).connections > n, 'new connection after 503');
  assert(await page.isHidden('#banner'), 'no error banner for a retryable error');
});

await step('stop: ends the stream cleanly and saves the session', async () => {
  await page.click('#btnMic');
  await page.waitForFunction(() => document.getElementById('stText').textContent === 'Listo', null, { timeout: 8000 });
  const st = await stats();
  assert(st.endFrames >= 1 && st.finishedSent >= 1, 'empty frame + finished');
  const idx = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:sessions') || '[]'));
  assert(idx.length === 1 && idx[0].count >= 2, 'session saved: ' + JSON.stringify(idx));
  const live = await page.$$eval('.is-live', (n) => n.length);
  assert(live === 0, 'no live marker after stop');
});

await step('conversation: bubbles in both directions + big text view', async () => {
  await page.click('[data-mode="conversar"]');
  assert((await page.textContent('#engineLabel')).includes('⇄'), 'two-way label');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('#blocks .bub.mine .tgt').length > 0 && /Poproszę/.test(document.querySelector('#blocks .bub.mine .tgt').textContent), null, { timeout: 20000 });
  await page.waitForSelector('#blocks .bub.theirs', { timeout: 5000 });
  const st = await stats();
  const cfg = st.configs[st.configs.length - 1];
  assert(cfg.translation.type === 'two_way' && cfg.translation.language_a === 'pl' && cfg.translation.language_b === 'es', 'two-way config');
  const theirs = await page.textContent('#blocks .bub.theirs .tgt');
  assert(/Buenos días/.test(theirs), 'their bubble translated to Spanish: ' + theirs);
  const meta = await page.textContent('#blocks .bub.mine .meta');
  assert(meta === 'ES → PL', 'mine meta: ' + meta);
  await sleep(800);
  await shot(page, '04-conversar-live');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.getElementById('stText').textContent === 'Listo', null, { timeout: 8000 });
  await page.click('#blocks .bub.mine .tgt');
  await page.waitForSelector('#blocks .bub.mine.selected .acts', { timeout: 3000 });
  await shot(page, '05-bubble-actions');
  await page.click('#blocks .bub.mine.selected [data-act="big"]');
  await page.waitForSelector('#bigView:not([hidden])', { timeout: 3000 });
  assert(/Poproszę/.test(await page.textContent('#bigText')), 'big view shows Polish');
  await sleep(200);
  await shot(page, '06-big');
  await page.click('#bigRotate');
  assert(await page.evaluate(() => document.getElementById('bigView').classList.contains('rot')), 'rotated');
  await page.click('#bigClose');
  await page.waitForSelector('#bigView', { state: 'hidden' });
});

await step('Android back button closes the big view / sheets', async () => {
  await page.click('#btnSettings');
  await page.waitForSelector('#sheetSettings:not([hidden])');
  await page.goBack();
  await page.waitForSelector('#sheetSettings', { state: 'hidden', timeout: 3000 });
  assert(page.url().startsWith(BASE), 'still in the app');
});

await step('history: list, open, copy', async () => {
  await page.click('#btnHistory');
  await page.waitForSelector('#histList li', { timeout: 3000 });
  await shot(page, '07-history');
  await page.click('#histList li button');
  await page.waitForSelector('#sheetSession:not([hidden]) #sessBlocks > *', { timeout: 3000 });
  await shot(page, '08-session');
  await page.click('#sessCopy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip.startsWith('Entiendo · ') && clip.includes('[PL] ') && clip.includes('[ES] '), 'export text: ' + clip.slice(0, 120));
  await page.click('#sessBack');
  await page.waitForSelector('#sheetSession', { state: 'hidden' });
  await page.click('#sheetHistory [data-close]');
  await page.waitForSelector('#sheetHistory', { state: 'hidden' });
});

await step('text options: size, hide original, order', async () => {
  await page.click('#btnText');
  await page.waitForSelector('#popText:not([hidden])');
  await page.click('#fontUp');
  await page.click('#fontUp');
  const fs = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim());
  assert(fs === '28px', 'font size: ' + fs);
  await shot(page, '09-text-options');
  await page.click('label:has(#popShowSrc)');
  assert(await page.evaluate(() => document.getElementById('blocks').classList.contains('hide-src')), 'hide-src');
  await page.click('label:has(#popShowSrc)');
  await page.click('label:has(#popSrcFirst)');
  assert(await page.evaluate(() => document.getElementById('blocks').classList.contains('src-after')), 'src-after');
  await page.click('label:has(#popSrcFirst)');
  await page.mouse.click(200, 500);
  await page.waitForSelector('#popText', { state: 'hidden' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:settings')));
  await sleep(400);
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:settings')));
  assert(saved2.fontSize === 28 && saved2.showSource === true && saved2.sourceFirst === true, 'persisted ' + JSON.stringify(saved || saved2));
});

await step('settings: theme + key check messages', async () => {
  await page.click('#btnSettings');
  await page.waitForSelector('#sheetSettings:not([hidden])');
  await shot(page, '10-settings');
  await page.click('#setTheme [data-v="light"]');
  assert((await page.getAttribute('html', 'data-theme')) === 'light', 'light theme');
  await page.click('#sheetSettings [data-close]');
  await shot(page, '11-light-theme');
  await page.click('#btnSettings');
  await page.click('#setTheme [data-v="dark"]');
  await page.fill('#setKey', 'nobalance');
  await page.click('#btnTestKey');
  await page.waitForFunction(() => /saldo/.test(document.getElementById('keyMsg').textContent), null, { timeout: 6000 });
  await page.fill('#setKey', 'test-key');
  await page.click('#btnTestKey');
  await page.waitForFunction(() => /correcta/.test(document.getElementById('keyMsg').textContent), null, { timeout: 6000 });
  await page.click('#sheetSettings [data-close]');
});

await step('new session clears the screen and keeps the old one in history', async () => {
  await page.click('#btnNew');
  await page.waitForFunction(() => document.querySelectorAll('#blocks > *').length === 0);
  const idx = await page.evaluate(() => JSON.parse(localStorage.getItem('entiendo:sessions')));
  assert(idx.length === 1, 'one saved session');
});

await step('fatal error: invalid key shows a clear banner', async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('entiendo:settings'));
    s.apiKey = 'bad';
    localStorage.setItem('entiendo:settings', JSON.stringify(s));
  });
  await page.reload();
  await page.click('#btnMic');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 6000 });
  const text = await page.textContent('#bannerText');
  assert(/no es válida/.test(text), 'banner: ' + text);
  assert((await page.textContent('#bannerAction')) === 'Ajustes', 'settings action');
  assert((await page.textContent('#stText')) === 'Listo', 'back to idle');
  await shot(page, '12-error');
});

await step('no uncaught page errors', async () => {
  const real = consoleErrors.filter((e) => !/WebSocket|ERR_|Failed to load resource|net::/.test(e));
  assert(real.length === 0, real.join('\n'));
});
await ctx.close();

// ---------------------------------------------------------------- free engine
console.log('E2E: free engine (simulated speech recognition)');
const ctx2 = await newContext();
await mockTranslation(ctx2, (q, tl) => (tl === 'pl' ? 'Poproszę dwie bułki' : 'Buenos días, ¿en qué puedo ayudarle?'));
await ctx2.addInitScript(() => {
  localStorage.setItem('entiendo:settings', JSON.stringify({ engine: 'free', onboarded: true, mode: 'escuchar' }));
  window.__sr = { starts: 0, langs: [] };
  class FakeSR {
    constructor() {
      this.lang = 'pl-PL';
    }
    start() {
      window.__sr.starts += 1;
      window.__sr.langs.push(this.lang);
      const es = this.lang.startsWith('es');
      const said = es ? 'quisiera dos panecillos' : 'dzień dobry w czym mogę pomóc';
      const res = (text, isFinal) => {
        const alt = { transcript: text, confidence: 0.9 };
        const r = [alt];
        r.isFinal = isFinal;
        return { resultIndex: 0, results: [r] };
      };
      setTimeout(() => this.onstart && this.onstart(), 20);
      setTimeout(() => this.onresult && this.onresult(res(said.split(' ').slice(0, 2).join(' '), false)), 150);
      setTimeout(() => this.onresult && this.onresult(res(said, true)), 400);
      setTimeout(() => this.onend && this.onend(), 2500);
    }
    stop() {
      setTimeout(() => this.onend && this.onend(), 10);
    }
    abort() {
      setTimeout(() => this.onend && this.onend(), 10);
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
});
const p2 = await ctx2.newPage();
const errs2 = [];
p2.on('pageerror', (e) => errs2.push(String(e)));

await step('free engine: Polish phrase → Spanish translation', async () => {
  await p2.goto(appUrl());
  assert(await p2.isHidden('#sheetSetup'), 'no setup when onboarded');
  assert((await p2.textContent('#engineLabel')).includes('Gratis'), 'free label');
  await p2.click('#btnMic');
  await p2.waitForFunction(() => [...document.querySelectorAll('#blocks .blk .tgt')].some((e) => /Buenos días/.test(e.textContent)), null, { timeout: 6000 });
  const src = await p2.textContent('#blocks .blk .src');
  assert(src === 'Dzień dobry w czym mogę pomóc', 'capitalised source: ' + src);
  await p2.waitForFunction(() => window.__sr.starts >= 2, null, { timeout: 5000 });
  await shot(p2, '13-free-escuchar');
  await p2.click('#btnMic');
  await p2.waitForFunction(() => document.getElementById('stText').textContent === 'Listo');
});

await step('free engine conversation: PL / ES buttons', async () => {
  await p2.click('[data-mode="conversar"]');
  assert(await p2.isVisible('#duo'), 'duo buttons');
  assert(await p2.isHidden('#btnMic'), 'single mic hidden');
  await p2.click('.duo-btn[data-lang="es-ES"]');
  await p2.waitForFunction(() => [...document.querySelectorAll('#blocks .bub.mine .tgt')].some((e) => /Poproszę/.test(e.textContent)), null, { timeout: 6000 });
  assert(await p2.evaluate(() => window.__sr.langs.includes('es-ES')), 'spanish recognition used');
  await p2.click('.duo-btn[data-lang="pl-PL"]');
  await p2.waitForFunction(() => document.querySelectorAll('#blocks .bub.theirs').length > 0, null, { timeout: 6000 });
  await shot(p2, '14-free-conversar');
  await p2.click('.duo-btn[data-lang="pl-PL"]');
  await p2.waitForFunction(() => document.getElementById('stText').textContent === 'Listo');
  assert(errs2.length === 0, errs2.join('\n'));
});
await ctx2.close();

// ---------------------------------------------------------------- PWA / offline
console.log('E2E: installability + offline');
const ctx3 = await newContext();
const p3 = await ctx3.newPage();
await step('service worker caches the app; it opens offline', async () => {
  await p3.goto(`${BASE}?ws=${encodeURIComponent(WS)}`);
  await p3.evaluate(() => navigator.serviceWorker.ready);
  await p3.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('entiendo-')), null, { timeout: 5000 });
  await ctx3.setOffline(true);
  await p3.reload();
  await p3.waitForSelector('#btnMic', { timeout: 5000 });
  assert((await p3.title()) === 'Entiendo', 'title offline');
  await ctx3.setOffline(false);
});
await step('manifest is valid and icons load', async () => {
  const m = await (await fetch(`${BASE}manifest.webmanifest`)).json();
  assert(m.display === 'standalone' && m.icons.some((i) => i.purpose === 'maskable'), 'manifest');
  for (const i of [...m.icons, ...m.shortcuts.flatMap((s) => s.icons)]) {
    const r = await fetch(BASE + i.src);
    assert(r.ok, 'icon ' + i.src);
  }
});
await ctx3.close();

await browser.close();
await mock.close();
staticServer.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
