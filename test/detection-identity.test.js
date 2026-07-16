'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identity, same } = require('../detection-identity.js');

const base = {
  keyword: 'restock',
  kwRegex: false,
  kwCaseSensitive: false,
  kwWholeWord: true,
  kwInverse: false,
  watchSelector: '.card',
  kwPerItem: true,
  kwExclude: 'sold out',
  collapseDigits: true,
  interval: 5000,
  notify: true,
  sound: true,
};

test('timing and presentation settings do not change detection identity', () => {
  const changedTiming = {
    ...base,
    interval: 90000,
    randomTimer: true,
    adaptive: true,
    sound: false,
    notify: false,
    showCountdown: false,
  };

  assert.equal(same(base, changedTiming), true);
  assert.equal(identity(base), identity(changedTiming));
});

for (const field of [
  'keyword',
  'kwRegex',
  'kwCaseSensitive',
  'kwWholeWord',
  'kwInverse',
  'watchSelector',
  'kwPerItem',
  'kwExclude',
  'collapseDigits',
]) {
  test(`changing detection field ${field} changes identity`, () => {
    const changed = { ...base };
    if (typeof base[field] === 'boolean') changed[field] = !base[field];
    else changed[field] = field === 'keyword' ? 'different' : '.other';
    assert.equal(same(base, changed), false);
  });
}

test('identity normalizes legacy missing values to matcher defaults', () => {
  assert.equal(same(
    { keyword: '', collapseDigits: true, watchSelector: '', kwExclude: '' },
    { keyword: undefined, collapseDigits: undefined, watchSelector: null, kwExclude: null }
  ), true);
});

test('identity trims matcher strings without including unrelated keys', () => {
  assert.equal(same(
    { keyword: '  restock  ', watchSelector: ' .card ', kwExclude: ' sold out ' },
    { keyword: 'restock', watchSelector: '.card', kwExclude: 'sold out', runtimeOnly: 1 }
  ), true);
});
