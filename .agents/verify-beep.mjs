// Verification for the keyword-beep fix:
//   1. Worst-case offscreen race — after the offscreen document is freshly
//      (re)created, the first PLAY_BEEP must still be delivered (retry-until-ACK).
//   2. Demonstrate the race is real — a naive immediate send (no retry) hits
//      "receiving end does not exist" in the same window.
//   3. End-to-end — a real keyword absent->present transition fires exactly one
//      beep, and stays silent on later cycles while the keyword remains.
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

// ── Local server whose page gains the keyword once we flip `showKeyword`. ──
let showKeyword = false;
const PAGE_HTML = () => `<!doctype html><html><head><meta charset="utf-8"><title>Beep Test</title></head>
<body style="font-family:sans-serif;padding:40px">
<h1>Keyword beep test</h1>
<p id="content">${showKeyword ? 'Status: INSTOCK — ready to ship' : 'Status: out of stock'}</p>
</body></html>`;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE_HTML());
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TEST_URL = `http://127.0.0.1:${server.address().port}/`;
log('test server', TEST_URL);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-beep-'));
const browser = await puppeteer.launch({
  headless: process.env.HEADED ? false : 'new',
  executablePath: CHROME,
  userDataDir,
  args: [
    `--disable-extensions-except=${REPO}`,
    `--load-extension=${REPO}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const EXT_ID = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
log('extension id', EXT_ID);

// Wake the service worker by opening an extension page.
const warm = await browser.newPage();
await warm.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });
await sleep(400);
await warm.close();

// Grab the service-worker execution context.
async function getSW() {
  for (let i = 0; i < 40; i++) {
    const t = browser.targets().find(t => t.type() === 'service_worker' && t.url().includes(EXT_ID));
    if (t) { const w = await t.worker(); if (w) return w; }
    await sleep(150);
  }
  throw new Error('service worker target not found');
}
const sw = await getSW();
log('service worker attached');

const results = {};

// ════════════════════════════════════════════════════════════════════════
// 1. Worst-case ACK — close the offscreen doc, then beep. Must return true.
// ════════════════════════════════════════════════════════════════════════
{
  const oks = await sw.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      // Force the race: ensure no offscreen doc so playBeep must create one and
      // immediately message it.
      await chrome.offscreen.closeDocument().catch(() => {});
      out.push(await playBeep()); // returns true only if the offscreen ACKed
    }
    return out;
  });
  results.worstCaseAck = { perTrial: oks, allDelivered: oks.every(Boolean) };
  log('1. worst-case beep delivered (5 fresh-doc trials):', JSON.stringify(oks), '→ all =', results.worstCaseAck.allDelivered);
}

// ════════════════════════════════════════════════════════════════════════
// 2. Demonstrate the race: naive immediate send (no retry) right after create.
// ════════════════════════════════════════════════════════════════════════
{
  const trials = await sw.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      await chrome.offscreen.closeDocument().catch(() => {});
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'race demo'
      });
      // Old-style: fire once with no retry, capture whether it errored.
      const err = await new Promise(res => chrome.runtime.sendMessage(
        { type: 'PLAY_BEEP' }, () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : null)
      ));
      out.push(err);
    }
    return out;
  });
  const raced = trials.filter(Boolean).length;
  results.raceDemo = { perTrial: trials, hitRaceCount: raced };
  log(`2. naive immediate send hit the race in ${raced}/5 trials (proves the dropped-beep bug)`);
}

// ════════════════════════════════════════════════════════════════════════
// 3. End-to-end: real keyword absent->present fires exactly one beep.
// ════════════════════════════════════════════════════════════════════════
const testPage = await browser.newPage();
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
const ext = await browser.newPage();
await ext.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' });

const tabId = await ext.evaluate((url) => new Promise(res => {
  chrome.tabs.query({}, tabs => { const t = tabs.find(t => t.url && t.url.startsWith(url)); res(t ? t.id : null); });
}), TEST_URL);
log('3. test tabId', tabId);

// Instrument playBeep with a counter in the SW (function decl → reassignable).
await sw.evaluate(() => {
  self.__beeps = 0;
  const orig = playBeep;
  playBeep = async function () { self.__beeps++; return orig.apply(this, arguments); };
});

// Start a keyword job with sound on, 2s interval. Page currently has NO keyword,
// so this snapshot becomes the absent baseline.
await ext.evaluate((tabId) => new Promise(res => chrome.runtime.sendMessage({
  type: 'START_REFRESH', tabId,
  settings: {
    interval: 2000, hardRefresh: false, showCountdown: false, notify: false,
    sound: true, monitorMode: false, randomTimer: false, randomMin: 5000, randomMax: 60000,
    stopAfter: 0, keyword: 'INSTOCK', stopOnKeyword: false, stopOnChange: false,
    stopOnClick: false, currentInterval: 2000,
  },
}, res)), tabId);
log('3. job started (keyword=INSTOCK, sound on, 2s); baseline = absent');

await sleep(1500);
showKeyword = true; // page will now serve the keyword on its next reload
log('3. flipped page to contain the keyword');

// Wait for the absent->present transition to register a beep.
let beeps = 0;
for (let i = 0; i < 20; i++) {
  beeps = await sw.evaluate(() => self.__beeps);
  if (beeps >= 1) break;
  await sleep(1000);
}
const beepAfterAppear = beeps;
log('3. beeps after keyword appeared =', beepAfterAppear, '(want exactly 1)');

// Keep refreshing several more cycles with the keyword still present — must stay
// silent (edge-triggered: no repeat beeps while it remains).
await sleep(7000);
const beepsLater = await sw.evaluate(() => self.__beeps);
const offscreenAlive = await sw.evaluate(() => chrome.offscreen.hasDocument().catch(() => false));
log('3. beeps after several more cycles (keyword still present) =', beepsLater, '(want still 1)');

await ext.evaluate((tabId) => new Promise(res => chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, res)), tabId);
await testPage.screenshot({ path: path.join(OUT, 'BEEP-e2e-keyword.png') });

// ════════════════════════════════════════════════════════════════════════
// 4. Sound options — instrument the offscreen document via CDP and assert that
//    repeat→N Audio constructions and the requested volume/tone are honored.
// ════════════════════════════════════════════════════════════════════════
{
  // Ensure an offscreen document exists, then attach via CDP and hook Audio.
  await sw.evaluate(() => playBeep()); // create doc + warm listener
  await sleep(300);
  const offTarget = browser.targets().find(t => t.url().includes('offscreen.html'));
  let soundResult = { attached: false };
  if (offTarget) {
    const cdp = await offTarget.createCDPSession();
    await cdp.send('Runtime.enable');
    const evalIn = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return result.value;
    };
    // Hook Audio to record each construction's src + volume.
    await evalIn(`(() => {
      window.__plays = [];
      const Orig = window.Audio;
      window.Audio = function (src) { const a = new Orig(src); window.__plays.push({ src });
        const vd = Object.getOwnPropertyDescriptor(Orig.prototype, 'volume');
        Object.defineProperty(a, 'volume', { set(v){ window.__plays[window.__plays.length-1].volume = v; }, get(){ return 0; } });
        a.play = () => Promise.resolve(); return a; };
    })()`);
    await sw.evaluate(() => playBeep({ volume: 0.3, tone: 'chime', repeat: 3 }));
    await sleep(2500); // allow all spaced repeats to fire (chime spacing ~600ms × 3)
    const plays = await evalIn('JSON.stringify(window.__plays)');
    const parsed = JSON.parse(plays || '[]');
    soundResult = {
      attached: true,
      playCount: parsed.length,
      repeatHonored: parsed.length === 3,
      volumeHonored: parsed.every(p => Math.abs(p.volume - 0.3) < 1e-6),
    };
    await cdp.detach();
  }
  results.soundOptions = soundResult;
  log('4. sound options — plays =', soundResult.playCount, '| repeat=3 honored =', soundResult.repeatHonored, '| volume=0.3 honored =', soundResult.volumeHonored);
}

results.endToEnd = {
  beepOnAppearance: beepAfterAppear,
  firedExactlyOnce: beepAfterAppear === 1,
  beepsAfterMoreCycles: beepsLater,
  stayedSilentWhilePresent: beepsLater === beepAfterAppear,
  offscreenAlive,
};

results.PASS =
  results.worstCaseAck.allDelivered &&
  results.endToEnd.firedExactlyOnce &&
  results.endToEnd.stayedSilentWhilePresent &&
  results.soundOptions.repeatHonored &&
  results.soundOptions.volumeHonored;

fs.writeFileSync(path.join(OUT, 'beep-results.json'), JSON.stringify(results, null, 2));
console.log('\n=== BEEP VERIFY RESULTS ===');
console.log(JSON.stringify(results, null, 2));
console.log('\nOverall PASS =', results.PASS);

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
