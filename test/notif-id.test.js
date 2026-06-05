// Tests for notification-id encode/decode (click-to-focus-tab).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotifId, parseNotifTabId } = require('../notif-id.js');

test('buildNotifId encodes prefix, tabId, and stamp', () => {
  assert.equal(buildNotifId('kw', 42, 1000), 'kw_42_1000');
  assert.equal(buildNotifId('chg', 7, 999), 'chg_7_999');
});

test('parseNotifTabId round-trips the tab id for each prefix', () => {
  assert.equal(parseNotifTabId(buildNotifId('kw', 42, 1700000000000)), 42);
  assert.equal(parseNotifTabId(buildNotifId('chg', 7, 5)), 7);
  assert.equal(parseNotifTabId(buildNotifId('refresh', 1234, 5)), 1234);
});

test('parseNotifTabId returns null for non-matching ids', () => {
  assert.equal(parseNotifTabId('something-else'), null);
  assert.equal(parseNotifTabId('kw_notanumber_5'), null);
  assert.equal(parseNotifTabId(''), null);
  assert.equal(parseNotifTabId(null), null);
  assert.equal(parseNotifTabId(undefined), null);
});

test('parseNotifTabId ignores unknown prefixes', () => {
  assert.equal(parseNotifTabId('evil_42_1'), null);
});
