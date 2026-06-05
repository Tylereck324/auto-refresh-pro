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
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
    labelInput.value = String(p && p.label != null ? p.label : ''); // inert, not HTML

    const secInput = doc.createElement('input');
    secInput.type = 'number';
    secInput.id = 'pSec' + i;
    secInput.placeholder = 'Sec';
    secInput.min = '2';
    const ms = Number(p && p.ms);
    secInput.value = String(Number.isFinite(ms) ? Math.round(ms / 1000) : 30);

    div.appendChild(label);
    div.appendChild(labelInput);
    div.appendChild(secInput);
    return div;
  }

  return { buildPresetRow };
});
