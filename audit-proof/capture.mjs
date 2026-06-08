// Audit proof capture harness.
// Loads the unpacked extension in Chrome for Testing, renders the passing
// test/lint runs to PNG, captures the working UI, and demonstrates the
// empty-presets fix (LOW-2). Output → ./audit-proof/*.png
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(REPO, 'audit-proof');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-audit-'));

// ── Run the real test + lint, capture combined output ───────────────────────
function run(cmd) {
  try { return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || '') + '\n[exit ' + e.status + ']'; }
}
const testOut = run('node --test "test/*.test.js"');
const lintOut = run('node scripts/lint.mjs');
const testPass = /\n\D*pass (\d+)/.exec(testOut);
const testFail = /\n\D*fail (\d+)/.exec(testOut);
log('tests:', testPass && testPass[1], 'pass /', testFail && testFail[1], 'fail');

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
log('extension loaded', EXT_ID);
await warm.close();

// ── Render a block of terminal text to a PNG ────────────────────────────────
async function renderText(title, text, file, accent) {
  const p = await browser.newPage();
  await p.setViewport({ width: 980, height: 700, deviceScaleFactor: 2 });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await p.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0a0c10;font-family:ui-monospace,Menlo,monospace">
    <div style="padding:14px 20px;border-bottom:1px solid #222;color:${accent};font-weight:700;font-size:15px">${esc(title)}</div>
    <pre style="margin:0;padding:16px 20px;color:#d6dae0;font-size:11.5px;line-height:1.45;white-space:pre-wrap">${esc(text)}</pre>
  </body>`, { waitUntil: 'domcontentloaded' });
  await sleep(200);
  await p.screenshot({ path: path.join(OUT, file), fullPage: true });
  await p.close();
  log('shot', file);
}
// Keep the tail (the summary lines) — that's the proof that matters.
const tail = (s, n) => s.split('\n').slice(-n).join('\n');
await renderText('node --test "test/*.test.js"  — full audit suite', tail(testOut, 48), 'tests-passing.png', '#34d399');
await renderText('node scripts/lint.mjs', lintOut, 'lint-passing.png', '#4f9eff');

// ── UI: popup idle ──────────────────────────────────────────────────────────
async function shot(file, name, { width = 1100, height = 900, full = true, wait = 700 } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: 2 });
  await p.goto(extUrl(file), { waitUntil: 'networkidle0' });
  await sleep(wait);
  await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  await p.close();
  log('shot', name);
}
await shot('popup.html', 'after-ui-popup-idle', { width: 360, height: 640 });
await shot('options.html', 'after-ui-options', { width: 760, height: 1100 });
await shot('manage.html', 'after-ui-manage', { width: 980, height: 900 });

// ── popup ACTIVE state (drive the popup's own status handler) ────────────────
{
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(400);
  await p.evaluate(() => {
    const total = 30000;
    const job = { settings: { interval: total, currentInterval: total }, refreshCount: 7, nextRefresh: Date.now() + 18000 };
    // applyStatus is a top-level function in popup.js → global.
    applyStatus({ jobs: { 999: job }, job });
  });
  await sleep(500);
  await p.screenshot({ path: path.join(OUT, 'after-ui-popup-active.png'), fullPage: true });
  await p.close();
  log('shot after-ui-popup-active');
}

// ── LOW-2 fix proof: empty presets must NOT blank the editor ─────────────────
{
  const p = await browser.newPage();
  await p.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 });
  // Seed storage with the exact poisoned shape (presets: []) that used to wedge
  // the editor empty, then load the Settings page.
  await p.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({ globalSettings: { presets: [] } }, r)));
  await p.goto(extUrl('options.html'), { waitUntil: 'networkidle0' });
  await sleep(700);
  const rows = await p.evaluate(() => document.querySelectorAll('#presetsList .preset-item').length);
  log('empty-presets → rendered preset rows:', rows);
  // Scroll the preset section into view for the shot.
  await p.evaluate(() => { const el = document.getElementById('presetsList'); if (el) el.scrollIntoView({ block: 'center' }); });
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, 'after-fix-empty-presets.png'), fullPage: true });
  await p.close();
  // Clear the seed so it doesn't bleed into other captures.
  const c = await browser.newPage();
  await c.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  await c.evaluate(() => new Promise(r => chrome.storage.local.remove('globalSettings', r)));
  await c.close();
  if (rows < 1) throw new Error('empty-presets fix FAILED: editor rendered 0 rows');
}

// ── overlay on a live page (proves the background actually runs a job) ───────
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Test Page</title>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f8;color:#222">
      <h1>Page Under Auto Refresh</h1><p>The overlay should appear in the corner.</p></body>`);
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
  await sleep(1100);
  await testPage.screenshot({ path: path.join(OUT, 'after-ui-overlay.png') });
  log('shot after-ui-overlay');

  // Manage page now shows the live job — proof the job store works end to end.
  const mp = await browser.newPage();
  await mp.setViewport({ width: 980, height: 700, deviceScaleFactor: 2 });
  await mp.goto(extUrl('manage.html'), { waitUntil: 'networkidle0' });
  await sleep(900);
  await mp.screenshot({ path: path.join(OUT, 'after-ui-manage-active.png'), fullPage: true });
  log('shot after-ui-manage-active');
  await mp.close();

  await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);
  await testPage.close(); await ext.close();
  server.close();
}

await browser.close();
log('done →', OUT);
process.exit(0);
