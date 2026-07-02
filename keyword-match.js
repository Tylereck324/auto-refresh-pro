// keyword-match.js — pure keyword-matching logic for the change/keyword monitor.
//
// Extracted from background.js so the matching rules (multi-keyword, whole-word,
// case sensitivity, regex, whitespace-normalized phrases) are unit-testable and
// so the regex path is compiled once per job rather than on every refresh cycle.
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

  // Collapse every run of whitespace — spaces, tabs, and the newlines that
  // innerText inserts between block elements — down to a single space, and trim.
  // The text the matcher scans is document.body.innerText, where a card's bold
  // title and the "By <author>" line beneath it are SEPARATE lines. So a pasted
  // phrase that spans them ("… - Evaluation By Vortex Oasis") never appears as a
  // literal substring of the raw text and could never match. Normalizing BOTH the
  // needle and the haystack the same way makes phrase matching robust to line
  // breaks and irregular spacing. Same idiom normalize.js uses for the
  // change-detection path. Deliberately NOT applied in regex mode, where the user
  // may match whitespace on purpose (\n, \s, runs of spaces).
  function normalizeWs(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
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
      // Normalize each term's internal whitespace before escaping so a phrase
      // term ("in  stock") matches against the equally-normalized haystack.
      const body = terms.map(t => escapeRegex(normalizeWs(t))).join('|');
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
        test: (text) => typeof text === 'string' && re.test(normalizeWs(text)),
      };
    }

    // Plain (case-insensitive by default) substring, ANY of the terms. Both the
    // needle and the haystack are whitespace-normalized (see normalizeWs) so a
    // phrase matches across the line breaks innerText inserts between a card's
    // title and its "By <author>" line, and across any irregular spacing.
    const fold = caseSensitive ? normalizeWs : (s) => normalizeWs(s).toLowerCase();
    const needles = terms.map(fold);
    return {
      ok: true, empty: false,
      test: (text) => {
        if (typeof text !== 'string') return false;
        const hay = fold(text);
        return needles.some(n => hay.includes(n));
      },
    };
  }

  return { compileMatcher, parseKeywords, escapeRegex, normalizeWs, MAX_REGEX_SCAN };
});
