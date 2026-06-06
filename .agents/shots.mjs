// Screenshot harness for the UI/UX pass. Loads the unpacked extension in
// Chrome for Testing and snapshots each surface. Output label comes from argv:
//   node .agents/shots.mjs after        → .agents/proof/shots-after/*.png
//   HEADED=1 node .agents/shots.mjs ...  → headed
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = '/Users/tylereck/Documents/auto-refresh-pro-repo';
const LABEL = process.argv[2] || 'shots';
const OUT = path.join(REPO, '.agents', 'proof', `shots-${LABEL}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-shots-'));
const browser = await puppeteer.launch({
  headless: process.env.HEADED ? false : 'new',
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
log('extension id', EXT_ID);

// Wake the service worker / confirm load.
const warm = await browser.newPage();
await warm.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(400);
const loaded = await warm.evaluate(() => !!(globalThis.chrome?.runtime?.id)).catch(() => false);
if (!loaded) { for (const t of browser.targets()) console.log(t.type(), t.url()); throw new Error('extension not loaded'); }
await warm.close();
log('extension confirmed loaded');

async function shot(file, name, { width = 1100, height = 900, full = true, wait = 600 } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height });
  await p.goto(extUrl(file), { waitUntil: 'networkidle0' });
  await sleep(wait);
  await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  await p.close();
  log('shot', name);
}

// Popup — idle (narrow viewport like the real toolbar popup)
await shot('popup.html', 'popup-idle', { width: 360, height: 640, full: true });

// Popup — expanded: open Options + Keyword, type a keyword to trigger the
// change-detection lock note, and enable sound to reveal the sound row.
{
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 640 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(500);
  await p.evaluate(() => {
    // Resilient so this same harness can also run against older popup markup
    // (for before/after captures) where these elements don't exist.
    const click = (id) => { const el = document.getElementById(id); if (el) el.click(); };
    click('toggleOptions'); click('toggleKeyword'); click('advancedToggle');
    const kw = document.getElementById('optKeyword');
    if (kw) { kw.value = 'in stock'; kw.dispatchEvent(new Event('input', { bubbles: true })); }
    const snd = document.getElementById('optSound');
    if (snd) { snd.checked = true; snd.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, 'popup-expanded.png'), fullPage: true });
  await p.close();
  log('shot popup-expanded');
}
// Settings + Manage (full-page surfaces)
await shot('options.html', 'options', { width: 760, height: 1000 });
await shot('manage.html', 'manage', { width: 980, height: 900 });

// Overlay — start a refresh on a live page and snapshot the injected overlay.
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Test Page</title>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f8;color:#222">
      <h1>Test Page Under Auto Refresh</h1>
      <p>The Auto Refresh Pro overlay should appear in a corner.</p></body>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const TEST_URL = `http://127.0.0.1:${server.address().port}/`;

  const ext = await browser.newPage();
  await ext.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  const testPage = await browser.newPage();
  await testPage.setViewport({ width: 900, height: 640 });
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
  await sleep(900);
  await testPage.screenshot({ path: path.join(OUT, 'overlay.png') });
  log('shot overlay');
  await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);
  await testPage.close(); await ext.close();
  server.close();
}

await browser.close();
log('done →', OUT);
process.exit(0);
