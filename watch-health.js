// watch-health.js — decides when a watch has silently stopped working.
//
// A job keeps "refreshing" happily while its page is actually a sign-in screen,
// a captcha / bot check, or an error page that never renders — and nothing ever
// alerts, so studies are missed with no signal. After each detection cycle the
// worker probes the page and feeds the result here; this module turns that into
// a one-shot "watch blocked" alert and a "watch resumed" note.
//
//   • A signal must persist for CONFIRM_CYCLES consecutive cycles (one bad load
//     is noise, not a stall).
//   • A page signal already present when the job STARTED is ignored for that
//     job (someone deliberately watching a page with a login box on it).
//   • Read failures (the page wouldn't load or script) count as a stall once
//     they reach FAILURE_THRESHOLD in a row.
//   • One alert per stall; recovery re-arms it.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('watch-health.js') → globalThis.ARPWatchHealth
//   • Node test runner: require('./watch-health.js')       → module.exports
(function (/** @type {any} */ root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPWatchHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONFIRM_CYCLES = 2;
  const FAILURE_THRESHOLD = 3;
  const REASONS = ['login', 'captcha', 'unreadable'];

  const HEALTHY = Object.freeze({ reason: null, count: 0, notified: false });

  // Normalize a persisted state (legacy / hand-edited storage → healthy).
  function normalizeState(s) {
    if (!s || typeof s !== 'object') return { ...HEALTHY };
    return {
      reason: REASONS.includes(s.reason) ? s.reason : null,
      count: Number.isInteger(s.count) && s.count > 0 ? s.count : 0,
      notified: !!s.notified,
    };
  }

  // This cycle's problem, or null. `probe` is the page probe's verdict
  // ('login' | 'captcha' | null), `failures` the consecutive failed reads,
  // `ignore` the probe verdicts present at job start.
  function classify(probe, failures, ignore) {
    const ignored = Array.isArray(ignore) ? ignore : [];
    if ((probe === 'login' || probe === 'captcha') && !ignored.includes(probe)) return probe;
    if (Number(failures) >= FAILURE_THRESHOLD) return 'unreadable';
    return null;
  }

  // Advance the state by one cycle. Returns the new state plus edge flags:
  //   alert     — the stall just became confirmed (notify once)
  //   recovered — a confirmed stall just cleared
  function step(state, reason) {
    const prev = normalizeState(state);
    if (!reason) {
      return { state: { ...HEALTHY }, alert: false, recovered: prev.notified };
    }
    const count = prev.reason === reason ? prev.count + 1 : 1;
    const alert = !prev.notified && count >= CONFIRM_CYCLES;
    return { state: { reason, count, notified: prev.notified || alert }, alert, recovered: false };
  }

  function describe(reason, failures) {
    if (reason === 'login') return 'The page is asking you to sign in';
    if (reason === 'captcha') return 'The page is showing a captcha / bot check';
    if (reason === 'unreadable') return 'The page failed to load or be read ' + (Number(failures) || FAILURE_THRESHOLD) + ' times in a row';
    return '';
  }

  return { CONFIRM_CYCLES, FAILURE_THRESHOLD, normalizeState, classify, step, describe };
});
