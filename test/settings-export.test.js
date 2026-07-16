'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPORT_KEYS, pick } = require('../settings-export.js');

test('exports exactly the supported settings allowlist', () => {
  const source = {
    popupSettings: { keyword: 'restock' },
    globalSettings: { notify: true },
    customHotkey: { key: 'r', code: 'KeyR' },
    autoStartUrls: [{ url: 'https://example.test/' }],
    urlRules: [{ pattern: 'https://example.test/*', enabled: true }],
    domainDenylist: ['private.test'],
    __ar_overlay_pos: { left: 10, top: 20 },
    __ar_overlay_size: { width: 400, height: 300 },
    alertLog: [{ url: 'https://private.test/token' }],
    unackedAlerts: 2,
    activeJobs: { 7: { settings: {} } },
    activeJobUrls: ['https://private.test/token'],
    futureRuntimeKey: 'private',
  };

  const result = pick(source);
  assert.deepEqual(Object.keys(result).sort(), [...EXPORT_KEYS].sort());
  for (const key of EXPORT_KEYS) assert.deepEqual(result[key], source[key]);
  assert.equal(Object.hasOwn(result, 'alertLog'), false);
  assert.equal(Object.hasOwn(result, 'activeJobs'), false);
  assert.equal(Object.hasOwn(result, 'futureRuntimeKey'), false);
});

test('only own allowlisted properties are exported', () => {
  const inherited = { globalSettings: { notify: false }, popupSettings: { keyword: 'inherited' } };
  const source = Object.create(inherited);
  source.customHotkey = null;
  source.alertLog = [{ snippet: 'private' }];

  const result = pick(source);
  assert.deepEqual(result, { customHotkey: null });
  assert.equal(Object.hasOwn(result, 'globalSettings'), false);
  assert.equal(Object.hasOwn(result, 'popupSettings'), false);
});

test('null, primitives, and arrays produce an empty settings object', () => {
  assert.deepEqual(pick(null), {});
  assert.deepEqual(pick(undefined), {});
  assert.deepEqual(pick('not storage'), {});
  assert.deepEqual(pick([]), {});
});
