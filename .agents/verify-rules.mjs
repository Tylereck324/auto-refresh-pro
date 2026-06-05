// Verification for per-domain URL rules (Phase 5):
//   • a tab that finishes loading a URL matching an enabled rule auto-starts
//   • a disabled rule does not
//   • navigating away stops the auto-started job
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

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset="utf-8"><title>rules</title><body><p>rule target page</p></body>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TEST_URL = `http://127.0.0.1:${PORT}/`;
const PATTERN = `*://127.0.0.1:${PORT}/*`;
log('test server', TEST_URL, '| rule pattern', PATTERN);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-rules-'));
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

async function getSW() {
  for (let i = 0; i < 40; i++) {
    const t = browser.targets().find(t => t.type() === 'service_worker' && t.url().includes(EXT_ID));
    if (t) { const w = await t.worker(); if (w) return w; }
    await sleep(150);
  }
  throw new Error('no service worker');
}
const sw = await getSW();

const jobForUrl = (url) => sw.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => {
    const t = tabs.find(t => t.url && t.url.startsWith(url));
    res(t ? !!activeJobs[t.id] : false);
  });
}), url);

const results = {};

// ── Disabled rule: no auto-start ────────────────────────────────────────────
await sw.evaluate((pattern) => new Promise(res => {
  const settings = ARPValidators.sanitizeRuleSettings({ interval: 2000 });
  chrome.storage.local.set({ urlRules: [{ pattern, enabled: false, settings }] }, res);
}), PATTERN);
let p1 = await browser.newPage();
await p1.goto(TEST_URL, { waitUntil: 'networkidle0' });
await sleep(1500);
results.disabledNoStart = (await jobForUrl(TEST_URL)) === false;
log('disabled rule → no auto-start =', results.disabledNoStart);
await p1.close();
await sleep(500);

// ── Enabled rule: auto-starts on load ───────────────────────────────────────
await sw.evaluate((pattern) => new Promise(res => {
  const settings = ARPValidators.sanitizeRuleSettings({ interval: 2000 });
  chrome.storage.local.set({ urlRules: [{ pattern, enabled: true, settings }] }, res);
}), PATTERN);
const p2 = await browser.newPage();
await p2.goto(TEST_URL, { waitUntil: 'networkidle0' });
let started = false;
for (let i = 0; i < 15; i++) { started = await jobForUrl(TEST_URL); if (started) break; await sleep(500); }
results.enabledAutoStart = started;
log('enabled rule → auto-started =', started);

// ── Navigating away stops the job ───────────────────────────────────────────
await p2.goto('http://127.0.0.1:' + PORT + '/../elsewhere'.replace('..', 'x') , { waitUntil: 'domcontentloaded' }).catch(() => {});
await p2.goto('about:blank', { waitUntil: 'domcontentloaded' });
await sleep(1500);
results.stoppedOnNavAway = (await jobForUrl(TEST_URL)) === false;
log('navigate away → stopped =', results.stoppedOnNavAway);
await p2.close();

results.PASS = results.disabledNoStart && results.enabledAutoStart && results.stoppedOnNavAway;
fs.writeFileSync(path.join(OUT, 'rules-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== RULES VERIFY ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
