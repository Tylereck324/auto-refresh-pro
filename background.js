// background.js - Service Worker for Auto Refresh Pro

// Shared input-validation / sanitization helpers (URL, image, import, sender).
// Must load first so every handler below can use ARPValidators.
importScripts('validators.js');
// Pure refresh-interval computation (ARPInterval.computeInterval).
importScripts('interval.js');
// Pure keyword-matching logic (ARPKeyword.compileMatcher).
importScripts('keyword-match.js');
// Pure text-normalization for noise-tolerant change detection (ARPNormalize).
importScripts('normalize.js');
// Pure notification-id encode/decode (ARPNotif) for click-to-focus-tab.
importScripts('notif-id.js');
// Pure post-restart job-rebuild + navigate-away helpers (ARPRehydrate).
importScripts('rehydrate.js');
// Async mutex (ARPSerialize.createMutex) used to serialize storage.activeJobs
// read-modify-write so concurrent saves/removes can't drop a tab's entry.
importScripts('serialize.js');

// In-memory store for active refresh jobs
// Structure: { tabId: { interval, nextRefresh, countdown, settings, alarmName } }
const activeJobs = {};

// chrome.alarms clamps any delay below this to the floor in packed builds, so a
// true sub-30s refresh can't be driven by alarms. Intervals below it use a
// self-rescheduling setTimeout loop instead (see scheduleNext).
const ALARM_MIN_MS = 30000;

// Schedule a job's next refresh with the right mechanism for its interval:
//  • >= ALARM_MIN_MS → chrome.alarms (survives worker termination cleanly).
//  • <  ALARM_MIN_MS → a self-rescheduling setTimeout. Alarms would clamp these
//    to ~30s; the frequent chrome.tabs.reload activity (an API call every <30s)
//    keeps the worker alive between ticks. A backstop alarm at the floor still
//    resumes the loop if the worker is killed anyway (sleep/suspend) — fireRefresh
//    re-establishes the fast loop on the next wake.
function scheduleNext(tabId, delayMs) {
  const job = activeJobs[tabId];
  if (!job) return;
  clearTimerLoop(job);
  if (delayMs >= ALARM_MIN_MS) {
    chrome.alarms.create(job.alarmName, { delayInMinutes: delayMs / 60000 });
  } else {
    job._timer = setTimeout(() => fireRefresh(tabId), delayMs);
    // Backstop only — continually pushed forward, so it fires only if the loop dies.
    chrome.alarms.create(job.alarmName, { delayInMinutes: ALARM_MIN_MS / 60000 });
  }
}

function clearTimerLoop(job) {
  if (job && job._timer) { clearTimeout(job._timer); job._timer = null; }
}

// ── Offscreen audio ────────────────────────────────────────────────────────
// Service workers can't play audio directly. We use an offscreen document
// (Chrome 116+) which has full audio access and no gesture-policy restrictions.

// Serializes offscreen-document creation. hasDocument()→createDocument() isn't
// atomic, so two near-simultaneous alerts could both see "no document" and the
// second createDocument would throw ("only a single offscreen document"),
// dropping that beep. A shared in-flight promise collapses concurrent callers
// onto one creation.
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument().catch(() => false)) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play keyword-detected alert beep'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function playBeep(opts = {}) {
  const { volume = 0.9, tone = 'beep', repeat = 1 } = opts;
  try {
    await ensureOffscreen();
    return await deliverBeep({ volume, tone, repeat });
  } catch (e) {
    console.warn('Offscreen audio failed:', e);
    return false;
  }
}

// Pull the sound parameters off a job's settings into the shape playBeep wants.
function soundOpts(settings) {
  return {
    volume: settings.soundVolume,
    tone: settings.soundTone,
    repeat: settings.soundRepeat,
  };
}

// Compile a keyword matcher from a job's settings, injecting the regex-safety
// guard so a poisoned/unsafe stored regex is refused (matcher.ok === false) and
// the keyword path is skipped rather than running a dangerous pattern.
function buildMatcher(settings) {
  return ARPKeyword.compileMatcher(settings, { isSafeRegex: ARPValidators.isSafeRegex });
}

