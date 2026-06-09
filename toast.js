// toast.js — the one showToast implementation, shared by the Settings
// (options.html) and Manage (manage.html) pages.
//
// WHY: each page previously carried its own hand-rolled copy with quietly
// different timeouts and null-guards — the same drift class compose-settings.js
// and preset-row.js were extracted to kill. Expects the page to contain an
// element with id="toast" (no-op when absent, so a page without the element
// can't crash a save path).
//
// Loaded as a plain page script (window.showToast); no service-worker or Node
// consumer, so no UMD wrapper needed.
(function () {
  'use strict';
  let timer = null;
  const VISIBLE_MS = 2200;
  window.showToast = function showToast(message, isError) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast show ' + (isError ? 'error' : 'success');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { toast.className = 'toast'; }, VISIBLE_MS);
  };
})();
