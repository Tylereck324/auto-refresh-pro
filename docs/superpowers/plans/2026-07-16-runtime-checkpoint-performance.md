# Runtime Checkpoint Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-refresh whole-map durable writes with per-job session records and one coalesced local checkpoint per 30-second dirty window.

**Architecture:** `activeJobs` remains authoritative while the service worker is live. A new dependency-free `runtime-checkpoint.js` module defines session keys, record precedence, and index normalization; `background.js` writes routine state to per-job `chrome.storage.session` records and retains `chrome.storage.local.activeJobs` as the unchanged durable snapshot. Immediate user-significant transitions still write locally, and a named one-shot alarm flushes routine state every 30 seconds.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript, `chrome.storage.local`, `chrome.storage.session`, `chrome.alarms`, Node `node:test`, VM-based Chrome API harness.

---

## File Structure

- Create `runtime-checkpoint.js`: pure constants and record/index selection helpers; no Chrome API dependency.
- Create `test/runtime-checkpoint.test.js`: unit coverage for every pure helper.
- Create `test/background-checkpoint.test.js`: integration coverage for session writes, checkpoint coalescing, recovery, stop ordering, and failures.
- Modify `background.js`: load the helper, split record construction from persistence, add per-job session storage, add deferred checkpoint alarm handling, and prefer newer session recovery.
- Modify `test/background-harness.js`: separate local/session stores, emit area-specific call records, inject write failures, and dispatch alarms deterministically.
- Create `scripts/benchmark-checkpoints.mjs`: deterministic write-count/byte-volume comparison plus optional clone timing.
- Modify `performance-optimization-log.md`: prepend the implementation run and replace expected metrics with measured results.

## Preflight Gate: Preserve the Existing Dirty Worktree

The current checkout already contains the completed but uncommitted security-remediation work, including overlapping changes in `background.js` and the untracked `test/background-harness.js`. Those changes are a prerequisite for this plan and must not be accidentally bundled into a performance commit.

Before Task 1:

```bash
git status --short
git diff --check
npm test
npm run lint
node audit-proof/verify-severe-fixes.mjs
```

Preferred path: with explicit user approval, commit the already-verified security remediation as its own baseline commit, staging its exact known file set. Then create or switch to a `codex/` performance branch and execute the task commits below.

If the user declines that baseline commit, do not run the task commit steps below. Execute inline without staging overlapping files, keep a precise implementation file manifest, and ask for a later integration decision.

## Task 1: Pure Runtime Checkpoint Policy

**Files:**

- Create: `test/runtime-checkpoint.test.js`
- Create: `runtime-checkpoint.js`
- Modify: `background.js:1-31`

- [ ] **Step 1: Write the failing helper tests**

Create `test/runtime-checkpoint.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const checkpoint = require('../runtime-checkpoint.js');

test('jobKey accepts only non-negative integer tab ids', () => {
  assert.equal(checkpoint.jobKey(7), 'arp.runtime.job.7');
  assert.equal(checkpoint.jobKey('7'), 'arp.runtime.job.7');
  for (const value of [-1, 1.5, '', null, undefined, 'abc']) {
    assert.equal(checkpoint.jobKey(value), null);
  }
});

test('tabIdFromKey reverses a valid runtime key and rejects other keys', () => {
  assert.equal(checkpoint.tabIdFromKey('arp.runtime.job.42'), 42);
  assert.equal(checkpoint.tabIdFromKey('arp.runtime.job.-1'), null);
  assert.equal(checkpoint.tabIdFromKey('activeJobs'), null);
  assert.equal(checkpoint.tabIdFromKey(null), null);
});

test('normalizeIndex deduplicates, sorts, bounds, and drops invalid ids', () => {
  assert.deepEqual(checkpoint.normalizeIndex([9, '3', 9, -1, 2.5, 'bad']), [3, 9]);
  assert.deepEqual(checkpoint.normalizeIndex(null), []);
});

test('updateIndex adds and removes one normalized tab id', () => {
  assert.deepEqual(checkpoint.updateIndex([9, 3], 7, true), [3, 7, 9]);
  assert.deepEqual(checkpoint.updateIndex([9, 3, 7], 7, false), [3, 9]);
  assert.deepEqual(checkpoint.updateIndex([3], 'bad', true), [3]);
});

test('selectNewest prefers the newer valid stored job', () => {
  const local = { settings: { interval: 5000 }, savedAt: 100 };
  const session = { settings: { interval: 5000 }, savedAt: 200 };
  assert.equal(checkpoint.selectNewest(session, local), session);
  assert.equal(checkpoint.selectNewest(local, session), session);
});

test('selectNewest falls back from malformed records', () => {
  const local = { settings: { interval: 5000 }, savedAt: 100 };
  assert.equal(checkpoint.selectNewest({ savedAt: 200 }, local), local);
  assert.equal(checkpoint.selectNewest(null, local), local);
  assert.equal(checkpoint.selectNewest(null, null), null);
});

test('prepareLocalRecovery quietly resets crash-stale detection baselines', () => {
  const record = {
    settings: { interval: 5000, keyword: 'needle' },
    previousContent: 'old page text',
    seenKeys: ['old-item'],
    savedAt: 100,
  };
  const recovered = checkpoint.prepareLocalRecovery(record);
  assert.equal(recovered.previousContent, null);
  assert.equal(recovered.seenKeys, null);
  assert.equal(record.previousContent, 'old page text');
});

test('checkpoint constants are stable and namespaced', () => {
  assert.equal(checkpoint.INDEX_KEY, 'arp.runtime.index');
  assert.equal(checkpoint.DIRTY_KEY, 'arp.runtime.checkpointDirty');
  assert.equal(checkpoint.CHECKPOINT_ALARM, 'arp.runtime.checkpoint');
  assert.equal(checkpoint.CHECKPOINT_DELAY_MINUTES, 0.5);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/runtime-checkpoint.test.js
```

