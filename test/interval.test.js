// Characterization + regression tests for refresh-interval computation.
// Locks in the existing fixed/random behavior and guards the NaN-hardening fix.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeInterval, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS } = require('../interval.js');

// ── Characterization: fixed interval ──────────────────────────────────────
test('fixed mode returns the configured interval unchanged', () => {
  assert.equal(computeInterval({ interval: 5000 }), 5000);
  assert.equal(computeInterval({ interval: 60000 }), 60000);
});

test('fixed mode floors a sub-minimum interval to the 2s floor', () => {
  assert.equal(computeInterval({ interval: 1000 }), MIN_INTERVAL_MS);
});

// ── Regression: a missing/garbage interval must not yield NaN ──────────────
// Before extraction, computeInterval returned `settings.interval` verbatim, so
// an undefined/NaN interval became `delayInMinutes: NaN` (alarm never fires)
// and `nextRefresh: NaN` (empty countdown). It now falls back to the default.
test('fixed mode falls back to the 30s default for a missing interval', () => {
  assert.equal(computeInterval({}), DEFAULT_INTERVAL_MS);
  assert.equal(computeInterval({ interval: undefined }), DEFAULT_INTERVAL_MS);
  assert.equal(computeInterval({ interval: NaN }), DEFAULT_INTERVAL_MS);
  assert.equal(computeInterval({ interval: 'oops' }), DEFAULT_INTERVAL_MS);
  assert.equal(computeInterval(undefined), DEFAULT_INTERVAL_MS);
  assert.ok(Number.isFinite(computeInterval({})));
});

// ── Characterization: random interval ─────────────────────────────────────
test('random mode returns a value within [min, max], floored to the 2s floor', () => {
  for (let i = 0; i < 200; i++) {
    const v = computeInterval({ randomTimer: true, randomMin: 5000, randomMax: 9000 });
    assert.ok(v >= 5000 && v <= 9000, `got ${v}`);
    assert.equal(v, Math.floor(v));
  }
});

test('random mode swaps an inverted range instead of going negative-width', () => {
  for (let i = 0; i < 200; i++) {
    const v = computeInterval({ randomTimer: true, randomMin: 9000, randomMax: 5000 });
    assert.ok(v >= 5000 && v <= 9000, `got ${v}`);
  }
});

test('random mode floors sub-2s bounds to the 2s floor', () => {
  for (let i = 0; i < 200; i++) {
    const v = computeInterval({ randomTimer: true, randomMin: 100, randomMax: 100 });
    assert.equal(v, MIN_INTERVAL_MS);
  }
});

test('random mode uses defaults when bounds are missing', () => {
  for (let i = 0; i < 200; i++) {
    const v = computeInterval({ randomTimer: true });
    assert.ok(v >= 5000 && v <= 30000, `got ${v}`);
  }
});
