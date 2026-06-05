// PNG / image handling security tests.
//
// Goal coverage: the extension must ACCEPT valid PNGs and safely REJECT
// corrupt, oversized, type-confused, and decompression-bomb inputs before any
// decoder or <img> touches them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../validators.js');
const { makePng, toDataUrl, REAL_PNG_BASE64 } = require('./fixtures.js');

test('accepts the extension\'s own bundled icon PNGs', () => {
  for (const name of ['icon16.png', 'icon48.png', 'icon128.png']) {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'icons', name));
    assert.equal(V.isValidPng(new Uint8Array(bytes), { maxBytes: 2 * 1024 * 1024 }), true,
      name + ' should validate as a real PNG');
  }
});

test('accepts a structurally valid PNG', () => {
  assert.equal(V.isValidPng(makePng({ width: 16, height: 16 })), true);
});

test('accepts a real decoder-valid 1x1 PNG (base64 round-trip)', () => {
  const bytes = V.decodeBase64ToBytes(REAL_PNG_BASE64);
  assert.ok(bytes, 'base64 should decode');
  assert.equal(V.isValidPng(bytes), true);
});

test('rejects a buffer with a corrupt signature', () => {
  const png = makePng();
  png[1] = 0x00; // corrupt the signature
  assert.equal(V.isValidPng(png), false);
});

test('rejects a truncated PNG (header cut short)', () => {
  const png = makePng();
  assert.equal(V.isValidPng(png.slice(0, 20)), false);
});

test('rejects a PNG whose first chunk is not IHDR', () => {
  const png = makePng();
  png[12] = 0x49; png[13] = 0x44; png[14] = 0x41; png[15] = 0x54; // 'IDAT'
  assert.equal(V.isValidPng(png), false);
});

test('rejects zero-dimension PNG', () => {
  assert.equal(V.isValidPng(makePng({ width: 0, height: 10 })), false);
  assert.equal(V.isValidPng(makePng({ width: 10, height: 0 })), false);
});

test('rejects a decompression-bomb dimension header', () => {
  // A few bytes declaring a 4-billion-pixel-wide canvas.
  assert.equal(V.isValidPng(makePng({ width: 0xffffffff, height: 0xffffffff })), false);
  assert.equal(V.isValidPng(makePng({ width: 100000, height: 100000 })), false);
});

test('rejects invalid bit depth / colour type', () => {
  assert.equal(V.isValidPng(makePng({ bitDepth: 7 })), false);
  assert.equal(V.isValidPng(makePng({ colorType: 9 })), false);
});

test('rejects an oversized PNG (size cap)', () => {
  const huge = makePng({ totalLen: V.MAX_IMAGE_BYTES + 1 });
  assert.equal(V.isValidPng(huge), false);
});

test('rejects non-PNG bytes (JPEG magic) as PNG', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(V.isValidPng(jpeg), false);
});

// ── isSafeImageSrc (favicon rendering path) ─────────────────────────────────

test('isSafeImageSrc accepts http(s) favicon URLs', () => {
  assert.equal(V.isSafeImageSrc('https://example.com/favicon.ico'), true);
  assert.equal(V.isSafeImageSrc('http://example.com/favicon.png'), true);
});

test('isSafeImageSrc accepts a valid data:image/png favicon', () => {
  assert.equal(V.isSafeImageSrc(`data:image/png;base64,${REAL_PNG_BASE64}`), true);
});

test('isSafeImageSrc rejects javascript: and file: schemes', () => {
  assert.equal(V.isSafeImageSrc('javascript:alert(1)'), false);
  assert.equal(V.isSafeImageSrc('file:///etc/passwd'), false);
  assert.equal(V.isSafeImageSrc('vbscript:msgbox(1)'), false);
});

test('isSafeImageSrc rejects data:image/svg+xml (active content)', () => {
  const svg = 'data:image/svg+xml;base64,' +
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal(V.isSafeImageSrc(svg), false);
});

test('isSafeImageSrc rejects a data: URL whose MIME lies about its bytes', () => {
  // Claims PNG, actually carries SVG/script bytes.
  const lie = toDataUrl('image/png', Buffer.from('<svg onload=alert(1)>'));
  assert.equal(V.isSafeImageSrc(lie), false);
});

test('isSafeImageSrc rejects oversized inline image', () => {
  const big = makePng({ totalLen: V.MAX_IMAGE_BYTES + 10 });
  assert.equal(V.isSafeImageSrc(toDataUrl('image/png', big)), false);
});

test('isSafeImageSrc rejects empty / non-string', () => {
  assert.equal(V.isSafeImageSrc(''), false);
  assert.equal(V.isSafeImageSrc(null), false);
  assert.equal(V.isSafeImageSrc(undefined), false);
  assert.equal(V.isSafeImageSrc(12345), false);
});
