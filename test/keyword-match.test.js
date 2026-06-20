// Tests for the keyword matcher: backward-compat substring, multi-keyword,
// whole-word, case sensitivity, regex compile/failure, whitespace-normalized
// phrase matching, and the inverse flag's transition semantics (exercised
// through compileMatcher's test()).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileMatcher, parseKeywords, normalizeWs } = require('../keyword-match.js');

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

test('whole-word matches non-ASCII keywords (ASCII-\\b regression)', () => {
  // \b is ASCII-only, so these silently never matched before the unicode-aware
  // lookaround boundaries: the matcher was ok:true and always returned false.
  const accented = compileMatcher({ keyword: 'café', kwWholeWord: true });
  assert.equal(accented.test('le café est bon'), true);
  assert.equal(accented.test('cafétéria'), false); // still bounded by letters
  const cjk = compileMatcher({ keyword: '在庫あり', kwWholeWord: true });
  assert.equal(cjk.test('状態: 在庫あり です'), true);
  const cyrillic = compileMatcher({ keyword: 'продано', kwWholeWord: true });
  assert.equal(cyrillic.test('товар продано вчера'), true);
  assert.equal(cyrillic.test('непродано'), false);
});

test('escaped comma is a literal, not a term separator', () => {
  // "1,000 in stock" used to split into "1" + "000 in stock" — and "1" matches
  // essentially any page. '\,' keeps the comma inside the term.
  const m = compileMatcher({ keyword: '1\\,000 in stock' });
  assert.equal(m.test('only 1,000 in stock today'), true);
  assert.equal(m.test('only 1 left'), false);
  // Unescaped commas still split into ANY-terms.
  const multi = compileMatcher({ keyword: 'cat, dog\\, esq' });
  assert.equal(multi.test('a cat'), true);
  assert.equal(multi.test('dog, esq'), true);
  assert.equal(multi.test('esq alone'), false);
});

test('whole-word handles terms ending in punctuation (C++)', () => {
  // Old \b needed a WORD char after the final '+', so "C++ developer" failed.
  const m = compileMatcher({ keyword: 'C++', kwWholeWord: true });
  assert.equal(m.test('senior C++ developer'), true);
  assert.equal(m.test('AC++ thing'), false); // still anchored on the left
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

// ── Whitespace normalization (phrase matching across line breaks) ────────────
test('normalizeWs collapses whitespace runs and trims', () => {
  assert.equal(normalizeWs('  AI Videos -\n  Evaluation '), 'AI Videos - Evaluation');
  assert.equal(normalizeWs('a\t\tb\nc'), 'a b c');
  assert.equal(normalizeWs(42), '');
});

test('plain phrase matches across the innerText line break (the headline fix)', () => {
  // document.body.innerText stacks a card's title and its "By <author>" line as
  // SEPARATE lines, so a phrase spanning the break is not a literal substring of
  // the raw text. Normalizing both sides makes it match.
  const m = compileMatcher({ keyword: 'Evaluation By Vortex' });
  const page = 'AI Videos - Evaluation\nBy Vortex Oasis\n20 Jun 2026, 12:59\nReward: $5.00';
  assert.equal(m.test(page), true);
});

test('plain phrase tolerates irregular spacing', () => {
  const m = compileMatcher({ keyword: 'in stock' });
  assert.equal(m.test('back   in\nstock today'), true);
});

test('extra spaces inside the keyword itself are normalized', () => {
  const m = compileMatcher({ keyword: 'AI   Videos' });
  assert.equal(m.test('watch the AI Videos demo'), true);
});

test('whole-word phrase matches across a line break and on boundaries', () => {
  const m = compileMatcher({ keyword: 'in stock', kwWholeWord: true });
  assert.equal(m.test('item is back  in\nstock now'), true);
  assert.equal(m.test('reinstock soon'), false); // still bounded as a whole word
});

test('regex mode is NOT whitespace-normalized (stays exact)', () => {
  // The user may match whitespace deliberately in regex mode, so the haystack is
  // left untouched: a single space in the pattern must not match a double space.
  const exact = compileMatcher({ keyword: 'foo bar', kwRegex: true });
  assert.equal(exact.test('foo bar'), true);
  assert.equal(exact.test('foo  bar'), false);
  // …and the user can opt into flexible whitespace explicitly with \s+.
  const flex = compileMatcher({ keyword: 'foo\\s+bar', kwRegex: true });
  assert.equal(flex.test('foo\n bar'), true);
});

test('recommended Prolific pattern catches every title variant, any author', () => {
  // "- Evaluation" (plain) is author-agnostic and title-word-agnostic.
  const m = compileMatcher({ keyword: '- Evaluation' });
  assert.equal(m.test('AI Videos - Evaluation\nBy Vortex Oasis'), true);
  assert.equal(m.test('AI Images - Evaluation\nBy Galactic Probe'), true);
  assert.equal(m.test('AI Audio - Evaluation\nBy rcbHU NUGdo'), true);
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
