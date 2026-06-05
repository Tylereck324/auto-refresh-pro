// Verification for scroll preservation (Phase 6):
//   • with preserveScroll on, scrollY survives an auto-refresh
//   • with it off, the page returns to top after refresh
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = '/Users/tylereck/Documents/auto-refresh-pro-repo';
const OUT  = path.join(REPO, '.agents', 'proof');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

// A tall page so there's somewhere to scroll.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  // Disable the browser's native scroll restoration so this isolates OUR feature
  // (it mimics the dynamic pages where a reload genuinely loses scroll position).
  res.end(`<!doctype html><meta charset="utf-8"><title>tall</title>
<script>history.scrollRestoration='manual';</script>
<body style="margin:0"><div style="height:5000px;background:linear-gradient(#fff,#333)">scroll me</div></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TEST_URL = `http://127.0.0.1:${server.address().port}/`;
log('test server', TEST_URL);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-scroll-'));
const browser = await puppeteer.launch({
  headless: process.env.HEADED ? false : 'new',
  executablePath: CHROME,
  userDataDir,
  args: [
    `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  ],
});

const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const EXT_ID = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const warm = await browser.newPage();
await warm.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });
await sleep(400); await warm.close();

const ext = await browser.newPage();
await ext.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });
const testPage = await browser.newPage();
await testPage.setViewport({ width: 900, height: 700 });
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });

const tabId = await ext.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
}), TEST_URL);

const baseSettings = (over) => ({
  interval: 3000, hardRefresh: false, showCountdown: false, notify: false, sound: false,
  monitorMode: false, randomTimer: false, randomMin: 5000, randomMax: 60000, stopAfter: 0,
  keyword: '', stopOnKeyword: false, stopOnChange: false, stopOnClick: false,
  preserveScroll: false, currentInterval: 3000, ...over,
});
const start = (s) => ext.evaluate((tabId, s) => new Promise(r => chrome.runtime.sendMessage({ type: 'START_REFRESH', tabId, settings: s }, r)), tabId, s);
const stop  = () => ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);

const results = {};

// ── preserveScroll ON: position survives the refresh ────────────────────────
await start(baseSettings({ preserveScroll: true }));
await sleep(500);
await testPage.evaluate(() => window.scrollTo(0, 1500));
const before = await testPage.evaluate(() => window.scrollY);
log('on: scrolled to', before, '— waiting for a refresh cycle');
await sleep(4500); // let one refresh fire
await sleep(600);  // allow restore (rAF + 400ms retry)
const afterOn = await testPage.evaluate(() => window.scrollY);
results.preservedWhenOn = Math.abs(afterOn - 1500) < 50;
log('on: scrollY after refresh =', afterOn, '(want ~1500)');
await stop(); await sleep(500);

// ── preserveScroll OFF: page returns to top ─────────────────────────────────
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
await start(baseSettings({ preserveScroll: false }));
await sleep(500);
await testPage.evaluate(() => window.scrollTo(0, 1500));
log('off: scrolled to 1500 — waiting for a refresh cycle');
await sleep(4500);
await sleep(600);
const afterOff = await testPage.evaluate(() => window.scrollY);
results.resetWhenOff = afterOff < 50;
log('off: scrollY after refresh =', afterOff, '(want ~0)');
await stop();

results.PASS = results.preservedWhenOn && results.resetWhenOff;
fs.writeFileSync(path.join(OUT, 'scroll-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== SCROLL VERIFY ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
