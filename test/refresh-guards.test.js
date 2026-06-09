// Boundary tests for the refresh-loop timing guards. The whole point is to pin
// that the backstop dedup uses a strict `<` against HALF the interval and the
// notify throttle uses an inclusive `>=` against the FULL gap — so flipping
// either operator or dropping the *0.5 factor fails a test.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBackstopDuplicate, shouldNotifyRefresh } = require('../refresh-guards.js');

// ── Backstop dedup: within 0.5 * interval of the last refresh ─────────────────
test('first refresh (falsy lastRefresh) is never a duplicate', () => {
  assert.equal(isBackstopDuplicate(0, 1000, 1000), false);
  assert.equal(isBackstopDuplicate(undefined, 1000, 1000), false);
});

test('a fire within half the interval is a duplicate', () => {
  assert.equal(isBackstopDuplicate(1000, 1499, 1000), true); // 499 < 500
});

test('exactly at half the interval is NOT a duplicate (strict <)', () => {
  assert.equal(isBackstopDuplicate(1000, 1500, 1000), false); // 500 < 500 is false
});

test('well past half the interval is not a duplicate', () => {
  assert.equal(isBackstopDuplicate(1000, 2000, 1000), false);
});

// ── Notify throttle: at least minGapMs since the last notification ────────────
test('first notification (falsy lastNotify) is always allowed', () => {
  assert.equal(shouldNotifyRefresh(0, 50000, 30000), true);
  assert.equal(shouldNotifyRefresh(undefined, 50000, 30000), true);
});

test('just under the gap is throttled', () => {
  assert.equal(shouldNotifyRefresh(1000, 1000 + 29999, 30000), false);
});

test('exactly at the gap is allowed (inclusive >=)', () => {
  assert.equal(shouldNotifyRefresh(1000, 1000 + 30000, 30000), true);
});
