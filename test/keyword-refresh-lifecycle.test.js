'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const baseSettings = {
  interval: 60_000,
  currentInterval: 60_000,
  keyword: '- Evaluation',
  kwCaseSensitive: false,
  kwWholeWord: false,
  kwRegex: false,
  kwInverse: false,
  kwPerItem: false,
  watchSelector: '',
  monitorMode: false,
  sound: false,
  notify: false,
  flashOnKeyword: false,
  stopOnKeyword: false,
  stopAfter: 0,
  quietHours: {},
};

async function start(harness, settings = {}) {
  return harness.dispatch({
    type: 'START_REFRESH',
    tabId: 7,
    settings: { ...baseSettings, ...settings },
  });
}

async function stop(harness) {
  await harness.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
}

test('keyword introduced by reload 1 alerts during cycle 1', async () => {
  const options = { executeScriptResult: 'No matching study yet' };
  options.onReload = () => {
    options.executeScriptResult = 'AI Videos - Evaluation\nBy Vortex Oasis';
  };
  const harness = createHarness(options);
  await start(harness, { flashOnKeyword: true });

  const cycleStart = harness.calls.length;
  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(harness.evaluate('activeJobs[7].keywordCount'), 1);
  const cycleCalls = harness.calls.slice(cycleStart);
  const reloadIndex = cycleCalls.findIndex((call) => call.api === 'tabs.reload');
  const settleIndex = cycleCalls.findIndex(
    (call) => call.api === 'scripting.executeScript' && call.details.func.name === 'waitForPageSettle',
  );
  const readIndex = cycleCalls.findIndex(
    (call) => call.api === 'scripting.executeScript' && call.details.func.name === 'readPageText',
  );
  const alertIndex = cycleCalls.findIndex((call) => call.api === 'notifications.create');
  assert.ok(reloadIndex >= 0, 'cycle should reload');
  assert.ok(settleIndex > reloadIndex, 'new document should settle after reload');
  assert.ok(readIndex > reloadIndex, 'new document must be read after reload');
  assert.ok(readIndex > settleIndex, 'settled document must be read after the settle probe');
  assert.ok(alertIndex > readIndex, 'alert must follow evaluation of the new document');
  assert.equal(cycleCalls.filter((call) => call.api === 'tabs.reload').length, 1);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const flashes = harness.calls.filter(
    (call) => call.api === 'tabs.sendMessage' && call.message.type === 'KEYWORD_FLASH',
  );
  assert.equal(flashes.length, 1);

  await stop(harness);
});

test('keyword introduced by post-load hydration alerts during cycle 1 and requests sound', async () => {
  const options = { executeScriptResult: 'No matching study yet' };
  options.onReload = () => {
    options.executeScriptResult = 'No matching study yet';
    setTimeout(() => {
      options.executeScriptResult = 'AI Videos - Evaluation\nBy Vortex Oasis';
    }, 50);
  };
  options.onExecuteScript = async ({ details }) => {
    if (details.func.name === 'waitForPageSettle') {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  };
  const harness = createHarness(options);
  await start(harness, { sound: true });

  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(harness.evaluate('activeJobs[7].keywordCount'), 1);
  assert.equal(
    harness.calls.filter((call) => call.api === 'offscreen.createDocument').length,
    1,
  );
  const beepCalls = harness.calls.filter(
    (call) => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PLAY_BEEP',
  );
  assert.equal(beepCalls.length, 1);
  assert.equal(beepCalls[0].args[0].target, 'offscreen');

  await stop(harness);
});

test('keyword present at Start remains a silent baseline after reload 1', async () => {
  const options = {
    executeScriptResult: 'AI Videos - Evaluation\nBy Vortex Oasis',
  };
  const harness = createHarness(options);
  await start(harness);

  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(harness.evaluate('activeJobs[7].keywordCount'), 0);
  assert.equal(
    harness.calls.filter((call) => call.api === 'notifications.create').length,
    0,
  );

  await stop(harness);
});

test('a job stopped while reload is in flight cannot evaluate or alert', async () => {
  let releaseReload;
  const reloadBlocked = new Promise((resolve) => { releaseReload = resolve; });
  const options = { executeScriptResult: 'No matching study yet' };
  options.onReload = async () => {
    options.executeScriptResult = 'AI Videos - Evaluation\nBy Vortex Oasis';
    await reloadBlocked;
  };
  const harness = createHarness(options);
  await start(harness);

  const cycle = harness.evaluate('fireRefresh(7)');
  while (!harness.calls.some((call) => call.api === 'tabs.reload')) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await stop(harness);
  releaseReload();
  await cycle;

  assert.equal(harness.evaluate('activeJobs[7]'), undefined);
  assert.equal(
    harness.calls.filter((call) => call.api === 'notifications.create').length,
    0,
  );
});

test('per-item keyword introduced by reload 1 alerts during cycle 1', async () => {
  const options = { executeScriptResult: [] };
  options.onReload = () => {
    options.executeScriptResult = [
      { text: 'AI Videos - Evaluation\nBy Vortex Oasis', href: 'https://example.test/study/1' },
    ];
  };
  const harness = createHarness(options);
  await start(harness, { kwPerItem: true, watchSelector: '.study-card' });

  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(harness.evaluate('activeJobs[7].keywordCount'), 1);
  await stop(harness);
});

test('generic page change introduced by reload 1 alerts during cycle 1', async () => {
  const options = { executeScriptResult: 'Original page content' };
  options.onReload = () => {
    options.executeScriptResult = 'Changed page content';
  };
  const harness = createHarness(options);
  await start(harness, { keyword: '', monitorMode: true });

  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(
    harness.calls.filter((call) => call.api === 'notifications.create').length,
    1,
  );
  await stop(harness);
});