Expected: FAIL with `Cannot find module '../runtime-checkpoint.js'`.

- [ ] **Step 3: Implement the pure helper module**

Create `runtime-checkpoint.js`:

```js
// Pure helpers for per-job session state and coalesced durable checkpoints.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPRuntimeCheckpoint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JOB_PREFIX = 'arp.runtime.job.';
  const INDEX_KEY = 'arp.runtime.index';
  const DIRTY_KEY = 'arp.runtime.checkpointDirty';
  const CHECKPOINT_ALARM = 'arp.runtime.checkpoint';
  const CHECKPOINT_DELAY_MINUTES = 0.5;
  const MAX_INDEX = 1000;

  function normalizeTabId(tabId) {
    if (tabId === '' || tabId == null) return null;
    const id = Number(tabId);
    return Number.isInteger(id) && id >= 0 ? id : null;
  }

  function jobKey(tabId) {
    const id = normalizeTabId(tabId);
    return id == null ? null : JOB_PREFIX + id;
  }

  function tabIdFromKey(key) {
    if (typeof key !== 'string' || !key.startsWith(JOB_PREFIX)) return null;
    return normalizeTabId(key.slice(JOB_PREFIX.length));
  }

  function normalizeIndex(value) {
    if (!Array.isArray(value)) return [];
    const ids = [];
    for (const valueId of value) {
      const id = normalizeTabId(valueId);
      if (id != null && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_INDEX) break;
    }
    return ids.sort((a, b) => a - b);
  }

  function updateIndex(value, tabId, present) {
    const ids = normalizeIndex(value);
    const id = normalizeTabId(tabId);
    if (id == null) return ids;
    const next = new Set(ids);
    if (present) next.add(id);
    else next.delete(id);
    return Array.from(next).sort((a, b) => a - b).slice(0, MAX_INDEX);
  }

  function validRecord(record) {
    return !!(record && typeof record === 'object' && !Array.isArray(record) &&
      record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings));
  }

  function stamp(record) {
    const value = Number(record && record.savedAt);
    return Number.isFinite(value) && value >= 0 ? value : -1;
  }

  function selectNewest(sessionRecord, localRecord) {
    const sessionOk = validRecord(sessionRecord);
    const localOk = validRecord(localRecord);
    if (!sessionOk) return localOk ? localRecord : null;
    if (!localOk) return sessionRecord;
    return stamp(sessionRecord) >= stamp(localRecord) ? sessionRecord : localRecord;
  }

  function prepareLocalRecovery(record) {
    if (!validRecord(record)) return null;
    return { ...record, previousContent: null, seenKeys: null };
  }

  return {
    JOB_PREFIX,
    INDEX_KEY,
    DIRTY_KEY,
    CHECKPOINT_ALARM,
    CHECKPOINT_DELAY_MINUTES,
    jobKey,
    tabIdFromKey,
    normalizeIndex,
    updateIndex,
    selectNewest,
    prepareLocalRecovery,
  };
});
```

- [ ] **Step 4: Load the helper in the service worker**

Add after `detection-identity.js` in `background.js`:

```js
// Pure session-key, record-precedence, and checkpoint constants.
importScripts('runtime-checkpoint.js');
```

- [ ] **Step 5: Run targeted and syntax checks**

Run:

