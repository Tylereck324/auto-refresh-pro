// settings-export.js — private-by-default projection for settings backups.
//
// Runtime state (active jobs, URLs, alert history, counters) is intentionally
// absent from this allowlist. Unknown future storage keys are excluded too.
//
// Loaded two ways:
//   • extension pages: <script src="settings-export.js"> → window.ARPSettingsExport
//   • Node tests: require('./settings-export.js') → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPSettingsExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EXPORT_KEYS = Object.freeze([
    'popupSettings',
    'globalSettings',
    'customHotkey',
    'autoStartUrls',
    'urlRules',
    'domainDenylist',
    '__ar_overlay_pos',
    '__ar_overlay_size',
  ]);

  function pick(storage) {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return {};
    const out = {};
    for (const key of EXPORT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(storage, key)) out[key] = storage[key];
    }
    return out;
  }

  return { EXPORT_KEYS, pick };
});
