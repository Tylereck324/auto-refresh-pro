# Severe Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five confirmed High-severity defects from the audit while preserving the existing permission model, auto-start behavior, and global hotkey behavior.

**Architecture:** Add three dependency-free UMD helpers: lifecycle generations for cancellation, detection-identity comparison for safe interval updates, and an explicit settings-export allowlist. Exercise the real service worker through a deterministic VM/Chrome harness, then run a real unpacked-extension browser smoke test for content events and export behavior.

**Tech Stack:** Chrome MV3 JavaScript, Node `node:test`, VM-based Chrome mocks, Puppeteer/Chrome for Testing, existing `npm test`, `npm run lint`, and `npm run build` scripts.

---

## Files and ownership

- Create `lifecycle-generation.js`: pure per-tab lifecycle-token registry.
- Create `detection-identity.js`: pure normalized settings identity comparison.
- Create `settings-export.js`: pure settings-only storage projection.
- Create `test/background-harness.js`: deterministic Chrome API and message-router harness.
- Create `test/lifecycle-generation.test.js`, `test/detection-identity.test.js`, `test/settings-export.test.js`, and `test/background-lifecycle.test.js`.
- Create `audit-proof/verify-severe-fixes.mjs`: real Chrome smoke/regression harness.
- Modify `validators.js` and `test/regex-safety.test.js` for bounded nested-quantifier rejection.
- Modify `content.js` for trusted browser-event checks.
- Modify `background.js` for lifecycle cancellation and detection-state preservation; add the three helper files to its `importScripts` list.
- Modify `popup.js` for `{ cancelled: true }` Start responses.
- Modify `manage.html` and `manage.js` to use `settings-export.js`.
- Modify `SECURITY-AUDIT.md` with the new findings and the deferred permission redesign.

## Task 1: Add pure helper tests and the deterministic background harness

**Files:**
- Create: `test/background-harness.js`
- Create: `test/lifecycle-generation.test.js`
- Create: `test/detection-identity.test.js`
- Create: `test/settings-export.test.js`
- Modify: none in production code

- [ ] **Step 1: Write the harness test entry points first.**

Create tests that require the three future helpers and intentionally fail with `MODULE_NOT_FOUND` until the modules exist. The background harness must expose a `loadBackground({ tabsGet, executeScript, storage })` function that returns `{ dispatch, activeJobs, alarms, storageState, sentMessages }` and executes the real `background.js` listener in a VM context.

- [ ] **Step 2: Run the new tests and confirm the expected missing-module failures.**

Run:

```bash
node --test test/lifecycle-generation.test.js test/detection-identity.test.js test/settings-export.test.js test/background-lifecycle.test.js
```

Expected: the new tests fail because the helper modules and harness do not yet exist; existing tests remain unaffected.

- [ ] **Step 3: Implement the minimal pure helper contracts.**

Use these exported shapes:

```js
// lifecycle-generation.js
function createRegistry() {
  // begin(tabId) -> token; invalidate(tabId) -> new token;
  // isCurrent(tabId, token) -> boolean;
  // pendingTabIds() -> number[]; finish(tabId, token) -> void
}

// detection-identity.js
function identity(settings) -> string;
function same(a, b) -> boolean;

// settings-export.js
const EXPORT_KEYS = [
  'popupSettings', 'globalSettings', 'customHotkey', 'autoStartUrls',
  'urlRules', 'domainDenylist', '__ar_overlay_pos', '__ar_overlay_size',
];
function pick(storage) -> object;
```

The modules must use own-property checks and must not depend on `chrome`, `document`, or mutable global state.

- [ ] **Step 4: Run the helper tests and confirm they pass.**

Run:

```bash
node --test test/lifecycle-generation.test.js test/detection-identity.test.js test/settings-export.test.js
```

Expected: all helper tests pass, while the background integration tests remain pending until Task 3.

## Task 2: Close the regex ReDoS gap

**Files:**
- Modify: `validators.js:163-263`
- Modify: `test/regex-safety.test.js`

- [ ] **Step 1: Add the failing regression cases.**

Add assertions for the audited shape and controls:

```js
assert.equal(V.isSafeRegex('^(?:a{1,2})+b$'), false);
assert.equal(V.isSafeRegex('(a?)+$'), false);
assert.equal(V.isSafeRegex('((a{2,3}))+z'), false);
assert.equal(V.isSafeRegex('(ab{2})+z'), true);
assert.equal(V.isSafeRegex('colou?r'), true);
```

