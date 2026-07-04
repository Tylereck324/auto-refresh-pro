// Tests for the per-item detection helpers: stable key derivation (whitespace-
// and optionally digit-insensitive), matching-key collection with dedup, and the
// arrival/departure set diff that drives "alert on each new match".
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { itemKey, collectMatches, collectItems, computeNewKeys, parseItemMeta } = require('../item-detect.js');
const { compileMatcher } = require('../keyword-match.js');

// ── itemKey ──────────────────────────────────────────────────────────────────
test('itemKey is stable across whitespace/line-break differences', () => {
  // The same card read with the innerText line break vs. flattened must key equal.
  assert.equal(
    itemKey('AI Videos - Evaluation\nBy Vortex Oasis'),
    itemKey('AI Videos - Evaluation   By Vortex Oasis')
  );
});

test('itemKey distinguishes different items (different author / title)', () => {
  const a = itemKey('AI Videos - Evaluation\nBy Vortex Oasis');
  const b = itemKey('AI Videos - Evaluation\nBy Galactic Probe');
  const c = itemKey('AI Images - Evaluation\nBy Vortex Oasis');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('itemKey returns short non-empty strings; empty/garbage → empty', () => {
  const k = itemKey('something');
  assert.equal(typeof k, 'string');
  assert.ok(k.length > 0 && k.length <= 8);
  assert.equal(itemKey('   \n\t '), '');
  assert.equal(itemKey(42), '');
});

test('itemKey collapseDigits folds volatile numbers (relative times/counters)', () => {
  // OFF by default: distinct timestamps stay distinct.
  assert.notEqual(itemKey('Study A • posted 2 min ago'), itemKey('Study A • posted 9 min ago'));
  // ON: the digit churn is folded so the same card keys equal across reloads.
  assert.equal(
    itemKey('Study A • posted 2 min ago', { collapseDigits: true }),
    itemKey('Study A • posted 9 min ago', { collapseDigits: true })
  );
});

// ── collectMatches ───────────────────────────────────────────────────────────
test('collectMatches returns keys only for matching items, de-duplicated', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const items = [
    'AI Videos - Evaluation\nBy Vortex Oasis',
    'Quick survey about coffee\nBy Someone',          // no match
    'AI Images - Evaluation\nBy Galactic Probe',
    'AI Videos - Evaluation\nBy Vortex Oasis',         // duplicate of #1
  ];
  const keys = collectMatches(items, m);
  assert.equal(keys.length, 2); // two distinct matching cards, dupe collapsed
  assert.deepEqual(keys, [itemKey(items[0]), itemKey(items[2])]);
});

test('collectMatches is safe on bad input', () => {
  const m = compileMatcher({ keyword: 'x' });
  assert.deepEqual(collectMatches(null, m), []);
  assert.deepEqual(collectMatches(['x'], null), []);
  assert.deepEqual(collectMatches([null, '', 42, 'x'], m), [itemKey('x')]);
});

// ── computeNewKeys ───────────────────────────────────────────────────────────
test('computeNewKeys returns arrivals in normal mode', () => {
  assert.deepEqual(computeNewKeys(['a', 'b'], ['b', 'c', 'd'], false), ['c', 'd']);
  // Nothing new while the same matches persist — the headline under-firing fix.
  assert.deepEqual(computeNewKeys(['a', 'b'], ['a', 'b'], false), []);
});

test('computeNewKeys returns departures in inverse mode', () => {
  assert.deepEqual(computeNewKeys(['a', 'b', 'c'], ['b'], true), ['a', 'c']);
  assert.deepEqual(computeNewKeys(['a'], ['a'], true), []);
});

test('computeNewKeys treats an empty baseline as real (everything is new)', () => {
  assert.deepEqual(computeNewKeys([], ['a', 'b'], false), ['a', 'b']);
});

test('collectMatches threads key opts through (digit-variant dedupe)', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const items = [
    'AI Videos - Evaluation\nBy Vortex Oasis • 24 places',
    'AI Videos - Evaluation\nBy Vortex Oasis • 23 places', // same card, counter ticked
  ];
  // Without collapseDigits the counter mints two identities…
  assert.equal(collectMatches(items, m).length, 2);
  // …with it they collapse to one, keyed identically to itemKey(text, opts).
  const keys = collectMatches(items, m, { collapseDigits: true });
  assert.deepEqual(keys, [itemKey(items[0], { collapseDigits: true })]);
});

