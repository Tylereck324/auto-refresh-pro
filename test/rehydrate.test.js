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
  assert.equal(job.previousContent, null); // no persisted baseline → start clean
  assert.equal(job._lastRefresh, 0);
  assert.equal(job._timer, null);
});

// The detection baseline must survive a worker restart: at intervals past the
// MV3 idle timeout the worker dies between EVERY pair of cycles, so a baseline
// that resets to null on rehydrate means keyword/change alerts never fire.
test('buildRehydratedJob restores the persisted detection baseline', () => {
  const job = R.buildRehydratedJob(
    { settings: { keyword: 'in stock' }, previousContent: 'sold out everywhere' },
    1,
    { matcher: MATCHER, now: 0 }
  );
  assert.equal(job.previousContent, 'sold out everywhere');
});

test('buildRehydratedJob degrades a non-string baseline to null (no corruption)', () => {
  for (const bad of [42, { text: 'x' }, ['x'], true, null, undefined]) {
    const job = R.buildRehydratedJob(
      { settings: {}, previousContent: bad },
      1,
      { matcher: MATCHER, now: 0 }
    );
    assert.equal(job.previousContent, null, `previousContent=${JSON.stringify(bad)} should rehydrate as null`);
  }
});

test('an empty-string baseline is preserved as a baseline, not dropped', () => {
  // '' is a valid string; the write side (saveJobToStorage) never persists ''
  // because doMonitorRefresh skips empty reads, but if it appears in storage it
  // must not crash and must remain a string so hasBaseline semantics stay sane.
  const job = R.buildRehydratedJob(
    { settings: {}, previousContent: '' },
    1,
    { matcher: MATCHER, now: 0 }
  );
  assert.equal(job.previousContent, '');
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
  // Sub-path of the original is still a navigate-away (SPA route into a detail
  // page, e.g. /studies → /studies/<id>).
  assert.equal(R.isNavigateAway('https://a.com/studies', 'https://a.com/studies/abc123'), true);
});

test('no baseline → never a navigate-away; unparseable → stop to be safe', () => {
  assert.equal(R.isNavigateAway(null, 'https://a.com/'), false);
  assert.equal(R.isNavigateAway('', 'https://a.com/'), false);
  assert.equal(R.isNavigateAway('https://a.com/', 'not a url'), true);
});