```bash
node --test test/runtime-checkpoint.test.js
npm run lint
```

Expected: 8 helper tests pass and lint reports `importScripts background.js → runtime-checkpoint.js`.

- [ ] **Step 6: Commit the pure policy**

```bash
git add runtime-checkpoint.js test/runtime-checkpoint.test.js background.js
git commit -m "test: define runtime checkpoint policy"
```

## Task 2: Upgrade the Background Harness for Session Storage

**Files:**

- Create: `test/background-checkpoint.test.js`
- Modify: `test/background-harness.js:20-180`

- [ ] **Step 1: Write the failing harness test**

Create the initial `test/background-checkpoint.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./background-harness.js');

test('harness exposes distinct local and session storage areas', async () => {
  const harness = createHarness({
    localStorage: { durable: 1 },
    sessionStorage: { runtime: 2 },
  });
  assert.deepEqual(await harness.chrome.storage.local.get(null), { durable: 1 });
  assert.deepEqual(await harness.chrome.storage.session.get(null), { runtime: 2 });
  assert.notEqual(harness.localStorage, harness.sessionStorage);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/background-checkpoint.test.js
```

Expected: FAIL because `chrome.storage.session` and the two exposed stores do not exist.

- [ ] **Step 3: Replace the single storage fake with area-specific fakes**

In `createHarness`, replace `storage` and `storageArea` with:

```js
const localStorage = { ...(options.localStorage || options.storage || {}) };
const sessionStorage = { ...(options.sessionStorage || {}) };
const failures = {
  localSet: Number(options.failLocalSet) || 0,
  sessionSet: Number(options.failSessionSet) || 0,
};

function storageArea(area, values) {
  return {
    async get(keys) {
      calls.push({ api: `storage.${area}.get`, keys });
      if (keys == null) return { ...values };
      const names = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of names) {
        if (Object.prototype.hasOwnProperty.call(values, key)) out[key] = values[key];
      }
      return out;
    },
    async set(next) {
      const failureKey = area + 'Set';
      if (failures[failureKey] > 0) {
        failures[failureKey]--;
        throw new Error(`${area} storage set failed`);
      }
      Object.assign(values, next);
      calls.push({ api: `storage.${area}.set`, values: structuredClone(next) });
    },
    async remove(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      for (const key of names) delete values[key];
      calls.push({ api: `storage.${area}.remove`, keys: names });
    },
  };
}
```

Change the Chrome facade to:

```js
storage: {
  local: storageArea('local', localStorage),
  session: storageArea('session', sessionStorage),
  onChanged: event(),
},
```

Expose `localStorage`, `sessionStorage`, and the backward-compatible alias `storage: localStorage` in the returned harness.

- [ ] **Step 4: Add deterministic alarm dispatch**

Add inside `createHarness`:

```js
async function fireAlarm(name) {
  for (const listener of chrome.alarms.onAlarm.listeners) {
    await listener({ name });
  }
}
```

Return `fireAlarm` from the harness.

- [ ] **Step 5: Run harness and existing lifecycle tests**

Run:

```bash
node --test test/background-checkpoint.test.js test/background-lifecycle.test.js
```

Expected: the new harness test and all four existing lifecycle tests pass.

- [ ] **Step 6: Commit the harness capability**

```bash
git add test/background-harness.js test/background-checkpoint.test.js
git commit -m "test: model session storage and checkpoint alarms"
```

## Task 3: Per-Job Session Persistence

**Files:**

- Modify: `test/background-checkpoint.test.js`
- Modify: `background.js:1589-1768`

- [ ] **Step 1: Add failing per-job persistence tests**

Append:

```js
const settings = {
  interval: 60_000,
  keyword: '',
  monitorMode: false,
  notify: false,
  sound: false,
};

test('start writes both durable and per-job session state', async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.dispatch({
    type: 'START_REFRESH', tabId: 7, settings: { ...settings },
  }), { ok: true, started: true });

  assert.ok(harness.localStorage.activeJobs['7']);
  assert.ok(harness.sessionStorage['arp.runtime.job.7']);
  assert.deepEqual(harness.sessionStorage['arp.runtime.index'], [7]);
});

```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/background-checkpoint.test.js
```

Expected: FAIL because start does not create a session record or index.

- [ ] **Step 3: Extract one stored-record builder**

Replace the inline object in `saveJobToStorage` with:

```js
function buildStoredJob(tabId, settings) {
  const job = activeJobs[tabId];
  if (!job) return null;
  const monitors = !!(settings && (settings.monitorMode ||
    (typeof settings.keyword === 'string' && settings.keyword.trim())));
  return {
    settings,
    refreshCount: job.refreshCount || 0,
    keywordCount: job.keywordCount || 0,
    nextRefresh: job.nextRefresh || (Date.now() + computeInterval(settings)),
    startUrl: job.startUrl || null,
    previousContent: (monitors && typeof job.previousContent === 'string')
      ? job.previousContent : null,
    seenKeys: Array.isArray(job._seenKeys) ? job._seenKeys.slice(0, 1000) : null,
    noChangeStreak: Number(job._noChangeStreak) || 0,
    manualPause: !!job._manualPause,
    awayPause: job._pauseReason === 'away',
    snoozeUntil: Number(job._snoozeUntil) || 0,
    savedAt: Date.now(),
  };
}
```

- [ ] **Step 4: Add serialized per-job session operations**

Add near `jobsStoreMutex`:

```js
const runtimeStoreMutex = ARPSerialize.createMutex();
let checkpointDirty = false;