// ── Actionable notifications ────────────────────────────────────────────────
// Clicking a keyword/change notification focuses the originating tab. The tab id
// is both kept in this warm-path map and encoded in the notification id (so a
// click still works after a service-worker restart wipes the map).
const notifTabMap = {};
// Entries are normally cleared on click/close (onClicked/onClosed). This caps the
// map in case a notification is dismissed without firing onClosed, so it can't
// grow unbounded over a long session. The tab id is still recoverable from the
// notification id itself (ARPNotif.parseNotifTabId), so eviction only loses the
// warm-path lookup, not correctness.
const MAX_NOTIF_ENTRIES = 100;

// Minimum gap between per-refresh notifications, so a fast interval can't spam.
const REFRESH_NOTIFY_MIN_GAP_MS = 30000;

function notify(prefix, tabId, options) {
  const id = ARPNotif.buildNotifId(prefix, tabId, Date.now());
  notifTabMap[id] = { tabId };
  // Evict oldest (insertion-ordered keys) once over the cap.
  const ids = Object.keys(notifTabMap);
  if (ids.length > MAX_NOTIF_ENTRIES) delete notifTabMap[ids[0]];
  chrome.notifications.create(id, options);
  return id;
}

async function handleNotifClick(id) {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  delete notifTabMap[id];
  chrome.notifications.clear(id);
  if (tabId == null) return;
  // A click is an acknowledgement — stop any repeat-until-ack beeping.
  clearAckBeeps(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) { /* tab gone */ }
}

chrome.notifications.onClicked.addListener(handleNotifClick);

chrome.notifications.onClosed.addListener((id) => {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  delete notifTabMap[id];
  if (tabId != null) clearAckBeeps(tabId);
});

// Repeat the alert beep on an interval until the user acknowledges (clicks/closes
// the notification) or a bounded cap is reached. Strictly bounded and cleared on
// every job-stop path so it can never run away.
function startAckBeeps(tabId) {
  const job = activeJobs[tabId];
  if (!job || !job.settings.sound || !job.settings.beepUntilAck) return;
  clearAckBeeps(tabId);
  // Cap the tick below the MV3 idle-shutdown window: each tick does a sendMessage
  // (playBeep), which keeps the worker alive only while ticks land < ~30s apart.
  // Keeping the gap under ALARM_MIN_MS makes the bounded nag self-sustaining so it
  // isn't cut short by worker termination between beeps.
  const intervalMs = Math.min(
    ALARM_MIN_MS - 5000,
    Math.max(2000, (parseFloat(job.settings.beepAckIntervalSec) || 5) * 1000)
  );
  const maxRepeats = Math.min(10, Math.max(1, parseInt(job.settings.beepRepeatMax) || 5));
  let count = 0;
  const tick = () => {
    const j = activeJobs[tabId];
    if (!j || count >= maxRepeats) { clearAckBeeps(tabId); return; }
    count++;
    playBeep(soundOpts(j.settings));
    j._ackTimer = setTimeout(tick, intervalMs);
  };
  job._ackTimer = setTimeout(tick, intervalMs);
}

function clearAckBeeps(tabId) {
  const job = activeJobs[tabId];
  if (job && job._ackTimer) { clearTimeout(job._ackTimer); job._ackTimer = null; }
}

// createDocument() resolves once the offscreen page has loaded, but offscreen.js
// may not have registered its onMessage listener yet — a PLAY_BEEP sent in that
// window is dropped ("receiving end does not exist") and was previously swallowed
// silently, losing the beep. This bit hardest once beeps became sparse (keyword
// edge only), since the document is torn down between rare beeps and every beep
// then races a fresh creation. Retry until the offscreen side ACKs. The ACK is
// synchronous, so a delivered message resolves on the first try and is never
// replayed — no double beep.
function deliverBeep(opts = {}, attempt = 0) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'PLAY_BEEP', volume: opts.volume, tone: opts.tone, repeat: opts.repeat }, () => {
      if (chrome.runtime.lastError) {
        // No live listener yet (or no receiver responded). Back off briefly and
        // retry, capped so we never spin forever if the document failed to load.
        if (attempt < 20) {
          setTimeout(() => deliverBeep(opts, attempt + 1).then(resolve), 25);
        } else {
          console.warn('Offscreen audio never acknowledged the beep');
          resolve(false);
        }
      } else {
        resolve(true); // offscreen acknowledged — the beep was delivered
      }
    });
  });
}

