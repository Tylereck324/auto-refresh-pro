// keyword-match.js — pure keyword-matching logic for the change/keyword monitor.
//
// Extracted from background.js so the matching rules (multi-keyword, whole-word,
// case sensitivity, regex) are unit-testable and so the regex path is compiled
// once per job rather than on every refresh cycle.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('keyword-match.js') → globalThis.ARPKeyword
//   • Node test runner: require('./keyword-match.js')      → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPKeyword = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Upper bound on text scanned by a compiled regex per cycle. The static guard
  // (validators.isSafeRegex) excludes the known exponential shapes, but a
  // statically-allowed pattern can still backtrack quadratically — and the
  // match runs synchronously in the service worker every cycle, so the cap is
  // what keeps the worst case at a tolerable per-cycle budget (~O(n²) at 20k is
  // milliseconds; at 200k it was tens of seconds, i.e. a frozen worker).
  // Trade-off: in regex mode a keyword first appearing beyond the cap is missed;
  // plain substring matching is linear, scans the full text, and isn't capped.
  // NOTE: normalize.js has a sibling cap (MAX_SCAN) for the change-detection path.
  const MAX_REGEX_SCAN = 20000;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Split a raw keyword string into individual terms (comma-separated = match ANY).
  // A term with no comma yields a single-element list — identical to the old
  // single-keyword behavior. '\,' escapes a literal comma: without it a keyword
  // like "1,000 in stock" silently became the terms "1" + "000 in stock", and
  // "1" matches essentially every page.
  function parseKeywords(raw) {
    if (typeof raw !== 'string') return [];
    return raw.split(/(?<!\\),/)
      .map(s => s.trim().replace(/\\,/g, ','))
      .filter(Boolean);
  }

  // Build a matcher from a job's keyword settings.
  //   settings: { keyword, kwCaseSensitive, kwWholeWord, kwRegex }
  //   opts.isSafeRegex(pattern) — optional guard; if provided and it returns
  //     false for a regex pattern, the matcher reports { ok:false } so callers
  //     can refuse to enter regex mode.
  // Returns { ok, empty, error, test(text)->bool }.
  function compileMatcher(settings, opts) {
    settings = settings || {};
    opts = opts || {};
    const raw = typeof settings.keyword === 'string' ? settings.keyword.trim() : '';
    if (!raw) return { ok: true, empty: true, test: () => false };

    const caseSensitive = !!settings.kwCaseSensitive;

    if (settings.kwRegex) {
      if (opts.isSafeRegex && !opts.isSafeRegex(raw)) {
        return { ok: false, empty: false, error: 'unsafe regex', test: () => false };
      }
      let re;
      try {
        re = new RegExp(raw, caseSensitive ? '' : 'i');
      } catch (e) {
        return { ok: false, empty: false, error: String(e && e.message || e), test: () => false };
      }
      return {
        ok: true, empty: false,
        test: (text) => {
          if (typeof text !== 'string') return false;
          const scan = text.length > MAX_REGEX_SCAN ? text.slice(0, MAX_REGEX_SCAN) : text;
          re.lastIndex = 0;
          return re.test(scan);
        },
      };
    }

    const terms = parseKeywords(raw);
    if (terms.length === 0) return { ok: true, empty: true, test: () => false };

    if (settings.kwWholeWord) {
      const body = terms.map(escapeRegex).join('|');
      let re;
      try {
        // Unicode-aware word boundaries. \b is ASCII-only (\w), so with it a
        // non-ASCII keyword ("café", "日本語") silently NEVER matched — no
        // boundary exists between é and a space. Lookarounds over letters/
        // numbers/_ express the same "not inside a word" rule for any script,
        // and also fix terms ending in punctuation ("C++"), where \b required
        // a word char after the '+'. The 'u' flag is required for \p{...}
        // (escapeRegex only emits escapes that stay valid under 'u').
        const notWord = '[\\p{L}\\p{N}_]';
        re = new RegExp(
          '(?<!' + notWord + ')(?:' + body + ')(?!' + notWord + ')',
          (caseSensitive ? '' : 'i') + 'u'
        );
      } catch (e) {
        return { ok: false, empty: false, error: String(e && e.message || e), test: () => false };
      }
      return {
        ok: true, empty: false,
        test: (text) => typeof text === 'string' && re.test(text),
      };
    }

    // Plain (case-insensitive by default) substring, ANY of the terms.
    const needles = caseSensitive ? terms : terms.map(t => t.toLowerCase());
    return {
      ok: true, empty: false,
      test: (text) => {
        if (typeof text !== 'string') return false;
        const hay = caseSensitive ? text : text.toLowerCase();
        return needles.some(n => hay.includes(n));
      },
    };
  }

  return { compileMatcher, parseKeywords, escapeRegex, MAX_REGEX_SCAN };
});
