// A notification for exactly one new study names it and, when clicked, opens
// that study (not just the listing tab); the link survives a worker restart.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

const card = (title, pay) => `${title}\n${pay}\n10 places\nBy Dr Lab`;
const existing = { text: card('Existing study', '£10.00/hr'), href: 'https://app.example.test/s/0' };
const settings = {
  interval: 60_000, keyword: 'study', watchSelector: '.card', kwPerItem: true,
  notify: false, sound: false, flashOnKeyword: false,
};

async function cycleWith(arrivals) {
  const options = { executeScriptResult: [existing] };
  options.onReload = () => { options.executeScriptResult = [existing, ...arrivals]; };
  const h = createHarness(options);
  await h.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await h.evaluate('fireRefresh(7)');
  const created = h.calls.filter((c) => c.api === 'notifications.create');
  return { h, notif: created.at(-1) };
}

test('one new study: the notification names it and the click opens the study', async () => {
  const { h, notif } = await cycleWith([{ text: card('Good study', '£12.00/hr'), href: 'https://app.example.test/s/2' }]);
  const [id, options] = notif.args;
  assert.equal(options.title, 'New study');
  assert.match(options.message, /^Good study\n£12\.00\/hr · 10 places · By Dr Lab\nClick to open it$/);

  await h.evaluate(`handleNotifClick(${JSON.stringify(id)})`);
  const opened = h.calls.filter((c) => c.api === 'tabs.create');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].createProperties.url, 'https://app.example.test/s/2');
  assert.equal(h.calls.some((c) => c.api === 'tabs.update'), false, 'listing tab is not hijacked');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('the study link survives a worker restart (warm map wiped)', async () => {
  const { h, notif } = await cycleWith([{ text: card('Late study', '£9.00/hr'), href: 'https://app.example.test/s/3' }]);
  const [id] = notif.args;
  await new Promise((r) => setTimeout(r, 0)); // let the session write land
  h.evaluate('for (const k of Object.keys(notifTabMap)) delete notifTabMap[k];');
  await h.evaluate(`handleNotifClick(${JSON.stringify(id)})`);
  const opened = h.calls.filter((c) => c.api === 'tabs.create');
  assert.equal(opened.at(-1).createProperties.url, 'https://app.example.test/s/3');
  assert.deepEqual(h.session.arpNotifUrls, {}, 'entry is forgotten after use');
  await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
});

test('several new studies, or an unsafe link: the click focuses the listing tab', async () => {
  for (const arrivals of [
    [{ text: card('A study', '£9.00/hr'), href: 'https://app.example.test/s/4' },
     { text: card('B study', '£9.00/hr'), href: 'https://app.example.test/s/5' }],
    [{ text: card('Bad link study', '£9.00/hr'), href: 'javascript:alert(1)' }],
  ]) {
    const { h, notif } = await cycleWith(arrivals);
    const [id, options] = notif.args;
    assert.equal(options.title, 'Keyword Detected!');
    await h.evaluate(`handleNotifClick(${JSON.stringify(id)})`);
    assert.equal(h.calls.some((c) => c.api === 'tabs.create'), false);
    assert.ok(h.calls.some((c) => c.api === 'tabs.update' && c.updateProperties.active === true));
    await h.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  }
});
