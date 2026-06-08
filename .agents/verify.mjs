// Verification harness: loads the unpacked extension in Chrome for Testing,
// seeds settings, drives the flows, and screenshots proof for each fix.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/opt/homebrew/lib/node_modules/@covibes/zeroshot/');
const puppeteer = require('puppeteer');

const REPO = '/Users/tylereck/Documents/auto-refresh-pro-repo';
const OUT  = path.join(REPO, '.agents', 'proof');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

// ── Tiny local server so content scripts (match <all_urls>) can run on http ──
const PAGE_HTML = (title) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title></head><body style="font-family:sans-serif;padding:40px;background:#f4f4f8">
<h1>Test Page Under Auto Refresh</h1>
<p id="content">Baseline content for monitoring. Lorem ipsum dolor sit amet.</p>
</body></html>`;
let pageTitle = 'My Test Page';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE_HTML(pageTitle));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TEST_URL = `http://127.0.0.1:${PORT}/`;
log('test server', TEST_URL);

// Chrome for Testing (Playwright's build) — plain Chromium that honours
// --load-extension. Regular Google Chrome 137+ silently drops it via an
// enterprise kill-switch, so the unpacked extension never loads there.
const CHROME = '/Users/tylereck/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const HEADLESS = process.env.HEADED ? false : 'new';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-verify-'));
const browser = await puppeteer.launch({
  headless: HEADLESS,
  executablePath: CHROME,
  userDataDir,
  args: [
    `--disable-extensions-except=${REPO}`,
    `--load-extension=${REPO}`,
    // Chrome 137+ blocks --load-extension behind this feature flag; opt out.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
log('launched chrome, headless =', HEADLESS);

// ── Extension ID is deterministic from the unpacked path. Navigate to an
// extension page directly: this both confirms the extension loaded and wakes
// its (otherwise idle) MV3 service worker. ──
import crypto from 'node:crypto';
const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 32);
const EXT_ID = [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
log('extension id (from path)', EXT_ID);

const warm = await browser.newPage();
const resp = await warm.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded' }).catch(e => { log('nav err', e.message); return null; });
await sleep(500);
const loaded = await warm.evaluate(() => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id)).catch(() => false);
if (!loaded) {
  console.log('--- all targets ---');
  for (const t of browser.targets()) console.log(t.type(), '|', t.url());
  throw new Error('extension page did not load chrome.runtime — extension not loaded at computed ID');
}
log('extension confirmed loaded, chrome.runtime.id present');
await warm.close();
const extUrl = (p) => `chrome-extension://${EXT_ID}/${p}`;

const results = {};

// Helper: open an extension page and run code with chrome.* available
async function withExtPage(file, fn) {
  const p = await browser.newPage();
  await p.goto(extUrl(file), { waitUntil: 'domcontentloaded' });
  const out = await fn(p);
  return { p, out };
}

// ════════════════════════════════════════════════════════════════════════
// C1 — custom presets + defaults from Settings flow into the popup
// ════════════════════════════════════════════════════════════════════════
// Seed globalSettings with OBVIOUSLY custom presets + defaults via an ext page.
{
  const { p } = await withExtPage('options.html', async (p) => {
    await p.evaluate(() => new Promise(res => chrome.storage.local.set({
      globalSettings: {
        hardRefresh: true,            // default toggle → should be ON in popup
        showCountdown: true,
        notify: true,                 // default toggle → should be ON in popup
        sound: false,
        defaultInterval: 45,          // → popup selects 45s? (no 45 preset → custom seed)
        presets: [
          { label: 'CUSTOM-2s', ms: 2000 }, { label: 'CUSTOM-7s', ms: 7000 },
          { label: 'CUSTOM-45', ms: 45000 }, { label: 'CUSTOM-3m', ms: 180000 },
          { label: 'CUSTOM-9m', ms: 540000 }, { label: 'CUSTOM-20m', ms: 1200000 },
          { label: 'CUSTOM-45m', ms: 2700000 }, { label: 'CUSTOM-2h', ms: 7200000 },
        ],
      },
    }, res)));
    // Ensure no leftover popupSettings overriding the seed
    await p.evaluate(() => new Promise(res => chrome.storage.local.remove('popupSettings', res)));
    return null;
  });
  await p.close();
  log('C1: seeded custom globalSettings');
}

// Now open the popup and read the rendered pills + default toggles
{
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 640 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(600); // let loadSettings render presets
  const data = await p.evaluate(() => ({
    pills: [...document.querySelectorAll('.pill')].map(b => b.textContent.trim()),
    activePill: (document.querySelector('.pill.active') || {}).textContent || null,
  }));
  await p.screenshot({ path: path.join(OUT, 'C1-popup-custom-presets.png') });
  await p.close();

  // Refresh-behavior defaults (hard refresh, notify) now live on the Settings
  // page — the popup is a launcher and no longer shows them. Verify them there.
  const o = await browser.newPage();
  await o.goto(extUrl('options.html'), { waitUntil: 'networkidle0' });
  await sleep(400);
  const defs = await o.evaluate(() => ({
    hardRefresh: document.getElementById('defHardRefresh').checked,
    notify: document.getElementById('defNotify').checked,
  }));
  await o.close();

  results.C1 = {
    pillsAreCustom: data.pills.every(l => l.startsWith('CUSTOM')),
    pills: data.pills,
    defaultHardRefreshOn: defs.hardRefresh,
    defaultNotifyOn: defs.notify,
  };
  log('C1: pills =', data.pills.join(', '));
  log('C1: hardRefresh default ON =', defs.hardRefresh, '| notify default ON =', defs.notify);
}

// ════════════════════════════════════════════════════════════════════════
// helpers to start/stop a job on the test tab via the background SW
// ════════════════════════════════════════════════════════════════════════
async function findTestTabId(extPage) {
  return await extPage.evaluate((url) => new Promise(res => {
    chrome.tabs.query({}, tabs => {
      const t = tabs.find(t => t.url && t.url.startsWith(url));
      res(t ? t.id : null);
    });
  }), TEST_URL);
}
async function startJob(extPage, tabId, settings) {
  return await extPage.evaluate((tabId, settings) => new Promise(res =>
    chrome.runtime.sendMessage({ type: 'START_REFRESH', tabId, settings }, res)
  ), tabId, settings);
}
async function stopJob(extPage, tabId) {
  return await extPage.evaluate((tabId) => new Promise(res =>
    chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId }, res)
  ), tabId);
}

