# Severe Audit Fixes Design

**Status:** Approved for implementation planning

**Date:** 2026-07-15

## Goal

Remediate the five confirmed High-severity defects found in the July 2026 audit without changing the extension's universal-site permission model, auto-start behavior, or global hotkey behavior.

## Scope

This remediation covers:

1. Catastrophic-backtracking regexes that pass `isSafeRegex`.
2. Synthetic page events that invoke content-script controls.
3. `START_REFRESH` racing `STOP_REFRESH` and resurrecting a stopped job.
4. Timing-only `UPDATE_INTERVAL` messages discarding per-item detection state.
5. Settings exports including private alert and runtime data.

The `<all_urls>` and unconditional content-script permission architecture is explicitly out of scope. It will be handled as a separate design because changing it affects auto-start rules, global hotkeys, installation permissions, and content-script availability.

## Architecture

The work is divided into independently testable and independently committable changes. New pure modules follow the repository's existing UMD-style pattern so they can be loaded by `importScripts` or extension pages and required directly by Node tests.

### New modules

- `lifecycle-generation.js` owns per-tab lifecycle generations and pending-start tracking. It has no Chrome API dependency.
- `detection-identity.js` determines whether two settings objects describe the same keyword and per-item detection behavior.
- `settings-export.js` builds a settings-only backup from an explicit top-level allowlist.
- `test/background-harness.js` runs the real `background.js` message listener with deterministic Chrome API fakes and deferred promises.
- `audit-proof/verify-severe-fixes.mjs` loads the real unpacked extension in Chrome for Testing and verifies hostile-page event isolation and representative end-to-end flows.

### Existing files changed

- `background.js` loads the lifecycle and detection helpers, implements cancellation-aware starts, and preserves baselines for timing-only updates.
- `validators.js` rejects repeated groups containing variable-width nested quantifiers.
- `content.js` requires trusted browser input for every user-action path.
- `popup.js` reconciles a Start that was cancelled by a concurrent Stop.
- `manage.html` loads `settings-export.js` before `manage.js`.
- `manage.js` exports the helper-produced settings object instead of all local storage.
- `SECURITY-AUDIT.md` records the five remediations and the deferred permission redesign.

## Detailed Behavior

### 1. Regex safety

The validator will reject a repeated group when its interior contains another variable-width quantifier. Variable-width quantifiers include `+`, `*`, `?`, `{m,}`, and `{m,n}` when `n` is greater than `m`. Exact repetitions such as `{2}` remain allowed because they do not introduce ambiguous width.

The exact audited payload `^(?:a{1,2})+b$` must return `false` from `isSafeRegex`. Nested variants and optional-inner variants such as `(a?)+` must also be rejected. Existing safe controls such as `colou?r`, `(ab{2})+`, `(?:foo(bar))+`, and disjoint alternations must remain accepted.

No timeout wrapper will be used. JavaScript cannot interrupt a synchronous `RegExp.test()`, so unsafe syntax must be rejected before matcher construction.

### 2. Trusted content-script actions

Page-created events must not cause extension actions. `content.js` will check `event.isTrusted` before:

- Pause, Resume, Extend, and Stop button actions.
- The global keyboard shortcut.
- Click-to-stop.
- Drag and resize initiation or continuation.

Normal browser-generated mouse, pointer, and keyboard input must continue working. Runtime messages sent from the background to the content script are unaffected.

### 3. Start and Stop lifecycle ordering

Every Start receives a per-tab generation synchronously when the message is received, before `rehydrateAll()` or any other await. A Stop invalidates that generation synchronously when its message is received. `STOP_ALL` invalidates every active or pending tab before performing asynchronous cleanup.

`startRefresh` receives its generation and checks that it is still current:

- after rehydration;
- after tab lookup;
- after denylist storage lookup;
- after baseline capture;
- immediately before publishing, scheduling, messaging, or persisting the job.

Replacing an already-running job uses an internal teardown that does not cancel the new Start's own generation. External Stop paths invalidate the generation before teardown. A cancelled Start returns the internal outcome `cancelled`; a denylisted Start returns `denied`; and a completed Start returns `started`.

The message response contract becomes:

```js
{ ok: true, started: true }
{ ok: false, denied: true }
{ ok: false, cancelled: true }
```

The popup treats `cancelled` as an immediate status reconciliation, not as a denylist error. A successful Stop response means no matching in-memory job, timer, DOM scan, alarm, overlay, or persisted job remains, even if Start was previously awaiting a Chrome API.