test('a ticking counter inside a card does not re-fire with collapseDigits', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const opts = { collapseDigits: true };
  const cycle1 = ['AI Videos - Evaluation\nBy Vortex Oasis • 24 places'];
  const cycle2 = ['AI Videos - Evaluation\nBy Vortex Oasis • 19 places'];
  // Without opts the same card re-fires every cycle the counter ticks…
  assert.equal(computeNewKeys(collectMatches(cycle1, m), collectMatches(cycle2, m), false).length, 1);
  // …with opts it is recognized as the same item: silence.
  assert.deepEqual(computeNewKeys(collectMatches(cycle1, m, opts), collectMatches(cycle2, m, opts), false), []);
});

test('end-to-end: starting on an EMPTY list, the first arrival fires', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const baseline = collectMatches([], m); // rendered page, zero items = real []
  assert.deepEqual(baseline, []);
  const cycle = collectMatches(['AI Videos - Evaluation\nBy Vortex Oasis'], m);
  assert.equal(computeNewKeys(baseline, cycle, false).length, 1);
});

// ── per-item exclusion (collectMatches 4th arg) ──────────────────────────────
// The exclude matcher mirrors background.buildExcludeMatcher: literal terms,
// whole-word boundaries, never substring/regex — see that builder for why.
const excludeMatcher = (terms) => compileMatcher({ keyword: terms, kwWholeWord: true });

test('collectMatches drops matching items the exclude matcher also accepts', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const ex = excludeMatcher('1 place');
  const items = [
    'AI Videos - Evaluation\nBy Vortex Oasis\n$5.00 • $20.00/hr\n15 mins\n1 place',   // broken single-slot card
    'AI Images - Evaluation\nBy Galactic Probe\n$5.00 • $20.00/hr\n15 mins\n120 places',
  ];
  assert.deepEqual(collectMatches(items, m, undefined, ex), [itemKey(items[1])]);
});

test('whole-word exclusion of "1 place" spares 21/61/120 places', () => {
  // As a SUBSTRING "1 place" is contained in "21 places"/"61 places" — the
  // whole-word compile is what keeps real multi-slot listings alertable.
  const m = compileMatcher({ keyword: '- Evaluation' });
  const ex = excludeMatcher('1 place');
  const spared = ['21 places', '61 places', '120 places', '1 placeholder']
    .map(n => 'AI Videos - Evaluation\nBy Vortex Oasis\n' + n);
  assert.equal(collectMatches(spared, m, undefined, ex).length, spared.length);
});

test('end-to-end: an excluded arrival never fires; its recovery fires as new', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const ex = excludeMatcher('1 place');
  const baseline = collectMatches([], m, undefined, ex);
  // A broken 1-place card arrives: silence.
  const broken = ['AI Videos - Evaluation\nBy Vortex Oasis\n1 place'];
  const k1 = collectMatches(broken, m, undefined, ex);
  assert.deepEqual(computeNewKeys(baseline, k1, false), []);
  // The same card refills to 60 places: it was never in the seen-set, so it
  // now fires as a genuine arrival.
  const refilled = ['AI Videos - Evaluation\nBy Vortex Oasis\n60 places'];
  const k2 = collectMatches(refilled, m, undefined, ex);
  assert.equal(computeNewKeys(k1, k2, false).length, 1);
});

test('an absent or empty exclude matcher excludes nothing', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const items = ['AI Videos - Evaluation\nBy Vortex Oasis\n1 place'];
  assert.equal(collectMatches(items, m).length, 1);
  // Empty kwExclude compiles to the empty matcher (test → false) — unchanged.
  assert.equal(collectMatches(items, m, undefined, excludeMatcher('')).length, 1);
});

