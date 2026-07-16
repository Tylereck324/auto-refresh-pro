// Tests for URL match-pattern (glob) validation and compilation, plus URL-rule
// sanitization. The compiled matcher must not let host wildcards cross into the
// path, and must never accept privileged schemes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

// ── isSafeUrlGlob ────────────────────────────────────────────────────────────
test('accepts well-formed match patterns', () => {
  assert.equal(V.isSafeUrlGlob('*://*.example.com/*'), true);
  assert.equal(V.isSafeUrlGlob('https://example.com/*'), true);
  assert.equal(V.isSafeUrlGlob('http://localhost:3000/path'), true);
  assert.equal(V.isSafeUrlGlob('https://*/*'), true);
});

test('rejects privileged / dangerous schemes', () => {
  assert.equal(V.isSafeUrlGlob('file://*/*'), false);
  assert.equal(V.isSafeUrlGlob('javascript://x/*'), false);
  assert.equal(V.isSafeUrlGlob('data://x/*'), false);
  assert.equal(V.isSafeUrlGlob('chrome://settings/*'), false);
});

test('rejects malformed / empty / oversized patterns', () => {
  assert.equal(V.isSafeUrlGlob('example.com'), false);      // no scheme
  assert.equal(V.isSafeUrlGlob('https://example.com'), false); // no path
  assert.equal(V.isSafeUrlGlob('https:// example.com/*'), false); // space
  assert.equal(V.isSafeUrlGlob(''), false);
  assert.equal(V.isSafeUrlGlob('https://' + 'a'.repeat(300) + '/*'), false);
  assert.equal(V.isSafeUrlGlob(null), false);
});

// ── compileUrlGlob matching ──────────────────────────────────────────────────
test('subdomain wildcard matches domain and subdomains', () => {
  const m = V.compileUrlGlob('*://*.example.com/*');
  assert.equal(m.ok, true);
  assert.equal(m.test('https://example.com/'), true);
  assert.equal(m.test('http://www.example.com/path?q=1'), true);
  assert.equal(m.test('https://deep.sub.example.com/x'), true);
  assert.equal(m.test('https://example.org/'), false);
});

test('host wildcard cannot cross into the path (no spoofing)', () => {
  const m = V.compileUrlGlob('https://*.example.com/*');
  // A host that is NOT under example.com must not match even if the path
  // contains the literal ".example.com/".
  assert.equal(m.test('https://evil.com/.example.com/x'), false);
});

test('exact host + path prefix matches as expected', () => {
  const m = V.compileUrlGlob('https://news.site/*');
  assert.equal(m.test('https://news.site/article/123'), true);
  assert.equal(m.test('https://news.site.evil.com/x'), false);
  assert.equal(m.test('http://news.site/x'), false); // scheme is https-only here
});

test('pattern host casing is normalized (tab URLs have lowercase hosts)', () => {
  // isSafeUrlGlob accepts mixed-case hosts, but the URL a rule is tested
  // against is browser-normalized to lowercase — a rule typed with a capital
  // letter used to silently never match anything.
  assert.equal(V.compileUrlGlob('https://Example.com/*').test('https://example.com/page'), true);
  assert.equal(V.compileUrlGlob('*://*.Prolific.co/*').test('https://app.prolific.co/studies'), true);
  // Paths stay case-sensitive — they are on the server side too.
  assert.equal(V.compileUrlGlob('https://example.com/Studies').test('https://example.com/studies'), false);
});

test('invalid glob compiles to a non-matcher', () => {
  const m = V.compileUrlGlob('not a pattern');
  assert.equal(m.ok, false);
  assert.equal(m.test('https://anything/'), false);
});

// ── sanitizeUrlRules ─────────────────────────────────────────────────────────
test('sanitizeUrlRules drops unsafe patterns and rebuilds settings', () => {
  const rules = V.sanitizeUrlRules([
    { pattern: '*://*.ok.com/*', settings: { interval: 5000, sound: true } },
    { pattern: 'file://evil/*', settings: { interval: 5000 } },     // unsafe → dropped
    { pattern: 'https://x.com/*', settings: { keyword: '(a+)+', kwRegex: true } }, // unsafe regex neutralized
  ]);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, '*://*.ok.com/*');
  assert.equal(rules[0].settings.sound, true);
  assert.equal(rules[0].settings.interval, 5000);
  assert.equal(rules[1].settings.kwRegex, false); // ReDoS pattern downgraded to literal
});

test('sanitizeRuleSettings carries bounded sound + noise sub-settings', () => {
  const out = V.sanitizeRuleSettings({
    interval: 5000,
    sound: true, soundTone: 'chime', soundVolume: 0.5, soundRepeat: 3, beepUntilAck: true,
    flashOnKeyword: true,
    monitorMode: true, noiseTolerant: true, collapseDigits: false, minChangedFraction: 0.25,
    preserveScroll: true,
  });
  assert.equal(out.soundTone, 'chime');
  assert.equal(out.soundVolume, 0.5);
  assert.equal(out.soundRepeat, 3);
  assert.equal(out.beepUntilAck, true);
  assert.equal(out.flashOnKeyword, true);
  assert.equal(out.noiseTolerant, true);
  assert.equal(out.collapseDigits, false);
  assert.equal(out.minChangedFraction, 0.25);
  assert.equal(out.preserveScroll, true);
});

test('sanitizeRuleSettings coerces flashOnKeyword to a boolean (default off)', () => {
  assert.equal(V.sanitizeRuleSettings({}).flashOnKeyword, false);
  assert.equal(V.sanitizeRuleSettings({ flashOnKeyword: 'truthy' }).flashOnKeyword, true);
  assert.equal(V.sanitizeRuleSettings({ flashOnKeyword: 0 }).flashOnKeyword, false);
});

test('sanitizeRuleSettings bounds out-of-range / garbage sound values', () => {
  const out = V.sanitizeRuleSettings({
    soundVolume: 99, soundRepeat: 1000, minChangedFraction: -5, soundTone: 12345,
  });
  assert.equal(out.soundVolume, 1);     // clamped to [0,1]
  assert.equal(out.soundRepeat, 5);     // clamped to [1,5]
  assert.equal(out.minChangedFraction, 0); // clamped to [0,1]
  assert.equal(out.soundTone, 'beep');  // non-string → default
  assert.equal(out.collapseDigits, true); // absent → defaults on
});

test('sanitizeUrlRules enforces the rule count cap', () => {
  const many = Array.from({ length: V.MAX_URL_RULES + 20 }, () => ({ pattern: 'https://x.com/*' }));
  assert.equal(V.sanitizeUrlRules(many).length, V.MAX_URL_RULES);
});

test('import sanitizes urlRules', () => {
  const res = V.sanitizeImportedSettings({ urlRules: [
    { pattern: 'https://good.com/*' },
    { pattern: 'javascript://bad/*' },
  ] });
  assert.equal(res.value.urlRules.length, 1);
  assert.ok(res.errors.some(e => /unsafe URL rule/.test(e)));
});