const baseSettings = (over) => ({
  interval: 90000, hardRefresh: false, showCountdown: true, notify: false,
  sound: false, monitorMode: false, randomTimer: false, randomMin: 5000,
  randomMax: 60000, stopAfter: 0, keyword: '', stopOnKeyword: false,
  stopOnChange: false, stopOnClick: false, currentInterval: 90000, ...over,
});

// ════════════════════════════════════════════════════════════════════════
// C2 + H2 — overlay shows when showCountdown:true (with default Alt+R hint)
// ════════════════════════════════════════════════════════════════════════
const testPage = await browser.newPage();
await testPage.setViewport({ width: 1000, height: 700 });
await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
const ext = await browser.newPage();
await ext.goto(extUrl('options.html'), { waitUntil: 'domcontentloaded' });

{
  const tabId = await findTestTabId(ext);
  log('C2: test tabId', tabId);
  await startJob(ext, tabId, baseSettings({ showCountdown: true, interval: 90000 }));
  // wait for overlay to appear
  await testPage.bringToFront();
  let appeared = false;
  for (let i = 0; i < 40; i++) {
    appeared = await testPage.evaluate(() => !!document.getElementById('__ar_overlay'));
    if (appeared) break;
    await sleep(200);
  }
  await sleep(800); // settle opacity + hint text
  const hint = await testPage.evaluate(() => {
    const h = document.querySelector('#__ar_overlay .__ar_hint_text');
    return h ? h.textContent : null;
  });
  await testPage.screenshot({ path: path.join(OUT, 'C2-overlay-shown.png') });
  results.C2_shown = { overlayPresent: appeared, hintText: hint };
  log('C2: overlay shown =', appeared, '| hint =', JSON.stringify(hint));
  await stopJob(ext, tabId);
  await sleep(600);
}

