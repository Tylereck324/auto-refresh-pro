// The worker's settings-sync bridge: local ⇄ chrome.storage.sync, with
// device-only webhooks, import-grade sanitizing, and no echo loops.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const webhooks = {
  webhookUrl: 'https://discord.example.com/api/webhooks/1', webhookFormat: 'discord',
  webhookUrl2: 'https://relay.example.com/ingest/secret', webhookFormat2: 'json',
};
const syncWrites = (h) => h.calls.filter((c) => c.api === 'sync.set');
const fire = (h, changes, area) => Promise.all(h.chrome.storage.onChanged.listeners.map((fn) => fn(changes, area)));
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a local settings change is pushed to sync without webhooks', async () => {
  const h = createHarness({ storage: { globalSettings: { defaultInterval: 60, ...webhooks } } });
  await h.evaluate("pushSettingToSync('globalSettings')");
  assert.deepEqual(h.sync.globalSettings, { defaultInterval: 60 });
});

test('a change from another device is applied locally, keeping this device\'s webhooks', async () => {
  const h = createHarness({ storage: { globalSettings: { defaultInterval: 60, ...webhooks } } });
  h.sync.globalSettings = { defaultInterval: 90, webhookUrl: 'https://attacker.example.com/x' };
  await fire(h, { globalSettings: { newValue: h.sync.globalSettings } }, 'sync');
  await settle();
  assert.equal(h.storage.globalSettings.defaultInterval, 90);
  assert.equal(h.storage.globalSettings.webhookUrl, webhooks.webhookUrl);
  assert.equal(h.storage.globalSettings.webhookUrl2, webhooks.webhookUrl2);
});

test('synced data is sanitized like an import', async () => {
  const h = createHarness({ storage: { domainDenylist: [] } });
  h.sync.urlRules = [
    { pattern: 'https://app.example.com/*', enabled: true, settings: { interval: 60000 } },
    { pattern: 'javascript:alert(1)', enabled: true, settings: { interval: 1 } },
  ];
  await h.evaluate("pullSettingFromSync('urlRules')");
  assert.deepEqual(h.storage.urlRules.map((r) => r.pattern), ['https://app.example.com/*']);
});

test('applying a synced value does not echo it back to sync', async () => {
  const h = createHarness({ storage: { globalSettings: { defaultInterval: 60, ...webhooks } } });
  h.sync.globalSettings = { defaultInterval: 90 };
  await h.evaluate("pullSettingFromSync('globalSettings')");
  const before = syncWrites(h).length;
  await fire(h, { globalSettings: { newValue: h.storage.globalSettings } }, 'local');
  await settle();
  assert.equal(syncWrites(h).length, before);
});

test('reconcile: sync wins where it has a value, otherwise this device seeds it', async () => {
  const h = createHarness({
    storage: { globalSettings: { defaultInterval: 60, ...webhooks }, domainDenylist: ['bank.example.com'] },
    sync: { globalSettings: { defaultInterval: 120 } },
  });
  await h.evaluate('reconcileSettingsSync()');
  assert.equal(h.storage.globalSettings.defaultInterval, 120, 'sync won');
  assert.equal(h.storage.globalSettings.webhookUrl, webhooks.webhookUrl, 'webhooks kept');
  assert.deepEqual(h.sync.domainDenylist, ['bank.example.com'], 'seeded from this device');
});

test('an oversized value or a failing sync write stays local without throwing', async () => {
  const big = Array.from({ length: 400 }, (_, i) => 'blocked-site-number-' + i + '.example.com');
  const h = createHarness({ storage: { domainDenylist: big, globalSettings: { defaultInterval: 60 } } });
  await h.evaluate("pushSettingToSync('domainDenylist')");
  assert.equal(h.sync.domainDenylist, undefined);
  h.failures.sync.set = true;
  await h.evaluate("pushSettingToSync('globalSettings')");
  assert.equal(h.sync.globalSettings, undefined);
  assert.equal(h.storage.globalSettings.defaultInterval, 60);
});

test('job state and history never reach sync', async () => {
  const h = createHarness({ storage: { activeJobs: { 7: { settings: {} } }, alertLog: [{ type: 'kw' }], autoStartUrls: [{ url: 'https://a.example.com' }] } });
  await fire(h, { activeJobs: {}, alertLog: {}, autoStartUrls: {} }, 'local');
  await h.evaluate('reconcileSettingsSync()');
  assert.deepEqual(Object.keys(h.sync), []);
});
