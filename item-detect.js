// item-detect.js — pure helpers for per-item ("alert on each new match")
// keyword detection.
//
// WHY: the page-level keyword path (background.doMonitorRefresh + monitor-decision
// computeKeywordFire) answers ONE boolean per cycle — "is the keyword anywhere on
// the page?" — and fires only on absent→present. On a busy list where some match
// is ALWAYS on screen (a feed of studies, listings, tickets) that boolean never
// flips back, so a newly-arrived matching item never re-alerts. Per-item detection
// instead treats each element matched by the job's CSS selector as a discrete
// item, keys each by its (normalized) text, and fires on the set of NEW matching
// keys between cycles — one alert per batch of arrivals, regardless of how many
// matches already sit on the page.
//
// Item boundaries come from the selector (each matched element = one item); there
// is no reliable way to segment an arbitrary page, which is why per-item mode is
// gated on a watchSelector being set.
//
// Loaded two ways, dependency-free and side-effect-free:
//   • service worker:   importScripts('item-detect.js') → globalThis.ARPItemDetect
//   • Node test runner: require('./item-detect.js')      → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPItemDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Cap the text hashed per item. Card text is tiny, but a broad selector could
  // match a large node, and the key is recomputed every cycle. Matches the
  // per-item slice readPageText applies in-page, so the key sees the same text.
  const MAX_ITEM_TEXT = 4000;

  // Derive a short, stable key for one item's text.
  //   • Whitespace is collapsed (the newlines innerText inserts between a card's
  //     title and its "By <author>" line must not change the key) — same idiom as
  //     normalize.js / keyword-match.normalizeWs.
  //   • opts.collapseDigits optionally folds digit runs to '0' — same semantics
  //     as normalize.js (keep the two in sync) — so relative
  //     timestamps / counters that tick every reload ("2 min ago", view counts)
  //     don't make every item look new. OFF by default: with stable absolute
  //     timestamps (e.g. Prolific) two otherwise-identical items posted at
  //     different times must stay distinct, and collapsing digits would merge
  //     them. (The background wires this to the job's "Ignore noise" settings —
  //     see itemKeyOpts — passed identically to the baseline and per-cycle
  //     collects, since keys built with different options never compare equal.)
  // The normalized text is hashed (FNV-1a, 32-bit → base36) so the persisted
  // seen-set stays compact. Distinct items get distinct keys; identical items
  // share one and dedupe. (Hash collisions are theoretically possible — at ~32
  // bits over a few hundred items the odds are ~1e-7 — and would drop one item
  // for one cycle; an acceptable trade for a bounded key.)
  function itemKey(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string') return '';
    let s = text.length > MAX_ITEM_TEXT ? text.slice(0, MAX_ITEM_TEXT) : text;
    if (opts.collapseDigits) s = s.replace(/\d+/g, '0');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // h *= FNV prime (16777619), via shifts to stay in 32-bit int range.
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // An item is either a bare text string (the Node tests and any string-array
  // caller) or a { text, href } object (the in-page per-item read, which also
  // captures each card's own link so an alert can deep-link straight to it).
  // These read the two fields tolerantly so both shapes flow through one path.
  function itemText(el) {
    if (typeof el === 'string') return el;
    return el && typeof el === 'object' && typeof el.text === 'string' ? el.text : '';
  }
  function itemHref(el) {
    return el && typeof el === 'object' && typeof el.href === 'string' ? el.href : '';
  }

  // From an array of items, return one detail record { key, href, text } per item
  // the matcher accepts, de-duplicated by key in first-occurrence order — so a
  // caller can recover the source link/text for a key that computeNewKeys later
  // flags as newly-arrived (to deep-link the alert). `matcher` is any object
  // exposing .test(text)->bool (the ARPKeyword compiled matcher).
  //
  // `exclude` (optional) is a second matcher-like: an item it accepts is DROPPED
  // even though the keyword matched — the "skip items containing …" filter for
  // listings that match the keyword but are known-bad (e.g. a study card whose
  // "1 place" marks it as broken/unjoinable). Applied to the same raw text the
  // keyword sees, BEFORE keying, so a skipped item never enters the seen-set:
  // if its text later changes past the filter (places refilled), it keys fresh
  // and fires as a new arrival — exactly the wanted behavior. Must be passed
  // IDENTICALLY to the baseline and per-cycle collects (like opts), or items
  // filtered on one side would diff as arrivals/departures on the other.
  function collectItems(items, matcher, opts, exclude) {
    const out = [];
    if (!Array.isArray(items) || !matcher || typeof matcher.test !== 'function') return out;
    const skip = exclude && typeof exclude.test === 'function' ? exclude : null;
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      const text = itemText(items[i]);
      if (!text) continue;
      if (!matcher.test(text)) continue;
      if (skip && skip.test(text)) continue;
      const k = itemKey(text, opts);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, href: itemHref(items[i]), text });
    }
    return out;
  }

  // The de-duplicated keys of the accepted items — the key-only view of
  // collectItems, kept as the baseline seed and the stable detection/test API.
  function collectMatches(items, matcher, opts, exclude) {
    return collectItems(items, matcher, opts, exclude).map(c => c.key);
  }

  // The keys that should fire this cycle, given the previous and current matching
  // key sets (both arrays; either may be empty). Normal mode fires on ARRIVALS
  // (in curr, not in prev); inverse mode ("alert when gone") fires on DEPARTURES
  // (in prev, not in curr). Returns an array (possibly empty), preserving source
  // order. Caller decides baseline semantics: a null/absent prev set means "no
  // baseline yet" and should not fire — pass [] only for a real empty baseline.
  function computeNewKeys(prevKeys, currKeys, inverse) {
    if (inverse) {
      const curr = new Set(Array.isArray(currKeys) ? currKeys : []);
      return (Array.isArray(prevKeys) ? prevKeys : []).filter(k => !curr.has(k));
    }
    const prev = new Set(Array.isArray(prevKeys) ? prevKeys : []);
    return (Array.isArray(currKeys) ? currKeys : []).filter(k => !prev.has(k));
  }

  // Best-effort presentation metadata pulled from one item's visible text, used
  // ONLY to enrich an outbound alert (a Discord embed / Slack line) — never for
  // detection or keying. Every field is optional: a card that doesn't match a
  // pattern simply omits it, so this stays robust to layout changes. Tuned for
  // study-listing cards (title line, "£…/hr" reward-per-hour, "N places",
  // "By <researcher>") but degrades gracefully to just a title on anything else.
  function parseItemMeta(text) {
    const meta = {};
    if (typeof text !== 'string' || !text) return meta;
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) meta.title = lines[0].slice(0, 200);
    const pay = text.match(/[£$€]\s?\d[\d,]*(?:\.\d{1,2})?\s*(?:\/\s*(?:hr|hour)\b|per\s+hour\b)/i);
    if (pay) meta.pay = pay[0].replace(/\s+/g, ' ').trim().slice(0, 40);
    const places = text.match(/\b\d[\d,]*\s+(?:places?|spots?)\b/i);
    if (places) meta.places = places[0].replace(/\s+/g, ' ').trim().slice(0, 40);
    const by = lines.find(l => /^by\s+\S/i.test(l));
    if (by) meta.researcher = by.replace(/^by\s+/i, '').trim().slice(0, 120);
    return meta;
  }

  return { itemKey, collectMatches, collectItems, computeNewKeys, parseItemMeta, MAX_ITEM_TEXT };
});
