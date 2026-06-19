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

  // Adaptive-backoff growth factor: each no-change cycle multiplies the base by
  // this, so the interval ramps up gently while a watched page stays quiet, then
  // snaps back the moment something is detected (caller resets the streak to 0).
  const ADAPTIVE_FACTOR = 1.5;

  // Compute the next interval (ms) in adaptive mode. `streak` is the number of
  // consecutive no-change/no-detection cycles seen so far. The base is the job's
  // configured `interval` (floored to MIN); the result grows as base·1.5^streak,
  // capped at settings.adaptiveMax (default 8× base). At streak 0 it equals the
  // base, so a freshly-detecting job refreshes at full speed. Mutually exclusive
  // with random mode — the caller picks adaptive XOR random/fixed.
  //
  // WHY: hammering a deal/restock/status page at a fixed 5s wastes requests (and
  // courts rate-limits/IP bans) when nothing is happening, yet a slow fixed
  // interval misses the moment it does. Backoff-while-quiet, sprint-on-change is
  // the standard answer; extracted here so the ramp curve is unit-testable.
  function computeAdaptiveInterval(settings, streak) {
    settings = settings || {};
    const baseRaw = Number(settings.interval);
    const base = Number.isFinite(baseRaw) && baseRaw > 0
      ? Math.max(MIN_INTERVAL_MS, Math.floor(baseRaw))
      : DEFAULT_INTERVAL_MS;
    const capRaw = Number(settings.adaptiveMax);
    const cap = Number.isFinite(capRaw) && capRaw > base ? Math.floor(capRaw) : base * 8;
    const n = Math.max(0, Math.floor(Number(streak) || 0));
    // Cap the exponent before pow() so a runaway streak can't overflow to
    // Infinity (NaN-hardening parity with computeInterval): once base·1.5^n
    // clears the cap it stays there anyway, and 1.5^64 already dwarfs any cap.
    const scaled = Math.floor(base * Math.pow(ADAPTIVE_FACTOR, Math.min(n, 64)));
    return Math.min(cap, Math.max(base, Number.isFinite(scaled) ? scaled : cap));
  }

  return { computeInterval, computeAdaptiveInterval, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS };
});
