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
  const MAX_SCAN = 200000;

  // Collapse whitespace runs to a single space and trim. When collapseDigits is
  // set, runs of digits become a single '0' so timestamps/counters/IDs that tick
  // every reload don't read as a change.
  function normalize(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string') return '';
    let s = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
    if (opts.collapseDigits) s = s.replace(/\d+/g, '0');
    return s.replace(/\s+/g, ' ').trim();
  }

  function tokenSet(s) {
    const set = new Set();
    for (const t of s.split(' ')) if (t) set.add(t);
    return set;
  }

  // Jaccard distance over word tokens: |symmetric difference| / |union|, in
  // [0,1]. O(n) in the token count — deliberately not an O(n^2) edit distance.
  // Two empty inputs are identical (0).
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

  return { normalize, changedFraction, isMeaningfulChange, MAX_SCAN };
});