// ════════════════════════════════════════════════════════════════════════
// C2 — overlay HIDDEN when showCountdown:false
// ════════════════════════════════════════════════════════════════════════
{
  const tabId = await findTestTabId(ext);
  await startJob(ext, tabId, baseSettings({ showCountdown: false, interval: 90000 }));
  await testPage.bringToFront();
  await sleep(2500); // give it ample time to (not) appear
  const overlayPresent = await testPage.evaluate(() => !!document.getElementById('__ar_overlay'));
  await testPage.screenshot({ path: path.join(OUT, 'C2-overlay-hidden.png') });
  results.C2_hidden = { overlayPresent };
  log('C2: overlay present when showCountdown:false =', overlayPresent, '(want false)');
  await stopJob(ext, tabId);
  await sleep(600);
}

// ════════════════════════════════════════════════════════════════════════
// M6 — overlay shows a click-to-stop cue when stopOnClick is armed
// ════════════════════════════════════════════════════════════════════════
{
  const tabId = await findTestTabId(ext);
  await startJob(ext, tabId, baseSettings({ showCountdown: true, stopOnClick: true, interval: 90000 }));
  await testPage.bringToFront();
  let hint = null;
  for (let i = 0; i < 40; i++) {
    hint = await testPage.evaluate(() => {
      const h = document.querySelector('#__ar_overlay .__ar_hint_text');
      return h ? h.textContent : null;
    });
    if (hint && /click/i.test(hint)) break;
    await sleep(200);
  }
  await testPage.screenshot({ path: path.join(OUT, 'M6-overlay-clickstop-cue.png') });
  results.M6 = { hintText: hint, mentionsClick: !!(hint && /click/i.test(hint)) };
  log('M6: overlay hint with stopOnClick =', JSON.stringify(hint));
  await stopJob(ext, tabId);
  await sleep(600);
}

// ════════════════════════════════════════════════════════════════════════
// H1 — manage.html escapes a malicious tab title (no XSS)
// ════════════════════════════════════════════════════════════════════════
{
  const MAL = '<img src=x onerror="window.__pwned=true">PWN';
  // navigate test page to a malicious title, start a job so it shows in manage
  pageTitle = MAL;
  await testPage.goto(TEST_URL, { waitUntil: 'networkidle0' });
  await testPage.evaluate((t) => { document.title = t; }, MAL);
  const tabId = await findTestTabId(ext);
  await startJob(ext, tabId, baseSettings({ showCountdown: false, interval: 90000 }));

  // Confirm the background actually has the job before opening manage.
  let jobCount = 0;
  for (let i = 0; i < 30; i++) {
    jobCount = await ext.evaluate(() => new Promise(res =>
      chrome.runtime.sendMessage({ type: 'GET_ALL_JOBS' }, r => res(r && r.jobs ? Object.keys(r.jobs).length : 0))));
    if (jobCount > 0) break;
    await sleep(200);
  }
  log('H1: active job count before manage =', jobCount);

  const manage = await browser.newPage();
  // capture any CSP / inline-script violations — proves the page's JS runs
  const cspErrors = [];
  manage.on('console', m => { if (m.type() === 'error' && /Content Security Policy|inline script/i.test(m.text())) cspErrors.push(m.text()); });
  await manage.setViewport({ width: 1000, height: 800 });
  await manage.goto(extUrl('manage.html'), { waitUntil: 'domcontentloaded' });
  // The externalised manage.js now runs natively and auto-polls every 3s.
  let rendered = false;
  for (let i = 0; i < 50; i++) {
    rendered = await manage.evaluate(() => !!document.querySelector('.tab-title'));
    if (rendered) break;
    await sleep(250);
  }
  await sleep(300);
  results.H1_cspBlocked = cspErrors.length > 0;
  log('H1: CSP inline-script violations =', cspErrors.length, '(want 0)');
  const probe = await manage.evaluate(() => ({
    pwned: !!window.__pwned,
    imgInjected: !!document.querySelector('.tab-title img'),
    titleText: (document.querySelector('.tab-title') || {}).textContent || null,
    cardRendered: !!document.querySelector('.tab-title'),
  }));
  await manage.screenshot({ path: path.join(OUT, 'H1-manage-escaped.png') });
  results.H1 = probe;
  log('H1: pwned =', probe.pwned, '| img injected =', probe.imgInjected, '| title text =', JSON.stringify(probe.titleText));
  await stopJob(ext, tabId);
  await manage.close();
}