- [ ] **Step 2: Run only the regex test and verify it fails for the new unsafe patterns.**

Run:

```bash
node --test test/regex-safety.test.js
```

Expected: the new unsafe assertions fail because `isSafeRegex` currently accepts at least the bounded-inner pattern.

- [ ] **Step 3: Implement variable-width nested-quantifier detection.**

Extend the existing balanced-group scan so it recognizes `?`, `+`, `*`, open-ended `{m,}`, and bounded variable `{m,n}` quantifiers as variable width. Reject a repeated outer group when its inner content contains one. Keep exact `{n}` repetitions accepted. Preserve the existing overlap and total-quantifier checks.

- [ ] **Step 4: Run the focused and full tests.**

Run:

```bash
node --test test/regex-safety.test.js
npm test
```

Expected: the focused test and all repository tests pass; `isSafeRegex('^(?:a{1,2})+b$')` is false before matcher construction.

## Task 3: Block synthetic content-script actions

**Files:**
- Modify: `content.js:277-870`
- Create/update: `audit-proof/verify-severe-fixes.mjs`

- [ ] **Step 1: Add a browser regression assertion before changing handlers.**

In the browser harness, start a job on a local page, dispatch an untrusted `KeyboardEvent` for the configured hotkey, dispatch an untrusted click on `#__ar_stop` when present, and dispatch untrusted pointer events. Assert through `GET_STATUS` that the job state is unchanged. Also use Puppeteer keyboard/mouse APIs to prove real input remains effective. The browser harness is the required regression test for this Chrome-bound behavior; no VM DOM substitute is needed.

- [ ] **Step 2: Run the browser assertion against the current code and confirm the synthetic-event failure.**

Run:

```bash
node audit-proof/verify-severe-fixes.mjs
```

Expected: the synthetic key/click assertion fails against the current handlers.

- [ ] **Step 3: Add trusted-event guards to every user-action path.**

Use a small local helper in `content.js`:

```js
function isTrustedActionEvent(event) {
  return !!(event && event.isTrusted);
}
```

Return immediately when it is false in pause/resume, extend, stop, keydown, click-to-stop, drag start, resize start, and drag/resize continuation handlers. Do not guard lifecycle events such as `beforeunload`, `visibilitychange`, or background messages.

- [ ] **Step 4: Rerun syntax, browser, and full tests.**

Run:

```bash
npm test
npm run lint
node audit-proof/verify-severe-fixes.mjs
```

Expected: synthetic events are ignored, real input works, and all existing checks pass.

## Task 4: Make Start/Stop cancellation authoritative

**Files:**
- Modify: `background.js:1353-1452`, `1545-1558`, `1963-1996`, `2011-2015`
- Modify: `popup.js:424-440`
- Modify: `test/background-harness.js`
- Modify: `test/background-lifecycle.test.js`

- [ ] **Step 1: Add the failing Start→Stop and Stop-All interleaving tests.**

Use deferred `tabs.get`, `storage.local.get`, and `scripting.executeScript` promises. Dispatch Start, dispatch and await Stop, release the deferred Start operations, then assert:

```js
assert.equal(startResponse.cancelled, true);
assert.equal(Object.hasOwn(activeJobs, tabId), false);
assert.equal(storageState.activeJobs?.[tabId], undefined);
assert.equal(alarms.has(`refresh_${tabId}`), false);
```

Repeat with `STOP_ALL` while Start is pending.

- [ ] **Step 2: Run the race tests and confirm they fail against the current implementation.**

Run:

```bash
node --test test/background-lifecycle.test.js
```

Expected: current code reports Stop success but later creates and persists the job.

- [ ] **Step 3: Integrate lifecycle generations at message receipt.**

Load `lifecycle-generation.js` before `background.js` logic. Resolve the target tab before the async message body, begin a Start generation synchronously, invalidate on Stop synchronously, and invalidate all active/pending tabs synchronously for Stop-All. Pass the Start token through `rehydrateAll` and `startRefresh`.

Rename the current teardown body to an internal non-invalidating function. Keep public Stop paths invalidating first. After every Start await and immediately before assigning/scheduling/messaging/persisting, return the `cancelled` outcome if the token is stale. Always call `finish(tabId, token)` in `finally`.

Return `{ ok: true, started: true }`, `{ ok: false, denied: true }`, or `{ ok: false, cancelled: true }` from the Start message path. Update the popup callback to call `refreshStatus()` when `cancelled` is present.

