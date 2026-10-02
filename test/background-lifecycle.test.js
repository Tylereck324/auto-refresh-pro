'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const settings = {
  interval: 60_000,
  keyword: '',
  monitorMode: false,
  notify: false,
  sound: false,
};

test('STOP_REFRESH cancels a START_REFRESH suspended in a Chrome API call', async () => {
  const harness = createHarness({ gateFirstTabGet: true });
  const startPromise = harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await harness.gates.tabGetCalled.promise;

  const stopResponse = await harness.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  assert.deepEqual(stopResponse, { ok: true });
  harness.releaseFirstTabGet();
  const startResponse = await startPromise;

  assert.deepEqual(startResponse, { ok: false, cancelled: true });
  assert.deepEqual(harness.evaluate('Object.keys(activeJobs)'), []);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storage.activeJobs)), {});
  assert.ok(harness.calls.some((call) => call.api === 'alarms.clear' && call.name === 'refresh_7'));
});

test('STOP_ALL invalidates a pending start before asynchronous cleanup', async () => {
  const harness = createHarness({ gateFirstTabGet: true });
  const startPromise = harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await harness.gates.tabGetCalled.promise;

  const stopAllResponse = await harness.dispatch({ type: 'STOP_ALL' });
  assert.deepEqual(stopAllResponse, { ok: true });
  harness.releaseFirstTabGet();
  assert.deepEqual(await startPromise, { ok: false, cancelled: true });
  assert.deepEqual(harness.evaluate('Object.keys(activeJobs)'), []);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storage.activeJobs)), {});
});

test('UPDATE_INTERVAL preserves the per-item baseline for timing-only changes', async () => {
  const harness = createHarness();
  const startResponse = await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  assert.deepEqual(startResponse, { ok: true, started: true });

  harness.evaluate("activeJobs[7]._seenKeys = new Set(['existing-item']);");
  const updateResponse = await harness.dispatch({
    type: 'UPDATE_INTERVAL',
    tabId: 7,
    settings: { interval: 120_000 },
  });
  assert.deepEqual(updateResponse, { ok: true });
  assert.equal(harness.evaluate("activeJobs[7]._seenKeys.has('existing-item')"), true);
});

test('UPDATE_INTERVAL resets the per-item baseline when detection identity changes', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  harness.evaluate("activeJobs[7]._seenKeys = new Set(['existing-item']);");

  const updateResponse = await harness.dispatch({
    type: 'UPDATE_INTERVAL',
    tabId: 7,
    settings: { interval: 120_000, keyword: 'new keyword' },
  });
  assert.deepEqual(updateResponse, { ok: true });
  assert.equal(harness.evaluate('activeJobs[7]._seenKeys'), null);
});

// Manage and Settings run in real tabs. Their messages must target msg.tabId,
// not the Manage/Settings tab they were sent from.
test('Manage (an extension page in a tab) can stop and pause another tab\'s job', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const manage = { tab: { id: 50 }, url: 'chrome-extension://extension-test-id/manage.html' };

  assert.deepEqual(await harness.dispatch({ type: 'PAUSE_JOB', tabId: 7 }, manage), { ok: true });
  assert.equal(harness.evaluate('activeJobs[7]._manualPause'), true);

  assert.deepEqual(await harness.dispatch({ type: 'STOP_REFRESH', tabId: 7 }, manage), { ok: true });
  assert.deepEqual(harness.evaluate('Object.keys(activeJobs)'), []);
});

test('a content script cannot redirect a command to another tab', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const page = { tab: { id: 9 }, url: 'https://evil.example/' };
  await harness.dispatch({ type: 'STOP_REFRESH', tabId: 7 }, page);
  assert.deepEqual(harness.evaluate('Object.keys(activeJobs)'), ['7']);
});
