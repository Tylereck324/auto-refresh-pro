// bg-store.js — job persistence: session/local storage, rehydrate after a worker restart, startup restore, closed-tab cleanup.
//
// A classic script loaded by background.js via importScripts: it shares the
// service worker's global scope (activeJobs, the ARP* modules, and the other
// bg-*.js files), so it is split out for readability, not isolation. Top-level
// code here must only register listeners and declare state — anything that
// touches background.js state runs later, from an event.

// ── Storage helpers ────────────────────────────────────────────────────────
// Every activeJobs read-modify-write goes through this single mutex. Without it,
// two concurrent saves (e.g. two tabs refreshing at once) interleave get→set and
// the second write clobbers the first tab's entry — silently un-persisting a live
// job so it's lost on the next worker restart. writeJobsLocked re-reads inside
// the lock, so each mutation sees the previous one's result.
const jobsStoreMutex = ARPSerialize.createMutex();
// Count of our own in-flight activeJobs writes, so the storage.onChanged
// listener can tell them apart from an out-of-band write. Without this, every
// saveJobToStorage (one per refresh cycle) flipped jobsStoreFresh and forced the
// next message to re-read the whole activeJobs blob — including each job's
// up-to-200k-char detection baseline — for data this worker just wrote itself.
let selfJobsWrites = 0;

// Read-modify-write activeJobs in local storage. MUST run inside jobsStoreMutex.
// A mutate returning exactly `false` signals "nothing changed" and skips the write.
async function writeJobsLocked(mutate) {
  const data = await chrome.storage.local.get('activeJobs');
  const jobs = data.activeJobs || {};
  if (await mutate(jobs) === false) return;
  selfJobsWrites++;
  try {
    await chrome.storage.local.set({ activeJobs: jobs });
  } catch (e) {
    selfJobsWrites--;
    throw e;
  }
}

// The persisted shape of a live job, or null if the job is gone.
function buildJobRecord(tabId, settings) {
  // Persist the detection baseline for monitor/keyword jobs. Without it, every
  // alarm-driven cycle at intervals past the MV3 idle timeout rehydrates with no
  // baseline, monitor-decision refuses to fire, and detection silently never
  // works. Plain refresh jobs skip it — no detection, no point paying the write.
  // readPageText caps the snapshot at 200k chars, bounding this write.
  const monitors = !!(settings && (settings.monitorMode ||
    (typeof settings.keyword === 'string' && settings.keyword.trim())));
  const job = activeJobs[tabId];
  // The job can be stopped between a save being requested and the write
  // running on the mutex (e.g. a live-watch alert is mid-delivery when the
  // user clicks Stop; its save queues AFTER the stop's remove). Writing anyway
  // would resurrect the entry with defaults — startUrl: null — and the next
  // rehydrate would re-attach the stopped job to whatever URL the tab shows
  // then. A stopped job stays stopped.
  if (!job) return null;
  return {
    settings,
    refreshCount: job.refreshCount || 0,
    keywordCount: job.keywordCount || 0,
    nextRefresh: job.nextRefresh || (Date.now() + computeInterval(settings)),
    startUrl: job.startUrl || null, // navigate-away baseline across restarts
    previousContent: (monitors && typeof job.previousContent === 'string')
      ? job.previousContent : null, // keyword/change baseline across restarts
    // Per-item detection baseline: the seen matching-item keys, so a worker
    // restart mid-session doesn't re-alert for every item already on the page.
    // Keys are short hashes; cap the count to bound the write (readPageText
    // already caps items at 500, so this is just defense in depth).
    seenKeys: Array.isArray(job._seenKeys) ? job._seenKeys.slice(0, 1000) : null,
    // Adaptive-backoff streak (#8): persist so the ramp resumes at the right
    // step after a worker restart at long (alarm-driven) intervals, instead of
    // snapping back to the fast base every time the worker idles out.
    noChangeStreak: Number(job._noChangeStreak) || 0,
    // Manual pause (#10): persist so a job paused via the overlay/Manage stays
    // paused across a worker restart instead of silently resuming (the
    // alarm-backed recheck lets the MV3 worker idle out). Quiet/offline pauses
    // are re-derived from the clock/navigator.onLine and need no persistence.
    manualPause: !!job._manualPause,
    // Navigate-away pause (#12): persist so an away pause survives a worker
    // restart — the rehydrated job stays dormant on the wrong page (no baseline
    // poisoning, no repeat notification) until a resume edge fires. Quiet/
    // offline pauses are re-derived and need no persistence; 'away' can't be
    // re-derived without a tabs.get, and losing it would re-notify per restart.
    awayPause: job._pauseReason === 'away',
    // Snooze deadline (#2): persist so a 15-minute snooze outlives the
    // worker (which idles out in ~30s). Expired deadlines are dropped at
    // rehydrate time; the job's stop path deletes the whole entry.
    snoozeUntil: Number(job._snoozeUntil) || 0,
    // Dead-watch state + its inputs. At intervals past the MV3 idle timeout the
    // worker dies between cycles, so without these a stall could never reach
    // its confirmation count (and the failure backoff would reset each cycle).
    consecutiveFailures: Number(job._consecutiveFailures) || 0,
    health: job._health || null,
    healthIgnore: Array.isArray(job._healthIgnore) ? job._healthIgnore : [],
    savedAt: Date.now(),
  };
}

