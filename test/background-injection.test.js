// On-demand content-script injection and the manifest `commands` shortcut:
// content.js runs only in pages hosting a job, and the toggle shortcut is a
// Chrome command handled by the worker rather than a per-page key listener.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./background-harness.js');

const settings = { interval: 60_000, keyword: '', monitorMode: false, notify: false, sound: false };
const commands = [{ name: 'toggle-refresh', shortcut: 'Alt+R' }];

const injections = (h) => h.calls.filter(
  (c) => c.api === 'scripting.executeScript' && (c.details.files || []).includes('content.js'));
const completeLoad = (h, tabId, url) => Promise.all(h.chrome.tabs.onUpdated.listeners.map(
  (fn) => fn(tabId, { status: 'complete' }, { id: tabId, url, status: 'complete' })));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('manifest declares no <all_urls> content script and binds the toggle command', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.commands['toggle-refresh'].suggested_key.default, 'Alt+R');
});

test('content.js is injected when a job\'s page finishes loading', async () => {
  const h = createHarness({ commands });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const before = injections(h).length;
  await completeLoad(h, 7, 'https://example.test/list');
  assert.equal(injections(h).length, before + 1);
});

test('pages without a job, or a job tab that navigated away, get no injection', async () => {
  const h = createHarness({ commands });
  await h.dispatch({ type: 'GET_STATUS', tabId: 9 }); // warm the store-fresh fast path
  await completeLoad(h, 9, 'https://other.test/');
  assert.equal(injections(h).length, 0);

  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const before = injections(h).length;
  await completeLoad(h, 7, 'https://elsewhere.test/page');
  assert.equal(injections(h).length, before);
});

test('the shortcut starts a job on a web page and stops it on the next press', async () => {
  const h = createHarness({ commands });
  const tab = { id: 7, url: 'https://example.test/list' };
  await Promise.all(h.chrome.commands.onCommand.listeners.map((fn) => fn('toggle-refresh', tab)));
  assert.deepEqual(h.evaluate('Object.keys(activeJobs)'), ['7']);

  await Promise.all(h.chrome.commands.onCommand.listeners.map((fn) => fn('toggle-refresh', tab)));
  assert.deepEqual(h.evaluate('Object.keys(activeJobs)'), []);
});

test('the shortcut never starts a job on a browser page', async () => {
  const h = createHarness({ commands });
  await Promise.all(h.chrome.commands.onCommand.listeners.map(
    (fn) => fn('toggle-refresh', { id: 7, url: 'chrome://newtab/' })));
  assert.deepEqual(h.evaluate('Object.keys(activeJobs)'), []);
});

test('the overlay is told the current shortcut label', async () => {
  const h = createHarness({ commands });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await h.evaluate('sendCountdownStart(7, 0)');
  await flush();
  const start = h.calls.find((c) => c.api === 'tabs.sendMessage' && c.message.type === 'COUNTDOWN_START');
  assert.equal(start.message.hotkey, 'Alt+R');

  const status = await h.dispatch({ type: 'GET_STATUS', tabId: null }, { tab: { id: 7 } });
  assert.equal(status.hotkey, 'Alt+R');
});
