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
