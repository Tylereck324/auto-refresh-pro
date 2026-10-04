// The lifetime keyword-detection total: counted across jobs, kept through
// Stop and a cleared journal, and delivered to the overlay of keyword jobs.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const card = (title) => `${title}\n£12.00/hr\n10 places\nBy Dr Lab`;
const existing = { text: card('Existing study'), href: 'https://app.example.test/s/0' };
const settings = {
  interval: 60_000, keyword: 'study', watchSelector: '.card', kwPerItem: true,
  notify: false, sound: false, flashOnKeyword: false,
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function harnessWithArrivals(arrivals, extra = {}) {
  const options = { executeScriptResult: [existing], ...extra };
  options.onReload = () => { options.executeScriptResult = [existing, ...arrivals]; };
  return createHarness(options);
}
const sent = (h, type) => h.calls.filter((c) => c.api === 'tabs.sendMessage' && c.message.type === type);

test('each detected item adds to the lifetime total and updates the overlay', async () => {
  const h = harnessWithArrivals([
    { text: card('A study'), href: 'https://app.example.test/s/1' },
    { text: card('B study'), href: 'https://app.example.test/s/2' },
  ], { storage: { lifetimeDetections: 10 } });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await h.evaluate('fireRefresh(7)');
  assert.equal(h.storage.lifetimeDetections, 12);
  assert.deepEqual(sent(h, 'DETECTIONS').map((c) => [c.tabId, c.message.total]), [[7, 12]]);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('the total survives Stop and clearing the alert journal', async () => {
  const h = harnessWithArrivals([{ text: card('A study'), href: 'https://app.example.test/s/1' }],
    { storage: { lifetimeDetections: 5 } });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await h.evaluate('fireRefresh(7)');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  await h.dispatch({ type: 'CLEAR_ALERTS' });
  assert.deepEqual(h.storage.alertLog, []);
  assert.equal(h.storage.lifetimeDetections, 6);
});

test('COUNTDOWN_START and the overlay sync carry the total for keyword jobs only', async () => {
  const h = createHarness({ storage: { lifetimeDetections: 42 }, executeScriptResult: [existing] });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await tick();
  assert.equal(sent(h, 'COUNTDOWN_START').at(-1).message.detections, 42);
  const sync = await h.dispatch({ type: 'GET_STATUS', tabId: null }, { tab: { id: 7 }, url: 'https://app.example.test/' });
  assert.equal(sync.detections, 42);
  // The popup (no sender tab) doesn't get it.
  assert.equal((await h.dispatch({ type: 'GET_STATUS', tabId: 7 })).detections, undefined);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });

  const plain = createHarness({ storage: { lifetimeDetections: 42 } });
  await plain.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { interval: 60_000 } });
  await tick();
  assert.equal(sent(plain, 'COUNTDOWN_START').at(-1).message.detections, undefined);
  await plain.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('RESET_DETECTIONS zeroes the total and updates open overlays; pages cannot send it', async () => {
  const h = createHarness({ storage: { lifetimeDetections: 9 }, executeScriptResult: [existing] });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });

  const fromPage = await h.dispatch({ type: 'RESET_DETECTIONS' }, { tab: { id: 7 }, url: 'https://evil.example/' });
  assert.equal(fromPage.ok, false);
  assert.equal(h.storage.lifetimeDetections, 9);

  const manage = { tab: { id: 50 }, url: 'chrome-extension://extension-test-id/manage.html' };
  assert.equal((await h.dispatch({ type: 'RESET_DETECTIONS' }, manage)).ok, true);
  assert.equal(h.storage.lifetimeDetections, 0);
  assert.deepEqual(sent(h, 'DETECTIONS').map((c) => [c.tabId, c.message.total]), [[7, 0]]);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});