async function writeSessionJob(tabId, record) {
  const key = ARPRuntimeCheckpoint.jobKey(tabId);
  if (!key || !record) return false;
  return runtimeStoreMutex(async () => {
    const meta = await chrome.storage.session.get(ARPRuntimeCheckpoint.INDEX_KEY);
    const index = ARPRuntimeCheckpoint.updateIndex(
      meta[ARPRuntimeCheckpoint.INDEX_KEY], tabId, true);
    await chrome.storage.session.set({
      [key]: record,
      [ARPRuntimeCheckpoint.INDEX_KEY]: index,
    });
    return true;
  });
}

async function removeSessionJob(tabId) {
  const key = ARPRuntimeCheckpoint.jobKey(tabId);
  if (!key) return;
  await runtimeStoreMutex(async () => {
    const meta = await chrome.storage.session.get(ARPRuntimeCheckpoint.INDEX_KEY);
    const index = ARPRuntimeCheckpoint.updateIndex(
      meta[ARPRuntimeCheckpoint.INDEX_KEY], tabId, false);
    await chrome.storage.session.remove(key);
    await chrome.storage.session.set({ [ARPRuntimeCheckpoint.INDEX_KEY]: index });
  });
}
```

- [ ] **Step 5: Mirror every existing immediate save into session storage**

Implement:

```js
async function saveJobToStorage(tabId, settings) {
  const record = buildStoredJob(tabId, settings);
  if (!record) return;
  try {
    await writeSessionJob(tabId, record);
  } catch (error) {
    console.warn('Runtime session write failed; using durable storage', error);
  }
  await saveLocalJob(tabId, record);
}

async function saveLocalJob(tabId, record) {
  await withJobsStore((jobs) => {
    if (!activeJobs[tabId]) return;
    jobs[tabId] = record;
  });
}
```

Do not change any call site yet. Task 4 introduces deferred routine saves only after the checkpoint alarm exists, so every intermediate commit remains fully durable.

- [ ] **Step 6: Remove session state during teardown**

Change `removeJobFromStorage` to remove session state before the local record:

```js
async function removeJobFromStorage(tabId) {
  await removeSessionJob(tabId).catch((error) => {
    console.warn('Runtime session cleanup failed', error);
  });
  await withJobsStore((jobs) => { delete jobs[tabId]; });
}
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
node --test test/runtime-checkpoint.test.js test/background-checkpoint.test.js test/background-lifecycle.test.js test/serialize.test.js
```

Expected: all targeted tests pass; the lifecycle tests still prove Stop cannot resurrect Start.

- [ ] **Step 8: Commit session persistence**

```bash
git add background.js test/background-checkpoint.test.js
git commit -m "perf: persist routine state per job in session"
```

## Task 4: Coalesced 30-Second Durable Checkpoints

**Files:**

- Modify: `test/background-checkpoint.test.js`
- Modify: `background.js:560-568`
- Modify: `background.js:1589-1785`

- [ ] **Step 1: Add the failing coalescing test**

Append:

```js
test('routine save writes only the changed session job', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  harness.calls.length = 0;

  await harness.evaluate("saveJobToStorage(7, activeJobs[7].settings, { deferred: true })");

  assert.equal(harness.calls.filter(c => c.api === 'storage.local.set').length, 0);
  const writes = harness.calls.filter(c => c.api === 'storage.session.set');
  assert.ok(writes.some(c => c.values['arp.runtime.job.7']));
  assert.ok(writes.every(c => !c.values['arp.runtime.job.8']));
});

