// URL & navigation safety tests (autoStartUrls → chrome.tabs.create).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

test('accepts ordinary http(s) URLs', () => {
  assert.equal(V.isSafeNavigableUrl('https://example.com/'), true);
  assert.equal(V.isSafeNavigableUrl('http://localhost:8080/path?q=1'), true);
});

test('rejects javascript: URLs (would run script on startup)', () => {
  assert.equal(V.isSafeNavigableUrl('javascript:alert(document.cookie)'), false);
  assert.equal(V.isSafeNavigableUrl('  javascript:alert(1)'), false);
  assert.equal(V.isSafeNavigableUrl('JaVaScRiPt:alert(1)'), false);
});

test('rejects data:, file:, chrome:, blob: schemes', () => {
  assert.equal(V.isSafeNavigableUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(V.isSafeNavigableUrl('file:///etc/passwd'), false);
  assert.equal(V.isSafeNavigableUrl('chrome://settings'), false);
  assert.equal(V.isSafeNavigableUrl('blob:https://x/abc'), false);
});

test('rejects empty, non-string, and over-long URLs', () => {
  assert.equal(V.isSafeNavigableUrl(''), false);
  assert.equal(V.isSafeNavigableUrl(null), false);
  assert.equal(V.isSafeNavigableUrl({}), false);
  assert.equal(V.isSafeNavigableUrl('https://example.com/' + 'a'.repeat(3000)), false);
});
