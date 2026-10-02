// Integration tests for webhook delivery from the real background.js: retries
// are driven by response status, and an undeliverable webhook is journaled.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const job = { settings: { webhookUrl: 'https://hooks.example.com/abc', webhookFormat: 'discord' } };
const info = { tabId: 7, type: 'kw', title: 'Studies', url: 'https://app.example.com/studies', keyword: 'Evaluation' };

function scriptedFetch(...statuses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => (status === 429 ? '0' : null) },
      text: async () => '',
    };
  };
  return { fetch, calls };
}

test('a rate-limited webhook is retried and not journaled once delivered', async () => {
  const { fetch, calls } = scriptedFetch(429, 204);
  const h = createHarness({ fetch });
  h.evaluate(`globalThis.__job = ${JSON.stringify(job)}; globalThis.__info = ${JSON.stringify(info)};`);
  const result = await h.evaluate('sendWebhook(__job, __info)');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).content.includes('Evaluation'), true);
  assert.equal((h.storage.alertLog || []).length, 0);
});

test('an undeliverable webhook is recorded in the alert journal without badging', async () => {
  const { fetch, calls } = scriptedFetch(404);
  const h = createHarness({ fetch });
  h.evaluate(`globalThis.__job = ${JSON.stringify(job)}; globalThis.__info = ${JSON.stringify(info)};`);
  const result = await h.evaluate('sendWebhook(__job, __info)');
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, 'a 404 is permanent — no retry');
  const entry = h.storage.alertLog.at(-1);
  assert.equal(entry.type, 'webhook');
  assert.equal(entry.tabId, 7);
  assert.match(entry.snippet, /HTTP 404 after 1 attempt$/);
  assert.equal(h.storage.unackedAlerts || 0, 0);
});

test('TEST_WEBHOOK reports the delivery outcome to the settings page', async () => {
  const { fetch, calls } = scriptedFetch(204);
  const h = createHarness({ fetch });
  // Settings opens in a real tab, so its sender carries a tab AND our page URL.
  const settingsPage = { tab: { id: 50 }, url: 'chrome-extension://extension-test-id/options.html' };
  const res = await h.dispatch({ type: 'TEST_WEBHOOK', url: 'https://hooks.example.com/abc', format: 'slack' }, settingsPage);
  assert.deepEqual(res, { ok: true, status: 204, attempts: 1 });
  assert.ok(JSON.parse(calls[0].init.body).text.includes('test alert'));
});

test('TEST_WEBHOOK rejects unsafe URLs and content-script senders', async () => {
  const { fetch, calls } = scriptedFetch(204);
  const h = createHarness({ fetch });
  assert.equal((await h.dispatch({ type: 'TEST_WEBHOOK', url: 'http://127.0.0.1/x' })).ok, false);
  const fromTab = await h.dispatch(
    { type: 'TEST_WEBHOOK', url: 'https://hooks.example.com/abc' },
    { tab: { id: 7 }, url: 'https://evil.example/' });
  assert.equal(fromTab.ok, false);
  assert.equal(calls.length, 0);
});

test('concurrent alerts to one webhook are delivered one at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  };
  const h = createHarness({ fetch });
  h.evaluate(`globalThis.__job = ${JSON.stringify(job)}; globalThis.__info = ${JSON.stringify(info)};`);
  const results = await h.evaluate('Promise.all([sendWebhook(__job, __info), sendWebhook(__job, __info), sendWebhook(__job, __info)])');
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(maxInFlight, 1);
});
