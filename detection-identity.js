// detection-identity.js — pure comparison of keyword/per-item detection state.
//
// Timing, notification, sound, and display settings deliberately do not appear
// here. UPDATE_INTERVAL can use same() to decide whether a detection baseline
// must be rebuilt or can be preserved.
//
// Loaded two ways:
//   • service worker: importScripts('detection-identity.js') → globalThis.ARPDetectionIdentity
//   • Node tests: require('./detection-identity.js') → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPDetectionIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DETECTION_KEYS = Object.freeze([
    'keyword',
    'kwRegex',
    'kwCaseSensitive',
    'kwWholeWord',
    'kwInverse',
    'watchSelector',
    'kwPerItem',
    'kwExclude',
    'collapseDigits',
  ]);

  function normalizedString(value, collapseWhitespace) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return collapseWhitespace ? trimmed.replace(/\s+/g, ' ') : trimmed;
  }

  function canonical(settings) {
    settings = settings && typeof settings === 'object' ? settings : {};
    const kwRegex = !!settings.kwRegex;
    // Regex whitespace is meaningful, so only trim its outer padding. Literal
    // matching normalizes whitespace before testing and can use the same form
    // for identity without resetting a baseline unnecessarily.
    const out = {
      keyword: normalizedString(settings.keyword, !kwRegex),
      kwRegex,
      kwCaseSensitive: !!settings.kwCaseSensitive,
      kwWholeWord: !!settings.kwWholeWord,
      kwInverse: !!settings.kwInverse,
      watchSelector: normalizedString(settings.watchSelector, false),
      kwPerItem: !!settings.kwPerItem,
      kwExclude: normalizedString(settings.kwExclude, true),
      // Background/item-detect treat an omitted value as the legacy default
      // (collapse digits enabled), so undefined and true are equivalent.
      collapseDigits: settings.collapseDigits !== false,
    };
    return out;
  }

  function identity(settings) {
    return JSON.stringify(canonical(settings));
  }

  function same(a, b) {
    return identity(a) === identity(b);
  }

  return { DETECTION_KEYS, identity, same };
});