// ── Alarm handler ──────────────────────────────────────────────────────────
// Alarms drive long intervals directly and act as the wake-up backstop for the
// short-interval setTimeout loop. Either way the work is the same: fireRefresh.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('refresh_')) return;
  fireRefresh(parseInt(alarm.name.replace('refresh_', '')));
});

// Run one refresh cycle for a job and schedule the next. Invoked by the alarm
// (long intervals + backstop) and by the setTimeout loop (short intervals).
async function fireRefresh(tabId) {
  // The worker may have been terminated since this was scheduled, wiping
  // activeJobs. Rebuild from storage before giving up — otherwise the loop dies.
  const job = activeJobs[tabId] || await rehydrateJob(tabId);
  if (!job) return; // genuinely stopped, or the tab was closed while we slept

  // Backstop dedup: if a setTimeout tick already refreshed within this interval,
  // a coincident backstop-alarm fire must not double-refresh. Re-arm and bail.
  const now = Date.now();
  const curInterval = job.settings.currentInterval || computeInterval(job.settings);
  if (job._lastRefresh && (now - job._lastRefresh) < curInterval * 0.5) {
    scheduleNext(tabId, Math.max(0, job.nextRefresh - now));
    return;
  }
  job._lastRefresh = now;
  job.refreshCount = (job.refreshCount || 0) + 1;

  // Compute next interval (random or fixed)
  const nextInterval = computeInterval(job.settings);
  job.settings.currentInterval = nextInterval;

  try {
    // Run keyword/monitor check if: keyword is set, OR monitor-change mode is on
    const hasKeyword = job.settings.keyword && job.settings.keyword.trim().length > 0;
    const hasMonitor = job.settings.monitorMode;
    if (hasKeyword || hasMonitor) {
      await doMonitorRefresh(tabId, job);
    } else {
      await doRefresh(tabId, job);
    }
  } catch (e) {
    console.warn('Refresh error on tab', tabId, e);
  }

  // Stop after X refreshes — checked AFTER the refresh so "stop after 1"
  // actually performs 1 refresh before stopping.
  if (job.settings.stopAfter > 0 && job.refreshCount >= job.settings.stopAfter) {
    await stopRefresh(tabId);
    return;
  }

  // Reschedule (alarm or setTimeout, per interval)
  if (activeJobs[tabId]) {
    activeJobs[tabId].nextRefresh = Date.now() + nextInterval;
    await saveJobToStorage(tabId, activeJobs[tabId].settings); // persist count + deadline
    scheduleNext(tabId, nextInterval);
    // Push the new deadline to all extension pages (popup) immediately so its
    // countdown resets in lockstep instead of waiting up to a second for its poll.
    broadcastStatus();
  }

  // Notify content script of countdown start.
  // Small head-start delay: the page just reloaded so tab.status is 'loading'.
  // sendCountdownStart will poll tab.status and retry until it's 'complete'.
  // It reads the job's absolute nextRefresh, so even a late delivery is correct.
  setTimeout(() => sendCountdownStart(tabId, 0), 300);
}

async function doRefresh(tabId, job) {
  if (job.settings.hardRefresh) {
    // Hard refresh: bypass cache
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } else {
    await chrome.tabs.reload(tabId);
  }

  // Notification (clickable → focuses this tab). Throttled: at a short interval
  // a per-refresh notification would spam (e.g. 12/min at 5s). Post at most once
  // per REFRESH_NOTIFY_MIN_GAP_MS; the message still shows the cumulative count.
  if (job.settings.notify) {
    const now = Date.now();
    if (!job._lastRefreshNotify || (now - job._lastRefreshNotify) >= REFRESH_NOTIFY_MIN_GAP_MS) {
      job._lastRefreshNotify = now;
      notify('refresh', tabId, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Auto Refresh Pro',
        message: `Page refreshed (${job.refreshCount} times)`
      });
    }
  }
  // NOTE: Sound is intentionally NOT played here.
  // Sound only fires when a keyword is detected or a page change is found.
}

