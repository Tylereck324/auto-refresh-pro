'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../lifecycle-generation.js');

test('begin returns a current token and tracks a pending tab', () => {
  const registry = createRegistry();
  const token = registry.begin(17);

  assert.equal(typeof token, 'number');
  assert.equal(registry.isCurrent(17, token), true);
  assert.deepEqual(registry.pendingTabIds(), [17]);
});

test('a newer begin supersedes an older token for the same tab', () => {
  const registry = createRegistry();
  const first = registry.begin(17);
  const second = registry.begin(17);

  assert.notEqual(second, first);
  assert.equal(registry.isCurrent(17, first), false);
  assert.equal(registry.isCurrent(17, second), true);
  assert.deepEqual(registry.pendingTabIds(), [17]);
});

test('invalidate makes a pending start stale and returns the replacement generation', () => {
  const registry = createRegistry();
  const start = registry.begin(17);
  const invalidated = registry.invalidate(17);

  assert.notEqual(invalidated, start);
  assert.equal(registry.isCurrent(17, start), false);
  assert.equal(registry.isCurrent(17, invalidated), true);
  assert.deepEqual(registry.pendingTabIds(), []);
});

test('finish only clears the matching pending token', () => {
  const registry = createRegistry();
  const first = registry.begin(17);
  registry.finish(17, first);
  assert.deepEqual(registry.pendingTabIds(), []);
  assert.equal(registry.isCurrent(17, first), true);

  const second = registry.begin(17);
  registry.finish(17, first);
  assert.deepEqual(registry.pendingTabIds(), [17]);
  assert.equal(registry.isCurrent(17, second), true);
  registry.finish(17, second);
  assert.deepEqual(registry.pendingTabIds(), []);
});

test('pendingTabIds reports each pending tab once and stop-all can invalidate them', () => {
  const registry = createRegistry();
  const first = registry.begin(3);
  registry.begin(9);
  const pending = registry.pendingTabIds();

  assert.deepEqual(pending, [3, 9]);
  for (const tabId of pending) registry.invalidate(tabId);
  assert.equal(registry.isCurrent(3, first), false);
  assert.deepEqual(registry.pendingTabIds(), []);
});
