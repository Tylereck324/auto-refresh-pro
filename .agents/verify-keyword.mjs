// Verification for smarter keyword matching (Phase 2):
//   • inverse mode fires when the keyword DISAPPEARS (present->absent)
//   • regex mode fires on a pattern match (absent->present)
// Drives the loaded extension in Chrome-for-Testing and counts playBeep calls.
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

// Page content is controlled by `mode`: 'present' shows the word + digits,
// 'absent' shows neither.
let mode = 'present';
const BODY = () => mode === 'present'
  ? 'Status: INSTOCK — order 12345 ready'
  : 'Status: pending — nothing yet';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><title>kw</title><body><p>${BODY()}</p></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TEST_URL = `http://127.0.0.1:${server.address().port}/`;
log('test server', TEST_URL);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-kw-'));
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
await sw.evaluate(() => { self.__beeps = 0; const o = playBeep; playBeep = async function(){ self.__beeps++; return o.apply(this, arguments); }; });
log('service worker instrumented');

const ext = await browser.newPage();
await ext.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });
const testPage = await browser.newPage();

const baseSettings = (over) => ({
  interval: 2000, hardRefresh: false, showCountdown: false, notify: false,
  sound: true, monitorMode: false, randomTimer: false, randomMin: 5000, randomMax: 60000,
  stopAfter: 0, keyword: '', kwCaseSensitive: false, kwWholeWord: false, kwRegex: false,
  kwInverse: false, stopOnKeyword: false, stopOnChange: false, stopOnClick: false,
  soundVolume: 0.9, soundTone: 'beep', soundRepeat: 1, currentInterval: 2000, ...over,
});
const findTab = () => ext.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
}), TEST_URL);
const start = (tabId, s) => ext.evaluate((tabId, s) => new Promise(r => chrome.runtime.sendMessage({ type: 'START_REFRESH', tabId, settings: s }, r)), tabId, s);
const stop  = (tabId) => ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);
const beeps = () => sw.evaluate(() => self.__beeps);
const waitForBeep = async (target) => { for (let i = 0; i < 18; i++) { if (await beeps() >= target) return true; await sleep(1000); } return false; };

const results = {};

// ── Inverse mode: keyword present at start, then disappears → fires ──────────
{
  mode = 'present';
  await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
  const tabId = await findTab();
  await sw.evaluate(() => { self.__beeps = 0; });
  await start(tabId, baseSettings({ keyword: 'INSTOCK', kwInverse: true }));
  log('inverse: started (keyword present at baseline)');
  await sleep(1500);
  mode = 'absent'; // keyword will be gone after the next reload
  log('inverse: keyword removed from page');
  const fired = await waitForBeep(1);
  results.inverse = { fired, beeps: await beeps() };
  log('inverse: fired on disappearance =', fired, '| beeps =', results.inverse.beeps);
  await stop(tabId); await sleep(500);
}

// ── Regex mode: pattern \d{3,} appears → fires ──────────────────────────────
{
  mode = 'absent'; // no digits
  await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
  const tabId = await findTab();
  await sw.evaluate(() => { self.__beeps = 0; });
  await start(tabId, baseSettings({ keyword: '\\d{3,}', kwRegex: true }));
  log('regex: started (no digits at baseline)');
  await sleep(1500);
  mode = 'present'; // now contains "12345"
  log('regex: digits appeared');
  const fired = await waitForBeep(1);
  results.regex = { fired, beeps: await beeps() };
  log('regex: fired on pattern match =', fired, '| beeps =', results.regex.beeps);
  await stop(tabId); await sleep(500);
}

results.PASS = results.inverse.fired && results.regex.fired;
fs.writeFileSync(path.join(OUT, 'keyword-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== KEYWORD VERIFY ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
