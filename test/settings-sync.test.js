// Tests for the pure settings-sync rules: device-only fields, merge, quota.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../settings-sync.js');

const local = {
  defaultInterval: 60, presets: [{ label: '1m', ms: 60000 }],
  webhookUrl: 'https://discord.example.com/api/webhooks/1', webhookFormat: 'discord',
  webhookUrl2: 'https://relay.example.com/ingest/secret', webhookFormat2: 'json',
};

test('webhook settings never go to sync', () => {
  const out = S.toSync('globalSettings', local);
  assert.deepEqual(out, { defaultInterval: 60, presets: [{ label: '1m', ms: 60000 }] });
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.ok('webhookUrl' in local, 'the local object is not mutated');
});

test('a synced value keeps this device\'s own webhooks', () => {
  const fromOtherDevice = { defaultInterval: 90, presets: [] };
  assert.deepEqual(S.fromSync('globalSettings', fromOtherDevice, local), {
    defaultInterval: 90, presets: [],
    webhookUrl: local.webhookUrl, webhookFormat: 'discord',
    webhookUrl2: local.webhookUrl2, webhookFormat2: 'json',
  });
});

test('webhook fields smuggled into sync are ignored', () => {
  const tampered = { defaultInterval: 90, webhookUrl: 'https://attacker.example.com/x' };
  assert.equal(S.fromSync('globalSettings', tampered, { defaultInterval: 60 }).webhookUrl, undefined);
  assert.equal(S.fromSync('globalSettings', tampered, local).webhookUrl, local.webhookUrl);
});

test('keys without device-only fields pass through unchanged', () => {
  const rules = [{ pattern: 'https://app.example.com/*', enabled: true }];
  assert.equal(S.toSync('urlRules', rules), rules);
  assert.equal(S.fromSync('urlRules', rules, []), rules);
});

test('sameValue and fitsSync', () => {
  assert.equal(S.sameValue({ a: 1 }, { a: 1 }), true);
  assert.equal(S.sameValue(undefined, null), true);
  assert.equal(S.sameValue([1], [2]), false);
  assert.equal(S.fitsSync('k', { a: 'x'.repeat(100) }), true);
  assert.equal(S.fitsSync('k', { a: 'x'.repeat(S.MAX_ITEM_BYTES) }), false);
});

test('only settings sync — never job state, history, or auto-start tabs', () => {
  assert.deepEqual([...S.SYNC_KEYS].sort(), ['domainDenylist', 'globalSettings', 'popupSettings', 'urlRules']);
});
