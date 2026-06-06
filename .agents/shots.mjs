// Screenshot harness for the UI/UX pass. Loads the unpacked extension in
// Chrome for Testing and snapshots each surface. Output label comes from argv:
//   node .agents/shots.mjs after        → .agents/proof/shots-after/*.png
//   HEADED=1 node .agents/shots.mjs ...  → headed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = '/Users/tylereck/Documents/auto-refresh-pro-repo';
const LABEL = process.argv[2] || 'shots';
const OUT = path.join(REPO, '.agents', 'proof', `shots-${LABEL}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-shots-'));
const browser = await puppeteer.launch({
  headless: process.env.HEADED ? false : 'new',
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

// Wake the service worker / confirm load.
const warm = await browser.newPage();
await warm.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(400);
const loaded = await warm.evaluate(() => !!(globalThis.chrome?.runtime?.id)).catch(() => false);
if (!loaded) { for (const t of browser.targets()) console.log(t.type(), t.url()); throw new Error('extension not loaded'); }
await warm.close();
log('extension confirmed loaded');

async function shot(file, name, { width = 1100, height = 900, full = true, wait = 600 } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height });
  await p.goto(extUrl(file), { waitUntil: 'networkidle0' });
  await sleep(wait);
  await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  await p.close();
  log('shot', name);
}

// Popup — idle (narrow viewport like the real toolbar popup)
await shot('popup.html', 'popup-idle', { width: 360, height: 640, full: true });
// Settings + Manage (full-page surfaces)
await shot('options.html', 'options', { width: 760, height: 1000 });
await shot('manage.html', 'manage', { width: 980, height: 900 });

await browser.close();
log('done →', OUT);
process.exit(0);
