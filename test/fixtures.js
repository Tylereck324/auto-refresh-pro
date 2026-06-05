// Shared PNG / image byte fixtures for the security tests.
'use strict';

// Build a structurally valid PNG header (signature + IHDR) for the given
// dimensions. isValidPng only inspects the signature + IHDR, so a header-only
// buffer padded to `totalLen` is a faithful "valid PNG" for validation tests.
function makePng({ width = 1, height = 1, bitDepth = 8, colorType = 6, totalLen = 67 } = {}) {
  const len = Math.max(33, totalLen);
  const b = Buffer.alloc(len);
  // 8-byte PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);          // IHDR length
  b.write('IHDR', 12, 'ascii');    // IHDR type
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = bitDepth;
  b[25] = colorType;
  return new Uint8Array(b);
}

// A real, decoder-valid 1x1 transparent PNG (used for the data: URL round-trip).
const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function toDataUrl(mime, bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}

module.exports = { makePng, toDataUrl, REAL_PNG_BASE64 };
