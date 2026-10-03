// Tests for the pure dead-watch decision logic.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../watch-health.js');

test('classify: page signals, ignored-at-start signals, and failure streaks', () => {
  assert.equal(W.classify('login', 0, []), 'login');
  assert.equal(W.classify('captcha', 0, ['login']), 'captcha');
  assert.equal(W.classify('login', 0, ['login']), null, 'present at start → ignored');
  assert.equal(W.classify(null, W.FAILURE_THRESHOLD - 1, []), null);
  assert.equal(W.classify(null, W.FAILURE_THRESHOLD, []), 'unreadable');
  assert.equal(W.classify('weird', 0, []), null);
});

test('step: alerts once after CONFIRM_CYCLES, then stays quiet', () => {
  let r = W.step(undefined, 'login');
  assert.equal(r.alert, false);
  r = W.step(r.state, 'login');
  assert.equal(r.alert, true);
  r = W.step(r.state, 'login');
  assert.equal(r.alert, false, 'one alert per stall');
  r = W.step(r.state, 'captcha');
  assert.equal(r.alert, false, 'reason change within a stall does not re-alert');
});

test('step: a single bad cycle never alerts', () => {
  let r = W.step(undefined, 'captcha');
  r = W.step(r.state, null);
  assert.equal(r.alert, false);
  assert.equal(r.recovered, false, 'nothing was announced, so nothing to recover from');
  r = W.step(r.state, 'captcha');
  assert.equal(r.alert, false);
});

test('step: recovery is reported and re-arms the alert', () => {
  let r = W.step(W.step(undefined, 'unreadable').state, 'unreadable');
  assert.equal(r.alert, true);
  r = W.step(r.state, null);
  assert.equal(r.recovered, true);
  r = W.step(W.step(r.state, 'login').state, 'login');
  assert.equal(r.alert, true, 'a later stall alerts again');
});

test('normalizeState tolerates legacy or hand-edited storage', () => {
  assert.deepEqual(W.normalizeState(null), { reason: null, count: 0, notified: false });
  assert.deepEqual(W.normalizeState({ reason: 'bogus', count: '3', notified: 1 }), { reason: null, count: 0, notified: true });
});

test('describe gives a readable reason', () => {
  assert.match(W.describe('login'), /sign in/);
  assert.match(W.describe('unreadable', 4), /4 times/);
});
