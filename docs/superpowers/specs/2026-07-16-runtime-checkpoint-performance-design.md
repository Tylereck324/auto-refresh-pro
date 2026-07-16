# Runtime Checkpoint Performance Design

**Status:** Approved in conversation; awaiting written-spec review

**Date:** 2026-07-16

## Goal

Reduce CPU, serialization, disk-write, and battery cost from active-job persistence while preserving current behavior during normal operation and service-worker sleep/wake cycles.

## Measured Problem

`background.js` currently calls `saveJobToStorage` after every refresh cycle. That helper enters `withJobsStore`, reads the complete `activeJobs` object from `chrome.storage.local`, changes one job, and writes the complete object back. Each detecting job may include a page baseline of up to 200,000 characters.

The cost therefore scales with both refresh frequency and the total size of every active job:

```text
local work per cycle = O(total persisted activeJobs payload)
```

A local Node proxy benchmark using `structuredClone` plus JSON serialization measured:

| Detecting jobs | Whole-map payload | Clone + stringify |
| ---: | ---: | ---: |
| 1 | 0.19 MiB | 0.276 ms |
| 5 | 0.95 MiB | 1.168 ms |
| 10 | 1.91 MiB | 2.523 ms |
| 25 | 4.77 MiB | 16.784 ms |

Ten jobs refreshing every five seconds produce 60 routine saves per 30 seconds. At the maximum baseline size, that represents approximately 114.6 MiB of repeated local-storage serialization per 30-second window.

## Approved Trade-off

The user accepts a durable snapshot that may lag by up to 30 seconds after a full browser crash or restart. If the result feels bad in use, the optimization must be easy to revert.

Normal operation and extension service-worker restarts must remain current by using `chrome.storage.session`. Chrome clears session storage when the browser restarts, when the extension reloads, or when the extension updates. In those cases, recovery falls back to the most recent local snapshot.

## Architecture

### In-memory authority

`activeJobs` remains authoritative while the service worker is running. Existing scheduling, detection, lifecycle-generation, and broadcast behavior continues to read and mutate these job objects.

### Per-job session records

Frequently changing runtime records are stored separately in `chrome.storage.session`, keyed by tab ID. A routine refresh writes only the changed job instead of cloning the whole job map.

The session layer also stores a small job-ID index and a dirty-checkpoint marker. Index mutations are serialized so concurrent starts and stops cannot lose entries.

### Backward-compatible durable snapshot

`chrome.storage.local.activeJobs` remains the durable and rollback-compatible representation. No migration is required for existing installations, and removing the session/checkpoint layer restores the old read path.

### Coalesced checkpoint alarm

The first routine mutation in a clean window marks the local snapshot dirty and schedules one one-shot alarm for 30 seconds later. Additional routine mutations update their per-job session records but do not schedule additional checkpoint alarms.

The checkpoint alarm rebuilds a consistent snapshot, writes it through the existing local-storage mutex, and clears the dirty marker only after the write succeeds.

## Persistence Policy

Routine refresh-cycle changes use session storage and request a deferred checkpoint.

The following user-significant or correctness-sensitive transitions flush local storage immediately:

- Start.
- Stop and Stop All.
- Settings or interval changes.
- Pause and resume.
- Snooze and extend-deadline actions.
- Detection alerts that advance an alert-relevant baseline.
- Cleanup of a closed or invalid tab.

Immediate paths update session and local state in a defined order and cancel or supersede a pending checkpoint as appropriate. A stopped job must be absent from memory, session storage, the session index, local storage, and any later checkpoint input before Stop reports success.

## Recovery Flow

1. Rehydrate newer per-job session records when available.
2. Fall back to `chrome.storage.local.activeJobs` for missing session records.
3. Run all recovered records through the existing validation and `ARPRehydrate.buildRehydratedJob` path.
4. Rebuild the session index from validated records if the index is missing or inconsistent.
5. Preserve current single-flight per-tab rehydration so concurrent alarms and messages cannot create detached job objects.

