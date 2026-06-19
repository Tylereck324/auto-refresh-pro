// Tests for noise-tolerant change detection helpers.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, changedFraction, isMeaningfulChange, diffTokens } = require('../normalize.js');

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

test('at-cap truncation: an early counter tick does not read as a change', () => {
  const { MAX_SCAN } = require('../normalize.js');
  // A length change EARLY in an over-cap document ("99" → "100") shifts every
  // later character, so the cap cuts mid-token in a different place — without
  // dropping the boundary token, that cut noise alone flagged a change even
  // with collapseDigits on. Pad with spaces (collapsed away) so the cut lands
  // mid-token, the common case a 1-char shift produces.
  const build = (prefix) => {
    let pad = '';
    while ((MAX_SCAN - (prefix.length + pad.length)) % 5 !== 3) pad += ' ';
    return prefix + pad + 'word '.repeat(Math.ceil(MAX_SCAN / 5) + 10);
  };
  const prev = build('id 99 ');
  const curr = build('id 100 ');
  assert.equal(
    isMeaningfulChange(prev, curr, { collapseDigits: true, minChangedFraction: 0 }),
    false
  );
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

// ── diffTokens ───────────────────────────────────────────────────────────────
test('diffTokens reports added and removed tokens', () => {
  const d = diffTokens('in stock $19.99', 'sold out $19.99');
  assert.deepEqual(d.added.sort(), ['out', 'sold']);
  assert.deepEqual(d.removed.sort(), ['in', 'stock']);
  assert.ok(d.summary.includes('+sold'));
  assert.ok(d.summary.includes('−in') || d.summary.includes('−stock'));
});

test('diffTokens keeps digits by default (so prices are visible)', () => {
  const d = diffTokens('price 19', 'price 24');
  assert.deepEqual(d.added, ['24']);
  assert.deepEqual(d.removed, ['19']);
});

test('diffTokens bounds each side to opts.max', () => {
  const prev = '';
  const curr = Array.from({ length: 50 }, (_, i) => 'w' + i).join(' ');
  const d = diffTokens(prev, curr, { max: 5 });
  assert.equal(d.added.length, 5);
  assert.equal(d.removed.length, 0);
});

test('diffTokens caps the rendered summary length', () => {
  const curr = Array.from({ length: 200 }, (_, i) => 'longtoken' + i).join(' ');
  const d = diffTokens('', curr, { max: 100 });
  assert.ok(d.summary.length <= 240, `summary was ${d.summary.length}`);
});

test('diffTokens coerces non-strings to empty', () => {
  const d = diffTokens(null, undefined);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.summary, '');
});