test('end-to-end: a new card fires while persistent matches stay quiet', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const cycle1 = ['AI Videos - Evaluation\nBy Vortex Oasis'];
  const cycle2 = [
    'AI Videos - Evaluation\nBy Vortex Oasis',          // still there
    'AI Images - Evaluation\nBy Galactic Probe',         // NEW
  ];
  const k1 = collectMatches(cycle1, m);
  const k2 = collectMatches(cycle2, m);
  const fired = computeNewKeys(k1, k2, false);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired, [itemKey(cycle2[1])]);
});

// ── collectItems (link carry-through) ────────────────────────────────────────
test('collectItems returns key/href/text per accepted item, deduped by key', () => {
  const m = compileMatcher({ keyword: '- Evaluation' });
  const items = [
    { text: 'AI Videos - Evaluation\nBy Vortex Oasis', href: 'https://app.prolific.com/studies/abc' },
    { text: 'Quick survey about coffee\nBy Someone', href: 'https://x/nomatch' }, // no keyword match
    { text: 'AI Images - Evaluation\nBy Galactic Probe', href: 'https://app.prolific.com/studies/def' },
    { text: 'AI Videos - Evaluation\nBy Vortex Oasis', href: 'https://dupe' },     // dupe of #0 by key
  ];
  const got = collectItems(items, m);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(c => c.key), [itemKey(items[0].text), itemKey(items[2].text)]);
  // First occurrence wins the href; the later duplicate is dropped.
  assert.equal(got[0].href, 'https://app.prolific.com/studies/abc');
  assert.equal(got[1].href, 'https://app.prolific.com/studies/def');
  // collectMatches is exactly the key-only view of the same result.
  assert.deepEqual(collectMatches(items, m), got.map(c => c.key));
});

test('collectItems accepts bare strings too (href defaults to empty)', () => {
  const m = compileMatcher({ keyword: 'x' });
  assert.deepEqual(collectItems(['x'], m), [{ key: itemKey('x'), href: '', text: 'x' }]);
  // Mixed/garbage entries are skipped just like collectMatches.
  assert.deepEqual(collectItems([null, '', 42, { text: '' }, 'x'], m).map(c => c.key), [itemKey('x')]);
  assert.deepEqual(collectItems(null, m), []);
});

test('collectItems href is dropped for a non-object item field', () => {
  const m = compileMatcher({ keyword: 'x' });
  // A matched string has no href; a matched object without href gets ''.
  assert.deepEqual(collectItems([{ text: 'x' }], m)[0], { key: itemKey('x'), href: '', text: 'x' });
});

// ── parseItemMeta (best-effort alert enrichment) ─────────────────────────────
test('parseItemMeta pulls title / £-per-hour / places / researcher', () => {
  const meta = parseItemMeta('AI Videos - Evaluation\nBy Vortex Oasis\n£9.00 · £36.00/hr\n23 places');
  assert.equal(meta.title, 'AI Videos - Evaluation');
  assert.equal(meta.pay, '£36.00/hr');
  assert.equal(meta.places, '23 places');
  assert.equal(meta.researcher, 'Vortex Oasis');
});

test('parseItemMeta matches "per hour" wording and spots/place variants', () => {
  assert.equal(parseItemMeta('Study\n$12 per hour\n1 spot').pay, '$12 per hour');
  assert.equal(parseItemMeta('Study\n$12 per hour\n1 spot').places, '1 spot');
  assert.equal(parseItemMeta('Study\n£8/hr\n5 places').pay, '£8/hr');
});

test('parseItemMeta omits fields it cannot find and is safe on junk', () => {
  const meta = parseItemMeta('Just a plain title with nothing else');
  assert.equal(meta.title, 'Just a plain title with nothing else');
  assert.equal(meta.pay, undefined);
  assert.equal(meta.places, undefined);
  assert.equal(meta.researcher, undefined);
  assert.deepEqual(parseItemMeta(''), {});
  assert.deepEqual(parseItemMeta(42), {});
});

test('parseItemMeta does not mistake a bare total reward for an hourly rate', () => {
  // "£9.00" alone (no /hr, no "per hour") must not be reported as pay.
  assert.equal(parseItemMeta('Some study\n£9.00\n10 places').pay, undefined);
});
