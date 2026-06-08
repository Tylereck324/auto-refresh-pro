// rehydrate.js — pure helpers for rebuilding a job's in-memory state after a
// service-worker restart, and for the navigate-away decision. Extracted from
// background.js so this logic is unit-testable without chrome.* stubs.
//
// The chrome-dependent bits (storage/tabs/alarms I/O, compiling the matcher)
// stay in background.js; this module only does pure data shaping and the URL
// comparison, both of which are easy to get subtly wrong and worth covering.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('rehydrate.js') → globalThis.ARPRehydrate
//   • Node test runner: require('./rehydrate.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPRehydrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Build the in-memory job object from a persisted entry. The caller supplies
  // the chrome-derived bits it can't compute here:
  //   opts.startUrl         — preferred navigate-away baseline (falls back to the
  //                           persisted stored.startUrl, then null)
  //   opts.matcher          — the compiled keyword matcher
  //   opts.now              — current epoch ms (for the nextRefresh fallback)
  //   opts.fallbackInterval — interval used when stored.nextRefresh is missing
  // refreshCount/nextRefresh come from storage so stopAfter and the countdown
  // resume faithfully; previousContent is intentionally null (the baseline isn't
  // persisted, so the first post-restart cycle just skips alerting once).
  function buildRehydratedJob(stored, tabId, opts) {
    opts = opts || {};
    const now = typeof opts.now === 'number' ? opts.now : 0;
    const fallbackInterval = typeof opts.fallbackInterval === 'number' ? opts.fallbackInterval : 30000;
    return {
      settings: stored.settings,
      refreshCount: stored.refreshCount || 0,
      nextRefresh: stored.nextRefresh || (now + fallbackInterval),
      alarmName: 'refresh_' + tabId,
      startUrl: opts.startUrl != null ? opts.startUrl : (stored.startUrl || null),
      previousContent: null,
      _matcher: opts.matcher,
      _lastRefresh: 0,
      _timer: null,
    };
  }

  // Whether navigating origUrl → newUrl counts as leaving the monitored page.
  // Compares origin + pathname only, ignoring hash/query so an in-place reload
  // (same URL) or a #fragment change doesn't trip a stop. No baseline → never a
  // navigate-away; an unparseable URL → treated as a navigate-away (stop to be
  // safe, e.g. a jump to chrome://).
  function isNavigateAway(origUrl, newUrl) {
    if (!origUrl) return false;
    try {
      const a = new URL(origUrl);
      const b = new URL(newUrl);
      return !(a.origin === b.origin && a.pathname === b.pathname);
    } catch (e) {
      return true;
    }
  }

  return { buildRehydratedJob, isNavigateAway };
});