// ════════════════════════════════════════════════════════════════════════
// C3 + H2 — options page: tooltip + honest info box
// ════════════════════════════════════════════════════════════════════════
{
  const p = await browser.newPage();
  await p.setViewport({ width: 760, height: 900 });
  await p.goto(extUrl('options.html'), { waitUntil: 'networkidle0' });
  await sleep(400);
  const probe = await p.evaluate(() => ({
    clearTitle: document.getElementById('clearBtn').getAttribute('title'),
    infoHasOldLink: !!document.getElementById('chromeShortcutLink'),
    infoText: document.querySelector('.hotkey-info').textContent.replace(/\s+/g, ' ').trim(),
  }));
  await p.screenshot({ path: path.join(OUT, 'C3-options.png') });
  results.C3 = probe;
  log('C3: clearBtn title =', JSON.stringify(probe.clearTitle));
  log('C3: stale chrome-shortcut link present =', probe.infoHasOldLink, '(want false)');
  await p.close();
}

// ════════════════════════════════════════════════════════════════════════
// M2 — random range is validated (inverted min/max gets swapped, floored 2s)
// ════════════════════════════════════════════════════════════════════════
// Randomize config now lives in the popup's Refresh Behavior section; the range
// is floored/swapped in popup.js gatherSettings when composing job settings.
{
  const p = await browser.newPage();
  await p.setViewport({ width: 420, height: 900 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(500);
  const gathered = await p.evaluate(() => {
    document.getElementById('optRandom').checked = true;
    document.getElementById('optRandomMin').value = '60'; // intentionally inverted
    document.getElementById('optRandomMax').value = '5';
    return gatherSettings(); // global in the popup's classic script
  });
  results.M2 = {
    randomMinMs: gathered.randomMin,
    randomMaxMs: gathered.randomMax,
    randomOn: gathered.randomTimer === true,
    minLEmax: gathered.randomMin <= gathered.randomMax,
    flooredAt2s: gathered.randomMin >= 2000 && gathered.randomMax >= 2000,
  };
  log('M2: inverted 60/5 ->', gathered.randomMin, '/', gathered.randomMax, 'ms | min<=max =', results.M2.minLEmax);
  await p.close();
}

// ════════════════════════════════════════════════════════════════════════
// L6 — keyboard focus ring is visible (tab into the popup)
// ════════════════════════════════════════════════════════════════════════
{
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 640 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(500);
  await p.bringToFront();
  // Tab into the first interval pill so :focus-visible engages (keyboard focus).
  await p.keyboard.press('Tab');
  await sleep(200);
  const focused = await p.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName, cls: a.className, text: (a.textContent || '').trim().slice(0, 20) };
  });
  results.L6 = focused;
  log('L6: focused element after Tab =', JSON.stringify(focused));
  await p.screenshot({ path: path.join(OUT, 'L6-focus-ring.png') });
  await p.close();
}