test('sixty routine saves coalesce into one durable checkpoint', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  harness.calls.length = 0;

  for (let i = 0; i < 60; i++) {
    harness.evaluate(`activeJobs[7].refreshCount = ${i + 1}`);
    await harness.evaluate("saveJobToStorage(7, activeJobs[7].settings, { deferred: true })");
  }

  const checkpointAlarms = harness.calls.filter(call =>
    call.api === 'alarms.create' && call.name === 'arp.runtime.checkpoint');
  assert.equal(checkpointAlarms.length, 1);
  assert.equal(harness.calls.filter(call => call.api === 'storage.local.set').length, 0);

  await harness.fireAlarm('arp.runtime.checkpoint');
  const localWrites = harness.calls.filter(call => call.api === 'storage.local.set');
  assert.equal(localWrites.length, 1);
  assert.equal(harness.localStorage.activeJobs['7'].refreshCount, 60);
  assert.equal(harness.sessionStorage['arp.runtime.checkpointDirty'], undefined);
});

test('keyword alerts mark the cycle for an immediate durable flush', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await harness.evaluate("deliverKeywordAlert(7, activeJobs[7], () => true, {})");
  assert.equal(harness.evaluate('activeJobs[7]._requiresDurableFlush'), true);
});

test('an alert-marked refresh writes locally instead of deferring', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  harness.calls.length = 0;
  harness.evaluate('activeJobs[7]._requiresDurableFlush = true');
  await harness.evaluate('fireRefresh(7)');
  assert.ok(harness.calls.some(call =>
    call.api === 'storage.local.set' && call.values.activeJobs));
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/background-checkpoint.test.js
```

Expected: FAIL because `deferred` is ignored and checkpoint-alarm handling does not exist.

- [ ] **Step 3: Add deferred saves while preserving immediate alert transitions**

Upgrade `saveJobToStorage`:

```js
async function saveJobToStorage(tabId, settings, options) {
  const record = buildStoredJob(tabId, settings);
  if (!record) return;
  const deferred = !!(options && options.deferred);
  try {
    await writeSessionJob(tabId, record);
    if (deferred) await requestDurableCheckpoint();
  } catch (error) {
    console.warn('Runtime session write failed; using durable storage', error);
    await saveLocalJob(tabId, record);
    return;
  }
  if (!deferred) await saveLocalJob(tabId, record);
}
```

Mark keyword and page-change alerts before their delivery tails:

```js
job._requiresDurableFlush = true;
```

For keyword alerts, set the flag next to `_changedThisCycle = true` in `deliverKeywordAlert`. For page-change alerts, set it in the `changed` branch next to that branch's `_changedThisCycle = true` assignment.

Change the routine save in `fireRefresh` to consume the flag:

```js
const saveImmediately = !!activeJobs[tabId]._requiresDurableFlush;
activeJobs[tabId]._requiresDurableFlush = false;
await saveJobToStorage(tabId, activeJobs[tabId].settings, {
  deferred: !saveImmediately,
});
```

The live-watch alert path already calls `saveJobToStorage` immediately. Clear `_requiresDurableFlush` immediately after that successful save so the next unrelated refresh does not perform a second immediate local write.

- [ ] **Step 4: Implement dirty-window scheduling**

Add:

```js
async function requestDurableCheckpoint() {
  if (checkpointDirty) return;
  try {
    await chrome.storage.session.set({ [ARPRuntimeCheckpoint.DIRTY_KEY]: true });
    checkpointDirty = true;
    chrome.alarms.create(ARPRuntimeCheckpoint.CHECKPOINT_ALARM, {
      delayInMinutes: ARPRuntimeCheckpoint.CHECKPOINT_DELAY_MINUTES,
    });
  } catch (error) {
    checkpointDirty = false;
    throw error;
  }
}
```

- [ ] **Step 5: Implement a complete durable snapshot flush**

Add:

```js
async function flushDurableCheckpoint() {
  await rehydrateAll();
  const snapshot = {};
  for (const [tabId, job] of Object.entries(activeJobs)) {
    const record = buildStoredJob(tabId, job.settings);
    if (record) snapshot[tabId] = record;
  }
  try {
    await jobsStoreMutex(async () => {
      selfJobsWrites++;
      try {
        await chrome.storage.local.set({
          activeJobs: snapshot,
          activeJobUrls: [...new Set(
            Object.values(snapshot).map(record => record.startUrl).filter(Boolean)
          )],
        });
      } catch (error) {
        selfJobsWrites--;
        throw error;
      }
    });
    checkpointDirty = false;
    await chrome.storage.session.remove(ARPRuntimeCheckpoint.DIRTY_KEY);
  } catch (error) {
    checkpointDirty = true;
    console.warn('Durable job checkpoint failed; retrying', error);
    chrome.alarms.create(ARPRuntimeCheckpoint.CHECKPOINT_ALARM, {
      delayInMinutes: ARPRuntimeCheckpoint.CHECKPOINT_DELAY_MINUTES,
    });
  }
}
```

- [ ] **Step 6: Route the named alarm without disturbing refresh alarms**

Replace the alarm listener with:

```js
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ARPRuntimeCheckpoint.CHECKPOINT_ALARM) {
    await flushDurableCheckpoint();
    return;
  }
  if (!alarm.name.startsWith('refresh_')) return;
  await fireRefresh(parseInt(alarm.name.replace('refresh_', '')));
});
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
node --test test/background-checkpoint.test.js test/background-lifecycle.test.js
```

Expected: the 60-save test reports one checkpoint alarm and one local write.

- [ ] **Step 8: Commit coalescing**

```bash
git add background.js test/background-checkpoint.test.js
git commit -m "perf: coalesce durable job checkpoints"
```

## Task 5: Recovery, Failure Fallback, and Stop Safety

**Files:**

- Modify: `test/background-checkpoint.test.js`
- Modify: `background.js:1697-1785`
- Modify: `background.js:1566-1684`

- [ ] **Step 1: Add failing recovery and failure tests**

Append:

```js
test('worker restart prefers newer session state', async () => {
  const localRecord = { settings: { ...settings }, refreshCount: 2, startUrl: 'https://example.test/list', previousContent: 'old', savedAt: 100 };
  const sessionRecord = { ...localRecord, refreshCount: 9, previousContent: 'current', savedAt: 200 };
  const harness = createHarness({
    localStorage: { activeJobs: { 7: localRecord } },
    sessionStorage: {
      'arp.runtime.index': [7],
      'arp.runtime.job.7': sessionRecord,
    },
  });

  const response = await harness.dispatch({ type: 'GET_ALL_JOBS' });
  assert.equal(response.jobs['7'].refreshCount, 9);
  assert.equal(harness.evaluate('activeJobs[7].previousContent'), 'current');
});

