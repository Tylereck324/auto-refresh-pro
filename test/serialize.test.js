// Regression tests for the storage read-modify-write race (background.js).
//
// BUG: saveJobToStorage/removeJobFromStorage did get('activeJobs') → mutate →
// set('activeJobs') with no serialization. Two concurrent saves (two tabs
// refreshing at once) interleave: both read the same map, each adds its own tab,
// and the second set() clobbers the first — silently dropping a live job so it's
// gone after the next MV3 worker restart. ARPSerialize.createMutex() funnels
// every cycle through one queue so each read sees the previous write.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMutex } = require('../serialize.js');

// A mock async store whose get/set both yield (setImmediate) — that yield is the
// exact window the real chrome.storage.local.get/set open for interleaving.
function makeStore() {
  let store = {};
  return {
    get: () => new Promise(r => setImmediate(() => r({ ...store }))),
    set: (v) => new Promise(r => setImmediate(() => { store = { ...v }; r(); })),
    snapshot: () => store,
  };
}

// The workload each "tab" runs: read the jobs map, add its own id, write it back.
function rmw(store, id) {
  return (async () => {
    const jobs = await store.get();
    jobs[id] = id;
    await store.set(jobs);
  })();
}

test('BASELINE: unserialized read-modify-write loses updates (proves the race)', async () => {
  const store = makeStore();
  await Promise.all(Array.from({ length: 50 }, (_, i) => rmw(store, i)));
  // With no mutex the interleaved writes clobber each other — far fewer than 50
  // entries survive. This documents the bug the mutex below fixes.
  assert.ok(Object.keys(store.snapshot()).length < 50,
    'expected lost updates without serialization');
});

test('FIX: the mutex serializes the same workload so every update survives', async () => {
  const store = makeStore();
  const mutex = createMutex();
  await Promise.all(Array.from({ length: 50 }, (_, i) => mutex(() => rmw(store, i))));
  assert.equal(Object.keys(store.snapshot()).length, 50);
});

test('mutex runs queued tasks in submission order', async () => {
  const mutex = createMutex();
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map(n =>
    mutex(async () => { await new Promise(r => setImmediate(r)); order.push(n); })
  ));
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('mutex returns each task its own result', async () => {
  const mutex = createMutex();
  const [a, b] = await Promise.all([mutex(() => 'a'), mutex(async () => 'b')]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
});

test('a rejecting task does not wedge the queue for later callers', async () => {
  const mutex = createMutex();
  await assert.rejects(mutex(async () => { throw new Error('boom'); }), /boom/);
  // The queue must still accept and run the next task.
  const v = await mutex(async () => 42);
  assert.equal(v, 42);
});

test('a remove interleaved with saves still lands deterministically', async () => {
  // Models stopRefresh (remove) racing two saveJobToStorage calls. Serialized,
  // the final state is exactly the last-submitted op's view — never a torn map.
  const store = makeStore();
  const mutex = createMutex();
  await mutex(() => rmw(store, 1));
  await Promise.all([
    mutex(() => rmw(store, 2)),
    mutex(async () => { const j = await store.get(); delete j[1]; await store.set(j); }),
    mutex(() => rmw(store, 3)),
  ]);
  const keys = Object.keys(store.snapshot()).map(Number).sort();
  assert.deepEqual(keys, [2, 3]); // 1 removed; 2 and 3 both preserved
});
