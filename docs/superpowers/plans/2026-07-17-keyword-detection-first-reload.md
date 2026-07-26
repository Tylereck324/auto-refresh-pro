# Keyword Detection on First Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and deliver a keyword alert against the document produced by the first scheduled reload, without waiting for the second interval or creating false alerts for content already present when the job starts.

**Architecture:** Keep the existing start-time content snapshot as the comparison baseline. For keyword/change jobs, register a one-shot tab-load waiter, initiate the reload, wait for that new document to finish loading and for a bounded post-load DOM-settle window, and only then read and evaluate its content. Because every keyword alert will then occur after navigation, screen flashes can always target the current document immediately and the deferred `_pendingFlash` state can be removed.

**Tech Stack:** Chrome Manifest V3 service worker APIs, JavaScript, Node.js `node:test`, the existing VM-based background harness.

**Implementation status:** Code, regression coverage, automated checks, and browser proof are complete. Commit steps remain unchecked until an integration choice is made.

---

## Confirmed failure

The current cycle reads and evaluates the old document in `doMonitorRefresh()`, stores it as `previousContent`, and then calls `doRefresh()`. A keyword introduced by reload 1 is therefore not observed until the timer for reload 2 fires.

The implementation must preserve these existing contracts:

- A keyword already present when Start is pressed remains part of the baseline and does not alert immediately.
- Normal keyword mode fires only on absent-to-present transitions.
- Inverse mode fires only on present-to-absent transitions.
- Empty or failed reads do not replace a valid baseline or cause inverse false positives.
- `stopOnKeyword`, quiet hours, snooze, journal entries, badge counts, webhooks, sound, and notifications retain their existing behavior.
- Per-item and DOM-watch detection share one `_seenKeys` baseline and do not double-alert.
- A stopped or replaced job must not update state after an awaited reload.

## File map

- Modify `test/background-harness.js`: simulate a real reload lifecycle and allow the returned page content to change when reload occurs.
- Create `test/keyword-refresh-lifecycle.test.js`: reproduce the second-reload defect and protect first-reload, delayed hydration, baseline, cancellation, sound, and flash behavior.
- Modify `background.js`: wait for the newly reloaded document and its bounded DOM-settle window, evaluate it, and remove deferred-flash handling.
- Modify `monitor-decision.js`: make flash delivery reflect the new post-reload alert timing.
- Modify `test/monitor-decision.test.js`: update the flash truth table.
- Modify `README.md`: document that each scheduled detecting cycle evaluates the document loaded by that reload.

### Task 1: Add a browser-like reload lifecycle to the background harness

**Files:**

- Modify: `test/background-harness.js:29-103`

- [x] **Step 1: Add a shared `tabsOnUpdated` event before constructing `chrome`**

Insert this after the `calls` declaration:

```js
const tabsOnUpdated = event();
```

Use it in the tab facade:

```js
tabs: {
  onRemoved: event(),
  onUpdated: tabsOnUpdated,
```

- [x] **Step 2: Replace the static reload stub with a lifecycle-aware implementation**

Replace the current `reload` member with:

```js
async reload(tabId, reloadProperties) {
  calls.push({ api: 'tabs.reload', tabId, reloadProperties });
  tab.status = 'loading';
  for (const listener of [...tabsOnUpdated.listeners]) {
    await listener(tabId, { status: 'loading' }, { ...tab, id: tabId });
  }
  if (typeof options.onReload === 'function') {
    await options.onReload({ tabId, reloadProperties, tab, calls });
  }
  if (options.completeReload === false) return;
  tab.status = 'complete';
  for (const listener of [...tabsOnUpdated.listeners]) {
    await listener(tabId, { status: 'complete' }, { ...tab, id: tabId });
  }
},
```

This makes the test harness change page content at the same boundary as a real navigation while preserving hard-refresh arguments.

- [x] **Step 3: Run the existing background tests**

Run:

```bash
node --test test/background-lifecycle.test.js
```

Expected: all existing tests pass. Any failure here is a harness compatibility regression and must be resolved before adding production changes.

- [ ] **Step 4: Commit the harness change**

```bash
git add test/background-harness.js
git commit -m "test: simulate tab reload completion in background harness"
```

### Task 2: Write the failing first-reload regression tests

**Files:**

- Create: `test/keyword-refresh-lifecycle.test.js`

- [x] **Step 1: Create the shared settings fixture and cleanup helper**

Create the file with:

```js
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
```

- [x] **Step 2: Add the first-reload transition test**

Append:

```js
test('keyword introduced by reload 1 alerts during cycle 1', async () => {
  const options = { executeScriptResult: 'No matching study yet' };
  options.onReload = () => {
    options.executeScriptResult = 'AI Videos - Evaluation\nBy Vortex Oasis';
  };
  const harness = createHarness(options);
  await start(harness);

  const cycleStart = harness.calls.length;
  await harness.evaluate('fireRefresh(7)');

  assert.equal(harness.evaluate('activeJobs[7].refreshCount'), 1);
  assert.equal(harness.evaluate('activeJobs[7].keywordCount'), 1);
  const cycleCalls = harness.calls.slice(cycleStart);
  const reloadIndex = cycleCalls.findIndex((call) => call.api === 'tabs.reload');
  const readIndex = cycleCalls.findIndex((call) => call.api === 'scripting.executeScript');
  const alertIndex = cycleCalls.findIndex((call) => call.api === 'notifications.create');
  assert.ok(reloadIndex >= 0, 'cycle should reload');
  assert.ok(readIndex > reloadIndex, 'new document must be read after reload');
  assert.ok(alertIndex > readIndex, 'alert must follow evaluation of the new document');
  assert.equal(cycleCalls.filter((call) => call.api === 'tabs.reload').length, 1);

  await stop(harness);
});
```

- [x] **Step 3: Add the existing-content baseline test**

Append:

```js
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
```

- [x] **Step 4: Add the stopped-during-reload safety test**

Append:

```js
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
```

- [x] **Step 5: Add coverage for the other detection branches sharing this lifecycle**

Append:

```js
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
```

- [x] **Step 6: Run the regression file and prove it fails for the diagnosed reason**

Run:

```bash
node --test test/keyword-refresh-lifecycle.test.js
```

Expected before the production fix: the page-level keyword, per-item keyword, and generic-change tests fail because the recorded detection read occurs before `tabs.reload`; the page-level and per-item keyword counts remain `0`. The existing-content test should pass. Keep the failure output in the task notes for review.

- [ ] **Step 7: Commit the failing tests**

```bash
git add test/keyword-refresh-lifecycle.test.js
git commit -m "test: reproduce keyword alert delayed until second reload"
```

### Task 3: Evaluate the newly reloaded document in the same cycle

**Files:**

- Modify: `background.js:1166-1350`

- [x] **Step 1: Add a cancellable one-shot reload-completion waiter**

Place this immediately before `doMonitorRefresh()`:

```js
const RELOAD_COMPLETE_TIMEOUT_MS = 15_000;

function createReloadCompletionWaiter(tabId, timeoutMs = RELOAD_COMPLETE_TIMEOUT_MS) {
  let settled = false;
  let timer = null;
  let finish = () => {};
  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') finish(true);
  };
  const promise = new Promise((resolve) => {
    finish = (completed) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
  return { promise, cancel: () => finish(false) };
}
```

- [x] **Step 2: Move reload and readiness ahead of the content read**

After `matcher`, `hasKeyword`, and `perItem` are computed, insert:

```js
const reloadWaiter = createReloadCompletionWaiter(tabId);
try {
  await doRefresh(tabId, job);
} catch (error) {
  reloadWaiter.cancel();
  throw error;
}
const reloadCompleted = await reloadWaiter.promise;
if (!reloadCompleted || activeJobs[tabId] !== job) {
  if (activeJobs[tabId] === job) {
    job._consecutiveFailures = (job._consecutiveFailures || 0) + 1;
  }
  return;
}
```

This listener is registered before `tabs.reload()`, so a fast cached navigation cannot complete before the waiter exists.

- [x] **Step 2a: Wait for asynchronous app hydration before reading**

After the load-complete waiter resolves, inject `waitForPageSettle()` with a 750 ms minimum hold, a 300 ms quiet window, and a 3-second timeout. Ignore mutations inside the extension's countdown overlay. This catches cards inserted by client-side API rendering after Chrome reports `status: complete` while keeping busy pages bounded.

- [x] **Step 3: Make read failures return without causing a second reload**

Replace the `executeScript` catch body with:

```js
} catch (e) {
  job._consecutiveFailures = (job._consecutiveFailures || 0) + 1;
  return;
}
```

Replace the empty-read guard with:

```js
if (perItem ? !Array.isArray(currentContent) : currentContent.length === 0) {
  return;
}
```

The scheduled reload has already happened. A failed post-load script execution must preserve the old baseline and let `fireRefresh()` apply the existing failure backoff; an empty observation must preserve the baseline without inventing a failure. Neither path may reload twice.

- [x] **Step 4: Remove the reload from both successful detection tails**

In the per-item branch, delete:

```js
await doRefresh(tabId, job);
if (job._pendingFlash) { job._pendingFlash = false; sendKeywordFlash(tabId, 0); }
```