test('browser restart falls back to the durable local snapshot', async () => {
  const localRecord = {
    settings: { ...settings, keyword: 'needle' },
    refreshCount: 4,
    startUrl: 'https://example.test/list',
    previousContent: 'possibly stale text',
    seenKeys: ['possibly-stale-item'],
    savedAt: 100,
  };
  const harness = createHarness({ localStorage: { activeJobs: { 7: localRecord } } });
  const response = await harness.dispatch({ type: 'GET_ALL_JOBS' });
  assert.equal(response.jobs['7'].refreshCount, 4);
  assert.equal(harness.evaluate('activeJobs[7].previousContent'), null);
  assert.equal(harness.evaluate('activeJobs[7]._seenKeys'), null);
});

test('session write failure falls back to immediate local persistence', async () => {
  const harness = createHarness({ failSessionSet: 1 });
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  assert.ok(harness.localStorage.activeJobs['7']);
});

test('stop before checkpoint cannot resurrect the removed job', async () => {
  const harness = createHarness();
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } });
  await harness.evaluate("saveJobToStorage(7, activeJobs[7].settings, { deferred: true })");
  await harness.dispatch({ type: 'STOP_REFRESH', tabId: 7 });
  await harness.fireAlarm('arp.runtime.checkpoint');
  assert.deepEqual(harness.localStorage.activeJobs, {});
  assert.equal(harness.sessionStorage['arp.runtime.job.7'], undefined);
  assert.deepEqual(harness.sessionStorage['arp.runtime.index'], []);
});

test('failed durable checkpoint stays dirty and schedules one retry', async () => {
  const harness = createHarness({ failLocalSet: 1 });
  await harness.dispatch({ type: 'START_REFRESH', tabId: 7, settings: { ...settings } }).catch(() => {});
  harness.failures.localSet = 1;
  await harness.evaluate("saveJobToStorage(7, activeJobs[7].settings, { deferred: true })");
  harness.calls.length = 0;
  await harness.fireAlarm('arp.runtime.checkpoint');
  assert.equal(harness.sessionStorage['arp.runtime.checkpointDirty'], true);
  assert.equal(harness.calls.filter(call =>
    call.api === 'alarms.create' && call.name === 'arp.runtime.checkpoint').length, 1);
});
```

Expose `failures` from the harness so the retry test can inject failure after Start.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/background-checkpoint.test.js
```

Expected: session precedence fails because rehydration reads only local storage; fallback/retry assertions also fail until failure handling is complete.

- [ ] **Step 3: Read and normalize all session runtime records once per worker**

Add:

