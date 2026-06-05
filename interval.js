// interval.js — pure refresh-interval computation, shared by the service worker.
//
// Extracted from background.js so the timing logic (the heart of the refresh
// loop) is unit-testable and so the fixed-interval path is hardened against a
// missing/garbage `interval` producing a NaN alarm delay (which would silently
// break scheduling: chrome.alarms with delayInMinutes:NaN never fires and
// nextRefresh:NaN renders an empty countdown).
//
// Loaded two ways, so it stays dependency-free and side-effect-free:
//   • service worker:   importScripts('interval.js')   → globalThis.ARPInterval
//   • Node test runner: require('./interval.js')        → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPInterval = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The 2-second floor every UI surface enforces. Centralized here so the
  // service worker can't be handed a sub-floor interval from a poisoned/legacy
  // storage entry.
  const MIN_INTERVAL_MS = 2000;
  const DEFAULT_INTERVAL_MS = 30000;
  const DEFAULT_RANDOM_MIN_MS = 5000;
  const DEFAULT_RANDOM_MAX_MS = 30000;

  // Compute the next refresh delay (ms) for a job's settings.
  //   • random mode: a uniform pick in [min, max], each floored to MIN and
  //     swapped if inverted, so the range is never negative-width or sub-floor.
  //   • fixed mode:  the configured interval, floored to MIN; a missing/garbage
  //     value falls back to the 30s default instead of yielding NaN.
  function computeInterval(settings) {
    settings = settings || {};
    if (settings.randomTimer) {
      let min = Math.max(MIN_INTERVAL_MS, Number(settings.randomMin) || DEFAULT_RANDOM_MIN_MS);
      let max = Math.max(MIN_INTERVAL_MS, Number(settings.randomMax) || DEFAULT_RANDOM_MAX_MS);
      if (min > max) { const t = min; min = max; max = t; }
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    const fixed = Number(settings.interval);
    return Number.isFinite(fixed) && fixed > 0
      ? Math.max(MIN_INTERVAL_MS, Math.floor(fixed))
      : DEFAULT_INTERVAL_MS;
  }

  return { computeInterval, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS };
});
