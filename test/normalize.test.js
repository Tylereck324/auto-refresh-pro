// Tests for noise-tolerant change detection helpers.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, changedFraction, isMeaningfulChange } = require('../normalize.js');

// ── normalize ────────────────────────────────────────────────────────────────
test('normalize collapses whitespace runs and trims', () => {
  assert.equal(normalize('  a\n\t b   c  '), 'a b c');
});

test('normalize collapses digit runs when collapseDigits set', () => {
  assert.equal(normalize('updated 12:34:56', { collapseDigits: true }), 'updated 0:0:0');
  assert.equal(normalize('updated 12:34:56'), 'updated 12:34:56'); // off by default
});

test('normalize coerces non-strings to empty', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

// ── changedFraction ──────────────────────────────────────────────────────────
test('changedFraction is 0 for identical token sets, 1 for disjoint', () => {
  assert.equal(changedFraction('a b c', 'a b c'), 0);
  assert.equal(changedFraction('a b c', 'x y z'), 1);
});

test('changedFraction is between 0 and 1 for partial overlap', () => {
  const f = changedFraction('a b c d', 'a b x y');
  assert.ok(f > 0 && f < 1);
});

test('changedFraction treats two empties as identical', () => {
  assert.equal(changedFraction('', ''), 0);
});

// ── isMeaningfulChange ───────────────────────────────────────────────────────
test('a timestamp-only change is NOT meaningful when digits are collapsed', () => {
  const prev = 'Last updated 10:00:00 — 5 items';
  const curr = 'Last updated 10:00:05 — 5 items';
  assert.equal(isMeaningfulChange(prev, curr, { collapseDigits: true }), false);
});

test('a real word change IS meaningful', () => {
  assert.equal(isMeaningfulChange('in stock', 'sold out', { collapseDigits: true }), true);
});

test('whitespace-only churn is never meaningful', () => {
  assert.equal(isMeaningfulChange('a  b', 'a\nb', {}), false);
});

test('threshold gates small changes', () => {
  const prev = 'one two three four five six seven eight nine ten';
  const curr = 'one two three four five six seven eight nine XXX'; // 1/10 tokens differ
  assert.equal(isMeaningfulChange(prev, curr, { minChangedFraction: 0 }), true);
  assert.equal(isMeaningfulChange(prev, curr, { minChangedFraction: 0.5 }), false);
});