// Immediate durable save, for user-significant transitions (start, settings,
// pause/resume, snooze, alerts). Writes the local snapshot now and drops the
// job's session record, which the local entry now supersedes.
async function saveJobToStorage(tabId, settings) {
  await jobsStoreMutex(async () => {
    await writeJobsLocked((jobs) => {
      const record = buildJobRecord(tabId, settings);
      if (!record) return false;
      jobs[tabId] = record;
    });
    await removeSessionRecord(tabId);
  });
}

// Routine per-cycle save (count, deadline, advanced baseline). Writes ONLY this
// job's session record — not the whole local map with every job's baseline — and
// arms one coalesced local checkpoint. A browser crash can therefore lose at
// most one checkpoint window of routine progress; a worker restart loses none.
async function saveJobRoutine(tabId, settings) {
  await jobsStoreMutex(async () => {
    const record = buildJobRecord(tabId, settings);
    if (!record) return;
    try {
      await chrome.storage.session.set({ [ARPCheckpoint.sessionKey(tabId)]: record });
    } catch (e) {
      // Session unavailable or over quota: fall back to the durable path for
      // this mutation rather than losing it.
      console.warn('Session job write failed; saving locally', e);
      await writeJobsLocked((jobs) => { jobs[tabId] = record; });
      await removeSessionRecord(tabId); // an older session record must not outrank it
      return;
    }
    armCheckpoint();
  });
}

async function removeSessionRecord(tabId) {
  const key = ARPCheckpoint.sessionKey(tabId);
  if (!key) return;
  try { await chrome.storage.session.remove(key); } catch (e) {}
}

// One checkpoint alarm per dirty window. The in-memory flag avoids re-creating
// (and thereby pushing back) the alarm on every routine save; after a worker
// restart it is false again, but the worker only restarts after ~30s idle, so
// re-arming then can't starve the checkpoint.
let checkpointArmed = false;
function armCheckpoint() {
  if (checkpointArmed) return;
  checkpointArmed = true;
  chrome.alarms.create(ARPCheckpoint.CHECKPOINT_ALARM,
    { delayInMinutes: ARPCheckpoint.CHECKPOINT_DELAY_MS / 60000 });
}

// Fold newer session records into the durable snapshot. Only entries still
// present locally are touched, so a job stopped while the checkpoint was
// pending is never resurrected. On failure, retry in one more window.
async function flushCheckpoint() {
  checkpointArmed = false;
  try {
    await jobsStoreMutex(async () => {
      const all = await chrome.storage.session.get(null);
      const records = ARPCheckpoint.collectSessionRecords(all);
      await writeJobsLocked((jobs) =>
        ARPCheckpoint.mergeIntoSnapshot(jobs, records) > 0 ? undefined : false);
    });
  } catch (e) {
    console.warn('Job checkpoint failed; retrying', e);
    armCheckpoint();
  }
}

async function removeJobFromStorage(tabId) {
  await jobsStoreMutex(async () => {
    let remaining = 0;
    await writeJobsLocked((jobs) => { delete jobs[tabId]; remaining = Object.keys(jobs).length; });
    await removeSessionRecord(tabId);
    if (remaining === 0) {
      // Nothing left to checkpoint.
      checkpointArmed = false;
      chrome.alarms.clear(ARPCheckpoint.CHECKPOINT_ALARM);
    }
  });
}

// ── Rehydrate after a service-worker restart ────────────────────────────────
// MV3 terminates idle workers, wiping the in-memory activeJobs map while each
// per-job alarm persists. These rebuild a job's runtime state from what
// saveJobToStorage persisted, so the refresh loop (and the UI) survive a restart
// rather than dying silently the first time the worker idles out.
// Single-flight per tab: rehydrateJob awaits twice (storage.get, tabs.get)
// before assigning activeJobs[tabId], so two concurrent callers (an alarm's
// fireRefresh racing the popup's GET_STATUS → rehydrateAll) would each build
// their own job object — the last assignment wins while the first caller keeps
// mutating a detached object, and its baseline/count updates are then persisted
// from the other (stale) one → duplicate alerts, lost stopAfter counting.
const rehydrateInflight = {};
function rehydrateJob(tabId, prefetched) {
  if (activeJobs[tabId]) return Promise.resolve(activeJobs[tabId]);
  if (rehydrateInflight[tabId]) return rehydrateInflight[tabId];
  const p = doRehydrateJob(tabId, prefetched)
    .finally(() => { delete rehydrateInflight[tabId]; });
  rehydrateInflight[tabId] = p;
  return p;
}