// Injected into the page to read its visible text for change/keyword detection.
// Excludes Auto Refresh Pro's own countdown overlay (#__ar_overlay) — its live
// timer ticks every second and would otherwise be read as a "page change".
// The overlay is detached only for the synchronous innerText read, then restored
// in the same call, so there is no visible flicker.
function readPageText() {
  if (!document.body) return '';
  const ov = document.getElementById('__ar_overlay');
  let parent = null, next = null;
  if (ov) { parent = ov.parentNode; next = ov.nextSibling; ov.remove(); }
  const text = document.body.innerText || '';
  if (ov && parent) parent.insertBefore(ov, next);
  return text;
}

async function doMonitorRefresh(tabId, job) {
  // Step 1: Read current page content BEFORE reloading.
  // Sound must also fire BEFORE reload — the content script is destroyed during navigation.
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageText
    });
  } catch (e) {
    await doRefresh(tabId, job);
    return;
  }

  const currentContent = (results && results[0] && results[0].result) || '';
  const prevContent = job.previousContent; // null/undefined = no baseline yet

  // A keyword takes precedence over generic change-monitoring. When one is set,
  // the keyword is the signal of interest, so we skip the page-change path
  // entirely below — otherwise every dynamic page (timestamps, ads, counters)
  // would beep on essentially every reload regardless of the keyword.
  // The matcher (multi-keyword / whole-word / case / regex) is compiled once at
  // job start and cached on job._matcher; recompile lazily if it's missing.
  const matcher = job._matcher || (job._matcher = buildMatcher(job.settings));
  const hasKeyword = matcher.ok && !matcher.empty;

  // ── Keyword detection ──
  // Alert on a transition between cycles: absent→present normally, or
  // present→absent in inverse mode ("alert when the keyword disappears").
  if (hasKeyword) {
    const foundNow    = matcher.test(currentContent);
    const hasBaseline = prevContent !== null && prevContent !== undefined;
    const foundPrev   = hasBaseline && matcher.test(prevContent);
    const fired = job.settings.kwInverse ? (!foundNow && foundPrev) : (foundNow && !foundPrev);

    if (fired && hasBaseline) {
      if (job.settings.sound) await playBeep(soundOpts(job.settings));
      const verb = job.settings.kwInverse ? 'disappeared from' : 'found on';
      notify('kw', tabId, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Keyword Detected!',
        message: '"' + job.settings.keyword + '" ' + verb + ' page!'
      });
      if (job.settings.stopOnKeyword) {
        await stopRefresh(tabId);
        return;
      }
      startAckBeeps(tabId); // repeat beep until acknowledged (if enabled)
    }
  }

  // ── Page change detection ──
  // Only alert when we have a real baseline and content actually changed.
  // Skipped entirely when a keyword is set — the keyword owns the signal so the
  // generic change beep/notification doesn't drown it out (see hasKeyword above).
  if (!hasKeyword && job.settings.monitorMode && prevContent !== null && prevContent !== undefined) {
    // Strict raw comparison by default (exact legacy behavior). When noise
    // tolerance is on, normalize (collapse whitespace/digits) and require the
    // configured minimum changed-fraction so clocks/counters/ads don't alert.
    const changed = job.settings.noiseTolerant
      ? ARPNormalize.isMeaningfulChange(prevContent, currentContent, {
          collapseDigits: job.settings.collapseDigits !== false,
          minChangedFraction: job.settings.minChangedFraction,
        })
      : (currentContent !== prevContent);
    if (changed) {
      if (job.settings.sound) await playBeep(soundOpts(job.settings));
      notify('chg', tabId, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Page Changed!',
        message: 'A change was detected on the monitored page.'
      });
      if (job.settings.stopOnChange) {
        await stopRefresh(tabId);
        return;
      }
      startAckBeeps(tabId); // repeat beep until acknowledged (if enabled)
    }
  }

  // Save snapshot then reload
  job.previousContent = currentContent;
  await doRefresh(tabId, job);
}

