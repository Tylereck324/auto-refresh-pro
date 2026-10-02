// Tests for webhook delivery: status inspection, 429 Retry-After handling,
// 5xx/network backoff, and no retry on permanent client errors.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../webhook-delivery.js');

function response(status, { retryAfter = null, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'Retry-After' ? retryAfter : null) },
    text: async () => body,
  };
}

// fetch stub that replays a script of responses (or Error instances to throw).
function scripted(...steps) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchFn, calls };
}

function recorder() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('retryAfterMs reads the header, then Discord\'s JSON body', () => {
  assert.equal(W.retryAfterMs('2', ''), 2000);
  assert.equal(W.retryAfterMs('0.25', ''), 250);
  assert.equal(W.retryAfterMs(null, '{"retry_after": 1.5}'), 1500);
  assert.equal(W.retryAfterMs(null, 'not json'), null);
  assert.equal(W.retryAfterMs('soon', ''), null);
});

test('nextDelay retries 429/5xx/network, stops on other statuses and the last attempt', () => {
  assert.equal(W.nextDelay(429, 1, 2000), 2000);
  assert.equal(W.nextDelay(429, 1, 60_000), W.MAX_WAIT_MS);
  assert.equal(W.nextDelay(503, 1, null), 1000);
  assert.equal(W.nextDelay(0, 2, null), 3000);
  assert.equal(W.nextDelay(404, 1, null), null);
  assert.equal(W.nextDelay(400, 1, null), null);
  assert.equal(W.nextDelay(503, W.MAX_ATTEMPTS, null), null);
});

test('deliver succeeds on the first 2xx and posts JSON without following redirects', async () => {
  const { fetchFn, calls } = scripted(response(204));
  const r = recorder();
  const result = await W.deliver('https://hook.test/x', { a: 1 }, { fetchFn, sleep: r.sleep });
  assert.deepEqual(result, { ok: true, status: 204, attempts: 1 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.deepEqual(r.waits, []);
});

test('deliver waits out a 429 then succeeds', async () => {
  const { fetchFn, calls } = scripted(response(429, { body: '{"retry_after": 0.5}' }), response(200));
  const r = recorder();
  const result = await W.deliver('https://hook.test/x', {}, { fetchFn, sleep: r.sleep });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(r.waits, [500]);
});

test('deliver backs off on 5xx and network errors, reporting the final failure', async () => {
  const { fetchFn, calls } = scripted(response(502), new TypeError('Failed to fetch'), response(503));
  const r = recorder();
  const result = await W.deliver('https://hook.test/x', {}, { fetchFn, sleep: r.sleep });
  assert.deepEqual(result, { ok: false, status: 503, attempts: 3, error: 'HTTP 503' });
  assert.equal(calls.length, 3);
  assert.deepEqual(r.waits, [1000, 3000]);
});

test('deliver does not retry a permanent client error', async () => {
  const { fetchFn, calls } = scripted(response(404));
  const r = recorder();
  const result = await W.deliver('https://hook.test/x', {}, { fetchFn, sleep: r.sleep });
  assert.deepEqual(result, { ok: false, status: 404, attempts: 1, error: 'HTTP 404' });
  assert.equal(calls.length, 1);
});

test('deliver reports a timeout distinctly', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const { fetchFn } = scripted(abort);
  const r = recorder();
  const result = await W.deliver('https://hook.test/x', {}, { fetchFn, sleep: r.sleep });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timed out');
  assert.equal(result.attempts, 3);
});
