// lifecycle-generation.js — dependency-free per-tab lifecycle generations.
//
// A Start request keeps its generation token while it awaits Chrome APIs. Stop
// invalidates the token synchronously, so the suspended Start can observe that
// it is stale before publishing a job, scheduling an alarm, or persisting state.
//
// Loaded two ways:
//   • service worker: importScripts('lifecycle-generation.js') → globalThis.ARPLifecycle
//   • Node tests: require('./lifecycle-generation.js') → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function tabKey(tabId) {
    const n = Number(tabId);
    return Number.isInteger(n) && n >= 0 ? n : tabId;
  }

  function createRegistry() {
    // Keep the last generation after finish so a stale token can never become
    // current again. The pending bit is separate because an active job may no
    // longer be awaiting Start, while its generation still guards late work.
    const entries = new Map();

    function entryFor(tabId) {
      const key = tabKey(tabId);
      let entry = entries.get(key);
      if (!entry) {
        entry = { generation: 0, pending: false };
        entries.set(key, entry);
      }
      return { key, entry };
    }

    function begin(tabId) {
      const { entry } = entryFor(tabId);
      entry.generation += 1;
      entry.pending = true;
      return entry.generation;
    }

    function invalidate(tabId) {
      const { entry } = entryFor(tabId);
      entry.generation += 1;
      entry.pending = false;
      return entry.generation;
    }

    function isCurrent(tabId, token) {
      const key = tabKey(tabId);
      const entry = entries.get(key);
      return !!entry && entry.generation === token;
    }

    function pendingTabIds() {
      const ids = [];
      for (const [tabId, entry] of entries) {
        if (entry.pending) ids.push(tabId);
      }
      // Chrome tab IDs are numeric. Sorting keeps STOP_ALL deterministic while
      // still preserving non-numeric IDs for defensive/test callers.
      return ids.sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return String(a).localeCompare(String(b));
      });
    }

    function finish(tabId, token) {
      const key = tabKey(tabId);
      const entry = entries.get(key);
      if (entry && entry.generation === token) entry.pending = false;
    }

    return { begin, invalidate, isCurrent, pendingTabIds, finish };
  }

  return { createRegistry };
});