// Refresh-interval computation lives in interval.js (ARPInterval.computeInterval)
// so it is unit-testable and the fixed path is NaN-hardened. Thin local alias
// keeps the call sites below unchanged.
const computeInterval = ARPInterval.computeInterval;

// ── Start refresh ──────────────────────────────────────────────────────────
async function startRefresh(tabId, settings) {
  // Stop any existing job
  if (activeJobs[tabId]) {
    await stopRefresh(tabId);
  }

  const interval = computeInterval(settings);
  settings.currentInterval = interval;

  // Snapshot the current URL and page content at start time.
  // URL: so we can stop if the user navigates away.
  // Content: so cycle 1 has a baseline — prevents false-positive keyword/change
  //          alerts on content that was already present before refresh started.
  let startUrl = null;
  let initialContent = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    startUrl = tab.url || null;
  } catch (e) {}

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageText
    });
    const raw = results && results[0] && results[0].result;
    // Only use as baseline if we got real content (non-empty).
    // If empty/null, leave previousContent as null — the keyword check
    // will skip alerting on cycle 1 and wait for cycle 2 when the page
    // has had a chance to fully render.
    initialContent = (raw && raw.length > 0) ? raw : null;
  } catch (e) {
    initialContent = null; // not scriptable — skip alert on first cycle
  }

  activeJobs[tabId] = {
    settings,
    refreshCount: 0,
    nextRefresh: Date.now() + interval,
    alarmName: `refresh_${tabId}`,
    startUrl,
    previousContent: initialContent,  // null = no baseline yet, skip first cycle
    _matcher: buildMatcher(settings), // compiled once; reused every cycle
    _lastRefresh: 0,                  // no refresh has fired yet
    _timer: null,                     // short-interval setTimeout handle
  };

  scheduleNext(tabId, interval);

  // Notify content script — retry until it responds, since the content script
  // may not be injected yet (tab still loading) when Start is pressed.
  sendCountdownStart(tabId, 0);

  // Persist to storage
  await saveJobToStorage(tabId, settings);
  broadcastStatus();
}

async function sendCountdownStart(tabId, attempt) {
  if (!activeJobs[tabId]) return;

  // Wait until the tab has finished loading before trying to message the content script.
  // This handles the post-reload case where the alarm fires but the new page isn't ready.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') {
      // Page still loading — wait and retry
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendCountdownStart(tabId, attempt + 1), delay);
      }
      return;
    }
  } catch (e) {
    return; // Tab gone
  }

  // Tab is complete — send the message. Include stopOnClick so the content
  // script knows immediately (the GET_STATUS sync only happens after a reload).
  // Re-read the job here: it may have been stopped during the await above.
  const job = activeJobs[tabId];
  if (!job) return;
  const stopOnClick = !!(job.settings && job.settings.stopOnClick);
  const showCountdown = !(job.settings && job.settings.showCountdown === false);
  const preserveScroll = !!(job.settings && job.settings.preserveScroll);
  // Carry the absolute deadline + the cycle's total so the overlay renders
  // remaining = nextRefresh - Date.now(), matching the popup exactly. Absolute
  // timestamps are comparable across the service worker and page (same clock),
  // and make a late/retried delivery self-correcting rather than reading high.
  const nextRefresh = job.nextRefresh;
  const total = (job.settings && job.settings.currentInterval) || job.settings.interval;
  chrome.tabs.sendMessage(tabId, { type: 'COUNTDOWN_START', nextRefresh, total, stopOnClick, showCountdown, preserveScroll }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // No live content script (page was loaded before the extension was
      // installed/reloaded). Inject it programmatically so the overlay shows
      // immediately instead of waiting for the first refresh to re-inject it.
      // content.js is idempotent (guards via window.__autoRefreshInjected), so
      // injecting once here is safe even if a declarative injection races in.
      if (attempt === 0) {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
          .catch(() => {}); // not scriptable (chrome://, web store, etc.)
      }
      // Retry — the injected script's own GET_STATUS sync will also show the
      // overlay, and the resend lands once its onMessage listener is registered.
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendCountdownStart(tabId, attempt + 1), delay);
      }
    }
  });
}