A full browser restart can restore counts, deadlines, adaptive streaks, or detection baselines from a snapshot up to 30 seconds old. Recovery must quietly re-establish any uncertain detection baseline so the stale snapshot cannot generate a duplicate alert burst. This accepted recovery trade-off may miss a change that occurred only inside the crash window.

## Failure Handling

- If a session write fails or exceeds quota, log one bounded warning and immediately use the existing local-storage persistence path for that mutation.
- If a deferred local checkpoint fails, retain the dirty marker and schedule one retry 30 seconds later.
- If local and session records disagree, select the record with the newer bounded numeric `savedAt`; malformed timestamps do not outrank valid records.
- If a job is stopped while a checkpoint is queued, the existing jobs-store mutex and a final live-job check prevent resurrection.
- If the session index is missing or corrupt, rebuild it from valid prefixed session records and local fallback data.
- All new alarms and storage keys use a namespaced constant and are removed when no active jobs remain.

## Module Boundaries

The implementation should add a small pure helper module for key construction, record selection, dirty/checkpoint decisions, and index normalization. It follows the repository's dependency-free UMD pattern so Node tests can require it while `background.js` loads it through `importScripts`.

Chrome API orchestration remains in `background.js` and is exercised through the existing VM-based background harness. No UI files or permission changes are required for the primary optimization.

## Test-Driven Implementation

Production code is written only after a failing test demonstrates each behavior.

### Pure unit tests

- Session key generation is stable and rejects invalid tab IDs.
- Session indexes are normalized, deduplicated, and bounded.
- Newer valid session records outrank local records.
- Missing, malformed, or older session records fall back locally.
- Dirty-state decisions coalesce repeated routine changes into one checkpoint window.

### Background integration tests

Using `test/background-harness.js` with session-storage and alarm fakes:

- A routine refresh writes one per-job session record and no immediate local snapshot.
- Sixty simulated refreshes in one 30-second window schedule one checkpoint and produce one local write.
- Updating one job does not rewrite unrelated session job records.
- A worker restart rehydrates current session state.
- A browser-restart simulation with empty session storage rehydrates local state.
- Start, settings changes, pause/resume, alerts, and stop flush locally immediately.
- Stop before checkpoint removes the job everywhere and the later alarm cannot resurrect it.
- Session failure falls back to immediate local persistence.
- Checkpoint failure stays dirty and retries once after 30 seconds.
- Concurrent multi-tab changes preserve every job.

## Performance Acceptance Criteria

For ten maximum-baseline detecting jobs refreshing every five seconds:

- Routine local writes fall from 60 to at most one per 30-second window.
- Estimated local serialization falls from approximately 114.6 MiB to approximately 1.91 MiB per window, a reduction of about 98%.
- Routine session writes serialize only the changed job, approximately 0.19 MiB rather than the 1.91 MiB whole map in this scenario.
- No timing assertion is placed in the unit suite; deterministic write counts and serialized-byte counts prevent machine-speed flakiness.
- An optional benchmark command records wall-clock measurements in `performance-optimization-log.md` without gating correctness.

## Verification Gate

Implementation is complete only after fresh runs of:

```bash
npm test
npm run lint
npm run build
node audit-proof/verify-severe-fixes.mjs
git diff --check
```

The final report must include targeted red-green evidence, final test counts, before/after write and byte counts, browser-smoke results, and the build artifact path.

## Rollback

Rollback removes the session-record helper, session writes, dirty marker, and checkpoint alarm. The existing `chrome.storage.local.activeJobs` shape and existing rehydration format remain valid throughout, so no reverse migration is required.

## Out of Scope

- Permission-model changes.
- Changing refresh, detection, notification, or alert semantics during normal operation.
- Optimizing the live-watch DOM scan cadence.
- Replacing `chrome.storage` with IndexedDB.
- UI redesign.
- Hidden Manage-page poll suppression, which remains a separate medium-priority opportunity.