### 4. Detection identity and interval updates

`UPDATE_INTERVAL` will snapshot the old settings, merge the new settings, and compare detection identity before resetting matcher state.

Detection identity consists of the normalized values of:

- `keyword`
- `kwRegex`
- `kwCaseSensitive`
- `kwWholeWord`
- `kwInverse`
- `watchSelector`
- `kwPerItem`
- `kwExclude`
- `collapseDigits`

Timing, notification, sound, adaptive-interval, quiet-hours, pause, and display changes do not alter detection identity.

When identity is unchanged, `_matcher`, `_excludeMatcher`, `_prevFound`, and `_seenKeys` are preserved. When identity changes, matchers are rebuilt and `_prevFound` and `_seenKeys` are reset so the next observation establishes a quiet baseline instead of emitting a false burst. Scheduling and DOM-watch re-arming continue to use the merged settings in both cases.

### 5. Settings export privacy

The settings backup will include only these top-level keys when present:

```text
popupSettings
globalSettings
customHotkey
autoStartUrls
urlRules
domainDenylist
__ar_overlay_pos
__ar_overlay_size
```

The helper copies only own properties from this allowlist. It excludes `activeJobs`, `activeJobUrls`, `alertLog`, `unackedAlerts`, and every unknown future storage key by default. Alert history remains available only through the existing separately labeled alert-history export.

The downloaded filename and one-click settings-export interaction remain unchanged.

## Testing Strategy

Every remediation follows red-green TDD: add the smallest regression test, run it and confirm the audited failure, implement the focused fix, then rerun the targeted and full suites.

### Unit tests

- `test/regex-safety.test.js` covers the audited bounded-quantifier payload, nested variants, optional-inner variants, and safe controls.
- `test/lifecycle-generation.test.js` covers begin, invalidate, current-token checks, pending starts, and Stop-All invalidation inputs.
- `test/detection-identity.test.js` proves timing-only changes compare equal and every detection field compares unequal when changed.
- `test/settings-export.test.js` proves the exact allowlist is exported and private, runtime, inherited, and unknown keys are excluded.

### Background integration tests

`test/background-lifecycle.test.js` uses `test/background-harness.js` to execute the real message listener. It will:

- suspend each asynchronous Start boundary;
- send Stop and wait for its success response;
- resume Start;
- assert no job, timer, DOM scan, alarm, overlay, or storage record survives;
- repeat the assertion for `STOP_ALL`;
- start a per-item job with baseline `[A]`, make `B` appear, apply a timing-only update, and verify `B` alerts exactly once;
- change a detection field and verify the next observation re-baselines without an alert burst.

### Browser verification

`audit-proof/verify-severe-fixes.mjs` will use a relative repository path, a temporary Chrome profile, a local HTTP test page, and the real unpacked extension. It will verify:

- synthetic page-created clicks, keydowns, and pointer events do not change job state;
- real Puppeteer keyboard and mouse input still operates extension controls;
- an exported settings file excludes seeded alert, URL, job, and counter data;
- representative Start, Stop, per-item, popup, and Manage flows still work.

The browser harness will always close Chrome, stop its local server, and delete its temporary profile in a `finally` block.

## Verification Gate

Implementation is complete only after all of these pass from the repository root:

```bash
npm test
npm run lint
npm run build
node audit-proof/verify-severe-fixes.mjs
```

The implementation report must also include:

- targeted red-green evidence for each defect;
- the final test count and zero failures;
- browser verification results;
- the final build artifact path;
- `git diff --check` output;
- `git status --short`, explicitly distinguishing pre-existing changes from implementation changes.

## Documentation

`SECURITY-AUDIT.md` will add dated entries for the five confirmed findings, their root causes, fixes, and regression coverage. Its permissions section will no longer claim that narrower scope is impossible; it will identify universal page access as an accepted architectural risk deferred to a separate permission-redesign project.

## Commit Boundaries

The intended implementation commits are:

1. Test infrastructure for real background lifecycle paths.
2. Regex safety remediation and regression tests.
3. Trusted content-event enforcement and browser regression coverage.
4. Start/Stop lifecycle cancellation and integration tests.
5. Detection-state preservation and integration tests.
6. Settings-export allowlist and privacy tests.
7. Browser verification and security documentation.

No permission-model changes or unrelated refactors belong in these commits.
