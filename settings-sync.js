// settings-sync.js — what syncs across the user's Chromes, and how a synced
// value merges with this device's copy.
//
// The extension keeps reading and writing chrome.storage.local everywhere; the
// worker (bg-sync.js) mirrors SYNC_KEYS to chrome.storage.sync and back. This
// module is the pure part of that bridge:
//   • DEVICE_ONLY fields never leave the device — webhook URLs are credentials,
//     and a relay URL points at a tunnel on one specific machine.
//   • fromSync keeps this device's DEVICE_ONLY fields when applying a synced value.
//   • fitsSync guards Chrome's per-item sync quota (8 KB); an oversized value
//     simply stays local.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('settings-sync.js') → globalThis.ARPSettingsSync
//   • Node test runner: require('./settings-sync.js')       → module.exports
(function (/** @type {any} */ root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPSettingsSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Settings shared across devices. Job state, the alert journal, auto-start
  // URLs (they open tabs on THIS browser's launch) and overlay position stay local.
  const SYNC_KEYS = Object.freeze(['globalSettings', 'popupSettings', 'urlRules', 'domainDenylist']);

  const DEVICE_ONLY = Object.freeze({
    globalSettings: Object.freeze(['webhookUrl', 'webhookFormat', 'webhookUrl2', 'webhookFormat2']),
  });

  // chrome.storage.sync.QUOTA_BYTES_PER_ITEM is 8192 (key + JSON value); keep headroom.
  const MAX_ITEM_BYTES = 8000;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // The value to store in sync for `key`: this device's value minus its
  // device-only fields.
  function toSync(key, localValue) {
    const hidden = DEVICE_ONLY[key];
    if (!hidden || !isPlainObject(localValue)) return localValue;
    const out = { ...localValue };
    for (const f of hidden) delete out[f];
    return out;
  }

  // The value to store locally after another device changed `key`: the synced
  // value plus THIS device's device-only fields (which sync never carries).
  function fromSync(key, syncValue, localValue) {
    const hidden = DEVICE_ONLY[key];
    if (!hidden || !isPlainObject(syncValue)) return syncValue;
    const out = { ...syncValue };
    for (const f of hidden) {
      if (isPlainObject(localValue) && f in localValue) out[f] = localValue[f];
      else delete out[f];
    }
    return out;
  }

  function sameValue(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  function fitsSync(key, value) {
    return (String(key).length + JSON.stringify(value === undefined ? null : value).length) <= MAX_ITEM_BYTES;
  }

  return { SYNC_KEYS, DEVICE_ONLY, MAX_ITEM_BYTES, toSync, fromSync, sameValue, fitsSync };
});
