// Parse-checks for the chrome-bound scripts the unit suite can't require()
// (they touch chrome.*/document at top level). A syntax error in any of them
// would otherwise only surface as a dead extension page at load time.
// vm.Script compiles without executing — exactly `node --check`, but inside
// the test run so it can't be skipped.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PAGE_SCRIPTS = [
  'background.js',
  'content.js',
  'popup.js',
  'options.js',
  'manage.js',
  'offscreen.js',
  'sounds.js',
  'toast.js',
  'preset-row.js',
];

for (const file of PAGE_SCRIPTS) {
  test(`${file} parses`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }));
  });
}

test('manifest.json is valid JSON with the expected shape', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(Array.isArray(manifest.permissions));
  // tabs/activeTab are deliberately absent: <all_urls> host permission already
  // grants tab url/title access and scripting everywhere, and dropping `tabs`
  // removes the "read your browsing history" install warning. Don't re-add
  // them without a concrete API that needs them.
  assert.ok(!manifest.permissions.includes('tabs'));
  assert.ok(!manifest.permissions.includes('activeTab'));
  for (const p of ['storage', 'alarms', 'notifications', 'scripting', 'offscreen']) {
    assert.ok(manifest.permissions.includes(p), `missing permission: ${p}`);
  }
});