Keep the immediate `return` after baseline and alert processing.

In the page-level branch, retain:

```js
job.previousContent = currentContent;
```

Delete the following reload and `_pendingFlash` block:

```js
await doRefresh(tabId, job);
if (job._pendingFlash) {
  job._pendingFlash = false;
  sendKeywordFlash(tabId, 0);
}
```

- [x] **Step 5: Update comments to match the new cycle order**

The opening comment in `doMonitorRefresh()` must state:

```js
// Reload first, then evaluate the document produced by THIS scheduled cycle.
// The start-time snapshot remains the previous baseline, so content introduced
// by reload 1 can alert during cycle 1 without treating content already present
// when Start was pressed as a new arrival.
```

Remove comments claiming sound must fire before reload or that detection reads before navigation.

- [x] **Step 6: Run the lifecycle tests**

Run:

```bash
node --test test/keyword-refresh-lifecycle.test.js test/background-lifecycle.test.js
```

Expected: all tests pass. The first-reload test must report `refreshCount === 1`, `keywordCount === 1`, and exactly one `tabs.reload` call.

- [ ] **Step 7: Commit the lifecycle fix**

```bash
git add background.js test/keyword-refresh-lifecycle.test.js
git commit -m "fix: evaluate keywords after each scheduled reload"
```

### Task 4: Deliver the screen flash to the detected document immediately

**Files:**

- Modify: `background.js:883-923, 1080-1160, 1231-1265, 1339-1349`
- Modify: `monitor-decision.js:42-51`
- Modify: `test/monitor-decision.test.js:52-67`
- Test: `test/keyword-refresh-lifecycle.test.js`

- [x] **Step 1: Change the pure flash decision to post-reload semantics**

Replace `computeFlashDelivery()` with:

```js
function computeFlashDelivery({ fired, flashOnKeyword }) {
  if (!fired || !flashOnKeyword) return 'none';
  return 'now';
}
```

Update its comment to explain that page-level refresh detection and DOM-watch detection both alert against a live, already-loaded document.

- [x] **Step 2: Update the flash truth-table tests**

Replace the existing flash tests with:

```js
test('flash delivery is none unless the alert fired and flash is enabled', () => {
  assert.equal(computeFlashDelivery({ fired: false, flashOnKeyword: true }), 'none');
  assert.equal(computeFlashDelivery({ fired: true, flashOnKeyword: false }), 'none');
  assert.equal(computeFlashDelivery({ fired: false, flashOnKeyword: false }), 'none');
});

test('flash targets the current document immediately after detection', () => {
  assert.equal(computeFlashDelivery({ fired: true, flashOnKeyword: true }), 'now');
  assert.equal(computeFlashDelivery({ fired: 1, flashOnKeyword: 'yes' }), 'now');
});
```

- [x] **Step 3: Remove deferred flash state from `deliverKeywordAlert()`**

Replace its flash block with:

```js
const flashPlan = ARPMonitor.computeFlashDelivery({
  fired: true,
  flashOnKeyword: job.settings.flashOnKeyword && !muted('flash'),
});
if (flashPlan === 'now') sendKeywordFlash(tabId, 0);
```

Remove every remaining assignment, check, or comment referring to `_pendingFlash`. Confirm with:

```bash
rg -n "_pendingFlash|after-reload" background.js monitor-decision.js test
```

Expected: no matches.

- [x] **Step 4: Add flash coverage to the first-reload lifecycle test**

Start the first test with `flashOnKeyword: true`, then append after `fireRefresh(7)`:

```js
await new Promise((resolve) => setTimeout(resolve, 0));
const flashes = harness.calls.filter(
  (call) => call.api === 'tabs.sendMessage' && call.message.type === 'KEYWORD_FLASH',
);
assert.equal(flashes.length, 1);
```

- [x] **Step 5: Run focused tests**

Run:

```bash
node --test test/keyword-refresh-lifecycle.test.js test/monitor-decision.test.js test/item-detect.test.js
```

Expected: all tests pass with one flash on the first-reload transition and none for an unchanged baseline.

- [ ] **Step 6: Commit the flash correction**

```bash
git add background.js monitor-decision.js test/monitor-decision.test.js test/keyword-refresh-lifecycle.test.js
git commit -m "fix: flash the document that triggered keyword detection"
```

### Task 5: Document and verify the completed behavior

**Files:**

- Modify: `README.md:109-113`
- Create: `audit-proof/capture-keyword-first-reload.mjs`
- Create during verification: `artifacts/keyword-first-reload/before-start.png`
- Create during verification: `artifacts/keyword-first-reload/after-first-reload-alert.png`
- Create during verification: `artifacts/keyword-first-reload/after-first-reload-alert-popup.png`

