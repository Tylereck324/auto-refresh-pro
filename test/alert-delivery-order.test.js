// Alert latency: outward channels (notification, webhook) don't wait on the
// journal write or the beep, and webhook targets come from a cached copy of
// Settings that storage.onChanged keeps current.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const card = (title) => `${title}\n£12.00/hr\n10 places\nBy Dr Lab`;
const existing = { text: card('Existing study'), href: 'https://app.example.test/s/0' };
const settings = {
  interval: 60_000, keyword: 'study', watchSelector: '.card', kwPerItem: true,
  notify: false, sound: true, flashOnKeyword: false,
};

function okFetch(calls) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  };
}

test('the notification is posted before the alert is journaled', async () => {
  const fetched = [];
  const options = {
    executeScriptResult: [existing],
    fetch: okFetch(fetched),
    storage: { globalSettings: { webhookUrl: 'https://hooks.example.com/abc', webhookFormat: 'json' } },
  };
  options.onReload = () => {
    options.executeScriptResult = [existing, { text: card('New study'), href: 'https://app.example.test/s/1' }];
  };
  const h = createHarness(options);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await h.evaluate('fireRefresh(7)');

  const notifAt = h.calls.findIndex((c) => c.api === 'notifications.create');
  const logAt = h.calls.findIndex((c) => c.api === 'storage.set' && 'alertLog' in c.values);
  const beepAt = h.calls.findIndex((c) => c.api === 'offscreen.createDocument');
  assert.ok(notifAt >= 0 && logAt >= 0, 'both happened');
  assert.ok(notifAt < logAt, 'notification precedes the journal write');
  assert.ok(beepAt >= 0, 'the beep still plays');
  assert.equal(h.storage.alertLog.filter((e) => e.type === 'kw').length, 1, 'the alert is still journaled');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fetched, ['https://hooks.example.com/abc']);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

const info = { tabId: 7, type: 'kw', title: 'Studies', url: 'https://app.example.com/studies', keyword: 'study' };

test('webhook targets are read from storage once, then served from the cache', async () => {
  const fetched = [];
  const h = createHarness({
    fetch: okFetch(fetched),
    emitStorageChanges: true,
    storage: { globalSettings: { webhookUrl: 'https://hooks.example.com/abc', webhookFormat: 'json' } },
  });
  let reads = 0;
  const realGet = h.chrome.storage.local.get;
  h.chrome.storage.local.get = async (keys) => {
    if (keys === 'globalSettings') reads++;
    return realGet(keys);
  };
  h.evaluate(`globalThis.__job = { settings: {} }; globalThis.__info = ${JSON.stringify(info)};`);
  await h.evaluate('sendWebhook(__job, __info)');
  await h.evaluate('sendWebhook(__job, __info)');
  assert.equal(reads, 1);
  assert.equal(fetched.length, 2);
});

test('a Settings change reaches the next alert without a re-read', async () => {
  const fetched = [];
  const h = createHarness({
    fetch: okFetch(fetched),
    emitStorageChanges: true,
    storage: { globalSettings: { webhookUrl: 'https://old-host.example.com/ingest/tok', webhookFormat: 'json' } },
  });
  h.evaluate(`globalThis.__job = { settings: {} }; globalThis.__info = ${JSON.stringify(info)};`);
  await h.evaluate('sendWebhook(__job, __info)');
  await h.chrome.storage.local.set({ globalSettings: { webhookUrl: 'https://new-host.example.com/ingest/tok', webhookFormat: 'json' } });
  await h.evaluate('sendWebhook(__job, __info)');
  assert.deepEqual(fetched, ['https://old-host.example.com/ingest/tok', 'https://new-host.example.com/ingest/tok']);

  // Clearing Settings falls back to the job's own start-time copy.
  await h.chrome.storage.local.remove('globalSettings');
  h.evaluate(`globalThis.__job = { settings: { webhookUrl: 'https://job.example.com/x', webhookFormat: 'json' } };`);
  await h.evaluate('sendWebhook(__job, __info)');
  assert.equal(fetched.at(-1), 'https://job.example.com/x');
});