async function stopRefresh(tabId) {
  if (activeJobs[tabId]) {
    clearAckBeeps(tabId); // stop any repeat-until-ack loop before dropping the job
    clearTimerLoop(activeJobs[tabId]); // stop the short-interval setTimeout loop
    delete activeJobs[tabId];
  }
  // Always clear the alarm, even if memory was wiped by a restart — a stray
  // alarm would otherwise rehydrate a job the user just stopped.
  chrome.alarms.clear(`refresh_${tabId}`);
  chrome.tabs.sendMessage(tabId, { type: 'STOPPED' }).catch(() => {});
  await removeJobFromStorage(tabId);
  broadcastStatus();
}

// ── Storage helpers ────────────────────────────────────────────────────────
// Every activeJobs read-modify-write goes through this single mutex. Without it,
// two concurrent saves (e.g. two tabs refreshing at once) interleave get→set and
// the second write clobbers the first tab's entry — silently un-persisting a live
// job so it's lost on the next worker restart. withJobsStore re-reads inside the
// lock, so each mutation sees the previous one's result.
const jobsStoreMutex = ARPSerialize.createMutex();
function withJobsStore(mutate) {
  return jobsStoreMutex(async () => {
    const data = await chrome.storage.local.get('activeJobs');
    const jobs = data.activeJobs || {};
    await mutate(jobs);
    await chrome.storage.local.set({ activeJobs: jobs });
  });
}

async function saveJobToStorage(tabId, settings) {
  await withJobsStore((jobs) => {
    const job = activeJobs[tabId];
    jobs[tabId] = {
      settings,
      refreshCount: (job && job.refreshCount) || 0,
      nextRefresh: (job && job.nextRefresh) || (Date.now() + computeInterval(settings)),
      startUrl: (job && job.startUrl) || null, // navigate-away baseline across restarts
      savedAt: Date.now(),
    };
  });
}

async function removeJobFromStorage(tabId) {
  await withJobsStore((jobs) => { delete jobs[tabId]; });
}

// ── Rehydrate after a service-worker restart ────────────────────────────────
// MV3 terminates idle workers, wiping the in-memory activeJobs map while each
// per-job alarm persists. These rebuild a job's runtime state from what
// saveJobToStorage persisted, so the refresh loop (and the UI) survive a restart
// rather than dying silently the first time the worker idles out.
async function rehydrateJob(tabId, prefetched) {
  let stored = prefetched;
  if (stored === undefined) {
    const data = await chrome.storage.local.get('activeJobs');
    stored = (data.activeJobs || {})[tabId];
  }
  if (!stored || !stored.settings) return null;

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

  activeJobs[tabId] = ARPRehydrate.buildRehydratedJob(stored, tabId, {
    startUrl,
    matcher: buildMatcher(stored.settings),
    now: Date.now(),
    fallbackInterval: computeInterval(stored.settings),
  });
  return activeJobs[tabId];
}

// Refill every persisted job not currently in memory. Safe to call repeatedly:
// jobs already in memory are skipped, so a live alarm is never disturbed.
async function rehydrateAll() {
  const data = await chrome.storage.local.get('activeJobs');
  const stored = data.activeJobs || {};
  for (const tabIdStr of Object.keys(stored)) {
    const tabId = parseInt(tabIdStr);
    if (!activeJobs[tabId]) await rehydrateJob(tabId, stored[tabIdStr]);
  }
}

// ── Startup: restore jobs ──────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(restoreJobs);
chrome.runtime.onInstalled.addListener(restoreJobs);

