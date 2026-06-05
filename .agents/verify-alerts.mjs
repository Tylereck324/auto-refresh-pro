// Verification for actionable alerts (Phase 4):
//   • repeat-until-ack beeps fire on an interval after a keyword alert
//   • clicking the notification (handleNotifClick) stops the loop, clears the
//     map entry, and activates the originating tab
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

let present = false;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><title>a</title><body><p>${present ? 'INSTOCK now' : 'pending'}</p></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TEST_URL = `http://127.0.0.1:${server.address().port}/`;
log('test server', TEST_URL);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-alerts-'));
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
const testPage = await browser.newPage();   // the tab that should get focused
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
const otherPage = await browser.newPage();  // a different tab, brought to front
await otherPage.goto('about:blank');
await otherPage.bringToFront();

const tabId = await ext.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
}), TEST_URL);
const beeps = () => sw.evaluate(() => self.__beeps);

// Keyword job with repeat-until-ack, fast ack interval, baseline absent.
await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({
  type: 'START_REFRESH', tabId,
  settings: {
    interval: 2000, hardRefresh: false, showCountdown: false, notify: false, sound: true,
    monitorMode: false, randomTimer: false, randomMin: 5000, randomMax: 60000, stopAfter: 0,
    keyword: 'INSTOCK', kwCaseSensitive: false, kwWholeWord: false, kwRegex: false, kwInverse: false,
    stopOnKeyword: false, stopOnChange: false, stopOnClick: false,
    soundVolume: 0.9, soundTone: 'beep', soundRepeat: 1,
    beepUntilAck: true, beepAckIntervalSec: 2, beepRepeatMax: 3, currentInterval: 2000,
  },
}, r)), tabId);
log('started: keyword job with beepUntilAck (interval 2s, max 3)');

await sleep(1500);
present = true; // keyword appears on next reload

// Wait for the first alert beep.
for (let i = 0; i < 18; i++) { if (await beeps() >= 1) break; await sleep(1000); }
const firstBeep = await beeps();
log('beeps at first alert =', firstBeep);

// Let the ack loop add repeats.
await sleep(5000);
const afterRepeats = await beeps();
log('beeps after ~5s of ack repeats =', afterRepeats, '(want > first)');

// Grab the notification id and "click" it.
const notifId = await sw.evaluate(() => Object.keys(notifTabMap)[0] || null);
await sw.evaluate((id) => handleNotifClick(id), notifId);
log('clicked notification', notifId);
await sleep(500);
const activeAfterClick = await sw.evaluate((tabId) => new Promise(res => {
  chrome.tabs.get(tabId, t => res(!!(t && t.active)));
}), tabId);
const mapClearedAfterClick = await sw.evaluate((id) => !(id in notifTabMap), notifId);

// After acknowledgement the loop must be silent.
const beepsAtAck = await beeps();
await sleep(5000);
const beepsAfterAck = await beeps();
log('beeps after acknowledgement settle =', beepsAfterAck, '(want == at-ack)');

await ext.evaluate((tabId) => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, r)), tabId);

const results = {
  alerted: firstBeep >= 1,
  repeatedUntilAck: afterRepeats > firstBeep,
  boundedByMax: afterRepeats <= firstBeep + 3,
  tabFocusedOnClick: activeAfterClick,
  mapClearedOnClick: mapClearedAfterClick,
  silentAfterAck: beepsAfterAck === beepsAtAck,
};
results.PASS = Object.values(results).every(Boolean);
fs.writeFileSync(path.join(OUT, 'alerts-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== ALERTS VERIFY ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
