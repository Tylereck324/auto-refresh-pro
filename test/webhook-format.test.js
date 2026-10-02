// Tests for the pure webhook body builder: one-tap per-item payloads for each
// format, the legacy flat message, link validation, the burst cap, and the
// versioned generic-JSON shape a relay consumes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../webhook-format.js');

const card = (title, extra = '') => `${title}\n£9.00/hr\n12 places\nBy Dr Smith${extra}`;
const kwInfo = (items) => ({
  type: 'kw', title: 'Studies', url: 'https://app.example.com/studies',
  keyword: 'Evaluation', count: 1, now: 1700000000000, items,
});

test('without items every format emits the legacy flat message', () => {
  const info = kwInfo(undefined);
  assert.match(F.buildBody('discord', info).content, /Keyword found on “Studies”: Evaluation\nhttps:\/\/app/);
  assert.match(F.buildBody('slack', info).text, /Keyword found on/);
  const json = F.buildBody('json', info);
  assert.equal(json.event, 'keyword');
  assert.deepEqual(json.items, []);
});

test('Discord renders one linked embed per arrival with parsed detail', () => {
  const body = F.buildBody('discord', kwInfo([{ key: 'k1', href: 'https://app.example.com/s/1', text: card('AI Video - Evaluation') }]));
  assert.equal(body.embeds.length, 1);
  assert.equal(body.embeds[0].title, 'AI Video - Evaluation');
  assert.equal(body.embeds[0].url, 'https://app.example.com/s/1');
  assert.equal(body.embeds[0].description, '£9.00/hr · 12 places · By Dr Smith');
  assert.match(body.content, /1 new for “Evaluation” on Studies/);
});

test('unsafe item links are dropped, never placed in the message', () => {
  const items = [{ key: 'k', href: 'javascript:alert(1)', text: card('Bad') }];
  assert.equal(F.buildBody('discord', kwInfo(items)).embeds[0].url, undefined);
  assert.doesNotMatch(F.buildBody('slack', kwInfo(items)).text, /javascript:/);
  assert.equal(F.buildBody('json', kwInfo(items)).items[0].url, '');
});

test('Slack escapes control characters in labels', () => {
  const body = F.buildBody('slack', kwInfo([{ key: 'k', href: 'https://a.example/x', text: card('A <b> & c|d') }]));
  assert.match(body.text, /<https:\/\/a\.example\/x\|A &lt;b&gt; &amp; c\/d>/);
});

test('bursts are capped with an "…and N more" summary', () => {
  const items = Array.from({ length: F.WEBHOOK_ITEM_CAP + 3 }, (_, i) => ({ key: 'k' + i, href: '', text: card('S' + i) }));
  assert.equal(F.buildBody('discord', kwInfo(items)).embeds.length, F.WEBHOOK_ITEM_CAP);
  assert.match(F.buildBody('discord', kwInfo(items)).content, /…and 3 more/);
});

test('generic JSON carries the whole burst (up to JSON_ITEM_CAP), unlike chat formats', () => {
  const burst = (n) => Array.from({ length: n }, (_, i) => ({ key: 'k' + i, href: '', text: card('S' + i) }));
  const small = F.buildBody('json', kwInfo(burst(F.WEBHOOK_ITEM_CAP + 3)));
  assert.equal(small.items.length, F.WEBHOOK_ITEM_CAP + 3);
  assert.equal(small.itemsTruncated, 0);
  const huge = F.buildBody('json', kwInfo(burst(F.JSON_ITEM_CAP + 7)));
  assert.equal(huge.items.length, F.JSON_ITEM_CAP);
  assert.equal(huge.itemsTruncated, 7);
});

test('generic JSON is versioned and carries a stable key per item', () => {
  const body = F.buildBody('json', kwInfo([{ key: 'abc123', href: 'https://app.example.com/s/1', text: card('Study') }]));
  assert.equal(body.schemaVersion, F.SCHEMA_VERSION);
  assert.equal(body.timestamp, 1700000000000);
  assert.deepEqual(body.items[0], {
    key: 'abc123', title: 'Study', url: 'https://app.example.com/s/1',
    pay: '£9.00/hr', places: '12 places', researcher: 'Dr Smith',
  });
});

test('change alerts include the diff snippet', () => {
  const body = F.buildBody('discord', { type: 'chg', title: 'Shop', url: 'https://s.example/', snippet: '+ in stock' });
  assert.match(body.content, /Page changed: “Shop”\n\+ in stock\nhttps:\/\/s\.example\//);
});
