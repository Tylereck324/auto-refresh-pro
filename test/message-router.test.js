// The runtime.onMessage router: one handler per message type, own-property
// lookup only, and every message gets a response.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

test('every message type the extension sends has a handler', () => {
  const h = createHarness();
  const types = h.evaluate('Object.keys(MESSAGE_HANDLERS).sort()');
  assert.deepEqual([...types], [
    'CLEAR_ALERTS', 'EXTEND_JOB', 'GET_ALL_JOBS', 'GET_STATUS', 'PAUSE_JOB',
    'RESUME_JOB', 'START_REFRESH', 'STOP_ALL', 'STOP_REFRESH', 'TEST_WEBHOOK',
    'UPDATE_INTERVAL',
  ]);
});

test('unknown and prototype-named types get an error response, never a crash', async () => {
  const h = createHarness();
  for (const type of ['NOPE', 'constructor', '__proto__', 'toString', 'hasOwnProperty', undefined, 42]) {
    assert.deepEqual(await h.dispatch({ type }), { ok: false, error: 'unknown message type' }, String(type));
  }
});

test('a handler that throws still settles the caller with an error', async () => {
  const h = createHarness();
  h.evaluate('MESSAGE_HANDLERS.GET_ALL_JOBS = async () => { throw new Error("boom"); }');
  assert.deepEqual(await h.dispatch({ type: 'GET_ALL_JOBS' }), { ok: false, error: 'boom' });
});

test('content-script senders are bound to their own tab', async () => {
  const h = createHarness();
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { interval: 60_000 } });
  await h.dispatch({ type: 'START_REFRESH', tabId: 9, settings: { interval: 60_000 } });
  // A content script in tab 9 asking to stop tab 7 stops tab 9 instead.
  const res = await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 }, { tab: { id: 9 } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual([...h.evaluate('Object.keys(activeJobs)')], ['7']);
});
