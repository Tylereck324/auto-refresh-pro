// Verification for monitor noise-tolerance (Phase 3):
//   • a page whose only change each reload is a ticking number does NOT alert
//   • a genuine text change DOES alert
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

// In 'tick' mode the page changes ONLY by an incrementing number each request
// (a stand-in for a clock/counter). In 'changed' mode the words differ.
let mode = 'tick';
let counter = 0;
const server = http.createServer((_req, res) => {
  counter++;
  const body = mode === 'tick'
    ? `Live counter: ${counter} — status stable`
    : 'Status CHANGED — brand new content here';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><title>n</title><body><p>${body}</p></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TEST_URL = `http://127.0.0.1:${server.address().port}/`;
log('test server', TEST_URL);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-noise-'));
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

const ext = await browser.newPage();
await ext.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });
const testPage = await browser.newPage();
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });

const tabId = await ext.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
}), TEST_URL);

const beeps = () => sw.evaluate(() => self.__beeps);

// Monitor mode + noise tolerance, no keyword.
await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({
  type: 'START_REFRESH', tabId,
  settings: {
    interval: 2000, hardRefresh: false, showCountdown: false, notify: false, sound: true,
    monitorMode: true, noiseTolerant: true, collapseDigits: true, minChangedFraction: 0,
    randomTimer: false, randomMin: 5000, randomMax: 60000, stopAfter: 0, keyword: '',
    stopOnKeyword: false, stopOnChange: false, stopOnClick: false,
    soundVolume: 0.9, soundTone: 'beep', soundRepeat: 1, currentInterval: 2000,
  },
}, r)), tabId);
log('started: monitor + ignore-noise, page only ticks a counter');

// Let several cycles run while only the counter changes — should stay silent.
await sleep(9000);
const beepsDuringTick = await beeps();
log('beeps during counter-only churn =', beepsDuringTick, '(want 0)');

// Now make a real word change.
mode = 'changed';
log('flipped to a genuine text change');
let beepsAfterChange = beepsDuringTick;
for (let i = 0; i < 12; i++) {
  beepsAfterChange = await beeps();
  if (beepsAfterChange > beepsDuringTick) break;
  await sleep(1000);
}
log('beeps after real change =', beepsAfterChange, '(want > 0)');

await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);

const results = {
  silentDuringTick: beepsDuringTick === 0,
  alertedOnRealChange: beepsAfterChange > beepsDuringTick,
};
results.PASS = results.silentDuringTick && results.alertedOnRealChange;
fs.writeFileSync(path.join(OUT, 'noise-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== NOISE VERIFY ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
