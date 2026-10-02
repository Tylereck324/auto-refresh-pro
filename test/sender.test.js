// Runtime message sender-trust tests (background onMessage boundary).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

const OWN_ID = 'abcdefghijklmnopabcdefghijklmnop';

test('accepts messages from this extension (matching id)', () => {
  assert.equal(V.isTrustedSender({ id: OWN_ID, tab: { id: 1 } }, OWN_ID), true);
});

test('rejects messages from another extension', () => {
  assert.equal(V.isTrustedSender({ id: 'a-different-extension-id-000000000' }, OWN_ID), false);
});

test('rejects senders with no id (web page / external)', () => {
  assert.equal(V.isTrustedSender({ tab: { id: 1 }, url: 'https://evil.example' }, OWN_ID), false);
  assert.equal(V.isTrustedSender({}, OWN_ID), false);
  assert.equal(V.isTrustedSender(null, OWN_ID), false);
});

test('fails closed when own id is unknown', () => {
  assert.equal(V.isTrustedSender({ id: OWN_ID }, null), false);
});

// Settings and Manage open in real tabs, so they carry sender.tab exactly like
// a content script; only sender.url distinguishes them.
test('isExtensionPageSender recognizes our own pages by sender.url', () => {
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, tab: { id: 3 }, url: `chrome-extension://${OWN_ID}/manage.html` }, OWN_ID), true);
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, url: `chrome-extension://${OWN_ID}/popup.html` }, OWN_ID), true);
});

test('isExtensionPageSender rejects content scripts, other extensions, and junk', () => {
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, tab: { id: 3 }, url: 'https://app.example.com/studies' }, OWN_ID), false);
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, url: 'chrome-extension://another-extension-id/page.html' }, OWN_ID), false);
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, tab: { id: 3 } }, OWN_ID), false);
  assert.equal(V.isExtensionPageSender({ id: OWN_ID, url: 'not a url' }, OWN_ID), false);
  assert.equal(V.isExtensionPageSender(null, OWN_ID), false);
});
