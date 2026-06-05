// Regression test for the Settings-page preset save count mismatch.
//
// BUG: options.js gatherAndSave() iterated a fixed 8-entry template
// (defaultPresets) when reading rows back, regardless of how many preset rows
// were actually rendered. Importing/having ≠8 presets therefore silently
// dropped presets past index 7 and fabricated phantom presets (label "N", 30s)
// when fewer than 8 existed — corrupting the user's preset set on every
// auto-save. readPresets(doc, count) now reads exactly the rendered rows.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPresets } = require('../preset-row.js');

// Minimal document stub: holds a map of input elements keyed by id.
function makeDoc(rows) {
  const els = {};
  rows.forEach((r, i) => {
    els['pLabel' + i] = { value: r.label };
    els['pSec' + i] = { value: String(r.sec) };
  });
  return { getElementById: (id) => els[id] || null };
}

test('reads back all rows when more than the old fixed length (no dropping)', () => {
  // 12 rendered presets — the old code would have saved only 8.
  const rows = Array.from({ length: 12 }, (_, i) => ({ label: 'p' + i, sec: i + 2 }));
  const doc = makeDoc(rows);
  const out = readPresets(doc, 12);
  assert.equal(out.length, 12);
  assert.equal(out[11].label, 'p11');
  assert.equal(out[11].ms, 13000);
});

test('reads back exactly the rendered rows when fewer than the old fixed length', () => {
  // 3 rendered presets — the old code would have fabricated 5 phantom rows.
  const rows = [
    { label: 'fast', sec: 5 },
    { label: 'med', sec: 30 },
    { label: 'slow', sec: 60 },
  ];
  const doc = makeDoc(rows);
  const out = readPresets(doc, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(p => p.label), ['fast', 'med', 'slow']);
  assert.deepEqual(out.map(p => p.ms), [5000, 30000, 60000]);
});

test('skips genuinely missing rows instead of fabricating defaults', () => {
  // count is larger than the rows that exist — missing rows must be skipped.
  const doc = makeDoc([{ label: 'only', sec: 10 }]);
  const out = readPresets(doc, 8);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'only');
});

test('floors each preset to the 2s minimum and defaults a blank seconds field', () => {
  const doc = makeDoc([
    { label: 'tiny', sec: 1 },   // below floor
    { label: 'blank', sec: '' }, // empty → default 30s
  ]);
  const out = readPresets(doc, 2);
  assert.equal(out[0].ms, 2000);
  assert.equal(out[1].ms, 30000);
});

test('falls back to a positional label when the label field is empty', () => {
  const doc = makeDoc([{ label: '', sec: 10 }]);
  const out = readPresets(doc, 1);
  assert.equal(out[0].label, '1'); // String(i + 1)
});
