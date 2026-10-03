// Dead-watch detection through the real worker: a job whose page turns into a
// sign-in page, a captcha, or stops loading raises ONE "watch blocked" alert
// after the signal persists, logs recovery, and survives worker restarts.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const settings = { interval: 60_000, keyword: 'study', notify: false, sound: false, flashOnKeyword: false };

// page.health: what probePageHealth reports; page.readable: false → reads throw.
function setup(page) {
  const h = createHarness({
    executeScriptResultFor(details) {
      const name = details.func && details.func.name;
      if (name === 'probePageHealth') {
        if (!page.readable) throw new Error('Cannot access contents of the page');
        return page.health;
      }
      if (name === 'readPageText') {
        if (!page.readable) throw new Error('Cannot access contents of the page');
        return 'no matching listings right now';
      }
      return undefined; // settle probe etc.
    },
  });
  return h;
}
const cycle = (h) => h.evaluate('activeJobs[7]._lastRefresh = 0; fireRefresh(7)');
const stallNotifs = (h) => h.calls.filter((c) => c.api === 'notifications.create' && c.args[0].startsWith('stall_'));
const journal = (h, type) => (h.storage.alertLog || []).filter((e) => e.type === type);

test('a sign-in page alerts once after two cycles, then recovery is logged', async () => {
  const page = { health: null, readable: true };
  const h = setup(page);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });

  page.health = 'login';
  await cycle(h);
  assert.equal(stallNotifs(h).length, 0, 'one bad cycle is not a stall');
  await cycle(h);
  assert.equal(stallNotifs(h).length, 1);
  assert.equal(stallNotifs(h)[0].args[1].title, 'Watch blocked');
  assert.match(stallNotifs(h)[0].args[1].message, /asking you to sign in/);
  assert.equal(journal(h, 'stall').length, 1);
  await cycle(h);
  assert.equal(stallNotifs(h).length, 1, 'no repeat alert for the same stall');

  const unackedBefore = h.storage.unackedAlerts;
  page.health = null;
  await cycle(h);
  assert.equal(journal(h, 'recovered').length, 1);
  assert.equal(h.storage.unackedAlerts, unackedBefore, 'recovery does not bump the badge');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('a sign-in box already on the page at start is never a stall', async () => {
  const page = { health: 'login', readable: true };
  const h = setup(page);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  for (let i = 0; i < 4; i++) await cycle(h);
  assert.equal(stallNotifs(h).length, 0);
  page.health = 'captcha'; // a NEW signal still counts
  await cycle(h);
  await cycle(h);
  assert.equal(stallNotifs(h).length, 1);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('a page that stops loading alerts as unreadable', async () => {
  const page = { health: null, readable: true };
  const h = setup(page);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  page.readable = false;
  for (let i = 0; i < 4; i++) await cycle(h);
  assert.equal(stallNotifs(h).length, 1);
  assert.match(stallNotifs(h)[0].args[1].message, /failed to load or be read 4 times/);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('stall progress survives a worker restart between cycles', async () => {
  const page = { health: null, readable: true };
  const h = setup(page);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  page.health = 'captcha';
  await cycle(h);
  // Worker dies (long interval): memory wiped, storage survives.
  h.evaluate('clearTimerLoop(activeJobs[7]); clearDomScan(activeJobs[7]); delete activeJobs[7];');
  await h.evaluate('rehydrateJob(7)');
  await cycle(h);
  assert.equal(stallNotifs(h).length, 1, 'second consecutive bad cycle confirms the stall');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('a snoozed job journals the stall but stays silent', async () => {
  const page = { health: null, readable: true };
  const h = setup(page);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  h.evaluate('activeJobs[7]._snoozeUntil = Date.now() + 60_000');
  page.health = 'login';
  await cycle(h);
  await cycle(h);
  assert.equal(stallNotifs(h).length, 0);
  assert.equal(journal(h, 'stall').length, 1);
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});
