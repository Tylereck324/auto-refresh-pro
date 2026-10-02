// Minimum reward/hour filter for per-item alerts: the pure parser, settings
// plumbing, and an end-to-end cycle through the real background worker.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../item-detect.js');
const { composeJobSettings } = require('../compose-settings.js');
const V = require('../validators.js');
const Identity = require('../detection-identity.js');
const { createHarness } = require('./background-harness.js');

const card = (title, pay) => `${title}\n${pay}\n10 places\nBy Researcher`;

test('parsePayPerHour reads the hourly rate in any currency', () => {
  assert.equal(D.parsePayPerHour(card('A', '£9.00/hr')), 9);
  assert.equal(D.parsePayPerHour(card('A', '$12.50 per hour')), 12.5);
  assert.equal(D.parsePayPerHour(card('A', '€1,200/hour')), 1200);
  assert.equal(D.parsePayPerHour('No rate shown'), null);
});

test('belowMinPay drops only readable rates under the minimum', () => {
  assert.equal(D.belowMinPay(card('A', '£7.50/hr'), 8), true);
  assert.equal(D.belowMinPay(card('A', '£8.00/hr'), 8), false);
  assert.equal(D.belowMinPay('No rate shown', 8), false, 'unreadable pay must still alert');
  assert.equal(D.belowMinPay(card('A', '£1.00/hr'), 0), false, '0 = filter off');
});

test('minPayPerHour is clamped by compose and by the rule sanitizer', () => {
  assert.equal(composeJobSettings({ minPayPerHour: '9.5' }, {}).minPayPerHour, 9.5);
  assert.equal(composeJobSettings({ minPayPerHour: -3 }, {}).minPayPerHour, 0);
  assert.equal(composeJobSettings({}, {}).minPayPerHour, 0);
  assert.equal(V.sanitizeRuleSettings({ minPayPerHour: 1e9 }).minPayPerHour, 10000);
});

test('changing the minimum changes detection identity (baseline is re-seeded)', () => {
  assert.equal(Identity.same({ minPayPerHour: 8 }, { minPayPerHour: 8 }), true);
  assert.equal(Identity.same({ minPayPerHour: 8 }, { minPayPerHour: 10 }), false);
  assert.equal(Identity.same({}, { minPayPerHour: 0 }), true);
});

test('a per-item cycle alerts on the high-pay arrival and skips the low-pay one', async () => {
  const listing = [{ text: card('Existing study', '£10.00/hr'), href: 'https://app.example.test/s/0' }];
  const options = { executeScriptResult: listing };
  options.onReload = () => {
    options.executeScriptResult = [
      ...listing,
      { text: card('Cheap study', '£4.00/hr'), href: 'https://app.example.test/s/1' },
      { text: card('Good study', '£12.00/hr'), href: 'https://app.example.test/s/2' },
    ];
  };
  const h = createHarness(options);
  const res = await h.dispatch({
    type: 'START_REFRESH', tabId: 7,
    settings: {
      interval: 60_000, keyword: 'study', watchSelector: '.card', kwPerItem: true,
      minPayPerHour: 8, notify: false, sound: false, flashOnKeyword: false,
    },
  });
  assert.deepEqual(res, { ok: true, started: true });

  await h.evaluate('fireRefresh(7)');
  assert.equal(h.evaluate('activeJobs[7].keywordCount'), 1);
  const entry = h.storage.alertLog.at(-1);
  assert.equal(entry.snippet, '1 new');
  // The cheap card never entered the seen-set.
  assert.equal(h.evaluate('activeJobs[7]._seenKeys.length'), 2);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});