```js
let runtimeSessionFresh = false;
let runtimeSessionRecords = {};

async function loadRuntimeSession() {
  if (runtimeSessionFresh) return runtimeSessionRecords;
  const data = await chrome.storage.session.get(null);
  const records = {};
  const discoveredIds = [];
  for (const [key, value] of Object.entries(data)) {
    const tabId = ARPRuntimeCheckpoint.tabIdFromKey(key);
    if (tabId == null) continue;
    records[tabId] = value;
    discoveredIds.push(tabId);
  }
  runtimeSessionRecords = records;
  runtimeSessionFresh = true;
  checkpointDirty = data[ARPRuntimeCheckpoint.DIRTY_KEY] === true;

  const normalized = ARPRuntimeCheckpoint.normalizeIndex(discoveredIds);
  if (JSON.stringify(normalized) !== JSON.stringify(
    ARPRuntimeCheckpoint.normalizeIndex(data[ARPRuntimeCheckpoint.INDEX_KEY]))) {
    await chrome.storage.session.set({ [ARPRuntimeCheckpoint.INDEX_KEY]: normalized });
  }
  if (checkpointDirty) {
    chrome.alarms.create(ARPRuntimeCheckpoint.CHECKPOINT_ALARM, {
      delayInMinutes: ARPRuntimeCheckpoint.CHECKPOINT_DELAY_MINUTES,
    });
  }
  return records;
}
```

Update `writeSessionJob` and `removeSessionJob` so they mirror successful changes into `runtimeSessionRecords` when `runtimeSessionFresh` is true.

- [ ] **Step 4: Prefer newer session records during rehydration**

Change `rehydrateAll` to read both sources and select each tab's newest record:

```js
async function rehydrateAll() {
  if (!unackedLoaded) { unackedLoaded = true; await loadUnacked(); }
  if (jobsStoreFresh && runtimeSessionFresh) return;
  jobsStoreFresh = true;
  const [localData, sessionRecords] = await Promise.all([
    chrome.storage.local.get('activeJobs'),
    loadRuntimeSession(),
  ]);
  const localRecords = localData.activeJobs || {};
  const ids = new Set([...Object.keys(localRecords), ...Object.keys(sessionRecords)]);
  for (const tabIdText of ids) {
    const tabId = parseInt(tabIdText, 10);
    if (activeJobs[tabId]) continue;
    const sessionRecord = sessionRecords[tabId];
    const localRecord = localRecords[tabId];
    let stored = ARPRuntimeCheckpoint.selectNewest(sessionRecord, localRecord);
    if (!sessionRecord && stored === localRecord) {
      // A missing session record means browser/extension restart or session
      // failure. The durable snapshot may be up to 30 seconds stale, so seed a
      // quiet first observation instead of replaying a duplicate alert.
      stored = ARPRuntimeCheckpoint.prepareLocalRecovery(stored);
    }
    if (stored) await rehydrateJob(tabId, stored);
  }
  refreshBadge();
}
```

Change the no-prefetch branch of `doRehydrateJob` to fetch both records and call `selectNewest`, so alarm-driven single-job recovery follows the same precedence. Apply `prepareLocalRecovery` when no session record exists there as well. `restoreJobs` must use the same local-recovery preparation before calling `rehydrateJob`, because `onStartup` and `onInstalled` both begin without durable session state.

- [ ] **Step 5: Make session fallback bounded and retryable**

Keep the session-write fallback inside `saveJobToStorage`. Ensure it warns once per worker with a boolean guard rather than logging on every fast refresh:

```js
let sessionFallbackWarned = false;

function warnSessionFallback(error) {
  if (sessionFallbackWarned) return;
  sessionFallbackWarned = true;
  console.warn('Runtime session storage unavailable; using durable storage', error);
}
```

On a later successful session write, reset `sessionFallbackWarned = false`.

- [ ] **Step 6: Run all storage/lifecycle tests**

Run:

```bash
node --test test/runtime-checkpoint.test.js test/background-checkpoint.test.js test/background-lifecycle.test.js test/rehydrate.test.js test/serialize.test.js
```

Expected: all tests pass with no unhandled rejections.

- [ ] **Step 7: Commit recovery and safety behavior**

```bash
git add background.js test/background-harness.js test/background-checkpoint.test.js
git commit -m "fix: preserve checkpoint recovery and stop ordering"
```

## Task 6: Deterministic Performance Measurement and Living Log

**Files:**

- Create: `scripts/benchmark-checkpoints.mjs`
- Modify: `performance-optimization-log.md`

- [ ] **Step 1: Add the deterministic benchmark**

Create `scripts/benchmark-checkpoints.mjs`:

```js
import { performance } from 'node:perf_hooks';

const JOBS = 10;
const REFRESHES_PER_JOB = 6;
const BASELINE_CHARS = 200_000;
const jobs = {};
for (let id = 1; id <= JOBS; id++) {
  jobs[id] = {
    settings: { interval: 5000, keyword: 'needle' },
    previousContent: 'x'.repeat(BASELINE_CHARS),
    savedAt: 1,
  };
}

const wholeMapBytes = Buffer.byteLength(JSON.stringify(jobs));
const oneJobBytes = Buffer.byteLength(JSON.stringify(jobs[1]));
const routineWrites = JOBS * REFRESHES_PER_JOB;
const beforeLocalBytes = wholeMapBytes * routineWrites;
const afterLocalBytes = wholeMapBytes;
const afterSessionBytes = oneJobBytes * routineWrites;

const iterations = 100;
const start = performance.now();
for (let i = 0; i < iterations; i++) structuredClone(jobs);
const cloneMs = (performance.now() - start) / iterations;

console.log(JSON.stringify({
  jobs: JOBS,
  windowSeconds: 30,
  routineWritesBefore: routineWrites,
  routineWritesAfter: 1,
  wholeMapMiB: wholeMapBytes / 1024 / 1024,
  oneJobMiB: oneJobBytes / 1024 / 1024,
  localMiBBefore: beforeLocalBytes / 1024 / 1024,
  localMiBAfter: afterLocalBytes / 1024 / 1024,
  sessionMiBAfter: afterSessionBytes / 1024 / 1024,
  localReductionPercent: (1 - afterLocalBytes / beforeLocalBytes) * 100,
  wholeMapCloneMs: cloneMs,
}, null, 2));
```

- [ ] **Step 2: Run the benchmark and capture its output**

Run:

```bash
node scripts/benchmark-checkpoints.mjs
```

Expected deterministic counts: 60 routine writes before, 1 after, and approximately 98.33% less local serialized volume. Timing is informational and machine-specific.

- [ ] **Step 3: Update the living performance log**

At the top of `performance-optimization-log.md`'s Execution History, add a new timestamped implementation section containing:

- Exact benchmark JSON output.
- Targeted RED and GREEN commands/results.
- Local/session write counts from `test/background-checkpoint.test.js`.
- Files changed.
- Any deviation from the approved 30-second policy.

Update Summary Statistics to `Optimizations implemented: 1` only after all verification passes.

- [ ] **Step 4: Commit measurement artifacts**

```bash
git add scripts/benchmark-checkpoints.mjs performance-optimization-log.md
git commit -m "docs: record checkpoint performance results"
```

## Task 7: Full Regression and Browser Verification

**Files:**

- Verify only; modify implementation/tests only when a failure identifies a real defect.

- [ ] **Step 1: Run the complete unit suite**

```bash
npm test
```

Expected: all existing 266 tests plus the new checkpoint tests pass with 0 failures.

- [ ] **Step 2: Run lint and reference validation**

```bash
npm run lint
```

Expected: syntax passes and `runtime-checkpoint.js` resolves from `background.js`.

- [ ] **Step 3: Build the extension**

```bash
npm run build
```

Expected: `dist/auto-refresh-pro-1.1.0.zip` is rebuilt successfully and contains `runtime-checkpoint.js` through the root-JS allowlist.

- [ ] **Step 4: Run the existing real-browser smoke suite**

```bash
node audit-proof/verify-severe-fixes.mjs
```

Expected: representative Start, Stop, interval-update, popup, Manage, and trusted-event flows pass without console errors.

- [ ] **Step 5: Inspect the packaged runtime file**

```bash
unzip -l dist/auto-refresh-pro-1.1.0.zip | rg 'runtime-checkpoint.js|background.js'
```

Expected: both runtime files are present exactly once.

- [ ] **Step 6: Run final repository checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Status must distinguish the pre-existing security-remediation changes from this performance implementation.

- [ ] **Step 7: Review acceptance criteria**

Confirm from fresh evidence:

- Routine local writes: 60 to 1 per 30-second window.
- Routine session writes contain one job record, not the whole job map.
- Start/stop/settings/pause/resume/alert paths still flush locally.
- Service-worker restart prefers session state.
- Browser restart falls back locally.
- Stop before checkpoint cannot resurrect a job.
- Session failure uses local storage.
- Local checkpoint failure retries and remains dirty.

- [ ] **Step 8: Commit any verification-only adjustments**

If verification required a code or test correction, stage only those exact files and commit with a message naming the corrected behavior. If no files changed, do not create an empty commit.
