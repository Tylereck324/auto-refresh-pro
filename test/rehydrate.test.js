// Tests for the pure post-restart rehydration helpers: rebuilding a job's
// in-memory shape from a persisted entry, and the navigate-away URL decision.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../rehydrate.js');

const MATCHER = { ok: true, empty: true, test: () => false };

// ── buildRehydratedJob ───────────────────────────────────────────────────────
test('buildRehydratedJob carries persisted count, deadline, and startUrl', () => {
  const job = R.buildRehydratedJob(
    { settings: { interval: 5000 }, refreshCount: 7, nextRefresh: 1234, startUrl: 'https://a.com/x' },
    42,
    { matcher: MATCHER, now: 9999, fallbackInterval: 5000 }
  );
  assert.equal(job.refreshCount, 7);
  assert.equal(job.nextRefresh, 1234);
  assert.equal(job.startUrl, 'https://a.com/x');
  assert.equal(job.alarmName, 'refresh_42');
  assert.equal(job._matcher, MATCHER);
  assert.equal(job.previousContent, null); // baseline not persisted
  assert.equal(job._lastRefresh, 0);
  assert.equal(job._timer, null);
});

test('buildRehydratedJob fills sane defaults for a sparse entry', () => {
  const job = R.buildRehydratedJob(
    { settings: { interval: 30000 } },
    1,
    { matcher: MATCHER, now: 1000, fallbackInterval: 30000 }
  );
  assert.equal(job.refreshCount, 0);
  assert.equal(job.nextRefresh, 31000); // now + fallbackInterval
  assert.equal(job.startUrl, null);
});

test('buildRehydratedJob prefers the live startUrl over the stored one', () => {
  const job = R.buildRehydratedJob(
    { settings: {}, startUrl: 'https://old.com/' },
    1,
    { matcher: MATCHER, startUrl: 'https://live.com/', now: 0 }
  );
  assert.equal(job.startUrl, 'https://live.com/');
});

// ── isNavigateAway ───────────────────────────────────────────────────────────
test('same origin + path is not a navigate-away (reload, hash/query change)', () => {
  assert.equal(R.isNavigateAway('https://a.com/p', 'https://a.com/p'), false);
  assert.equal(R.isNavigateAway('https://a.com/p?x=1', 'https://a.com/p?x=2'), false);
  assert.equal(R.isNavigateAway('https://a.com/p', 'https://a.com/p#section'), false);
});

test('different path or origin is a navigate-away', () => {
  assert.equal(R.isNavigateAway('https://a.com/p', 'https://a.com/q'), true);
  assert.equal(R.isNavigateAway('https://a.com/p', 'https://b.com/p'), true);
  assert.equal(R.isNavigateAway('https://a.com/p', 'http://a.com/p'), true); // scheme → origin differs
});

test('no baseline → never a navigate-away; unparseable → stop to be safe', () => {
  assert.equal(R.isNavigateAway(null, 'https://a.com/'), false);
  assert.equal(R.isNavigateAway('', 'https://a.com/'), false);
  assert.equal(R.isNavigateAway('https://a.com/', 'not a url'), true);
});
