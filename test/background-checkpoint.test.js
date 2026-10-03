// Integration tests for two-tier job persistence in the real background.js:
// routine cycles write one per-job session record and arm ONE coalesced local
// checkpoint; significant transitions still write the local snapshot at once.
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

const localWrites = (h) => h.calls.filter((c) => c.api === 'storage.set' && 'activeJobs' in c.values);
const sessionWrites = (h) => h.calls.filter((c) => c.api === 'session.set');
const checkpointAlarms = (h) => h.calls.filter((c) => c.api === 'alarms.create' && c.name === 'arp_checkpoint');
const fireCheckpoint = (h) => Promise.all(
  h.chrome.alarms.onAlarm.listeners.map((fn) => fn({ name: 'arp_checkpoint' })));

// Run one full cycle. Clearing _lastRefresh defeats the backstop-dedup guard,
// which would otherwise swallow back-to-back cycles within one interval.
const cycle = (h) => h.evaluate('activeJobs[7]._lastRefresh = 0; fireRefresh(7)');

async function startJob(h) {
  const res = await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  assert.deepEqual(res, { ok: true, started: true });
}

test('Start writes the durable local snapshot immediately', async () => {
  const h = createHarness();
  await startJob(h);
  assert.ok(h.storage.activeJobs[7], 'local entry written on start');
  assert.equal(checkpointAlarms(h).length, 0);
});

test('routine cycles write only the session record and arm one checkpoint', async () => {
  const h = createHarness();
  await startJob(h);
  const localBefore = localWrites(h).length;

  for (let i = 0; i < 5; i++) await cycle(h);

  assert.equal(localWrites(h).length, localBefore, 'no routine local writes');
  assert.equal(sessionWrites(h).length, 5);
  assert.equal(checkpointAlarms(h).length, 1, 'repeated cycles coalesce into one checkpoint');
  assert.equal(h.session.arpJob_7.refreshCount, 5);
  assert.equal(h.storage.activeJobs[7].refreshCount, 0, 'local snapshot lags until checkpoint');

  await fireCheckpoint(h);
  assert.equal(localWrites(h).length, localBefore + 1);
  assert.equal(h.storage.activeJobs[7].refreshCount, 5);

  // The next routine cycle opens a fresh window.
  await cycle(h);
  assert.equal(checkpointAlarms(h).length, 2);
});

test('a worker restart rehydrates the newer session record', async () => {
  const h = createHarness();
  await startJob(h);
  for (let i = 0; i < 3; i++) await cycle(h);

  // Simulate the worker dying: in-memory map wiped, both storage areas survive.
  h.evaluate('clearTimerLoop(activeJobs[7]); clearDomScan(activeJobs[7]); delete activeJobs[7];');
  const job = await h.evaluate('rehydrateJob(7)');
  assert.equal(job.refreshCount, 3);
});

test('a browser restart (empty session) falls back to the local snapshot', async () => {
  const h = createHarness();
  await startJob(h);
  for (let i = 0; i < 3; i++) await cycle(h);
  await fireCheckpoint(h);
  await cycle(h);

  h.evaluate('clearTimerLoop(activeJobs[7]); clearDomScan(activeJobs[7]); delete activeJobs[7];');
  for (const k of Object.keys(h.session)) delete h.session[k];
  const job = await h.evaluate('rehydrateJob(7)');
  assert.equal(job.refreshCount, 3, 'restores the last checkpoint');
});

test('Stop before the checkpoint removes the job everywhere and the alarm cannot resurrect it', async () => {
  const h = createHarness();
  await startJob(h);
  await cycle(h);
  assert.ok(h.session.arpJob_7);

  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  assert.equal(h.session.arpJob_7, undefined);
  assert.equal(h.storage.activeJobs[7], undefined);
  assert.ok(h.calls.some((c) => c.api === 'alarms.clear' && c.name === 'arp_checkpoint'));

  await fireCheckpoint(h);
  assert.equal(h.storage.activeJobs[7], undefined);
});

test('an immediate save supersedes the session record', async () => {
  const h = createHarness();
  await startJob(h);
  await cycle(h);
  assert.ok(h.session.arpJob_7);

  await h.dispatch({ type: 'PAUSE_JOB', tabId: 7 });
  assert.equal(h.session.arpJob_7, undefined);
  assert.equal(h.storage.activeJobs[7].manualPause, true);
  assert.equal(h.storage.activeJobs[7].refreshCount, 1);
});

test('a session write failure falls back to an immediate local write', async () => {
  const h = createHarness();
  await startJob(h);
  h.failures.session.set = true;
  const localBefore = localWrites(h).length;

  await cycle(h);
  assert.equal(localWrites(h).length, localBefore + 1);
  assert.equal(h.storage.activeJobs[7].refreshCount, 1);
});

test('a failed checkpoint re-arms for another window', async () => {
  const h = createHarness();
  await startJob(h);
  await cycle(h);
  h.failures.local.set = true;

  await fireCheckpoint(h);
  assert.equal(checkpointAlarms(h).length, 2, 'retry scheduled');

  h.failures.local.set = false;
  await fireCheckpoint(h);
  assert.equal(h.storage.activeJobs[7].refreshCount, 1);
});