// ════════════════════════════════════════════════════════════════════════
// L1 — typing a sub-2s custom interval surfaces a hint instead of silent clamp
// ════════════════════════════════════════════════════════════════════════
{
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 680 });
  await p.goto(extUrl('popup.html'), { waitUntil: 'networkidle0' });
  await sleep(400);
  const probe = await p.evaluate(() => {
    const input = document.getElementById('customValue');
    const unit = document.getElementById('customUnit');
    unit.value = '1000'; // seconds
    input.value = '1';   // 1s -> below the 2s floor
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const hint = document.getElementById('customHint');
    return { hintShown: hint.classList.contains('show'), inputInvalid: input.classList.contains('invalid'), hintText: hint.textContent.trim() };
  });
  results.L1 = probe;
  log('L1: sub-2s hint shown =', probe.hintShown, '| input flagged =', probe.inputInvalid);
  await p.screenshot({ path: path.join(OUT, 'L1-clamp-hint.png') });
  await p.close();
}

// ════════════════════════════════════════════════════════════════════════
// M5 — Settings auto-save (no Save button); L4 — hotkey needs manual confirm
// ════════════════════════════════════════════════════════════════════════
{
  const op = await browser.newPage();
  await op.setViewport({ width: 760, height: 980 });
  await op.goto(extUrl('options.html'), { waitUntil: 'networkidle0' });
  await sleep(800); // let load() populate + set `loaded`

  // M5: toggle Notifications and confirm it persists WITHOUT any save click.
  const m5 = await op.evaluate(async () => {
    const get = () => new Promise(r => chrome.storage.local.get('globalSettings', d => r(d.globalSettings || {})));
    const before = await get();
    const el = document.getElementById('defNotify');
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800)); // debounce(350) + write
    const after = await get();
    return { saveButtonRemoved: !document.getElementById('saveBtn'), notifyBefore: !!before.notify, notifyAfter: !!after.notify };
  });
  results.M5 = { ...m5, changedWithoutSaveClick: m5.notifyBefore !== m5.notifyAfter };
  log('M5: saveButton removed =', m5.saveButtonRemoved, '| notify persisted', m5.notifyBefore, '->', m5.notifyAfter);

  // L4: record a combo; it must NOT auto-apply — only on explicit confirm.
  const l4a = await op.evaluate(() => {
    startRecording();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', altKey: true, bubbles: true, cancelable: true }));
    return { pending: !!pendingHotkey, btnText: recordBtn.textContent.trim(), appliedYet: JSON.stringify(currentHotkey) };
  });
  await sleep(1100); // well past the old 800ms auto-confirm window
  const l4b = await op.evaluate(() => ({ stillRecording: recording, appliedAfterWait: JSON.stringify(currentHotkey) }));
  const l4c = await op.evaluate(() => { recordBtn.click(); return { applied: JSON.stringify(currentHotkey), recording }; });
  results.L4 = {
    previewShown: l4a.pending,
    confirmButtonShown: /use this/i.test(l4a.btnText),
    didNotAutoApply: l4b.appliedAfterWait === 'null' && l4b.stillRecording === true,
    appliedOnConfirm: /"code":"KeyG"/.test(l4c.applied) && l4c.recording === false,
  };
  log('L4: confirm-btn =', JSON.stringify(l4a.btnText), '| auto-applied after 1.1s =', l4b.appliedAfterWait !== 'null', '(want false) | applied on confirm =', results.L4.appliedOnConfirm);
  await op.screenshot({ path: path.join(OUT, 'M5-L4-options-autosave.png') });
  await op.close();
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log('\n=== RESULTS ===');
console.log(JSON.stringify(results, null, 2));

await browser.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('\nScreenshots in', OUT);
