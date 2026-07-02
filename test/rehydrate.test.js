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
    { settings: { interval: 5000 }, refreshCount: 7, keywordCount: 3, nextRefresh: 1234, startUrl: 'https://a.com/x' },
    42,
    { matcher: MATCHER, now: 9999, fallbackInterval: 5000 }
  );
  assert.equal(job.refreshCount, 7);
  assert.equal(job.keywordCount, 3);
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
  assert.equal(job.keywordCount, 0);
  assert.equal(job.nextRefresh, 31000); // now + fallbackInterval
  assert.equal(job.startUrl, null);
});

// A string keywordCount (hand-edited or legacy storage) must coerce to a number,
// or `count + 1` becomes string concatenation ("3" → "31") and the popup tally
// is garbage. Same hazard the refreshCount coercion guards against.
test('buildRehydratedJob coerces a string/garbage keywordCount to a number', () => {
  assert.equal(
    R.buildRehydratedJob({ settings: {}, keywordCount: '3' }, 1, { matcher: MATCHER, now: 0 }).keywordCount,
    3
  );
  for (const bad of [undefined, null, 'NaN', {}, []]) {
    const job = R.buildRehydratedJob({ settings: {}, keywordCount: bad }, 1, { matcher: MATCHER, now: 0 });
    assert.equal(job.keywordCount, 0, `keywordCount=${JSON.stringify(bad)} should rehydrate as 0`);
  }
});

// A notification snooze must outlive the worker: MV3 idles it out within ~30s
// of the snooze click, so without restore the remaining ~14.5 minutes of a
// 15-minute snooze would silently un-mute and alerts would resume beeping.
test('buildRehydratedJob restores an unexpired snooze deadline', () => {
  const job = R.buildRehydratedJob(
    { settings: {}, snoozeUntil: 5000 },
    1,
    { matcher: MATCHER, now: 1000 }
  );
  assert.equal(job._snoozeUntil, 5000);
});

test('buildRehydratedJob drops an expired or garbage snooze deadline', () => {
  for (const stale of [999, 1000, '5000?', {}, [], null, undefined]) {
    const job = R.buildRehydratedJob(
      { settings: {}, snoozeUntil: stale },
      1,
      { matcher: MATCHER, now: 1000 }
    );
    assert.equal(job._snoozeUntil, 0, `snoozeUntil=${JSON.stringify(stale)} should rehydrate as 0`);
  }
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
