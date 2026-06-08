// Design-critique capture harness.
// Loads the unpacked extension in Chrome for Testing and renders every UI
// surface + state I'm evaluating to PNG. Pass a label arg ("before"/"after")
// to choose the output subdir. Output → ./audit-proof/<label>/*.png
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const LABEL = process.argv[2] || 'before';
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(REPO, 'audit-proof', LABEL);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-crit-'));

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  userDataDir,
  args: [
    `--disable-extensions-except=${REPO}`,
    `--load-extension=${REPO}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  ],
});

const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const EXT_ID = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const extUrl = (p) => `chrome-extension://${EXT_ID}/${p}`;

const warm = await browser.newPage();
await warm.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(500);
const loaded = await warm.evaluate(() => !!(globalThis.chrome?.runtime?.id)).catch(() => false);
if (!loaded) { for (const t of browser.targets()) console.log(t.type(), t.url()); throw new Error('extension not loaded'); }
log('extension loaded', EXT_ID, '→', LABEL);
await warm.close();

async function shot(file, name, { width = 1100, height = 900, full = true, wait = 700, dpr = 2, before, fit = false } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: dpr });
  await p.goto(extUrl(file), { waitUntil: 'networkidle0' });
  await sleep(wait);
  if (before) await before(p);
  await sleep(wait);
  // fit: size the viewport to the document so popup shots clip to their real
  // content height (Chrome auto-sizes the popup; a fixed tall viewport would
  // otherwise add a fake black void below the footer).
  if (fit) {
    // Shrink the viewport first so scrollHeight reflects true content height
    // (not the clamped tall viewport), then size to it for a void-free shot.
    await p.setViewport({ width, height: 2, deviceScaleFactor: dpr });
    await sleep(60);
    const h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await p.setViewport({ width, height: h, deviceScaleFactor: dpr });
    await sleep(120);
    await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
  } else {
    await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  }
  await p.close();
  log('shot', name);
}

// ── POPUP: idle, collapsed (default landing state) ───────────────────────────
await shot('popup.html', 'popup-idle', { width: 360, height: 640, fit: true });

// ── POPUP: idle, both disclosure sections expanded ───────────────────────────
await shot('popup.html', 'popup-expanded', { width: 360, height: 640, fit: true, before: async (p) => {
  await p.evaluate(() => {
    document.querySelectorAll('.section-toggle').forEach(btn => {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('open');
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (panel) panel.classList.add('open');
    });
  });
}});

// ── POPUP: active (hero countdown) ───────────────────────────────────────────
// The popup polls GET_STATUS every 1s and would overwrite an injected job, so
// nuke any timers first, then inject the active state and freeze it.
await shot('popup.html', 'popup-active', { width: 360, height: 640, fit: true, before: async (p) => {
  await p.evaluate(() => {
    let id = setTimeout(() => {}, 0);
    while (id--) { clearTimeout(id); clearInterval(id); }
    const total = 30000;
    const job = { settings: { interval: total, currentInterval: total }, refreshCount: 7, nextRefresh: Date.now() + 18000 };
    applyStatus({ jobs: { 999: job }, job });
  });
}});

// ── OPTIONS / SETTINGS: desktop ──────────────────────────────────────────────
await shot('options.html', 'options-desktop', { width: 820, height: 1100 });

// ── OPTIONS / SETTINGS: narrow (mobile / split-screen, 380px) ────────────────
await shot('options.html', 'options-narrow', { width: 380, height: 1100 });

// ── OPTIONS / SETTINGS: save feedback toast (after only; pre-fix had none) ────
{
  const p = await browser.newPage();
  await p.setViewport({ width: 820, height: 720, deviceScaleFactor: 2 });
  await p.goto(extUrl('options.html'), { waitUntil: 'networkidle0' });
  await sleep(700);
  // Toggle a top-of-page setting to fire the 350ms debounced save → toast.
  await p.evaluate(() => {
    const el = document.getElementById('defHardRefresh');
    if (el) { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(700); // past the debounce, while the toast is showing
  await p.screenshot({ path: path.join(OUT, 'options-toast.png'), fullPage: false });
  await p.close();
  log('shot options-toast');
}

// ── MANAGE: empty state (no active jobs) ─────────────────────────────────────
await shot('manage.html', 'manage-empty', { width: 980, height: 900 });

// ── MANAGE: narrow empty (360px) ─────────────────────────────────────────────
await shot('manage.html', 'manage-narrow', { width: 360, height: 1000 });

// ── MANAGE: active jobs + overlay on a live page ─────────────────────────────
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Live Auction — Vintage Camera Lot</title>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f8;color:#222">
      <h1>Page Under Auto Refresh</h1><p>The countdown overlay should appear in the corner.</p></body>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const TEST_URL = `http://127.0.0.1:${server.address().port}/`;

  const ext = await browser.newPage();
  await ext.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  const testPage = await browser.newPage();
  await testPage.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
  await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });

  const tabId = await ext.evaluate((url) => new Promise(res => {
    chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
  }), TEST_URL);

  await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({
    type: 'START_REFRESH', tabId,
    settings: { interval: 30000, currentInterval: 30000, showCountdown: true,
      hardRefresh: false, notify: false, sound: false, monitorMode: false,
      randomTimer: false, randomMin: 5000, randomMax: 60000, stopAfter: 0,
      keyword: '', stopOnKeyword: false, stopOnChange: false, stopOnClick: false, preserveScroll: false },
  }, r)), tabId);
  await sleep(1200);
  await testPage.screenshot({ path: path.join(OUT, 'overlay.png') });
  log('shot overlay');

  const mp = await browser.newPage();
  await mp.setViewport({ width: 980, height: 700, deviceScaleFactor: 2 });
  await mp.goto(extUrl('manage.html'), { waitUntil: 'networkidle0' });
  await sleep(900);
  await mp.screenshot({ path: path.join(OUT, 'manage-active.png'), fullPage: true });
  log('shot manage-active');
  await mp.close();

  await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);
  await testPage.close(); await ext.close();
  server.close();
}

await browser.close();
log('done →', OUT);
process.exit(0);
