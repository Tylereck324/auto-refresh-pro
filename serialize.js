// serialize.js — a tiny async mutex, used by the service worker to serialize
// read-modify-write cycles on chrome.storage.local.activeJobs.
//
// WHY: persisting a job is get('activeJobs') → mutate the map → set('activeJobs').
// That get→set is not atomic. With two or more tabs refreshing at once (every
// fireRefresh persists), the calls interleave: A reads {}, B reads {} (before A
// writes), A writes {1}, B writes {2} — and tab 1's entry is silently lost. On
// the next MV3 worker restart that tab is never rehydrated, so its auto-refresh
// dies without a trace. runExclusive() funnels every such cycle through one
// queue so each read sees the previous write.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('serialize.js') → globalThis.ARPSerialize
//   • Node test runner: require('./serialize.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPSerialize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Returns runExclusive(fn): queues fn so calls run one at a time, in
  // submission order. Each call resolves/rejects with its own fn's result, and a
  // rejected fn never wedges the queue for later callers (the chain swallows it).
  function createMutex() {
    let tail = Promise.resolve();
    return function runExclusive(fn) {
      const result = tail.then(() => fn());
      // Advance the queue once this task settles, success OR failure, so the next
      // task waits for it but a rejection here doesn't poison the chain.
      tail = result.then(() => {}, () => {});
      return result;
    };
  }

  return { createMutex };
});
