// Real-browser proof for the first-reload keyword detection lifecycle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(REPO, 'artifacts', 'keyword-first-reload');
const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(OUT, { recursive: true });

let rootRequestTimes = [];
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    rootRequestTimes.push(Date.now());
  }
  const isReloadDocument = rootRequestTimes.length >= 2;
  const body = isReloadDocument
    ? `<h1>Study feed</h1><p id="study-status">Loading studies…</p>
       <script>
         setTimeout(() => {
           const status = document.getElementById('study-status');
           if (status) status.outerHTML = '<p>AI Videos - Evaluation</p><p>By Vortex Oasis</p>';
         }, 600);
       </script>`
    : '<h1>Study feed</h1><p>No matching study yet</p><p>Baseline before start</p>';
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>Study feed</title><body style="font-family:system-ui,sans-serif;padding:56px;background:#f4f7fb;color:#17243a">${body}</body>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const testUrl = `http://127.0.0.1:${server.address().port}/`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-keyword-first-reload-'));
const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const extensionId = [...hash].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
const extUrl = (file) => `chrome-extension://${extensionId}/${file}`;

let browser;
try {
  browser = await puppeteer.launch({
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

  const warm = await browser.newPage();
  await warm.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  await sleep(500);
  if (!await warm.evaluate(() => !!globalThis.chrome?.runtime?.id)) {
    throw new Error('extension did not load');
  }
  await warm.close();

  const controller = await browser.newPage();
  await controller.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
  await page.goto(testUrl, { waitUntil: 'networkidle0' });

  const tabId = await controller.evaluate((url) => new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve((tabs.find((tab) => tab.url?.startsWith(url)) || {}).id || null);
    });
  }), testUrl);
  if (!Number.isInteger(tabId)) throw new Error('target tab not found');

  await page.screenshot({ path: path.join(OUT, 'before-start.png'), fullPage: true });
  const sendFromTarget = (message) => controller.evaluate((payload) => chrome.scripting.executeScript({
    target: { tabId: payload.tabId },
    world: 'ISOLATED',
    func: async (request) => chrome.runtime.sendMessage(request),
    args: [payload.message],
  }).then((results) => results[0]?.result ?? null), { tabId, message });
  const getStatus = () => sendFromTarget({ type: 'GET_STATUS', tabId });

  const startMs = Date.now();
  const startResponse = await sendFromTarget({
    type: 'START_REFRESH',
    tabId,
    settings: {
      interval: 5000,
      currentInterval: 5000,
      showCountdown: false,
      hardRefresh: false,
      notify: true,
      sound: true,
      monitorMode: false,
      randomTimer: false,
      stopAfter: 0,
      keyword: '- Evaluation',
      kwCaseSensitive: false,
      kwWholeWord: false,
      kwRegex: false,
      kwInverse: false,
      kwPerItem: false,
      flashOnKeyword: true,
      stopOnKeyword: false,
    },
  });
  if (!startResponse?.started) throw new Error(`start failed: ${JSON.stringify(startResponse)}`);

  let detectedAt = null;
  let status = null;
  for (let i = 0; i < 100; i += 1) {
    status = await getStatus();
    if (status?.job?.keywordCount === 1) {
      detectedAt = Date.now();
      break;
    }
    await sleep(100);
  }
  if (!detectedAt) throw new Error(`keyword was not detected: ${JSON.stringify(status)}`);
  const requestsBeforeDetection = rootRequestTimes.filter((time) => time <= detectedAt).length;
  if (requestsBeforeDetection !== 2 || status.job.refreshCount !== 1 || status.job.keywordCount !== 1) {
    throw new Error(`first-reload proof failed: ${JSON.stringify({ requestsBeforeDetection, job: status.job })}`);
  }
  // Exercise the same explicit offscreen target used by background.js. This
  // catches a broadcast race where the worker's generic message handler could
  // acknowledge PLAY_BEEP before the audio document received it.
  const audioProof = await controller.evaluate(async () => {
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      : [];
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_BEEP', tone: 'beep', volume: 0.9, repeat: 1 }, (value) => {
        resolve({ value, error: chrome.runtime.lastError?.message || null });
      });
    });
    return { offscreenContexts: contexts.length, response };
  });
  if (!audioProof.response.value?.ok || audioProof.response.error || audioProof.offscreenContexts < 1) {
    throw new Error(`offscreen audio proof failed: ${JSON.stringify(audioProof)}`);
  }

  // Capture the live popup while the job still reports its detection count.
  const popup = await browser.newPage();
  await popup.setViewport({ width: 380, height: 700, deviceScaleFactor: 2 });
  await popup.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(300);
  const liveStatus = await getStatus();
  await popup.evaluate((snapshot) => applyStatus(snapshot), liveStatus);
  await sleep(300);
  await popup.screenshot({ path: path.join(OUT, 'after-first-reload-alert-popup.png'), fullPage: true });
  await popup.close();

  // Stop before the five-second timer can start cycle 2, then wait for the
  // four-second flash cleanup backstop before capturing the clean page state.
  await sendFromTarget({ type: 'STOP_REFRESH', tabId });
  await sleep(5200);
  await page.bringToFront();
  await page.screenshot({ path: path.join(OUT, 'after-first-reload-alert.png'), fullPage: true });

  console.log(JSON.stringify({
    startMs,
    detectedAt,
    elapsedMs: detectedAt - startMs,
    rootRequestTimes,
    requestsBeforeDetection,
    refreshCount: status.job.refreshCount,
    keywordCount: status.job.keywordCount,
    audioProof,
    screenshots: [
      path.join(OUT, 'before-start.png'),
      path.join(OUT, 'after-first-reload-alert.png'),
      path.join(OUT, 'after-first-reload-alert-popup.png'),
    ],
  }, null, 2));

  await controller.close();
  await page.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
