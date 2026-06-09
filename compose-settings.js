// compose-settings.js — the single canonical constructor for the job-settings
// object the background's refresh loop consumes.
//
// WHY: this object was previously built by hand in two places that had to stay in
// lockstep but drifted — popup.js gatherSettings() (popup-launched jobs) and the
// background HOTKEY_TOGGLE handler (hotkey-launched jobs). The drift caused real
// gaps (e.g. the popup path omitting fields the hotkey path carried). Both now
// call composeJobSettings(s, g) so a field is defined in exactly one place.
//
//   s — the popup's per-launch state (popupSettings shape): selectedMs, random,
//       randomMin/randomMax (seconds), stopOnClick, sound, monitor, noiseTolerant,
//       collapseDigits, minChangedFraction (0–1), keyword, kw*, stopOn*, beepUntilAck.
//   g — the Settings-page defaults (globalSettings): hardRefresh, showCountdown,
//       notify, preserveScroll, stopAfter, sound tone/volume/repeat, defaultInterval,
//       plus the legacy random/stopOnClick values for un-migrated configs.
//
// Loaded three ways, so it stays dependency-free and side-effect-free:
//   • service worker:   importScripts('compose-settings.js') → globalThis.ARPCompose
//   • popup page:       <script src="compose-settings.js">    → window.ARPCompose
//   • Node test runner: require('./compose-settings.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPCompose = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 30000;
  const MIN_RANDOM_SEC = 2;
  const DEFAULT_RANDOM_MIN_SEC = 5;
  const DEFAULT_RANDOM_MAX_SEC = 60;

  function composeJobSettings(s, g) {
    s = s || {};
    g = g || {};

    // Interval: the popup always supplies selectedMs; the hotkey path may not, so
    // fall back to the Settings default (then a hard 30s).
    const interval = s.selectedMs || (g.defaultInterval ? g.defaultInterval * 1000 : DEFAULT_INTERVAL_MS);

    // A field that "moved" from Settings into the popup falls back to the legacy
    // globalSettings value when the popup state predates the move (s.* undefined).
    const pref = (sv, gv) => (sv !== undefined ? sv : gv);
    const numOr = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };

    // Random range: floor each bound at 2s and swap an inverted range so the
    // background never receives a negative-width or sub-floor range. (interval.js
    // re-applies this at compute time; doing it here keeps the stored values canonical.)
    let randomMinSec = Math.max(MIN_RANDOM_SEC, numOr(pref(s.randomMin, g.randomMin), DEFAULT_RANDOM_MIN_SEC));
    let randomMaxSec = Math.max(MIN_RANDOM_SEC, numOr(pref(s.randomMax, g.randomMax), DEFAULT_RANDOM_MAX_SEC));
    if (randomMinSec > randomMaxSec) { const t = randomMinSec; randomMinSec = randomMaxSec; randomMaxSec = t; }

    return {
      interval,
      // ── Preferences (Settings page / globalSettings) ──
      hardRefresh: !!g.hardRefresh,
      showCountdown: g.showCountdown !== false,
      notify: !!g.notify,
      preserveScroll: !!g.preserveScroll,
      stopAfter: Math.max(0, parseInt(g.stopAfter, 10) || 0),
      soundVolume: typeof g.soundVolume === 'number' ? g.soundVolume : 0.9,
      soundTone: g.soundTone || 'beep',
      soundRepeat: parseInt(g.soundRepeat, 10) || 1,
      // ── Per-launch (popup state) ──
      randomTimer: !!pref(s.random, g.random),
      randomMin: randomMinSec * 1000,
      randomMax: randomMaxSec * 1000,
      stopOnClick: !!pref(s.stopOnClick, g.stopOnClick),
      // Sound gets the same legacy fallback as random/stopOnClick: the popup
      // seeds its checkbox from g.sound, so a hotkey launch before the popup
      // has ever saved popupSettings must read the same default, not false.
      sound: !!pref(s.sound, g.sound),
      monitorMode: !!s.monitor,
      noiseTolerant: !!s.noiseTolerant,
      collapseDigits: s.collapseDigits !== false,
      minChangedFraction: Math.min(1, Math.max(0, parseFloat(s.minChangedFraction) || 0)),
      keyword: typeof s.keyword === 'string' ? s.keyword : '',
      kwCaseSensitive: !!s.kwCaseSensitive,
      kwWholeWord: !!s.kwWholeWord,
      kwRegex: !!s.kwRegex,
      kwInverse: !!s.kwInverse,
      stopOnKeyword: !!s.stopOnKeyword,
      stopOnChange: !!s.stopOnChange,
      beepUntilAck: !!s.beepUntilAck,
      currentInterval: interval,
    };
  }

  return { composeJobSettings };
});
