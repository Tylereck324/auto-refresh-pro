// Instant live watch (page-change trigger) and the read-ordering guards that
// keep overlapping per-item reads from double-alerting.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, deferred } = require('./background-harness.js');

const card = (t) => `${t}\n£10.00/hr\n5 places\nBy Lab`;
const A = { text: card('Study A'), href: 'https://app.example.test/s/a' };
const B = { text: card('Study B'), href: 'https://app.example.test/s/b' };
const settings = {
  interval: 60_000, keyword: 'study', watchSelector: '.card', kwPerItem: true,
  domWatch: true, domWatchInterval: 20_000, notify: false, sound: false, flashOnKeyword: false,
};
const contentScript = { tab: { id: 7 }, url: 'https://example.test/list' };
const reads = (h) => h.calls.filter((c) => c.api === 'scripting.executeScript' && c.details.func && c.details.func.name === 'readPageText');
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup(page) {
  return createHarness({
    async executeScriptResultFor(details) {
      const name = details.func && details.func.name;
      if (name === 'readPageText') return page.read();
      return null;
    },
  });
}

test('a page change triggers an immediate scan that alerts on the new study', async () => {
  let items = [A];
  const h = setup({ read: () => items });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const before = reads(h).length;

  items = [A, B];
  assert.deepEqual(await h.dispatch({ type: 'DOM_MUTATED' }, contentScript), { ok: true });
  await settle(20);
  assert.equal(reads(h).length, before + 1, 'scanned without waiting for the 20 s timer');
  assert.equal(h.evaluate('activeJobs[7].keywordCount'), 1);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('page-change scans are rate-limited per job', async () => {
  const h = setup({ read: () => [A] });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const before = reads(h).length;
  for (let i = 0; i < 5; i++) await h.dispatch({ type: 'DOM_MUTATED' }, contentScript);
  await settle(50);
  assert.equal(reads(h).length, before + 1, 'a burst collapses into one scan');
  await h.dispatch({ type: 'DOM_MUTATED' }, contentScript);
  await settle(50);
  assert.equal(reads(h).length, before + 1, 'the next scan waits out the minimum gap');
  await settle(1000);
  assert.equal(reads(h).length, before + 2);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('only a content script can request a page-change scan', async () => {
  const h = setup({ read: () => [A] });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const manage = { tab: { id: 50 }, url: 'chrome-extension://extension-test-id/manage.html' };
  assert.deepEqual(await h.dispatch({ type: 'DOM_MUTATED', tabId: 7 }, manage), { ok: false });
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('the overlay is told to observe the page only when live watch is on', async () => {
  for (const [domWatch, expected] of [[true, true], [false, false]]) {
    const h = setup({ read: () => [A] });
    await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings, domWatch } });
    await h.evaluate('sendCountdownStart(7, 0)');
    await settle(10);
    const msg = h.calls.filter((c) => c.api === 'tabs.sendMessage' && c.message.type === 'COUNTDOWN_START').at(-1);
    assert.equal(msg.message.liveWatch, expected);
    await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  }
});

test('overlapping scans never run concurrently; the extra request becomes one rerun', async () => {
  let inFlight = 0, maxInFlight = 0;
  const h = setup({ read: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await settle(20); inFlight--; return [A]; } });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  const before = reads(h).length;
  await Promise.all([h.evaluate('doDomScan(7)'), h.evaluate('doDomScan(7)'), h.evaluate('doDomScan(7)')]);
  await settle(1100);
  assert.equal(maxInFlight, 1);
  assert.equal(reads(h).length, before + 2, 'one scan + one folded rerun');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('a slow, stale scan cannot rewind the baseline and re-alert a study', async () => {
  let items = [A];
  const gate = deferred();
  let holdNext = false;
  const h = setup({
    async read() {
      if (holdNext) { holdNext = false; const snapshot = items; await gate.promise; return snapshot; }
      return items;
    },
  });
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });

  holdNext = true;
  const staleScan = h.evaluate('doDomScan(7)'); // reads [A], then stalls
  await settle(5);
  items = [A, B];
  await h.evaluate('activeJobs[7]._lastRefresh = 0; fireRefresh(7)'); // newer read: alerts B
  assert.equal(h.evaluate('activeJobs[7].keywordCount'), 1);

  gate.resolve();
  await staleScan; // older read lands last — must be discarded
  assert.equal(h.evaluate('activeJobs[7]._seenKeys.length'), 2, 'baseline not rewound to [A]');

  await h.evaluate('doDomScan(7)');
  assert.equal(h.evaluate('activeJobs[7].keywordCount'), 1, 'B is not re-alerted');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});