async function doRehydrateJob(tabId, prefetched) {
  let stored = prefetched;
  if (stored === undefined) {
    const data = await chrome.storage.local.get('activeJobs');
    stored = (data.activeJobs || {})[tabId];
  }
  // Routine progress since the last checkpoint lives in the job's session
  // record; prefer it when newer (it's absent after a browser restart).
  let session;
  try {
    const key = ARPCheckpoint.sessionKey(tabId);
    if (key) session = (await chrome.storage.session.get(key))[key];
  } catch (e) {}
  stored = ARPCheckpoint.pickRecord(stored, session);
  if (!stored) return null;

  // The tab may have been closed while the worker slept (onRemoved never fired
  // to clean up). If it's gone, drop the orphan + its alarm and don't reschedule.
  let startUrl = stored.startUrl || null; // prefer the persisted original baseline
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!startUrl) startUrl = tab.url || null; // legacy entries without a stored URL
  } catch (e) {
    await removeJobFromStorage(tabId);
    chrome.alarms.clear(`refresh_${tabId}`);
    return null;
  }

  // A START_REFRESH can land during the awaits above and build a fresh job —
  // that one is newer (new baseline, count reset); don't clobber it.
  if (activeJobs[tabId]) return activeJobs[tabId];

  activeJobs[tabId] = ARPRehydrate.buildRehydratedJob(stored, tabId, {
    startUrl,
    matcher: buildMatcher(stored.settings),
    now: Date.now(),
    fallbackInterval: computeInterval(stored.settings),
  });
  // Restart the live-watch chain: it's a plain setTimeout chain, so it died
  // with the worker; the alarm/message that triggered this rehydrate is what
  // brings it back.
  scheduleDomScan(tabId);
  return activeJobs[tabId];
}

// Refill every persisted job not currently in memory. Safe to call repeatedly:
// jobs already in memory are skipped, so a live alarm is never disturbed.
//
// The onMessage handler calls this on every inbound message (a restarted worker
// has an empty map), but while the worker is warm the in-memory activeJobs map
// is already authoritative — the only writer of the activeJobs storage key is
// this worker (writeJobsLocked), which mirrors every mutation in memory. So once
// we've read storage once, re-reading on every message (the popup polls, every
// content script syncs) is pure cost. Gate the read on a freshness flag: a fresh
// worker starts with it false (so the first message rehydrates), and any write
// to activeJobs — including an out-of-band import via manage.js — trips the
// storage.onChanged listener below to re-arm a single re-read.
let jobsStoreFresh = false;
let unackedLoaded = false; // load the persisted unacked count once per worker life
async function rehydrateAll() {
  if (!unackedLoaded) { unackedLoaded = true; await loadUnacked(); } // restore badge after restart
  if (jobsStoreFresh) return;
  jobsStoreFresh = true; // set BEFORE the await: a write during the get flips it back, forcing a re-read
  const data = await chrome.storage.local.get('activeJobs');
  const stored = data.activeJobs || {};
  for (const tabIdStr of Object.keys(stored)) {
    const tabId = parseInt(tabIdStr);
    if (!activeJobs[tabId]) await rehydrateJob(tabId, stored[tabIdStr]);
  }
  refreshBadge(); // active-job count may have changed after a restart-time refill
}

// Re-arm a single rehydrateAll read whenever the persisted job map changes —
// covers this worker's own writes (harmless: next message re-reads once) and an
// out-of-band import (manage.js writes activeJobs straight to storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activeJobs) {
    // Our own writes (writeJobsLocked mirrors every mutation in memory first)
    // don't invalidate freshness — only an out-of-band write does.
    if (selfJobsWrites > 0) selfJobsWrites--;
    else jobsStoreFresh = false;
  }
  // Keep the URL-rules cache (used by the tab-complete listener below) current
  // without re-reading storage per navigation.
  if (changes.urlRules) {
    urlRulesCache = Array.isArray(changes.urlRules.newValue) ? changes.urlRules.newValue : [];
  }
  // Keep the badge in sync with the persisted unacked counter — covers this
  // worker's own writes (idempotent) AND an out-of-band clear from the Manage
  // page's "Clear" button, which writes unackedAlerts straight to storage (#1/#3).
  if (changes.unackedAlerts) {
    unackedMirror = Number(changes.unackedAlerts.newValue) || 0;
    refreshBadge();
  }
});