- [x] **Step 1: Update the README behavior note**

Replace the keyword-detection note with:

```markdown
- Keyword detection snapshots the page when Start is pressed, then waits briefly for async app content to settle before evaluating the newly loaded document after each scheduled reload. By default it alerts only when the keyword *appears* (absent → present), so content already present at Start remains a silent baseline while content introduced by the first reload alerts in that same cycle. Sound delivery is addressed directly to the offscreen audio document and keeps the media element alive through playback. With **per-item detection** (a selector + "Alert on each new match"), it diffs the set of matching items and alerts on each newly arrived item while earlier matches remain on screen.
```

- [x] **Step 2: Run the complete automated verification set**

Run:

```bash
npm test
npm run lint
npm run build
node audit-proof/verify-severe-fixes.mjs
git diff --check
```

Expected:

- The complete test suite passes with zero failures.
- Lint exits successfully.
- The extension build completes and produces the expected `dist` artifact.
- Severe-fix verification reports success.
- `git diff --check` prints no output.

- [x] **Step 3: Perform a real-browser first-reload check**

Use the built unpacked extension in Chrome on a page where the keyword is absent initially and appears after the next server-backed reload:

1. Run `node audit-proof/capture-keyword-first-reload.mjs` (it creates the output directory and captures all three PNGs).
2. Configure an 8-second interval, keyword `- Evaluation`, Sound alert on, Stop on found off, and Flash screen on alert on.
3. Save a real PNG screenshot before pressing Start as `artifacts/keyword-first-reload/before-start.png`.
4. Press Start and observe the first automatic reload.
5. Confirm the sound/notification/flash occurs after reload 1 and before any reload 2 begins.
6. Open the popup and confirm `Refreshes: 1` and `Detections: 1`.
7. Save a real PNG screenshot showing the detected state as `artifacts/keyword-first-reload/after-first-reload-alert.png` and the popup state as `artifacts/keyword-first-reload/after-first-reload-alert-popup.png`.
8. Visually inspect all three PNGs: they must not be blank, must show the correct screen, must have readable text and visible important controls, and must have no obvious overlap or clipping.
9. If the page or alert is not ready after reload 1, inspect extension service-worker errors, page console errors, failed tests, and the recorded call ordering before changing timing. The bounded post-complete DOM-settle wait and delayed-hydration harness regression are now implemented; replace the affected PNG rather than retaining stale proof after any future timing change.

- [x] **Step 4: Recheck repository scope**

Run:

```bash
git status --short
git diff --stat
git diff -- background.js monitor-decision.js test/background-harness.js test/keyword-refresh-lifecycle.test.js test/monitor-decision.test.js README.md
```

Expected: only the files named in this plan plus the three verification PNGs are changed. Preserve the pre-existing untracked `package-lock.json`; do not stage or edit it as part of this fix.

- [ ] **Step 5: Commit documentation and verification artifacts**

```bash
git add README.md artifacts/keyword-first-reload/before-start.png artifacts/keyword-first-reload/after-first-reload-alert.png
git commit -m "docs: record first-reload keyword verification"
```

## Final acceptance criteria

- A keyword absent at Start and introduced by reload 1 alerts during refresh cycle 1.
- The alert occurs after the new document is evaluated and before another reload starts.
- A keyword already present at Start remains silent until a real transition occurs.
- Empty reads retain the prior baseline; reload timeouts and script failures retain it and enter the existing failure-backoff path.
- Stopping or replacing a job during reload prevents stale evaluation and alerts.
- Page-level, per-item, and DOM-watch modes do not double-alert.
- Screen flash targets the document that was actually evaluated.
- Focused tests, the full suite, lint, build, audit proof, and whitespace checks pass.
- Real PNG proof shows the first-reload result and passes visual sanity inspection.
- The pre-existing untracked `package-lock.json` remains outside the change.

## Handoff prompt

Use this prompt in a fresh Codex task:

```text
Implement the plan at docs/superpowers/plans/2026-07-17-keyword-detection-first-reload.md exactly as written. Use superpowers:executing-plans or superpowers:subagent-driven-development, follow TDD, preserve the pre-existing untracked package-lock.json, and stop for review if the diagnosed reload ordering is not reproduced by the first failing test. Do not broaden the change beyond keyword/change refresh lifecycle, flash delivery, its tests, README behavior, and required PNG verification. Before reporting completion, run every verification command in the plan, visually inspect both PNG screenshots, replace any bad screenshot after fixes, and list the commands and absolute PNG paths in the final response.
```
