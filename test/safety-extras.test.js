// Tests for the newer validators: CSS selector, webhook URL (SSRF guard),
// and the domain denylist.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validators.js');

// ── isSafeSelector ─────────────────────────────────────────────────────────
test('isSafeSelector accepts ordinary selectors', () => {
  assert.equal(V.isSafeSelector('#price'), true);
  assert.equal(V.isSafeSelector('.stock-status'), true);
  assert.equal(V.isSafeSelector('div[data-test="qty"] > span'), true);
  assert.equal(V.isSafeSelector('  .a .b  '), true); // trimmed
});

test('isSafeSelector rejects markup/injection chars, empties, and over-long', () => {
  assert.equal(V.isSafeSelector('<script>'), false);
  assert.equal(V.isSafeSelector('a{color:red}'), false);
  assert.equal(V.isSafeSelector('a;b'), false);
  assert.equal(V.isSafeSelector(''), false);
  assert.equal(V.isSafeSelector('   '), false);
  assert.equal(V.isSafeSelector('x'.repeat(201)), false);
  assert.equal(V.isSafeSelector(42), false);
});

// ── isSafeWebhookUrl + SSRF guard ──────────────────────────────────────────
test('isSafeWebhookUrl accepts public https endpoints', () => {
  assert.equal(V.isSafeWebhookUrl('https://discord.com/api/webhooks/123/abc'), true);
  assert.equal(V.isSafeWebhookUrl('https://hooks.slack.com/services/T/B/x'), true);
  assert.equal(V.isSafeWebhookUrl('https://example.com:8443/hook'), true);
});

test('isSafeWebhookUrl rejects non-https and credentialed URLs', () => {
  assert.equal(V.isSafeWebhookUrl('http://example.com/hook'), false); // cleartext
  assert.equal(V.isSafeWebhookUrl('ftp://example.com/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://user:pass@example.com/x'), false);
  assert.equal(V.isSafeWebhookUrl(''), false);
  assert.equal(V.isSafeWebhookUrl('not a url'), false);
});

test('isSafeWebhookUrl blocks SSRF targets (loopback / private / metadata)', () => {
  assert.equal(V.isSafeWebhookUrl('https://localhost/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://127.0.0.1/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://10.0.0.5/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://192.168.1.1/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://172.16.5.5/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(V.isSafeWebhookUrl('https://100.64.1.1/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://service.local/x'), false);
  assert.equal(V.isSafeWebhookUrl('https://[::1]/x'), false);
});

test('isPrivateHost lets ordinary public hosts through', () => {
  assert.equal(V.isPrivateHost('example.com'), false);
  assert.equal(V.isPrivateHost('8.8.8.8'), false);
  assert.equal(V.isPrivateHost('172.32.0.1'), false); // just outside 172.16/12
});

test('isSafeWebhookUrl blocks IPv6-embedded IPv4 SSRF (mapped/compatible/NAT64)', () => {
  // These all normalize to an internal IPv4 at the socket layer — must be denied.
  assert.equal(V.isSafeWebhookUrl('https://[::ffff:127.0.0.1]/x'), false);      // mapped loopback
  assert.equal(V.isSafeWebhookUrl('https://[::ffff:169.254.169.254]/x'), false); // mapped metadata
  assert.equal(V.isSafeWebhookUrl('https://[::ffff:10.0.0.5]/x'), false);        // mapped private
  assert.equal(V.isSafeWebhookUrl('https://[::127.0.0.1]/x'), false);            // compatible loopback
  assert.equal(V.isSafeWebhookUrl('https://[64:ff9b::7f00:1]/x'), false);        // NAT64 of 127.0.0.1
  assert.equal(V.isSafeWebhookUrl('https://[fe80::1]/x'), false);                // link-local
  assert.equal(V.isSafeWebhookUrl('https://[fc00::1]/x'), false);                // ULA
});

test('isSafeWebhookUrl allows a genuinely public IPv6 literal (global unicast)', () => {
  assert.equal(V.isSafeWebhookUrl('https://[2606:4700:4700::1111]/x'), true);
});

test('isSafeWebhookUrl blocks trailing-dot loopback names', () => {
  assert.equal(V.isSafeWebhookUrl('https://localhost./x'), false);
  assert.equal(V.isSafeWebhookUrl('https://service.local./x'), false);
});

test('isUrlDenied canonicalizes a trailing-dot FQDN (cannot bypass a rule)', () => {
  assert.equal(V.isUrlDenied('https://mail.google.com./inbox', ['mail.google.com']), true);
  assert.equal(V.isUrlDenied('https://secure.bank.com./login', ['*.bank.com']), true);
  // A trailing dot on the pattern itself is normalized too.
  assert.equal(V.isUrlDenied('https://mail.google.com/inbox', ['mail.google.com.']), true);
});

// ── denylist ───────────────────────────────────────────────────────────────
test('isUrlDenied matches exact host, subdomain wildcard, and global', () => {
  assert.equal(V.isUrlDenied('https://mail.google.com/inbox', ['mail.google.com']), true);
  assert.equal(V.isUrlDenied('https://www.google.com/', ['mail.google.com']), false);
  assert.equal(V.isUrlDenied('https://secure.bank.com/login', ['*.bank.com']), true);
  assert.equal(V.isUrlDenied('https://bank.com/login', ['*.bank.com']), true); // apex matches *.
  assert.equal(V.isUrlDenied('https://anything.com/', ['*']), true);
  assert.equal(V.isUrlDenied('https://example.com/', []), false);
  assert.equal(V.isUrlDenied('not a url', ['*']), false); // unparseable → not denied
});

test('sanitizeDenylist bounds, dedupes, lowercases, and drops garbage', () => {
  const out = V.sanitizeDenylist(['Mail.Google.com', 'mail.google.com', '*.bank.com', 'has space', '', 42, 'ok.com']);
  assert.deepEqual(out, ['mail.google.com', '*.bank.com', 'ok.com']);
});

test('sanitizeQuietHours bounds times and coerces shape', () => {
  const q = V.sanitizeQuietHours({ enabled: 1, startMin: '1320', endMin: 9999, mode: 'pause', days: [1,0,0,0,0,0,1] });
  assert.equal(q.enabled, true);
  assert.equal(q.startMin, 1320);
  assert.equal(q.endMin, 0); // 9999 out of range → default 0
  assert.equal(q.mode, 'pause');
  assert.deepEqual(q.days, [true, false, false, false, false, false, true]);
  assert.equal(V.sanitizeQuietHours(null), null);
});