// ── Startup: restore jobs ──────────────────────────────────────────────────
// onStartup = browser launch: restore persisted jobs AND open auto-start URLs.
// onInstalled also fires on every extension update/reload mid-session — restore
// jobs there too (the update wiped the worker's memory and its alarms), but
// NEVER auto-start: the user's auto-start tabs are already open, and opening
// them again on each update would duplicate tabs and jobs.
chrome.runtime.onStartup.addListener(() => restoreJobs({ autoStart: true }));
chrome.runtime.onInstalled.addListener(() => {
  // activeJobUrls was the declarative content script's page-load gate; the
  // script is now injected only into job pages, so the index is dead weight.
  chrome.storage.local.remove('activeJobUrls').catch(() => {});
  return restoreJobs({ autoStart: false });
});

async function restoreJobs(opts) {
  const autoStart = !!(opts && opts.autoStart);
  const data = await chrome.storage.local.get(['activeJobs', 'autoStartUrls', 'domainDenylist']);
  const jobs = data.activeJobs || {};
  const denylist = Array.isArray(data.domainDenylist) ? data.domainDenylist : [];
  await loadUnacked(); // restore the unacked badge count on browser launch / update
  unackedLoaded = true;

  for (const [tabIdStr, stored] of Object.entries(jobs)) {
    const tabId = parseInt(tabIdStr);
    if (activeJobs[tabId]) continue; // already live (e.g. mid-session update race)

    // Tab ids are session-scoped: after a browser restart this id may belong to
    // a completely unrelated tab (they're small sequential integers). Blindly
    // re-attaching would auto-reload — and for monitor jobs, read the text of —
    // whatever page now holds the id, e.g. the user's banking tab. Re-attach
    // only when the tab's URL still matches the job's persisted startUrl
    // (origin + pathname, same comparison as the navigate-away stop); drop the
    // entry otherwise, including legacy entries with no startUrl to verify.
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      tab = null; // tab gone
    }
    const url = tab ? (tab.url || tab.pendingUrl || '') : '';
    if (!tab || !stored.startUrl || ARPRehydrate.isNavigateAway(stored.startUrl, url)) {
      await removeJobFromStorage(tabId);
      chrome.alarms.clear(`refresh_${tabId}`);
      continue;
    }
    // Denylist may have been added since the job was persisted — don't re-attach
    // to a now-blocked origin (#7).
    if (ARPValidators.isUrlDenied(url, denylist)) {
      await removeJobFromStorage(tabId);
      chrome.alarms.clear(`refresh_${tabId}`);
      continue;
    }

    // Same restore semantics as a mid-session worker restart: rehydrateJob
    // preserves refreshCount/nextRefresh so "stop after N" resumes faithfully
    // instead of resetting to 0 (which startRefresh would do). The persisted
    // deadline is usually in the past after a browser relaunch; the small floor
    // spreads the overdue refreshes out instead of firing them all at once.
    const job = await rehydrateJob(tabId, stored);
    if (job) {
      scheduleNext(tabId, Math.max(1000, job.nextRefresh - Date.now()));
      // A job restored in a paused state must not get an un-pausing
      // COUNTDOWN_START. For an away pause this would stick forever: the
      // fireRefresh gate only re-signals PAUSED on a reason EDGE, and the
      // rehydrated reason is already 'away'.
      const restoredPaused = job._manualPause ? 'manual' : (job._pauseReason || null);
      if (restoredPaused) sendOverlayPaused(tabId, restoredPaused);
      else sendCountdownStart(tabId, 0);
    }
  }
  broadcastStatus();
  refreshBadge();

  if (!autoStart) return;

  // Auto-start URLs. Only open entries whose URL is a safe http(s) navigation —
  // a poisoned storage value (e.g. an imported javascript:/file: URL) must never
  // be auto-opened on browser startup — and never one on the denylist (#7).
  const autoStartUrls = /** @type {any[]} */ (data.autoStartUrls || []);
  for (const item of autoStartUrls) {
    if (item.url && ARPValidators.isSafeNavigableUrl(item.url) && !ARPValidators.isUrlDenied(item.url, denylist)) {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      if (item.autoRefresh && item.refreshSettings) {
        await startRefresh(tab.id, item.refreshSettings);
      }
    }
  }
}

// ── Tab removal cleanup ────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeJobs[tabId]) { await stopRefresh(tabId); return; }
  // The worker may have restarted with an empty map. Clean any persisted orphan
  // (and its backstop alarm) so a closed tab's job can't be rehydrated later.
  const data = await chrome.storage.local.get('activeJobs');
  if (data.activeJobs && data.activeJobs[tabId]) {
    await removeJobFromStorage(tabId);
    chrome.alarms.clear(`refresh_${tabId}`);
  }
});