async function restoreJobs() {
  const data = await chrome.storage.local.get(['activeJobs', 'autoStartUrls']);
  const jobs = data.activeJobs || {};

  for (const [tabIdStr, job] of Object.entries(jobs)) {
    const tabId = parseInt(tabIdStr);
    try {
      await chrome.tabs.get(tabId);
      // Tab still exists, restart job
      await startRefresh(tabId, job.settings);
    } catch (e) {
      // Tab gone, remove from storage
      delete jobs[tabIdStr];
    }
  }

  // Auto-start URLs. Only open entries whose URL is a safe http(s) navigation —
  // a poisoned storage value (e.g. an imported javascript:/file: URL) must never
  // be auto-opened on browser startup.
  const autoStartUrls = data.autoStartUrls || [];
  for (const item of autoStartUrls) {
    if (item.url && ARPValidators.isSafeNavigableUrl(item.url)) {
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

// ── Stop refresh if user navigates away from the original URL ──────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return; // only care about URL changes
  // Rehydrate if the worker restarted, so a navigate-away is still caught and the
  // comparison uses the persisted original URL — not the post-restart one.
  const job = activeJobs[tabId] || await rehydrateJob(tabId);
  if (!job || !job.startUrl) return;
  if (ARPRehydrate.isNavigateAway(job.startUrl, changeInfo.url)) {
    await stopRefresh(tabId);
  }
});

// ── Per-domain URL rules: auto-start a job when a tab finishes loading a URL
// that matches an enabled rule. Sequences cleanly with the navigate-away stop
// above (which fires earlier, on changeInfo.url) and with autoStartUrls (the
// activeJobs guard prevents double-starting). ──────────────────────────────
const startingTabs = new Set(); // in-flight guard against duplicate 'complete' events
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.url) return;
  if (activeJobs[tabId] || startingTabs.has(tabId)) return; // don't stomp an existing/in-flight job
  if (!ARPValidators.isSafeNavigableUrl(tab.url)) return;

  // One read for both keys (this handler already paid a storage.get for rules).
  const data = await chrome.storage.local.get(['urlRules', 'activeJobs']);
  // Don't stomp a job persisted before a worker restart — restore it instead.
  const storedJob = (data.activeJobs || {})[tabId];
  if (storedJob && await rehydrateJob(tabId, storedJob)) return;

  const rules = Array.isArray(data.urlRules) ? data.urlRules : [];
  if (rules.length === 0) return;

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const m = ARPValidators.compileUrlGlob(rule.pattern);
    if (m.ok && m.test(tab.url)) {
      // Re-sanitize at apply time — storage could be poisoned outside import.
      startingTabs.add(tabId);
      try {
        if (!activeJobs[tabId]) await startRefresh(tabId, ARPValidators.sanitizeRuleSettings(rule.settings));
      } finally {
        startingTabs.delete(tabId);
      }
      break;
    }
  }
});

// ── Broadcast status to all extension pages ────────────────────────────────
function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', jobs: serializeJobs() }).catch(() => {});
}

