// refresh-guards.js — two pure timing guards for the refresh loop, extracted from
// background.js so the off-by-one-prone arithmetic is unit-testable. Both were
// inline at async chrome.* call sites and untestable; a flipped comparison or a
// lost factor would have been invisible to the suite.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('refresh-guards.js') → globalThis.ARPGuards
//   • Node test runner: require('./refresh-guards.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPGuards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // True when a backstop alarm fired too soon after a setTimeout tick already
  // refreshed — within half the interval — so it must re-arm and bail instead of
  // double-refreshing. A falsy lastRefreshTs (0/undefined = no refresh yet) is
  // never a duplicate. Strict `<`: at exactly half the interval it is allowed.
  function isBackstopDuplicate(lastRefreshTs, now, curInterval) {
    return !!lastRefreshTs && (now - lastRefreshTs) < curInterval * 0.5;
  }

  // True when a per-refresh notification is allowed: either none has been posted
  // yet (falsy lastNotifyTs) or at least minGapMs has elapsed. Inclusive `>=`:
  // exactly at the gap boundary it is allowed.
  function shouldNotifyRefresh(lastNotifyTs, now, minGapMs) {
    return !lastNotifyTs || (now - lastNotifyTs) >= minGapMs;
  }

  return { isBackstopDuplicate, shouldNotifyRefresh };
});
