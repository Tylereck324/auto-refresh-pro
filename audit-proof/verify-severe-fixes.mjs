// Real Chrome regression harness for the audit fixes.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Audit test</title><body><h1>Audit test page</h1></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const testUrl = `http://127.0.0.1:${server.address().port}/`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-severe-'));
const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const extensionId = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const extUrl = file => `chrome-extension://${extensionId}/${file}`;

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
  assert.equal(await warm.evaluate(() => !!globalThis.chrome?.runtime?.id), true);
  await warm.close();

  const ext = await browser.newPage();
  await ext.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });
  const page = await browser.newPage();
  await page.goto(testUrl, { waitUntil: 'networkidle0' });

  const tabId = await ext.evaluate((url) => new Promise(resolve => {
    chrome.tabs.query({}, tabs => resolve((tabs.find(t => t.url && t.url.startsWith(url)) || {}).id || null));
  }), testUrl);
  assert.ok(Number.isInteger(tabId));

  const settings = {
    interval: 90000, currentInterval: 90000, showCountdown: true,
    hardRefresh: false, notify: false, sound: false, monitorMode: false,
    randomTimer: false, randomMin: 5000, randomMax: 60000, stopAfter: 0,
    keyword: '', stopOnKeyword: false, stopOnChange: false, stopOnClick: false,
  };
  const send = (message) => ext.evaluate((message) => new Promise(resolve => {
    chrome.runtime.sendMessage(message, resolve);
  }), message);
  const startResponse = await send({ type: 'START_REFRESH', tabId, settings });
  console.log('start response', startResponse);
  await ext.evaluate((tabId) => new Promise(resolve => chrome.tabs.sendMessage(tabId, {
    type: 'COUNTDOWN_START', totalMs: 90000, deadline: Date.now() + 90000,
  }, resolve)), tabId);
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => !!document.getElementById('__ar_overlay'))) break;
    await sleep(100);
  }
  assert.equal(await page.evaluate(() => !!document.getElementById('__ar_overlay')), true);

  // Synthetic page events must not reach extension controls.
  await ext.evaluate((tabId) => chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'r', code: 'KeyR', altKey: true, bubbles: true, composed: true,
      }));
      document.getElementById('__ar_stop')?.click();
    },
  }), tabId);
  await sleep(200);
  const afterSynthetic = await send({ type: 'GET_STATUS', tabId });
  assert.ok(afterSynthetic && afterSynthetic.job, 'synthetic page events stopped the job');

  // Real browser input must still be delivered as a trusted DOM event.
  await page.bringToFront();
  const stopBox = await page.$eval('#__ar_stop', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, disabled: el.disabled };
  });
  await page.evaluate(() => {
    window.__auditClick = null;
    document.addEventListener('click', (event) => {
      window.__auditClick = { trusted: event.isTrusted, id: event.target && event.target.id };
    }, true);
  });
  await page.mouse.click(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
  assert.deepEqual(await page.evaluate(() => window.__auditClick), { trusted: true, id: '__ar_stop' });

  // Puppeteer's scripting-world injection does not carry sender.tab metadata,
  // so cleanup uses the extension page after proving synthetic events were
  // ignored and the browser emitted a trusted control event.
  await send({ type: 'STOP_REFRESH', tabId });
  await sleep(300);
  assert.equal((await send({ type: 'GET_STATUS', tabId })).job, null);

  await ext.close();
  await page.close();
  console.log('PASS: synthetic events ignored; trusted browser input observed');
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
