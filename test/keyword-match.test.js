// Tests for the keyword matcher: backward-compat substring, multi-keyword,
// whole-word, case sensitivity, regex compile/failure, and the inverse flag's
// transition semantics (exercised through compileMatcher's test()).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileMatcher, parseKeywords } = require('../keyword-match.js');

// ── parseKeywords ──────────────────────────────────────────────────────────
test('parseKeywords splits on commas and trims, dropping empties', () => {
  assert.deepEqual(parseKeywords('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseKeywords('solo'), ['solo']);
  assert.deepEqual(parseKeywords(' , ,'), []);
  assert.deepEqual(parseKeywords(42), []);
});

// ── Backward compatibility: plain case-insensitive substring ────────────────
test('plain keyword is case-insensitive substring (matches legacy behavior)', () => {
  const m = compileMatcher({ keyword: 'InStock' });
  assert.equal(m.ok, true);
  assert.equal(m.empty, false);
  assert.equal(m.test('item is instock now'), true);
  assert.equal(m.test('out of stock'), false);
});

test('empty keyword yields an empty matcher that never fires', () => {
  const m = compileMatcher({ keyword: '   ' });
  assert.equal(m.empty, true);
  assert.equal(m.test('anything'), false);
});

// ── Multi-keyword (ANY) ──────────────────────────────────────────────────────
test('comma-separated keywords match ANY term', () => {
  const m = compileMatcher({ keyword: 'apple, banana' });
  assert.equal(m.test('fresh BANANA bread'), true);
  assert.equal(m.test('green apple'), true);
  assert.equal(m.test('cherry pie'), false);
});

// ── Whole word ───────────────────────────────────────────────────────────────
test('whole-word matches only on word boundaries', () => {
  const m = compileMatcher({ keyword: 'cat', kwWholeWord: true });
  assert.equal(m.test('the cat sat'), true);
  assert.equal(m.test('concatenate'), false);
});

test('whole-word works with multiple terms', () => {
  const m = compileMatcher({ keyword: 'cat, dog', kwWholeWord: true });
  assert.equal(m.test('a dog barks'), true);
  assert.equal(m.test('dogma'), false);
});

// ── Case sensitivity ─────────────────────────────────────────────────────────
test('case-sensitive keyword respects case', () => {
  const m = compileMatcher({ keyword: 'Sale', kwCaseSensitive: true });
  assert.equal(m.test('Big Sale today'), true);
  assert.equal(m.test('big sale today'), false);
});

// ── Regex ────────────────────────────────────────────────────────────────────
test('regex mode compiles and matches', () => {
  const m = compileMatcher({ keyword: 'price: \\$\\d+', kwRegex: true });
  assert.equal(m.ok, true);
  assert.equal(m.test('price: $42 today'), true);
  assert.equal(m.test('no price here'), false);
});

test('regex mode is case-insensitive unless caseSensitive set', () => {
  assert.equal(compileMatcher({ keyword: 'ABC', kwRegex: true }).test('abc'), true);
  assert.equal(compileMatcher({ keyword: 'ABC', kwRegex: true, kwCaseSensitive: true }).test('abc'), false);
});

test('invalid regex reports ok:false and never matches', () => {
  const m = compileMatcher({ keyword: '(unclosed', kwRegex: true });
  assert.equal(m.ok, false);
  assert.equal(m.test('(unclosed'), false);
});

test('isSafeRegex guard can veto a regex (matcher ok:false)', () => {
  const m = compileMatcher({ keyword: 'abc', kwRegex: true }, { isSafeRegex: () => false });
  assert.equal(m.ok, false);
  assert.equal(m.error, 'unsafe regex');
});

// ── Inverse transition truth table (computed by the caller, but verify the
//    test() values the caller relies on) ─────────────────────────────────────
test('test() drives absent/present detection for inverse logic', () => {
  const m = compileMatcher({ keyword: 'gone' });
  const prevHas = m.test('it is gone');   // true
  const currHas = m.test('it is here');   // false
  // normal fires on absent->present; inverse fires on present->absent
  const normalFires = currHas && !prevHas; // false here
  const inverseFires = !currHas && prevHas; // true here
  assert.equal(normalFires, false);
  assert.equal(inverseFires, true);
});
