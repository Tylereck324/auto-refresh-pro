// Truth-table tests for the keyword / change fire-decision. This is the core
// behavior of the monitor feature, previously inline in doMonitorRefresh and
// only re-derived by hand in keyword-match.test.js — now exercised directly.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeKeywordFire, shouldCheckChange } = require('../monitor-decision.js');

// ── Keyword: normal mode (alert when the keyword APPEARS) ─────────────────────
test('normal mode fires only on an absent→present transition', () => {
  const fire = (foundNow, foundPrev, hasBaseline) =>
    computeKeywordFire({ foundNow, foundPrev, hasBaseline, kwInverse: false });
  assert.equal(fire(true, false, true), true);   // absent → present: FIRE
  assert.equal(fire(true, true, true), false);   // present → present: no transition
  assert.equal(fire(false, false, true), false); // absent → absent
  assert.equal(fire(false, true, true), false);  // present → absent (only inverse fires here)
});

test('normal mode never fires without a baseline (first cycle is silent)', () => {
  assert.equal(computeKeywordFire({ foundNow: true, foundPrev: false, hasBaseline: false, kwInverse: false }), false);
});

// ── Keyword: inverse mode (alert when the keyword DISAPPEARS) ──────────────────
test('inverse mode fires only on a present→absent transition', () => {
  const fire = (foundNow, foundPrev, hasBaseline) =>
    computeKeywordFire({ foundNow, foundPrev, hasBaseline, kwInverse: true });
  assert.equal(fire(false, true, true), true);   // present → absent: FIRE
  assert.equal(fire(true, false, true), false);  // absent → present
  assert.equal(fire(true, true, true), false);   // present → present
  assert.equal(fire(false, false, true), false); // absent → absent
});

test('inverse mode never fires without a baseline', () => {
  assert.equal(computeKeywordFire({ foundNow: false, foundPrev: true, hasBaseline: false, kwInverse: true }), false);
});

// ── Change-detection gate ─────────────────────────────────────────────────────
test('change path runs only with no keyword, monitor on, and a baseline', () => {
  assert.equal(shouldCheckChange({ hasKeyword: false, monitorMode: true, hasBaseline: true }), true);
});

test('a set keyword owns the signal and suppresses the change path', () => {
  assert.equal(shouldCheckChange({ hasKeyword: true, monitorMode: true, hasBaseline: true }), false);
});

test('change path is gated off without monitor mode or without a baseline', () => {
  assert.equal(shouldCheckChange({ hasKeyword: false, monitorMode: false, hasBaseline: true }), false);
  assert.equal(shouldCheckChange({ hasKeyword: false, monitorMode: true, hasBaseline: false }), false);
});
