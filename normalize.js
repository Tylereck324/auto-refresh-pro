// normalize.js — pure text-normalization & change-significance helpers for the
// page-change monitor. Extracted so the "ignore noise" logic is unit-testable.
//
// The whole-page change detector otherwise fires on any text diff, so pages with
// live clocks, ad rotations, view counters, or CSRF tokens alert on essentially
// every reload. These helpers collapse that noise and gate on a minimum amount
// of real change.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('normalize.js') → globalThis.ARPNormalize
//   • Node test runner: require('./normalize.js')      → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPNormalize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Bound the work done per comparison; page innerText can be very large.
  // NOTE: keyword-match.js has a sibling cap (MAX_REGEX_SCAN) for the keyword
  // path; if you tune this bound, look at that one too.
  const MAX_SCAN = 200000;

  // Collapse whitespace runs to a single space and trim. When collapseDigits is
  // set, runs of digits become a single '0' so timestamps/counters/IDs that tick
  // every reload don't read as a change.
  function normalize(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string') return '';
    // At-cap inputs (this slice, or readPageText's upstream cap) get their last
    // token dropped: a length change EARLIER in the document (a counter ticking
    // 99→100) shifts every later character, so the cut lands mid-token in a
    // different place each snapshot — and that boundary noise alone would read
    // as a change, defeating collapseDigits for >cap pages.
    const truncated = text.length >= MAX_SCAN;
    let s = truncated ? text.slice(0, MAX_SCAN) : text;
    if (opts.collapseDigits) s = s.replace(/\d+/g, '0');
    s = s.replace(/\s+/g, ' ').trim();
    if (truncated) s = s.replace(/ [^ ]*$/, '');
    return s;
  }

  function tokenSet(s) {
    const set = new Set();
    for (const t of s.split(' ')) if (t) set.add(t);
    return set;
  }

  // Jaccard distance over word tokens: |symmetric difference| / |union|, in
  // [0,1]. O(n) in the token count — deliberately not an O(n^2) edit distance.
  // Two empty inputs are identical (0).
  //
  // KNOWN BLIND SPOT (accepted): sets ignore order and multiplicity, so a pure
  // reordering ("A B C" → "C B A") or a repetition-count change ("error" →
  // "error error error") is distance 0 and won't clear a non-zero threshold.
  // That's the right call for the noise-suppression goal (ad/listing shuffles
  // shouldn't alert), but it means "the same words rearranged" never counts as
  // a change when minChangedFraction > 0.
  function changedFraction(a, b) {
    const A = tokenSet(typeof a === 'string' ? a : '');
    const B = tokenSet(typeof b === 'string' ? b : '');
    if (A.size === 0 && B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    if (union === 0) return 0;
    return (union - inter) / union;
  }

  // Decide whether prev→curr is a meaningful change under the given options.
  //   opts.collapseDigits     — normalize digits away before comparing
  //   opts.minChangedFraction — require at least this fraction of tokens to differ
  //                             (0 = any non-zero difference counts)
  function isMeaningfulChange(prev, curr, opts) {
    opts = opts || {};
    const nPrev = normalize(prev, opts);
    const nCurr = normalize(curr, opts);
    if (nPrev === nCurr) return false;
    const threshold = Number(opts.minChangedFraction) || 0;
    if (threshold <= 0) return true; // any real (post-normalization) difference
    return changedFraction(nPrev, nCurr) >= threshold;
  }

  // Summarize what changed between two page snapshots, for the alert log. Returns
  // { added, removed, summary } where added/removed are bounded token lists and
  // summary is a short "+new −gone" string. Deliberately NOT digit-collapsed by
  // default: the snippet is for a human reading the journal ("$19.99" → "$24.99"
  // should be visible), unlike isMeaningfulChange whose job is to suppress that
  // noise. Whitespace is still collapsed so layout churn doesn't dominate. O(n)
  // in the token count, and each side is capped so a wholesale page swap can't
  // produce a multi-thousand-token entry.
  function diffTokens(prev, curr, opts) {
    opts = opts || {};
    const max = Number.isFinite(Number(opts.max)) ? Math.max(1, Math.floor(Number(opts.max))) : 12;
    // Only collapse digits if the caller explicitly asks; default keeps numbers.
    const nOpts = { collapseDigits: !!opts.collapseDigits };
    const A = tokenSet(normalize(prev, nOpts));
    const B = tokenSet(normalize(curr, nOpts));
    const added = [];
    const removed = [];
    for (const t of B) if (!A.has(t) && added.length < max) added.push(t);
    for (const t of A) if (!B.has(t) && removed.length < max) removed.push(t);
    const parts = [];
    for (const t of added) parts.push('+' + t);
    for (const t of removed) parts.push('−' + t); // U+2212 MINUS SIGN
    let summary = parts.join(' ');
    // Bound the rendered summary length too — a page of long unique tokens could
    // still blow past a sane entry size even within the per-side count cap.
    const MAX_SUMMARY = 240;
    if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1) + '…';
    return { added, removed, summary };
  }

  return { normalize, changedFraction, isMeaningfulChange, diffTokens, MAX_SCAN };
});
