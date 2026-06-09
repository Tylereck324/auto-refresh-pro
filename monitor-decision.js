// monitor-decision.js — the pure "should an alert fire this cycle?" logic for
// the keyword / page-change monitor. Extracted from background.js because it is
// the single most behavior-defining branch of the feature, yet was inline and
// untested: a refactor of these booleans could silently break the headline
// keyword-detection feature while every other test stayed green.
//
// The rules:
//   • Keyword: alert only on a TRANSITION across the baseline — absent→present
//     normally, present→absent in inverse mode. A persistently-present keyword
//     must NOT beep every cycle, and the first cycle (no baseline) never fires.
//   • Change: only when no keyword owns the signal, monitor mode is on, and a
//     real baseline exists (the actual text diff is computed by the caller).
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('monitor-decision.js') → globalThis.ARPMonitor
//   • Node test runner: require('./monitor-decision.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Whether the keyword alert should fire this cycle.
  //   foundNow    — keyword present in the current page text
  //   foundPrev   — keyword present in the previous cycle's text
  //   hasBaseline — a previous-content baseline exists (false on the first cycle)
  //   kwInverse   — "alert when the keyword DISAPPEARS" mode
  // No baseline ⇒ never fire (avoids alerting on content already present at start).
  function computeKeywordFire({ foundNow, foundPrev, hasBaseline, kwInverse }) {
    if (!hasBaseline) return false;
    return kwInverse ? (!foundNow && !!foundPrev) : (!!foundNow && !foundPrev);
  }

  // Whether to evaluate the generic page-change path this cycle. The keyword, when
  // set, owns the signal, so change-monitoring is skipped to avoid drowning it.
  // The caller still computes the actual text diff; this only gates entry.
  function shouldCheckChange({ hasKeyword, monitorMode, hasBaseline }) {
    return !hasKeyword && !!monitorMode && !!hasBaseline;
  }

  return { computeKeywordFire, shouldCheckChange };
});
