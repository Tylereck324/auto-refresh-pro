// Tests for the pure two-tier persistence helpers (session record per job +
// coalesced local checkpoint).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../runtime-checkpoint.js');

const rec = (savedAt, extra = {}) => ({ settings: { interval: 5000 }, savedAt, ...extra });

test('sessionKey is stable and rejects invalid tab ids', () => {
  assert.equal(C.sessionKey(7), 'arpJob_7');
  assert.equal(C.sessionKey('7'), 'arpJob_7');
  assert.equal(C.sessionKey(-1), null);
  assert.equal(C.sessionKey(1.5), null);
  assert.equal(C.sessionKey('7x'), null);
  assert.equal(C.sessionKey(null), null);
});

test('tabIdFromSessionKey inverts sessionKey and ignores unrelated keys', () => {
  assert.equal(C.tabIdFromSessionKey('arpJob_42'), 42);
  assert.equal(C.tabIdFromSessionKey('arpJob_'), null);
  assert.equal(C.tabIdFromSessionKey('arpJob_4a'), null);
  assert.equal(C.tabIdFromSessionKey('activeJobs'), null);
  assert.equal(C.tabIdFromSessionKey(undefined), null);
});

test('savedAtOf ranks malformed timestamps as 0', () => {
  assert.equal(C.savedAtOf(rec(10)), 10);
  assert.equal(C.savedAtOf(rec('10')), 0);
  assert.equal(C.savedAtOf(rec(NaN)), 0);
  assert.equal(C.savedAtOf(rec(-5)), 0);
  assert.equal(C.savedAtOf(null), 0);
});

test('pickRecord prefers a strictly newer valid session record', () => {
  const local = rec(100);
  const session = rec(200);
  assert.equal(C.pickRecord(local, session), session);
  const tie = rec(100);
  assert.equal(C.pickRecord(local, tie), tie); // tie → session (written at/after local)
  assert.equal(C.pickRecord(local, rec(50)), local);
});

test('pickRecord falls back to local for missing or malformed session records', () => {
  const local = rec(100);
  assert.equal(C.pickRecord(local, undefined), local);
  assert.equal(C.pickRecord(local, { savedAt: 999 }), local); // no settings
  assert.equal(C.pickRecord(local, rec('999')), local);       // malformed savedAt
});

test('pickRecord never resurrects a job with no local entry', () => {
  assert.equal(C.pickRecord(undefined, rec(999)), null);
  assert.equal(C.pickRecord({ savedAt: 1 }, rec(999)), null);
});

test('collectSessionRecords keeps only valid job records', () => {
  const out = C.collectSessionRecords({
    arpJob_1: rec(1),
    arpJob_2: { savedAt: 2 },
    other: rec(3),
  });
  assert.deepEqual(Object.keys(out), ['1']);
  assert.deepEqual(C.collectSessionRecords(null), {});
});

test('mergeIntoSnapshot replaces only older entries that exist locally', () => {
  const jobs = { 1: rec(100), 2: rec(100), 3: rec(300) };
  const changed = C.mergeIntoSnapshot(jobs, {
    1: rec(150, { refreshCount: 9 }),
    3: rec(200),         // older than local → kept
    4: rec(999),         // stopped (no local entry) → not resurrected
  });
  assert.equal(changed, 1);
  assert.equal(jobs[1].refreshCount, 9);
  assert.equal(jobs[3].savedAt, 300);
  assert.equal(jobs[4], undefined);
  assert.equal(jobs[2].savedAt, 100);
});
