# Performance Optimization Log

## Summary Statistics

| Metric | Count |
| --- | ---: |
| Audit runs | 1 |
| Critical findings | 0 |
| High findings | 1 |
| Medium findings | 1 |
| Low findings | 0 |
| Optimizations implemented | 0 |
| Optimizations approved for implementation | 1 |

## Execution History

### 2026-07-16 10:43:16 EDT — Runtime persistence performance audit and design

#### Executive summary

The primary measurable hotspot is `background.js` rewriting the entire durable `activeJobs` object after every refresh, even though one job changed. Detecting jobs can carry 200,000-character baselines, so the work scales with total active-job payload and aggregate refresh frequency. The approved design moves routine per-job state to `chrome.storage.session` and coalesces `chrome.storage.local` checkpoints into 30-second windows while preserving immediate durable writes for user-significant transitions.

A secondary hidden-page polling opportunity was identified in `manage.js` and deliberately deferred so the first implementation stays focused on the selected storage, CPU, and battery goal.

#### Commands executed

```text
git status --short --branch
git remote -v
git log -6 --oneline --decorate
rg --files -g '!dist/**' -g '!node_modules/**'
rg -n '<timer, DOM, storage, message, alarm, JSON, collection patterns>' --glob '*.js'
git show --stat --oneline c21f74e
git diff --stat
gemini --model gemini-3-flash-preview --approval-mode plan ...
npm test
npm run lint
node -e '<structuredClone and JSON payload benchmark>'
```

Gemini CLI inspection could not run because authentication returned `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`. Local repository evidence, Git history, the connected GitHub repository, and official Chrome documentation were used instead.

#### Baseline validation

- `npm test`: 266 passing, 0 failing; 948.741 ms reported test duration and 1.74 s wall time.
- `npm run lint`: passed; 4.98 s wall time.
- Worktree already contained the prior security-remediation changes; no production code was changed during this audit/design phase.

#### Findings by severity

- High: 1 — whole-map durable persistence on every refresh.
- Medium: 1 — Manage page wakes the service worker every eight seconds while hidden.
- Critical/Low: 0.

## Optimization #1: Storage and CPU — Coalesce whole-map durable checkpoints

**Location:** `background.js:1590`, `background.js:1602`, `background.js:1627`

**Severity:** High

**Current code:**

```js
function withJobsStore(mutate) {
  return jobsStoreMutex(async () => {
    const data = await chrome.storage.local.get('activeJobs');
    const jobs = data.activeJobs || {};
    await mutate(jobs);
    await chrome.storage.local.set({ activeJobs: jobs, activeJobUrls: /* ... */ });
  });
}

async function saveJobToStorage(tabId, settings) {
  await withJobsStore((jobs) => {
    jobs[tabId] = /* changed job plus detection baseline */;
  });
}
```

**Problem:**

One job's refresh reads and writes the full persisted map. Every detecting job may contribute a baseline of up to 200,000 characters. With multiple fast jobs, the same unrelated baselines are repeatedly cloned, serialized, read, and written.

**Impact quantification:**

- Current complexity per refresh: O(total persisted job payload).
- Proposed routine complexity: O(changed job payload), plus one O(total payload) local checkpoint per 30-second dirty window.
- Affected path: every successful refresh cycle.
- Users affected: all active jobs; impact grows with detecting jobs, large pages, and short intervals.

**Before metrics:**

| Jobs | Payload per local write | Proxy clone + stringify | Writes/hour at 5 seconds | Theoretical serialized volume/hour |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.19 MiB | 0.276 ms | 720 | 0.13 GiB |
| 5 | 0.95 MiB | 1.168 ms | 3,600 | 3.35 GiB |
| 10 | 1.91 MiB | 2.523 ms | 7,200 | 13.42 GiB |
| 25 | 4.77 MiB | 16.784 ms | 18,000 | 83.87 GiB |

These are serialization proxies and theoretical transferred-byte totals, not claims about physical disk bytes written by Chrome.

**Expected after metrics for ten jobs:**

- Routine local writes per 30 seconds: 60 to at most 1.
- Local serialized payload per 30 seconds: approximately 114.6 MiB to 1.91 MiB.
- Net local serialization reduction: approximately 98%.
- Routine session payload: only the changed job, approximately 0.19 MiB at the benchmark's maximum baseline.

**Approved solution:**

Use per-job `chrome.storage.session` runtime records and a 30-second coalesced `chrome.storage.local.activeJobs` checkpoint. Flush local storage immediately for start, stop, settings, pause/resume, snooze/extend, alert baseline changes, and cleanup. Prefer newer session state during service-worker rehydration; fall back to the unchanged local shape after a full browser restart.

**Measurement and verification:**

- Extend the background harness to count `storage.session` and `storage.local` operations and serialized bytes.
- Simulate ten maximum-baseline jobs and 60 refreshes within one checkpoint window.
- Assert one local write, per-job session writes, and no stopped-job resurrection.
- Re-run the proxy benchmark and browser smoke suite after implementation.

**Trade-offs:**

- Memory: session storage holds current runtime records, bounded by Chrome's session quota and the existing job caps.
- Complexity: adds a checkpoint policy, session index, and recovery precedence.
- Durability: a full browser crash/restart can lose up to 30 seconds of runtime-only state.
- Maintainability: local snapshot format stays unchanged, keeping rollback simple.

**Risk assessment:**

- Breaking changes: none intended in normal operation; crash recovery can be slightly stale by explicit user approval.
- Edge cases: concurrent stop/checkpoint, session quota failure, failed local checkpoint, corrupt session index, and extension reload.
- Browser compatibility: `chrome.storage.session` requires MV3 Chrome 102+; the extension already depends on Chrome 116+ for offscreen audio.

## Optimization #2: Worker wakeups — Suspend hidden Manage-page polling

**Location:** `manage.js:534`

**Severity:** Medium

**Problem:**

An open Manage page sends `GET_ALL_JOBS` every eight seconds even while hidden. The signature guard avoids most DOM work, but the message still wakes the service worker.

**Impact quantification:**

- Current hidden wakeups: up to 450 per hour per open Manage page.
- Proposed hidden wakeups: zero, with an immediate refresh on `visibilitychange` when the page becomes visible.

**Status:** Deferred. The selected first pass is limited to active-job persistence so storage architecture and UI polling behavior do not change together.

**Verification when scheduled:**

- Fake document visibility in a focused Manage-page test.
- Assert no interval messages while hidden and one immediate refresh on visibility restoration.
- Confirm background status pushes still update visible pages.
