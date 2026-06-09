// Tests for the best-effort regex-safety guard (ReDoS heuristic + length cap)
// and keyword-pattern length sanitization in validators.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

test('accepts ordinary, simple patterns', () => {
  assert.equal(V.isSafeRegex('price: \\$\\d+'), true);
  assert.equal(V.isSafeRegex('in ?stock'), true);
  assert.equal(V.isSafeRegex('(cat|dog|bird)'), true);
  assert.equal(V.isSafeRegex('\\bsale\\b'), true);
});

test('rejects invalid regex syntax', () => {
  assert.equal(V.isSafeRegex('(unclosed'), false);
  assert.equal(V.isSafeRegex('a{2,1}'), false); // invalid quantifier range
  assert.equal(V.isSafeRegex('['), false);
});

test('rejects empty and non-string', () => {
  assert.equal(V.isSafeRegex(''), false);
  assert.equal(V.isSafeRegex(null), false);
  assert.equal(V.isSafeRegex(42), false);
});

test('rejects over-long patterns', () => {
  assert.equal(V.isSafeRegex('a'.repeat(V.MAX_REGEX_LEN + 1)), false);
});

test('rejects classic ReDoS shapes (nested quantifiers)', () => {
  assert.equal(V.isSafeRegex('(a+)+'), false);
  assert.equal(V.isSafeRegex('(a*)*'), false);
  assert.equal(V.isSafeRegex('(.+)+'), false);
  assert.equal(V.isSafeRegex('(a+)+$'), false);
  assert.equal(V.isSafeRegex('(a+){5,}'), false);
});

test('rejects unbounded open-ended group repetition', () => {
  assert.equal(V.isSafeRegex('(abc){3,}'), false);
});

test('rejects a pile of stacked quantifiers', () => {
  assert.equal(V.isSafeRegex('a*b*c*d*e*f*g*h*i*j*k*l*m*'), false);
});

test('rejects quantified alternation groups with overlapping branches', () => {
  // Exponential without any nested quantifier — the shape the nested-quantifier
  // heuristic can't see.
  assert.equal(V.isSafeRegex('(a|a)+b'), false);     // identical branches
  assert.equal(V.isSafeRegex('(a|ab)*c'), false);    // prefix overlap
  assert.equal(V.isSafeRegex('(ab|a)*c'), false);    // prefix overlap, reversed
  assert.equal(V.isSafeRegex('(.|\\n)*stock'), false); // the classic user idiom
  assert.equal(V.isSafeRegex('(?:x|x)+y'), false);   // non-capturing form
  assert.equal(V.isSafeRegex('(a|)+b'), false);      // empty branch
  assert.equal(V.isSafeRegex('(a|b){2,4}'), true);   // disjoint branches are fine
});

test('keeps accepting reasonable alternations', () => {
  assert.equal(V.isSafeRegex('(cat|dog|bird)+'), true);  // disjoint branches
  assert.equal(V.isSafeRegex('(in|out) of stock'), true); // unquantified group
  assert.equal(V.isSafeRegex('colou?r'), true);
  assert.equal(V.isSafeRegex('\\$(\\d|,)+'), true);       // \d vs ',' — disjoint
});

test('sanitizeKeywordPattern caps length and coerces non-strings', () => {
  assert.equal(V.sanitizeKeywordPattern('abc'), 'abc');
  assert.equal(V.sanitizeKeywordPattern('a'.repeat(V.MAX_KEYWORD_LEN + 50)).length, V.MAX_KEYWORD_LEN);
  assert.equal(V.sanitizeKeywordPattern(123), '');
});

test('import disables an unsafe regex keyword in popupSettings', () => {
  const res = V.sanitizeImportedSettings({ popupSettings: { keyword: '(a+)+', kwRegex: true } });
  assert.equal(res.ok, true);
  assert.equal(res.value.popupSettings.kwRegex, false);
  assert.ok(res.errors.some(e => /unsafe regex/.test(e)));
});

test('import keeps a safe regex keyword', () => {
  const res = V.sanitizeImportedSettings({ popupSettings: { keyword: '\\d+', kwRegex: true } });
  assert.equal(res.value.popupSettings.kwRegex, true);
  assert.equal(res.value.popupSettings.keyword, '\\d+');
});
