// preset-row.js — builds a single editable preset row for the Settings page.
//
// SECURITY: preset labels originate from chrome.storage (globalSettings.presets)
// which can be populated by an imported settings file. The previous version
// concatenated the label into innerHTML, allowing a stored DOM-XSS payload such
// as  "><img src=x onerror=alert(1)>  to execute on the Settings page. This
// builder uses createElement + value/textContent assignment exclusively, so the
// label is always treated as inert string data — never parsed as HTML.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.buildPresetRow = api.buildPresetRow;
  root.readPresets = api.readPresets;
  root.DEFAULT_PRESETS = api.DEFAULT_PRESETS;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The eight built-in interval presets. Single source of truth: options.js seeds
  // globalSettings.presets from these, and popup.js falls back to them when no
  // custom presets are stored — so the two surfaces must never disagree.
  const DEFAULT_PRESETS = [
    { label: '5s', ms: 5000 },   { label: '10s', ms: 10000 },
    { label: '30s', ms: 30000 }, { label: '1m', ms: 60000 },
    { label: '5m', ms: 300000 }, { label: '10m', ms: 600000 },
    { label: '30m', ms: 1800000 }, { label: '1h', ms: 3600000 },
  ];

  function buildPresetRow(doc, p, i) {
    const div = doc.createElement('div');
    div.className = 'preset-item';

    const label = doc.createElement('span');
    label.className = 'preset-label';
    label.textContent = 'Preset ' + (i + 1);

    const labelInput = doc.createElement('input');
    labelInput.type = 'text';
    labelInput.id = 'pLabel' + i;
    labelInput.placeholder = 'Label';
    // ariaLabel IDL property reflects to the aria-label attribute (ARIAMixin);
    // using the property keeps the inert-value DOM stub in the tests happy.
    labelInput.ariaLabel = 'Preset ' + (i + 1) + ' label';
    labelInput.value = String(p && p.label != null ? p.label : ''); // inert, not HTML

    const secInput = doc.createElement('input');
    secInput.type = 'number';
    secInput.id = 'pSec' + i;
    secInput.placeholder = 'Sec';
    secInput.min = '2';
    secInput.ariaLabel = 'Preset ' + (i + 1) + ' seconds';
    const ms = Number(p && p.ms);
    secInput.value = String(Number.isFinite(ms) ? Math.round(ms / 1000) : 30);

    div.appendChild(label);
    div.appendChild(labelInput);
    div.appendChild(secInput);
    return div;
  }

  // Read back the `count` rendered preset rows (pLabel{i}/pSec{i}) into preset
  // objects. `count` MUST be the number of rows actually rendered — iterating a
  // fixed template length instead silently dropped presets past that length and
  // fabricated phantom ones when fewer existed. Missing rows are skipped rather
  // than defaulted, so the saved set always matches what the user sees.
  function readPresets(doc, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const labelEl = doc.getElementById('pLabel' + i);
      const secEl = doc.getElementById('pSec' + i);
      if (!labelEl && !secEl) continue; // row not present — don't fabricate one
      const label = (labelEl && labelEl.value) || String(i + 1);
      const sec = parseFloat(secEl && secEl.value) || 30;
      out.push({ label: label, ms: Math.max(2000, sec * 1000) });
    }
    return out;
  }

  return { buildPresetRow, readPresets, DEFAULT_PRESETS };
});