function serializeJobs() {
  const out = {};
  for (const [tabId, job] of Object.entries(activeJobs)) {
    out[tabId] = {
      settings: job.settings,
      refreshCount: job.refreshCount,
      nextRefresh: job.nextRefresh
    };
  }
  return out;
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Trust boundary: only honour messages from this extension's own surfaces
  // (popup/options/manage pages and our injected content scripts). All of those
  // carry sender.id === chrome.runtime.id; a web page or another extension does
  // not. Without externally_connectable, web pages can't reach us directly, but
  // this fails closed and guards against a compromised/another extension.
  if (!msg || !ARPValidators.isTrustedSender(sender)) {
    sendResponse && sendResponse({ ok: false, error: 'untrusted sender' });
    return false;
  }
  (async () => {
    await rehydrateAll(); // a restarted worker has an empty activeJobs; refill it
    switch (msg.type) {
      case 'START_REFRESH':
        await startRefresh(msg.tabId, msg.settings);
        sendResponse({ ok: true });
        break;
      case 'STOP_REFRESH': {
        const stopTabId = msg.tabId || (sender.tab && sender.tab.id);
        if (stopTabId) await stopRefresh(stopTabId);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        const resolvedTabId = msg.tabId || (sender.tab && sender.tab.id);
        sendResponse({
          jobs: serializeJobs(),
          job: resolvedTabId && activeJobs[resolvedTabId] ? {
            settings: activeJobs[resolvedTabId].settings,
            refreshCount: activeJobs[resolvedTabId].refreshCount,
            nextRefresh: activeJobs[resolvedTabId].nextRefresh
          } : null
        });
        break;
      }
      case 'STOP_ALL':
        for (const tabId of Object.keys(activeJobs)) {
          await stopRefresh(parseInt(tabId));
        }
        sendResponse({ ok: true });
        break;
      case 'UPDATE_INTERVAL': {
        // Restart the alarm with the new interval, preserving the existing job state
        // (refresh count, previousContent baseline, startUrl — just update the timing)
        const updateTabId = msg.tabId;
        const job = activeJobs[updateTabId];
        if (!job) { sendResponse({ ok: false }); break; }

        // Drop any running short-interval loop before rescheduling
        clearTimerLoop(job);

        // Merge new settings, keeping existing state
        const newInterval = computeInterval(msg.settings);
        msg.settings.currentInterval = newInterval;
        job.settings = { ...job.settings, ...msg.settings };
        job.nextRefresh = Date.now() + newInterval;
        job._matcher = buildMatcher(job.settings); // keyword/flags may have changed

        // Reschedule with the right mechanism for the new interval
        scheduleNext(updateTabId, newInterval);

        // Tell the content script to reset its countdown
        sendCountdownStart(updateTabId, 0);

        await saveJobToStorage(updateTabId, job.settings);
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case 'HOTKEY_TOGGLE': {
        // Triggered by the custom in-page keybinding
        const toggleTabId = sender.tab && sender.tab.id;
        if (!toggleTabId) { sendResponse({ ok: false }); break; }
        if (activeJobs[toggleTabId]) {
          await stopRefresh(toggleTabId);
        } else {
          // Compose the job the same way the popup does: per-launch state from
          // popupSettings (s), refresh-behavior preferences from globalSettings
          // (g). Keep the two in sync with popup.js gatherSettings().
          const data = await chrome.storage.local.get(['popupSettings', 'globalSettings']);
          const s = data.popupSettings || {};
          const g = data.globalSettings || {};
          const interval = s.selectedMs || (g.defaultInterval ? g.defaultInterval * 1000 : 30000);
          await startRefresh(toggleTabId, {
            interval, hardRefresh: !!g.hardRefresh,
            showCountdown: g.showCountdown !== false, notify: !!g.notify,
            sound: s.sound || false, monitorMode: s.monitor || false,
            noiseTolerant: s.noiseTolerant || false,
            collapseDigits: s.collapseDigits !== false,
            minChangedFraction: parseFloat(s.minChangedFraction) || 0,
            randomTimer: !!g.random,
            randomMin: (parseFloat(g.randomMin) || 5) * 1000,
            randomMax: (parseFloat(g.randomMax) || 60) * 1000,
            stopAfter: parseInt(g.stopAfter) || 0, keyword: s.keyword || '',
            kwCaseSensitive: s.kwCaseSensitive || false, kwWholeWord: s.kwWholeWord || false,
            kwRegex: s.kwRegex || false, kwInverse: s.kwInverse || false,
            stopOnKeyword: s.stopOnKeyword || false, stopOnChange: s.stopOnChange || false,
            stopOnClick: !!g.stopOnClick,
            preserveScroll: !!g.preserveScroll,
            soundVolume: typeof g.soundVolume === 'number' ? g.soundVolume : 0.9,
            soundTone: g.soundTone || 'beep',
            soundRepeat: parseInt(g.soundRepeat) || 1,
            beepUntilAck: s.beepUntilAck || false,
            beepAckIntervalSec: parseFloat(s.beepAckIntervalSec) || 5,
            beepRepeatMax: parseInt(s.beepRepeatMax) || 5,
            currentInterval: interval
          });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'GET_ALL_JOBS':
        sendResponse({ jobs: serializeJobs() });
        break;
    }
  })();
  return true; // Keep channel open for async
});