- [ ] **Step 4: Run focused integration tests and full validation.**

Run:

```bash
node --test test/background-lifecycle.test.js
npm test
npm run lint
```

Expected: both interleavings leave no runtime or persisted job, and all existing tests pass.

## Task 5: Preserve per-item baselines for timing-only updates

**Files:**
- Modify: `background.js:2017-2070`
- Modify: `test/background-lifecycle.test.js`
- Modify: `test/detection-identity.test.js`

- [ ] **Step 1: Add the failing per-item interval-update regression.**

Arrange a job with `_seenKeys = ['A']`, send `UPDATE_INTERVAL` with no detection-field changes, make the observed page return `['A', 'B']`, and assert one alert for `B`. Add a second test changing `keyword` and assert the next cycle re-baselines without an alert burst.

- [ ] **Step 2: Run the focused test and confirm the baseline is currently lost.**

Run:

```bash
node --test test/background-lifecycle.test.js
```

Expected: the timing-only case currently emits zero alerts because `_seenKeys` is cleared unconditionally.

- [ ] **Step 3: Compare detection identity before resetting matcher state.**

Capture `oldSettings`, merge `msg.settings`, and call `detectionIdentity.same(oldSettings, job.settings)`. Only rebuild `_matcher`, `_excludeMatcher`, `_prevFound`, and `_seenKeys` when identity changes. Always keep the existing scheduling, pause handling, `_epoch`, and DOM-watch re-arming logic.

- [ ] **Step 4: Run focused and full tests.**

Run:

```bash
node --test test/detection-identity.test.js test/background-lifecycle.test.js
npm test
```

Expected: `B` alerts exactly once after a timing-only update, detection changes re-baseline, and all tests pass.

## Task 6: Make settings export private-by-default

**Files:**
- Modify: `manage.html` to load `settings-export.js` before `manage.js`
- Modify: `manage.js:464-477`
- Modify: `test/settings-export.test.js`
- Modify: `SECURITY-AUDIT.md`

- [ ] **Step 1: Add the failing export privacy test.**

Pass a storage object containing configuration plus these private keys:

```js
const data = {
  globalSettings: { notify: true },
  alertLog: [{ url: 'https://private.test/token' }],
  unackedAlerts: 3,
  activeJobs: { 7: { settings: {} } },
  activeJobUrls: ['https://private.test/token'],
  futureRuntimeKey: 'private',
};
```

Assert the projection contains `globalSettings` only and has none of the private/runtime keys.

- [ ] **Step 2: Run the focused test and confirm it fails while export reads all keys.**

Run:

```bash
node --test test/settings-export.test.js
```

Expected: the new test fails because the current export path copies all storage and deletes only `activeJobs`.

- [ ] **Step 3: Use the allowlist helper in the Manage export handler.**

Replace the `get(null)`/delete path with:

```js
const data = await chrome.storage.local.get(null);
const settings = ARPSettingsExport.pick(data);
const blob = new Blob([JSON.stringify(settings, null, 2)], {
  type: 'application/json',
});
```

Keep the existing filename, download link, and success toast. Update the Manage page script order so the helper is available before `manage.js`.

- [ ] **Step 4: Run focused tests, full tests, and browser export verification.**

Run:

```bash
node --test test/settings-export.test.js test/import.test.js
npm test
npm run lint
node audit-proof/verify-severe-fixes.mjs
```

Expected: exported JSON contains only configuration keys and the existing import/export UI still works.

## Task 7: Update security documentation and perform final validation

**Files:**
- Modify: `SECURITY-AUDIT.md`
- Verify: all implementation and test files from Tasks 1-6

- [ ] **Step 1: Document each remediation with evidence.**

Add dated entries for the regex, synthetic-event, lifecycle, detection-baseline, and export-privacy findings. State that universal page access remains a separate accepted architectural risk, not a fixed vulnerability in this pass.

- [ ] **Step 2: Run repository-wide validation.**

Run:

```bash
npm test
npm run lint
npm run build
node audit-proof/verify-severe-fixes.mjs
git diff --check
git status --short
```

Expected: tests, lint, build, and browser verification pass; `git diff --check` is clean; only planned new files and the user's pre-existing modified files are present.

- [ ] **Step 3: Inspect the final diff for scope.**

Confirm that `manifest.json` permissions are unchanged, no production credentials or new dependencies were added, no tests were skipped, and the final build artifact is `dist/auto-refresh-pro-1.1.0.zip`.
