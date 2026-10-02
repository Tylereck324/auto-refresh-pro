// runtime-checkpoint.js — pure helpers for the two-tier job persistence used by
// background.js:
//
//   • chrome.storage.session holds one record PER JOB (key arpJob_<tabId>). The
//     routine per-refresh save writes only the job that changed, so a cycle no
//     longer re-serializes every job's up-to-200k-char detection baseline.
//   • chrome.storage.local.activeJobs stays the durable, rollback-compatible
//     snapshot. Routine changes reach it through ONE coalesced checkpoint per
//     CHECKPOINT_DELAY_MS window; user-significant transitions (start, stop,
//     pause, settings, alerts) still write it immediately.
//
// Session storage survives service-worker restarts but is cleared on browser
// restart / extension reload, so recovery prefers a NEWER session record and
// otherwise falls back to the local snapshot (at most one window stale).
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('runtime-checkpoint.js') → globalThis.ARPCheckpoint
//   • Node test runner: require('./runtime-checkpoint.js')       → module.exports
(function (/** @type {any} */ root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPCheckpoint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SESSION_PREFIX = 'arpJob_';
  const CHECKPOINT_ALARM = 'arp_checkpoint';
  const CHECKPOINT_DELAY_MS = 30000;

  function isTabId(id) {
    return Number.isInteger(id) && id >= 0;
  }

  // Session key for a tab's job record, or null for an invalid tab id.
  function sessionKey(tabId) {
    const id = typeof tabId === 'string' && /^\d+$/.test(tabId) ? Number(tabId) : tabId;
    return isTabId(id) ? SESSION_PREFIX + id : null;
  }

  // Inverse of sessionKey: the tab id a key belongs to, or null if it isn't one.
  function tabIdFromSessionKey(key) {
    if (typeof key !== 'string' || !key.startsWith(SESSION_PREFIX)) return null;
    const rest = key.slice(SESSION_PREFIX.length);
    if (!/^\d+$/.test(rest)) return null;
    const id = Number(rest);
    return isTabId(id) ? id : null;
  }

  // A usable persisted job record carries a settings object.
  function isRecord(r) {
    return !!(r && typeof r === 'object' && r.settings && typeof r.settings === 'object');
  }

  // Bounded numeric savedAt; anything malformed ranks as 0 (never newer).
  function savedAtOf(r) {
    const t = r && r.savedAt;
    return (typeof t === 'number' && Number.isFinite(t) && t > 0) ? t : 0;
  }

  // Choose which persisted record to rehydrate from. The LOCAL entry gates
  // existence: Start writes it immediately and Stop deletes it immediately, so a
  // session record with no local entry is a leftover from a stopped job and must
  // never resurrect it. Between the two, the newer valid savedAt wins; a tie
  // goes to the session record, because every immediate local save deletes the
  // job's session record — one that survives was written at or after the
  // latest local save (two writes can share a millisecond).
  function pickRecord(local, session) {
    if (!isRecord(local)) return null;
    if (isRecord(session) && savedAtOf(session) >= savedAtOf(local)) return session;
    return local;
  }

  // Extract { tabId: record } from a storage.session.get(null) result, ignoring
  // unrelated keys and malformed records.
  function collectSessionRecords(all) {
    const out = {};
    if (!all || typeof all !== 'object') return out;
    for (const key of Object.keys(all)) {
      const id = tabIdFromSessionKey(key);
      if (id !== null && isRecord(all[key])) out[id] = all[key];
    }
    return out;
  }

  // Fold newer session records into the local job map IN PLACE. Only tabs
  // already present locally are updated (see pickRecord). Returns the number of
  // entries replaced, so the caller can skip a no-op write.
  function mergeIntoSnapshot(localJobs, sessionRecords) {
    let changed = 0;
    if (!localJobs || typeof localJobs !== 'object') return 0;
    for (const id of Object.keys(sessionRecords || {})) {
      const local = localJobs[id];
      const picked = pickRecord(local, sessionRecords[id]);
      if (picked && picked !== local) { localJobs[id] = picked; changed++; }
    }
    return changed;
  }

  return {
    SESSION_PREFIX,
    CHECKPOINT_ALARM,
    CHECKPOINT_DELAY_MS,
    sessionKey,
    tabIdFromSessionKey,
    savedAtOf,
    pickRecord,
    collectSessionRecords,
    mergeIntoSnapshot,
  };
});
