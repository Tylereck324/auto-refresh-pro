// Edge-case screenshot harness for the design critique. Loads the unpacked
// extension and drives each surface into the states the normal shots.mjs never
// reaches: running countdown, keyword lock, regex/validation errors, populated
// Manage with overflow + extreme content, hotkey recording, resized overlays,
// forced-colors, and 200% zoom.
//   node .agents/critique-shots.mjs before
//   node .agents/critique-shots.mjs after
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = process.env.REPO || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LABEL = process.argv[2] || 'edge';
const OUT = path.join(REPO, '.agents', 'proof', `edge-${LABEL}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-edge-'));
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
log('extension id', EXT_ID);

const warm = await browser.newPage();
await warm.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(400);
await warm.close();

// Faithful Manage tab-card markup (mirrors manage.js innerHTML).
function jobCard(title, url, interval, refreshes) {
  return `<div class="tab-card active">
    <img class="tab-favicon" src="icons/icon16.png">
    <div class="tab-info">
      <div class="tab-title">${title}</div>
      <div class="tab-url">${url}</div>
    </div>
    <div class="tab-stats">
      <span class="stat-pill active-badge">ACTIVE</span>
      <span class="stat-pill">Every ${interval}s</span>
      <span class="stat-pill">${refreshes} refreshes</span>
    </div>
    <div class="tab-actions">
      <button class="btn-sm btn-sm-go">Go to Tab</button>
      <button class="btn-sm btn-sm-stop">Stop</button>
    </div>
  </div>`;
}

async function shot(name, file, opts = {}) {
  const { width = 360, height = 640, full = true, wait = 500, setup, forcedColors, scale = 1 } = opts;
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: scale });
  // Clear extension storage first so a state-driven scenario (e.g. typing a
  // regex, which popup.js persists) doesn't bleed into the next render.
  await p.goto(extUrl(file), { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => new Promise(r => chrome.storage.local.clear(r))).catch(() => {});
  await p.goto(extUrl(file), { waitUntil: 'networkidle0' });
  if (forcedColors) {
    // emulateMediaFeatures() rejects forced-colors in this puppeteer build, so
    // drive it through the raw CDP command — applied AFTER navigation so the
    // storage-clear reload above can't reset the emulation.
    const client = await p.target().createCDPSession();
    await client.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'forced-colors', value: 'active' },
        { name: 'prefers-color-scheme', value: 'light' },
      ],
    });
  }
  await sleep(wait);
  if (setup) await p.evaluate(setup);
  await sleep(350);
  await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  await p.close();
  log('shot', name);
}

const ONLY = process.env.ONLY || '';
if (ONLY !== 'overlay') {

// ── POPUP: active / running (hero countdown visible) ──
await shot('popup-active', 'popup.html', { setup: () => {
  document.getElementById('hero').className = 'hero visible';
  document.getElementById('statusDot').className = 'status-dot active';
  const lbl = document.getElementById('statusLabel'); lbl.className = 'status-label active'; lbl.textContent = 'ACTIVE';
  document.getElementById('countdownDisplay').textContent = '0:27';
  document.getElementById('progressFill').style.width = '64%';
  document.getElementById('statRefreshes').textContent = '12';
  document.getElementById('statActive').textContent = '3';
  document.getElementById('btnStart').classList.add('hidden');
  const stop = document.getElementById('btnStop'); stop.classList.remove('hidden'); stop.disabled = false;
  document.querySelector('.pill[data-ms="30000"]')?.classList.add('active');
}});

// ── POPUP: huge numbers in the hero stats ──
await shot('popup-active-bignum', 'popup.html', { setup: () => {
  document.getElementById('hero').className = 'hero visible';
  document.getElementById('statusDot').className = 'status-dot active';
  const lbl = document.getElementById('statusLabel'); lbl.className = 'status-label active'; lbl.textContent = 'ACTIVE';
  document.getElementById('countdownDisplay').textContent = '1666:39';
  document.getElementById('progressFill').style.width = '88%';
  document.getElementById('statRefreshes').textContent = '1284091';
  document.getElementById('statActive').textContent = '147';
  document.getElementById('btnStart').classList.add('hidden');
  const stop = document.getElementById('btnStop'); stop.classList.remove('hidden'); stop.disabled = false;
}});

// ── POPUP: keyword set → change-detection locked + lock note, both panels open ──
await shot('popup-keyword-locked', 'popup.html', { setup: () => {
  document.getElementById('toggleKeyword').click();
  document.getElementById('toggleChange').click();
  const kw = document.getElementById('optKeyword');
  kw.value = 'in stock, available now, add to cart';
  kw.dispatchEvent(new Event('input', { bubbles: true }));
}});

// ── POPUP: invalid regex flagged ──
await shot('popup-regex-error', 'popup.html', { setup: () => {
  document.getElementById('toggleKeyword').click();
  document.getElementById('optKwRegex').checked = true;
  document.getElementById('optKwRegex').dispatchEvent(new Event('change', { bubbles: true }));
  const kw = document.getElementById('optKeyword');
  kw.value = '(a+)+$';
  kw.dispatchEvent(new Event('input', { bubbles: true }));
}});

// ── POPUP: custom interval below the 2s floor → invalid + hint ──
await shot('popup-custom-invalid', 'popup.html', { setup: () => {
  const v = document.getElementById('customValue');
  v.value = '1';
  v.dispatchEvent(new Event('input', { bubbles: true }));
}});

// ── POPUP: long keyword string (overflow stress in the keyword field) ──
await shot('popup-longkeyword', 'popup.html', { setup: () => {
  document.getElementById('toggleKeyword').click();
  const kw = document.getElementById('optKeyword');
  kw.value = 'supercalifragilisticexpialidocious-out-of-stock-notification-keyword-string';
  kw.dispatchEvent(new Event('input', { bubbles: true }));
}});

// ── POPUP: 200% browser zoom (fixed 360px popup) ──
await shot('popup-zoom200', 'popup.html', { setup: () => {
  document.documentElement.style.zoom = '2';
}});

// ── POPUP: focus ring on a preset pill (keyboard nav) ──
await shot('popup-focus', 'popup.html', { setup: () => {
  const pill = document.querySelector('.pill');
  if (pill) pill.focus();
}});

// ── POPUP: forced-colors (Windows High Contrast emulation) ──
await shot('popup-forced-colors', 'popup.html', { forcedColors: true });

// ── MANAGE: a single active job ──
await shot('manage-one', 'manage.html', { width: 980, height: 700, setup: () => {
  if (window.loadJobs) window.loadJobs = () => {};
  document.getElementById('stopAllBtn').disabled = false;
  document.getElementById('tabList').innerHTML = `<div class="tab-card active">
    <img class="tab-favicon" src="icons/icon16.png">
    <div class="tab-info"><div class="tab-title">Concert Tickets — On Sale Now</div>
    <div class="tab-url">https://tickets.example.com/event/12345</div></div>
    <div class="tab-stats"><span class="stat-pill active-badge">ACTIVE</span>
    <span class="stat-pill">Every 5s</span><span class="stat-pill">42 refreshes</span></div>
    <div class="tab-actions"><button class="btn-sm btn-sm-go">Go to Tab</button>
    <button class="btn-sm btn-sm-stop">Stop</button></div></div>`;
}});

// ── MANAGE: many jobs (overflow / scale) ──
await shot('manage-many', 'manage.html', { width: 980, height: 1000, setup: () => {
  if (window.loadJobs) window.loadJobs = () => {};
  document.getElementById('stopAllBtn').disabled = false;
  const titles = ['Inventory Dashboard','Live Scores — NBA','Order Status #88213','Stock Watch: AAPL','Auction: Vintage Camera','Flight AA particle','News Feed','Build #4471 — CI','Queue Position','Ticket Drop'];
  let html = '';
  for (let i = 0; i < 24; i++) {
    const t = titles[i % titles.length];
    html += `<div class="tab-card active">
      <img class="tab-favicon" src="icons/icon16.png">
      <div class="tab-info"><div class="tab-title">${t}</div>
      <div class="tab-url">https://site${i}.example.com/path/to/resource?id=${i}00</div></div>
      <div class="tab-stats"><span class="stat-pill active-badge">ACTIVE</span>
      <span class="stat-pill">Every ${(i%9)+2}s</span><span class="stat-pill">${i*13} refreshes</span></div>
      <div class="tab-actions"><button class="btn-sm btn-sm-go">Go to Tab</button>
      <button class="btn-sm btn-sm-stop">Stop</button></div></div>`;
  }
  document.getElementById('tabList').innerHTML = html;
}});

// ── MANAGE: extreme content — very long title + long URL, populated lists ──
await shot('manage-longcontent', 'manage.html', { width: 980, height: 800, setup: () => {
  if (window.loadJobs) window.loadJobs = () => {};
  document.getElementById('stopAllBtn').disabled = false;
  document.getElementById('tabList').innerHTML = `<div class="tab-card active">
    <img class="tab-favicon" src="icons/icon16.png">
    <div class="tab-info">
    <div class="tab-title">Совершенно невероятно длинное название вкладки которое просто продолжается и продолжается без конца ابدا</div>
    <div class="tab-url">https://very-long-subdomain.example-website-with-a-really-long-name.com/some/deeply/nested/path/segment/that/keeps/going?query=parameter&another=value&third=thing#fragment-identifier</div></div>
    <div class="tab-stats"><span class="stat-pill active-badge">ACTIVE</span>
    <span class="stat-pill">Every 3600s</span><span class="stat-pill">999999 refreshes</span></div>
    <div class="tab-actions"><button class="btn-sm btn-sm-go">Go to Tab</button>
    <button class="btn-sm btn-sm-stop">Stop</button></div></div>`;
  // Populate auto-start + rules lists too.
  document.getElementById('autoStartList').innerHTML =
    `<div class="autostart-item"><span class="autostart-url">https://this-is-a-really-long-auto-start-url.example.com/with/a/very/long/path/that/overflows</span>
     <span style="color:var(--text2);font-size:11px;">5s</span>
     <button class="autostart-remove" title="Remove">✕</button></div>`;
  document.getElementById('ruleList').innerHTML =
    `<div class="autostart-item"><span class="autostart-url">*://*.example.com/*</span>
     <span style="color:var(--text2);font-size:11px;">30s</span>
     <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text2);"><input type="checkbox" checked> on</label>
     <button class="autostart-remove" title="Remove">✕</button></div>`;
}});

// ── MANAGE: 320px mobile ──
await shot('manage-320', 'manage.html', { width: 320, height: 900, setup: () => {
  if (window.loadJobs) window.loadJobs = () => {};
  document.getElementById('stopAllBtn').disabled = false;
  document.getElementById('tabList').innerHTML = `<div class="tab-card active">
    <img class="tab-favicon" src="icons/icon16.png">
    <div class="tab-info"><div class="tab-title">Order Status #88213</div>
    <div class="tab-url">https://shop.example.com/orders/88213</div></div>
    <div class="tab-stats"><span class="stat-pill active-badge">ACTIVE</span>
    <span class="stat-pill">Every 10s</span><span class="stat-pill">88 refreshes</span></div>
    <div class="tab-actions"><button class="btn-sm btn-sm-go">Go to Tab</button>
    <button class="btn-sm btn-sm-stop">Stop</button></div></div>`;
}});

// ── OPTIONS: hotkey recording state with recorded combo ──
await shot('options-recording', 'options.html', { width: 760, height: 520, full: false, setup: () => {
  const disp = document.getElementById('hotkeyDisplay');
  disp.className = 'hotkey-display recording';
  disp.innerHTML = '<span class="key-badge">Ctrl</span><span class="key-badge">Shift</span><span class="key-badge">R</span>';
  document.getElementById('recordingHint').style.display = 'block';
  const btn = document.getElementById('recordBtn'); btn.className = 'btn-record recording'; btn.textContent = '⏺ Recording…';
}});

// ── OPTIONS: 320px mobile ──
await shot('options-320', 'options.html', { width: 320, height: 1400 });

} // end ONLY !== 'overlay'

// ── OVERLAY: drive the REAL content.js overlay, then resize it ──
// Faithful proof — exercises the actual injected overlay (its real opacities and
// the scaleOverlay() small-size hide logic), not a hand-built replica.
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Test Page</title>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f8;color:#222">
      <h1>Test Page Under Auto Refresh</h1></body>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const TEST_URL = `http://127.0.0.1:${server.address().port}/`;

  const ext = await browser.newPage();
  await ext.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  const testPage = await browser.newPage();
  await testPage.setViewport({ width: 900, height: 620 });
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

  // Move the overlay somewhere with room to grow, then resize it to a target
  // size by dragging the real resize handle — scaleOverlay() runs for real.
  async function setOverlay(name, targetW, targetH, originX, originY) {
    await testPage.evaluate(({ x, y }) => {
      const el = document.getElementById('__ar_overlay');
      if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
    }, { x: originX, y: originY });
    await sleep(120);
    const rect = await testPage.evaluate(() => {
      const el = document.getElementById('__ar_overlay');
      const r = el.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });
    const hx = rect.right - 6, hy = rect.bottom - 6;            // resize handle
    await testPage.mouse.move(hx, hy);
    await testPage.mouse.down();
    await testPage.mouse.move(hx + (targetW - (rect.right - originX)),
                              hy + (targetH - (rect.bottom - originY)), { steps: 8 });
    await testPage.mouse.up();
    await sleep(250);
    await testPage.screenshot({ path: path.join(OUT, name + '.png') });
    log('shot', name);
  }

  // Default size (~240px) — proves the contrast bump at the as-shipped size.
  // Move it fully into view first (default corner sits at the viewport edge).
  await testPage.evaluate(() => {
    const el = document.getElementById('__ar_overlay');
    if (el) { el.style.left = '320px'; el.style.top = '170px'; }
  });
  await sleep(150);
  await testPage.screenshot({ path: path.join(OUT, 'overlay-default.png') });
  log('shot overlay-default');
  // Origins chosen so the pre-resize ~240px overlay sits fully on-screen, so the
  // resize handle is reachable before we drag it to the target size.
  await setOverlay('overlay-large', 480, 320, 80, 120);
  await setOverlay('overlay-small', 140, 80, 320, 300);

  await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);
  await testPage.close(); await ext.close();
  server.close();
}

await browser.close();
log('done →', OUT);
process.exit(0);
