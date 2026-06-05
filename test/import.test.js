// Imported-settings sanitization tests (Manage page → chrome.storage.local).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

test('rejects non-object top-level payloads', () => {
  assert.equal(V.sanitizeImportedSettings(null).ok, false);
  assert.equal(V.sanitizeImportedSettings([1, 2, 3]).ok, false);
  assert.equal(V.sanitizeImportedSettings('a string').ok, false);
  assert.equal(V.sanitizeImportedSettings(42).ok, false);
});

test('strips javascript:/file: auto-start URLs, keeps safe ones', () => {
  const dirty = {
    autoStartUrls: [
      { url: 'https://good.example/', intervalSec: 30 },
      { url: 'javascript:alert(document.cookie)', intervalSec: 5 },
      { url: 'file:///etc/passwd' },
      { url: 'data:text/html,<script>alert(1)</script>' },
    ],
  };
  const { ok, value, errors } = V.sanitizeImportedSettings(dirty);
  assert.equal(ok, true);
  assert.equal(value.autoStartUrls.length, 1);
  assert.equal(value.autoStartUrls[0].url, 'https://good.example/');
  assert.ok(errors.some(e => /unsafe auto-start/.test(e)));
});

test('auto-start refreshSettings is rebuilt from scratch (no injected fields)', () => {
  const dirty = {
    autoStartUrls: [
      { url: 'https://x.example/', intervalSec: 10,
        refreshSettings: { interval: 1, evil: true, hardRefresh: true } },
    ],
  };
  const { value } = V.sanitizeImportedSettings(dirty);
  const rs = value.autoStartUrls[0].refreshSettings;
  assert.equal(rs.evil, undefined);
  assert.equal(rs.interval, 10000); // derived from intervalSec, not attacker value
  assert.equal(rs.hardRefresh, false);
});

test('neutralizes a stored-XSS preset label payload (bounded string)', () => {
  const dirty = {
    globalSettings: {
      presets: [
        { label: '"><img src=x onerror=alert(1)>', ms: 5000 },
        { label: 'ok', ms: 'not-a-number' },
        { label: 'x'.repeat(500), ms: 1000 },
      ],
    },
  };
  const { value } = V.sanitizeImportedSettings(dirty);
  const presets = value.globalSettings.presets;
  // Malicious label survives only as inert data, bounded in length...
  assert.ok(presets[0].label.length <= 40);
  // ...non-numeric ms entry dropped...
  assert.equal(presets.length, 2);
  // ...and the over-long label is clamped, never reaching the DOM unbounded.
  assert.ok(presets[1].label.length <= 40);
  // ms is floored to the 2s minimum.
  assert.equal(presets[0].ms, 5000);
});

test('preserves unrelated keys (forward compatible)', () => {
  const { value } = V.sanitizeImportedSettings({
    popupSettings: { sound: true, selectedMs: 30000 },
    somethingNew: { a: 1 },
  });
  assert.deepEqual(value.popupSettings, { sound: true, selectedMs: 30000 });
  assert.deepEqual(value.somethingNew, { a: 1 });
});

test('drops malformed customHotkey, keeps well-formed', () => {
  assert.equal(V.sanitizeImportedSettings({ customHotkey: 'nope' }).value.customHotkey, null);
  const good = V.sanitizeImportedSettings({
    customHotkey: { key: 'r', code: 'KeyR', alt: true, junk: 1 },
  }).value.customHotkey;
  assert.equal(good.key, 'r');
  assert.equal(good.alt, true);
  assert.equal(good.junk, undefined);
});
