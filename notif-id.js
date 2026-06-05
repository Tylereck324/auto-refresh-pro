// notif-id.js — pure helpers for encoding/decoding the originating tab id in a
// notification id. The tab is embedded in the id so a notification click can
// still focus the right tab even after the service worker was torn down and the
// in-memory map lost.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('notif-id.js') → globalThis.ARPNotif
//   • Node test runner: require('./notif-id.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPNotif = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFIXES = ['kw', 'chg', 'refresh'];

  // Build a notification id of the form `<prefix>_<tabId>_<stamp>`.
  function buildNotifId(prefix, tabId, stamp) {
    return prefix + '_' + tabId + '_' + stamp;
  }

  // Recover the tab id from a notification id, or null if it doesn't match the
  // scheme (e.g. an old auto-generated id).
  function parseNotifTabId(id) {
    if (typeof id !== 'string') return null;
    const m = /^(kw|chg|refresh)_(\d+)_/.exec(id);
    if (!m) return null;
    const tabId = parseInt(m[2], 10);
    return Number.isFinite(tabId) ? tabId : null;
  }

  return { buildNotifId, parseNotifTabId, PREFIXES };
});
