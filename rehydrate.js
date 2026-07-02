// rehydrate.js — pure helpers for rebuilding a job's in-memory state after a
// service-worker restart, and for the navigate-away decision. Extracted from
// background.js so this logic is unit-testable without chrome.* stubs.
//
// The chrome-dependent bits (storage/tabs/alarms I/O, compiling the matcher)
// stay in background.js; this module only does pure data shaping and the URL
// comparison, both of which are easy to get subtly wrong and worth covering.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('rehydrate.js') → globalThis.ARPRehydrate
//   • Node test runner: require('./rehydrate.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPRehydrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Build the in-memory job object from a persisted entry. The caller supplies
  // the chrome-derived bits it can't compute here:
  //   opts.startUrl         — preferred navigate-away baseline (falls back to the
  //                           persisted stored.startUrl, then null)
  //   opts.matcher          — the compiled keyword matcher
  //   opts.now              — current epoch ms (for the nextRefresh fallback)
  //   opts.fallbackInterval — interval used when stored.nextRefresh is missing
  // refreshCount/nextRefresh come from storage so stopAfter and the countdown
  // resume faithfully. previousContent — the keyword/change-detection baseline —
  // is restored too: for any interval past the MV3 idle timeout the worker dies
  // between EVERY pair of cycles, so without it each cycle would start
  // baseline-less and detection would never fire at long intervals. Non-string
  // values (legacy entries, hand-edited storage) degrade to null = no baseline,
  // which skips alerting for one cycle rather than corrupting comparisons.
  function buildRehydratedJob(stored, tabId, opts) {
    opts = opts || {};
    const now = typeof opts.now === 'number' ? opts.now : 0;
    const fallbackInterval = typeof opts.fallbackInterval === 'number' ? opts.fallbackInterval : 30000;
    return {
      settings: stored.settings,
      // Coerce persisted numbers: a string refreshCount (hand-edited or legacy
      // storage) would otherwise survive and turn `count + 1` into string
      // concatenation ("5" → "51"), corrupting the display AND the stopAfter
      // comparison; a string nextRefresh would feed NaN into the scheduler.
      refreshCount: Number(stored.refreshCount) || 0,
      keywordCount: Number(stored.keywordCount) || 0, // same coercion; counts keyword alerts
      nextRefresh: Number(stored.nextRefresh) || (now + fallbackInterval),
      alarmName: 'refresh_' + tabId,
      startUrl: opts.startUrl != null ? opts.startUrl : (stored.startUrl || null),
      previousContent: typeof stored.previousContent === 'string' ? stored.previousContent : null,
      // Per-item detection baseline (the seen matching-item keys). Restored so a
      // mid-session worker restart resumes diffing against items already seen
      // instead of re-alerting for all of them. Non-array (legacy / hand-edited)
      // degrades to null = no baseline, skipping one cycle rather than corrupting.
      _seenKeys: Array.isArray(stored.seenKeys) ? stored.seenKeys : null,
      // Adaptive-backoff streak (#8) — coerced like the counts above so a
      // hand-edited/legacy string can't poison the interval math.
      _noChangeStreak: Number(stored.noChangeStreak) || 0,
      // Manual pause (#10) — restore so a paused job stays paused across a worker
      // restart until an explicit RESUME_JOB.
      _manualPause: !!stored.manualPause,
      // Navigate-away pause (#12) — restore so a worker restart mid-absence
      // neither re-notifies (the away EDGE checks _pauseReason) nor resumes
      // reads on the wrong page (scheduleDomScan stays disarmed on 'away');
      // cleared by the resume edges when the tab returns to the watched URL.
      _pauseReason: stored.awayPause ? 'away' : null,
      // Notification snooze (#2) — restore so a 15-minute snooze isn't cut short
      // by the worker idling out mid-window (alerts would resume beeping while
      // the user believes they're muted). An expired or non-numeric deadline
      // degrades to 0 = not snoozed.
      _snoozeUntil: (Number(stored.snoozeUntil) || 0) > now ? Number(stored.snoozeUntil) : 0,
      _matcher: opts.matcher,
      _lastRefresh: 0,
      _timer: null,
    };
  }

  // Whether navigating origUrl → newUrl counts as leaving the monitored page.
  // Compares origin + pathname only, ignoring hash/query so an in-place reload
  // (same URL) or a #fragment change doesn't trip a stop. No baseline → never a
  // navigate-away; an unparseable URL → treated as a navigate-away (stop to be
  // safe, e.g. a jump to chrome://).
  function isNavigateAway(origUrl, newUrl) {
    if (!origUrl) return false;
    try {
      const a = new URL(origUrl);
      const b = new URL(newUrl);
      return !(a.origin === b.origin && a.pathname === b.pathname);
    } catch (e) {
      return true;
    }
  }

  return { buildRehydratedJob, isNavigateAway };
});
