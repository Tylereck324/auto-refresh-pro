// Tests for the per-item detection helpers: stable key derivation (whitespace-
// and optionally digit-insensitive), matching-key collection with dedup, and the
// arrival/departure set diff that drives "alert on each new match".
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { itemKey, collectMatches, computeNewKeys } = require('../item-detect.js');
const { compileMatcher } = require('../keyword-match.js');

// ── itemKey ──────────────────────────────────────────────────────────────────
test('itemKey is stable across whitespace/line-break differences', () => {
  // The same card read with the innerText line break vs. flattened must key equal.
  assert.equal(
    itemKey('AI Videos - Evaluation\nBy Vortex Oasis'),
    itemKey('AI Videos - Evaluation   By Vortex Oasis')
  );
});

test('itemKey distinguishes different items (different author / title)', () => {
  const a = itemKey('AI Videos - Evaluation\nBy Vortex Oasis');
  const b = itemKey('AI Videos - Evaluation\nBy Galactic Probe');
  const c = itemKey('AI Images - Evaluation\nBy Vortex Oasis');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('itemKey returns short non-empty strings; empty/garbage → empty', () => {
  const k = itemKey('something');
  assert.equal(typeof k, 'string');
  assert.ok(k.length > 0 && k.length <= 8);
  assert.equal(itemKey('   \n\t '), '');
  assert.equal(itemKey(42), '');
});

test('itemKey collapseDigits folds volatile numbers (relative times/counters)', () => {
  // OFF by default: distinct timestamps stay distinct.
  assert.notEqual(itemKey('Study A • posted 2 min ago'), itemKey('Study A • posted 9 min ago'));
  // ON: the digit churn is folded so the same card keys equal across reloads.
  assert.equal(
    itemKey('Study A • posted 2 min ago', { collapseDigits: true }),
    itemKey('Study A • posted 9 min ago', { collapseDigits: true })
  );
});

// ── collectMatches ───────────────────────────────────────────────────────────
test('collectMatches returns keys only for matching items, de-duplicated', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const items = [
    'AI Videos - Evaluation\nBy Vortex Oasis',
    'Quick survey about coffee\nBy Someone',          // no match
    'AI Images - Evaluation\nBy Galactic Probe',
    'AI Videos - Evaluation\nBy Vortex Oasis',         // duplicate of #1
  ];
  const keys = collectMatches(items, m);
  assert.equal(keys.length, 2); // two distinct matching cards, dupe collapsed
  assert.deepEqual(keys, [itemKey(items[0]), itemKey(items[2])]);
});

test('collectMatches is safe on bad input', () => {
  const m = compileMatcher({ keyword: 'x' });
  assert.deepEqual(collectMatches(null, m), []);
  assert.deepEqual(collectMatches(['x'], null), []);
  assert.deepEqual(collectMatches([null, '', 42, 'x'], m), [itemKey('x')]);
});

// ── computeNewKeys ───────────────────────────────────────────────────────────
test('computeNewKeys returns arrivals in normal mode', () => {
  assert.deepEqual(computeNewKeys(['a', 'b'], ['b', 'c', 'd'], false), ['c', 'd']);
  // Nothing new while the same matches persist — the headline under-firing fix.
  assert.deepEqual(computeNewKeys(['a', 'b'], ['a', 'b'], false), []);
});

test('computeNewKeys returns departures in inverse mode', () => {
  assert.deepEqual(computeNewKeys(['a', 'b', 'c'], ['b'], true), ['a', 'c']);
  assert.deepEqual(computeNewKeys(['a'], ['a'], true), []);
});

test('computeNewKeys treats an empty baseline as real (everything is new)', () => {
  assert.deepEqual(computeNewKeys([], ['a', 'b'], false), ['a', 'b']);
});

test('end-to-end: a new card fires while persistent matches stay quiet', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const cycle1 = ['AI Videos - Evaluation\nBy Vortex Oasis'];
  const cycle2 = [
    'AI Videos - Evaluation\nBy Vortex Oasis',          // still there
    'AI Images - Evaluation\nBy Galactic Probe',         // NEW
  ];
  const k1 = collectMatches(cycle1, m);
  const k2 = collectMatches(cycle2, m);
  const fired = computeNewKeys(k1, k2, false);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired, [itemKey(cycle2[1])]);
});
