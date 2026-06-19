// quiet-hours.js — pure "are we inside a quiet window right now?" logic for the
// alert scheduler. Extracted so the time-window math (which wraps midnight and
// filters by weekday — both easy to get subtly wrong) is unit-testable without
// faking a clock in the service worker.
//
// WHY: a monitor job left running overnight WILL beep, flash, and post a desktop
// notification at 3am — there is otherwise no way to say "watch quietly between
// 11pm and 7am" or "pause hammering this site while I'm asleep". Two modes:
//   • 'suppress' — keep detecting (baseline + counts + badge + log still update);
//                  only mute the chosen delivery channels (sound/flash/notify).
//   • 'pause'    — skip the reload entirely and re-check later.
// The caller reads config.mode/config.channels; this module only answers the
// boolean "is `now` inside the window?".
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('quiet-hours.js') → globalThis.ARPQuietHours
//   • Node test runner: require('./quiet-hours.js')       → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPQuietHours = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_OF_DAY = 24 * 60;

  function clampMinutes(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return 0;
    return Math.min(MIN_OF_DAY - 1, Math.max(0, n));
  }

  // Accept either a Date (service-worker call site uses `new Date()` for LOCAL
  // time) or a plain { minutesOfDay, day } object (tests, and any caller that has
  // already decomposed the clock). day is 0=Sun…6=Sat to match Date.getDay().
  function decompose(now) {
    if (now && typeof now.getHours === 'function') {
      return { minutesOfDay: now.getHours() * 60 + now.getMinutes(), day: now.getDay() };
    }
    if (typeof now === 'number') {
      // A bare number is minutes-of-day; no weekday context, so day-filtering off.
      return { minutesOfDay: clampMinutes(now), day: -1 };
    }
    now = now || {};
    const day = Number(now.day);
    return {
      minutesOfDay: clampMinutes(now.minutesOfDay),
      day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : -1,
    };
  }

  // Parse "HH:MM" (24h) → minutes-of-day, or null if malformed. For the options
  // UI / import boundary, where times arrive as strings.
  function parseTimeToMinutes(str) {
    if (typeof str !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // Render minutes-of-day → "HH:MM" for the UI.
  function minutesToTime(min) {
    const m = clampMinutes(min);
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // Is `now` inside the configured quiet window?
  //   config.enabled   — master switch (false ⇒ never quiet)
  //   config.startMin  — window start, minutes-of-day [0,1440)
  //   config.endMin    — window end,   minutes-of-day [0,1440)
  //   config.days      — optional 7-element boolean array indexed by getDay()
  //                      (Sun..Sat); when present, the window only applies on
  //                      enabled days. A day with no weekday context (numeric
  //                      `now`) skips this filter.
  // A window where start === end is treated as zero-width (disabled), NOT as
  // "all day": "quiet from 9:00 to 9:00" is far more likely a misconfiguration
  // than an intent to mute every hour. start < end is a same-day window; start >
  // end wraps past midnight (e.g. 22:00→07:00). The window is half-open
  // [start, end) so back-to-back windows don't double-cover the boundary minute.
  function isWithinQuietHours(now, config) {
    if (!config || !config.enabled) return false;
    const { minutesOfDay, day } = decompose(now);
    const start = clampMinutes(config.startMin);
    const end = clampMinutes(config.endMin);
    if (start === end) return false; // zero-width = disabled

    // Weekday filter. For a midnight-wrapping window the "active day" is the day
    // the window STARTED on, so an after-midnight minute (before `end`) is
    // checked against yesterday's flag — otherwise a Fri 22:00→07:00 window
    // would wrongly switch off at Sat 00:00 even though the user is still asleep.
    if (Array.isArray(config.days) && config.days.length === 7 && day >= 0) {
      const wraps = start > end;
      const inLatePart = wraps && minutesOfDay < end; // 00:00..end belongs to prev day
      const effectiveDay = inLatePart ? (day + 6) % 7 : day;
      if (!config.days[effectiveDay]) return false;
    }

    if (start < end) return minutesOfDay >= start && minutesOfDay < end;
    return minutesOfDay >= start || minutesOfDay < end; // wraps midnight
  }

  // Convenience for the worker: returns the action to take this cycle —
  // 'none' (not quiet), or config.mode ('suppress' | 'pause') when quiet.
  function quietAction(now, config) {
    if (!isWithinQuietHours(now, config)) return 'none';
    return config && config.mode === 'pause' ? 'pause' : 'suppress';
  }

  // Should a specific delivery channel be muted right now? In 'suppress' mode a
  // channel is muted only if it's listed in config.channels (default: all three
  // — sound, flash, notify — when channels is absent). 'pause' mode never reaches
  // here (the cycle is skipped before any channel fires).
  function isChannelMuted(now, config, channel) {
    if (quietAction(now, config) !== 'suppress') return false;
    const chans = config && config.channels;
    if (!chans || typeof chans !== 'object') return true; // default: mute everything
    return chans[channel] !== false;
  }

  return {
    isWithinQuietHours,
    quietAction,
    isChannelMuted,
    parseTimeToMinutes,
    minutesToTime,
    MIN_OF_DAY,
  };
});
