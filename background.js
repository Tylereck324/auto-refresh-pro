// background.js - Service Worker for Auto Refresh Pro

// Shared input-validation / sanitization helpers (URL, image, import, sender).
// Must load first so every handler below can use ARPValidators.
importScripts('validators.js');
// Pure refresh-interval computation (ARPInterval.computeInterval).
importScripts('interval.js');
// Pure keyword-matching logic (ARPKeyword.compileMatcher).
importScripts('keyword-match.js');
// Pure per-item ("alert on each new match") detection helpers (ARPItemDetect).
importScripts('item-detect.js');
// Pure text-normalization for noise-tolerant change detection (ARPNormalize).
importScripts('normalize.js');
// Pure notification-id encode/decode (ARPNotif) for click-to-focus-tab.
importScripts('notif-id.js');
// Pure post-restart job-rebuild + navigate-away helpers (ARPRehydrate).
importScripts('rehydrate.js');
// Async mutex (ARPSerialize.createMutex) used to serialize storage.activeJobs
// read-modify-write so concurrent saves/removes can't drop a tab's entry.
importScripts('serialize.js');
// Canonical job-settings constructor (ARPCompose.composeJobSettings) shared with
// the popup, so hotkey- and popup-launched jobs compose identical settings.
importScripts('compose-settings.js');
// Pure keyword/change fire-decision logic (ARPMonitor) — the core "should an
// alert fire this cycle?" branch, extracted so it's unit-testable.
importScripts('monitor-decision.js');
// Pure refresh-loop timing guards (ARPGuards.isBackstopDuplicate / shouldNotifyRefresh).
importScripts('refresh-guards.js');
// Pure quiet-hours window logic (ARPQuietHours.isWithinQuietHours / quietAction).
importScripts('quiet-hours.js');
// Pure lifecycle cancellation tokens for asynchronous Start/Stop ordering.
importScripts('lifecycle-generation.js');
// Pure detection identity comparison for safe timing-only updates.
importScripts('detection-identity.js');
// Pure two-tier persistence helpers (ARPCheckpoint): per-job session records +
// one coalesced local checkpoint per window.
importScripts('runtime-checkpoint.js');
// Webhook POST with status inspection + 429/5xx retry (ARPWebhook.deliver).
importScripts('webhook-delivery.js');
// Pure Discord/Slack/JSON body builder (ARPWebhookFormat.buildBody).
importScripts('webhook-format.js');
// Pure dead-watch decision logic (ARPWatchHealth: sign-in / captcha / unreadable).
importScripts('watch-health.js');
// Pure rules for what syncs across the user's Chromes (ARPSettingsSync).
importScripts('settings-sync.js');

// In-memory store for active refresh jobs
// Structure: { tabId: { interval, nextRefresh, countdown, settings, alarmName } }
const activeJobs = {};
const lifecycleRegistry = ARPLifecycle.createRegistry();

// chrome.alarms clamps any delay below this to the floor in packed builds, so a
// true sub-30s refresh can't be driven by alarms. Intervals below it use a
// self-rescheduling setTimeout loop instead (see scheduleNext).
const ALARM_MIN_MS = 30000;

// How often a paused job (quiet-hours pause mode, offline, or navigated away)
// wakes to re-check whether it can resume. Capped so a fast interval doesn't
// spin while paused.
const PAUSE_RECHECK_MS = 5 * 60 * 1000;

// Cadence (ms) at which a paused job wakes to re-check whether it can resume.
//   • Upper cap: PAUSE_RECHECK_MS (60s when offline, which resumes a touch
//     quicker after the network returns) so resume isn't delayed indefinitely by
//     a very long configured interval.
//   • Lower FLOOR: ALARM_MIN_MS. This is the fix for the "fast interval doesn't
//     spin" intent above — without a floor, Math.min(curInterval, cap) makes a
//     5s job re-check every 5s, and a sub-ALARM_MIN_MS delay runs on a
//     setTimeout loop (scheduleNext) whose every tick resets the MV3 idle timer,
//     keeping the worker awake for a job that is deliberately dormant. Flooring
//     at ALARM_MIN_MS forces the recheck onto chrome.alarms, so the worker can
//     sleep between wakes. Resume promptness is unaffected: away/manual resume
//     via their own edges (onUpdated / RESUME_JOB), and 30s is ample for the
//     clock-driven quiet/offline resumes.
function pauseRecheckMs(baseInterval, offline) {
  const cap = offline ? 60000 : PAUSE_RECHECK_MS;
  const base = Number.isFinite(baseInterval) && baseInterval > 0 ? baseInterval : cap;
  return Math.max(ALARM_MIN_MS, Math.min(base, cap));
}

// Delay before the resume cycle after the tab returns to the watched page (#12).
// Long enough for the SPA shell to start rendering, short enough that an item
// which arrived while away alerts within moments of coming back.
const AWAY_RESUME_DELAY_MS = 2500;

// Best-effort offline signal. navigator.onLine is available in the service
// worker; `=== false` means the browser is definitely offline (true can be a
// false positive, so we only act on the definite case).
function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

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

// ── Alarm handler ──────────────────────────────────────────────────────────
// Alarms drive long intervals directly and act as the wake-up backstop for the
// short-interval setTimeout loop. Either way the work is the same: fireRefresh.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ARPCheckpoint.CHECKPOINT_ALARM) return flushCheckpoint();
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

  // Navigate-away backstop (#12): the tabs.onUpdated pause/resume listener can
  // miss a navigation (SPA history-API route changes don't always fire it), and
  // once missed nothing else re-checks — the loop would keep reloading whatever
  // page the tab is on now. Verify the tab is still on the job's original URL;
  // a moved tab PAUSES via the away gate below (silently stopping here is how a
  // dead watch once went unnoticed and studies were missed) and auto-resumes
  // when the tab returns.
  let away = false;
  if (job.startUrl) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      await stopRefresh(tabId); // tab gone and onRemoved never fired
      return;
    }
    away = ARPRehydrate.isNavigateAway(job.startUrl, tab.url || tab.pendingUrl || '');
  }

  // now + the cycle's current interval, used by both the pause gate and the
  // backstop-dedup check below.
  const now = Date.now();
  const curInterval = job.settings.currentInterval || computeInterval(job.settings);

  // ── Pause gates (#5 quiet-hours pause, #9 offline) ──
  // Skip the reload WITHOUT advancing the cycle — no refreshCount bump, no
  // baseline capture — and wake again soon to re-check. Quiet-hours PAUSE mode
  // mutes a job overnight; the offline gate avoids reloading into Chrome's "No
  // internet" page, whose NON-empty text would otherwise become the detection
  // baseline and fire a false "changed"/"keyword appeared" the moment the
  // network returns. NOTE: this catches hangs + offline, not soft 5xx/captcha
  // pages (tab.status only distinguishes loading/complete — no HTTP codes).
  const pauseReason =
    job._manualPause ? 'manual'
    : away ? 'away'
    : (ARPQuietHours.quietAction(new Date(), job.settings.quietHours) === 'pause') ? 'quiet'
    : (isOffline() ? 'offline' : null);
  if (pauseReason) {
    // Notify on the away EDGE only (not every recheck) — see notifyAwayPause.
    const prevReason = job._pauseReason;
    const awayEdge = pauseReason === 'away' && prevReason !== 'away';
    job._pauseReason = pauseReason;
    // Disarm the live-watch chain too — its ticks would otherwise keep the MV3
    // worker awake all night for a job that is deliberately dormant. Re-armed
    // on the resume edge below (and by RESUME_JOB for manual pauses).
    clearDomScan(job);
    const recheck = pauseRecheckMs(curInterval, pauseReason === 'offline');
    job.nextRefresh = now + recheck;
    scheduleNext(tabId, recheck);
    broadcastStatus();
    // Reflect the pause on the in-page overlay (edge only — a long overnight pause
    // must not message every recheck). Without this the overlay's countdown would
    // drain to 0:00 and freeze, since broadcastStatus reaches only extension pages.
    if (prevReason !== pauseReason) sendOverlayPaused(tabId, pauseReason);
    if (awayEdge) {
      notifyAwayPause(tabId);
      // Persist so an away pause survives a worker restart without re-notifying
      // (saveJobToStorage reads _pauseReason; buildRehydratedJob restores it).
      await saveJobToStorage(tabId, job.settings);
    }
    return;
  }
  if (job._pauseReason) { job._pauseReason = null; scheduleDomScan(tabId); broadcastStatus(); } // resumed

  // Backstop dedup: if a setTimeout tick already refreshed within this interval,
  // a coincident backstop-alarm fire must not double-refresh. Re-arm and bail.
  if (ARPGuards.isBackstopDuplicate(job._lastRefresh, now, curInterval)) {
    scheduleNext(tabId, Math.max(0, job.nextRefresh - now));
    return;
  }
  job._lastRefresh = now;
  job.refreshCount = (job.refreshCount || 0) + 1;

  // Reschedule-epoch snapshot. The refresh below can take seconds (executeScript
  // + reload); if the user submits UPDATE_INTERVAL in that window, its handler
  // bumps _epoch and reschedules with the NEW interval — and this cycle must not
  // overwrite that with the interval it computed before the await.
  const epoch = job._epoch || 0;

  // What kind of cycle is this? Hoisted out of the try so the post-detection
  // interval math (adaptive backoff) can see it.
  const hasKeyword = job.settings.keyword && job.settings.keyword.trim().length > 0;
  const hasMonitor = job.settings.monitorMode;
  job._changedThisCycle = false; // doMonitorRefresh flips this when an alert fires

  // Flag the cycle's detection window so an overlapping live-watch tick skips
  // its (redundant) read — this cycle's read is strictly fresher.
  job._detectionBusy = true;
  try {
    if (hasKeyword || hasMonitor) {
      await doMonitorRefresh(tabId, job);
    } else {
      await doRefresh(tabId, job);
    }
  } catch (e) {
    console.warn('Refresh error on tab', tabId, e);
  }
  job._detectionBusy = false;
  if ((hasKeyword || hasMonitor) && activeJobs[tabId] === job) {
    await checkWatchHealth(tabId, job);
    if (activeJobs[tabId] !== job) return; // stopped while alerting
  }
  // Re-arm live watch every active cycle (idempotent — scheduleDomScan clears
  // before arming, so chains never multiply). This is the self-heal for chain
  // deaths with no resume edge of their own: a transient-offline tick, or a
  // worker kill whose revival path skipped rehydrateJob (job still in memory).
  scheduleDomScan(tabId);

  // Compute the NEXT interval AFTER detection ran, so adaptive backoff (#8) can
  // read this cycle's outcome (job._changedThisCycle) and the failure backoff
  // (#9) can read the streak doMonitorRefresh maintains. Adaptive applies only to
  // detecting jobs — a plain refresh has no "change" signal to ramp against.
  let nextInterval;
  if (job.settings.adaptive && (hasKeyword || hasMonitor)) {
    job._noChangeStreak = job._changedThisCycle ? 0 : (job._noChangeStreak || 0) + 1;
    nextInterval = ARPInterval.computeAdaptiveInterval(job.settings, job._noChangeStreak);
  } else {
    nextInterval = computeInterval(job.settings);
  }
  const fails = job._consecutiveFailures || 0;
  if (fails > 0) {
    // Exponential backoff (capped at 15 min) for a page that won't render/script
    // — the "refreshes forever on a non-scriptable/erroring page" fix.
    nextInterval = Math.min(nextInterval * Math.pow(2, Math.min(fails, 6)), 15 * 60 * 1000);
  }

  // Stop after X refreshes — checked AFTER the refresh so "stop after 1"
  // actually performs 1 refresh before stopping.
  if (job.settings.stopAfter > 0 && job.refreshCount >= job.settings.stopAfter) {
    await stopRefresh(tabId);
    return;
  }

  // Reschedule (alarm or setTimeout, per interval) — unless an UPDATE_INTERVAL
  // landed during the await above (epoch advanced): its reschedule is newer and
  // already persisted/broadcast, so ours would drag the job back to the old
  // timing for one full stale cycle. currentInterval (the overlay/popup ring
  // total) is assigned INSIDE this guard too: a stale cycle writing it after an
  // UPDATE_INTERVAL bumped the epoch would otherwise clobber the new total back
  // for one cycle while the new deadline ships.
  if (activeJobs[tabId] && (activeJobs[tabId]._epoch || 0) === epoch) {
    activeJobs[tabId].settings.currentInterval = nextInterval;
    activeJobs[tabId].nextRefresh = Date.now() + nextInterval;
    // Persist count + deadline. A cycle that fired an alert advanced an
    // alert-relevant baseline, so it goes straight to the durable snapshot;
    // every other cycle takes the cheap per-job session path.
    if (activeJobs[tabId]._changedThisCycle) await saveJobToStorage(tabId, activeJobs[tabId].settings);
    else await saveJobRoutine(tabId, activeJobs[tabId].settings);
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
  // Honors the same mutes as the kw/chg alert paths: quiet-hours suppress mode
  // muting the notify channel, and a notification-button snooze — without this
  // gate, "Notify on refresh" kept posting all night through both.
  if (job.settings.notify) {
    const now = Date.now();
    const snoozed = job._snoozeUntil && now < job._snoozeUntil;
    const refreshNotifyMuted = !!snoozed ||
      ARPQuietHours.isChannelMuted(new Date(), job.settings.quietHours, 'notify');
    if (!refreshNotifyMuted &&
        ARPGuards.shouldNotifyRefresh(job._lastRefreshNotify, now, REFRESH_NOTIFY_MIN_GAP_MS)) {
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
//
// Returns a STRING normally. When `perItem` is set (per-item detection) AND a
// selector is given, returns instead:
//   • an ARRAY — one entry per matched element — on a successful read. An EMPTY
//     array is a REAL observation: "the page rendered and zero items are present"
//     (e.g. a studies list with nothing posted). It must stay distinguishable
//     from a failed read, because an empty list is the normal starting state for
//     the alert-on-arrival use case — collapsing the two made the FIRST arrival
//     unable to ever fire (it just became the baseline).
//   • null — no read: the body is missing, the selector is invalid, or the page
//     hasn't rendered (zero matches AND no visible body text). Callers skip the
//     cycle and keep their baseline.
function readPageText(selector, perItem) {
  if (!document.body) return perItem ? null : '';
  const ov = document.getElementById('__ar_overlay');
  let parent = null, next = null;
  if (ov) { parent = ov.parentNode; next = ov.nextSibling; ov.remove(); }

  // (Inlined as literals: an executeScript func can't close over an outer const.)
  const MAX_PAGE_TEXT = 200000; // bound on the joined/body string (see note below)
  let result;

  if (perItem && selector && typeof selector === 'string') {
    // Per-item read: ONE entry per matched element, so the background can track
    // the set of matching items and alert on each NEW one. Both the item COUNT
    // and each item's LENGTH are bounded, so a broad selector ("li" on an endless
    // feed) can't blow up the structure-cloned message or the persisted seen-set.
    let items = null; // null = no read (invalid selector / page not rendered)
    try {
      const nodes = document.querySelectorAll(selector);
      const MAX_ITEMS = 500, MAX_ITEM_LEN = 4000;
      items = [];
      for (let i = 0; i < nodes.length && items.length < MAX_ITEMS; i++) {
        const node = /** @type {HTMLElement} */ (nodes[i]);
        const t = node.innerText || node.textContent || '';
        if (!t) continue;
        // Best-effort deep-link for THIS card so an alert can open the item
        // directly (the study), not just the listing page: the node itself if it's
        // a link, else a link inside it, else an ancestor link. The DOM .href is
        // already absolute. Accept only http(s) — a javascript:/mailto: href must
        // not ride into a webhook (Discord rejects a non-http embed url and would
        // drop the whole alert). href is decorative: text alone still drives
        // detection, so any failure just yields ''.
        let href = '';
        try {
          const a = /** @type {HTMLAnchorElement | null} */ ((node.tagName === 'A' && /** @type {HTMLAnchorElement} */ (node).href) ? node
            : (node.querySelector && node.querySelector('a[href]'))
            || (node.closest && node.closest('a[href]')));
          if (a && typeof a.href === 'string' && /^https?:\/\//i.test(a.href)) {
            href = a.href.length > 2000 ? a.href.slice(0, 2000) : a.href;
          }
        } catch (e) { /* selector-engine edge / detached node — href stays '' */ }
        items.push({ text: t.length > MAX_ITEM_LEN ? t.slice(0, MAX_ITEM_LEN) : t, href });
      }
      // Zero matches on a body with no visible text is a mid-load read, not a
      // genuinely empty list — the selector had nothing to miss. Report "no
      // read" so the caller keeps its baseline instead of treating the blank
      // page as "every item departed" (inverse mode would false-fire, and the
      // next full read would re-fire everything as new). The probe runs only in
      // the ambiguous zero-match case; the overlay is already detached, so its
      // ticking timer text can't make a blank page look rendered.
      if (items.length === 0 && !(document.body.innerText || '').trim()) {
        items = null;
      }
    } catch (e) { items = null; /* invalid selector → no read, never throw */ }
    result = items;
  } else if (selector && typeof selector === 'string') {
    // Scoped read (#4 CSS-selector detection): read only the matched region(s)
    // so all downstream detection (keyword match, change diff, noise tolerance,
    // minChangedFraction) runs against just that text instead of the whole body
    // — the only way a one-word price/status change isn't drowned out on a busy
    // page. Invalid CSS throws HERE (in-page, not at the storage boundary), so
    // it's guarded. A selector that matches NOTHING returns '' which the callers
    // treat as "no read this cycle" (skip detection, keep the old baseline) — not
    // as a wholesale change. That deliberately avoids a false alert the instant a
    // watched element briefly drops out of the DOM (re-render, lazy load).
    try {
      const nodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selector));
      const parts = [];
      for (let i = 0; i < nodes.length; i++) {
        const t = nodes[i].innerText || nodes[i].textContent || '';
        if (t) parts.push(t);
      }
      result = parts.join('\n');
    } catch (e) {
      result = ''; // invalid selector → treat as empty read (skip), never throw
    }
  } else {
    result = document.body.innerText || '';
  }

  if (ov && parent) parent.insertBefore(ov, next);
  // Bound the returned string. innerText on an infinite-scroll / pathological page
  // can be many MB; that full payload is structure-cloned out of the page on
  // every cycle, held resident in job.previousContent, and (for monitor jobs)
  // persisted to storage as the cross-restart baseline. The cap matches the
  // matchers' scan bounds (keyword-match MAX_REGEX_SCAN / normalize MAX_SCAN,
  // both 200k), so detection is unchanged for any page those paths could see
  // anyway, while a runaway page can't blow up worker memory, message
  // serialization, or the per-cycle storage write. Change detection beyond the
  // cap is out of scope by design. (The per-item array is bounded separately above.)
  if (typeof result === 'string' && result.length > MAX_PAGE_TEXT) {
    result = result.slice(0, MAX_PAGE_TEXT);
  }
  return result;
}

// Deliver a keyword alert through every channel — journal + unacked badge,
// webhook, sound, desktop notification, screen-edge flash — and apply
// stop-on-keyword. Shared by the page-level boolean path and the per-item path so
// both stay in lockstep. Returns true if the job was STOPPED (the caller must
// then return without reloading). opts:
//   count   — how many hits this cycle (per-item: number of new matches; bumps
//             keywordCount by this much). Default 1 = the boolean path's behavior.
//   message — desktop-notification body (default: the classic single-keyword line).
//   snippet — short note for the alert journal (per-item: "3 new").
async function deliverKeywordAlert(tabId, job, muted, opts) {
  opts = opts || {};
  const count = opts.count || 1;
  // Running tally surfaced next to the refresh count in the popup. Bumped before
  // the stopOnKeyword early-return so a stop-on-hit cycle still counts the hit.
  job.keywordCount = (job.keywordCount || 0) + count;
  job._changedThisCycle = true; // adaptive backoff: snap back to the fast base
  const meta = await tabMeta(tabId);
  // Every outward channel starts before the journal write and the beep's
  // offscreen setup, so none of them waits on the others. Outbound webhook
  // (not awaited: its internal fetch is timed-out, and blocking the reload on a
  // slow endpoint would stall the cycle).
  if (!muted('notify')) sendWebhook(job, { tabId, type: 'kw', title: meta.title || meta.url, url: meta.url, keyword: job.settings.keyword, inverse: !!job.settings.kwInverse, count: job.keywordCount, items: opts.items });
  const beep = (job.settings.sound && !muted('sound')) ? playBeep(soundOpts(job.settings)) : null;
  const verb = job.settings.kwInverse ? 'disappeared from' : 'found on';
  // Exactly one new study with a usable link: name it in the notification and
  // make the click open it directly.
  const study = singleStudy(opts.items);
  if (!muted('notify')) notify('kw', tabId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: study ? 'New study' : 'Keyword Detected!',
    message: study
      ? (study.title + (study.detail ? '\n' + study.detail : '') + '\nClick to open it')
      : (opts.message || ('"' + job.settings.keyword + '" ' + verb + ' page!')),
    requireInteraction: true,                              // persist until acted on (Win/Linux/ChromeOS)
    buttons: [{ title: 'Stop' }, { title: 'Snooze 15m' }], // #2 actionable buttons
  }, study ? study.url : undefined);
  // The alert is evaluated after the reload, so the live content script can
  // receive the screen-edge flash immediately.
  const flashPlan = ARPMonitor.computeFlashDelivery({
    fired: true,
    flashOnKeyword: job.settings.flashOnKeyword && !muted('flash'),
  });
  if (flashPlan === 'now') sendKeywordFlash(tabId, 0);
  // Journal + unacked badge — independent of delivery suppression, so a muted
  // overnight hit is still captured.
  await logAlert({ tabId, url: meta.url, title: meta.title, type: 'kw', keyword: job.settings.keyword, snippet: opts.snippet || '' });
  if (beep) await beep;
  if (job.settings.stopOnKeyword) {
    await stopRefresh(tabId);
    return true;
  }
  if (!muted('sound')) startAckBeeps(tabId); // repeat beep until acknowledged (if enabled)
  return false;
}

// Identity options for per-item keys, mirroring the noise settings the change
// path feeds isMeaningfulChange: with "Ignore noise" on (and digit-collapse not
// explicitly off), digit runs fold to '0' so a counter ticking inside a matched
// card ("24 places", "2 min ago") doesn't mint a fresh item key on every reload
// — which would re-alert for the same card on every single cycle. Off by
// default so two items distinct only by a number (an absolute timestamp, a
// batch #) stay distinct. Must be passed IDENTICALLY to the baseline collect in
// startRefresh and the per-cycle collect in doMonitorRefresh: keys built with
// different options never compare equal.
function itemKeyOpts(settings) {
  return (settings.noiseTolerant && settings.collapseDigits !== false)
    ? { collapseDigits: true }
    : undefined;
}

// Desktop-notification body for a per-item batch: "3 new matches for '…'" (or
// "…disappeared" in inverse mode). Distinct from the boolean path's single-line
// message so the user can tell a fresh-arrival alert from a page-level one.
function perItemMessage(settings, count) {
  const kw = settings.keyword || 'match';
  const noun = count === 1 ? 'match' : 'matches';
  return settings.kwInverse
    ? (count + ' ' + noun + ' for "' + kw + '" disappeared')
    : (count + ' new ' + noun + ' for "' + kw + '"');
}

// The one arrival a notification can open directly: exactly one item with a
// safe http(s) link. Returns { url, title, detail } or null.
function singleStudy(items) {
  if (!Array.isArray(items) || items.length !== 1) return null;
  const it = items[0];
  if (!it || !it.href || !ARPValidators.isSafeNavigableUrl(it.href)) return null;
  const { meta, detail } = ARPWebhookFormat.webhookItemDetail(it.text);
  return { url: it.href, title: (meta.title || 'New match').slice(0, 120), detail: detail.slice(0, 120) };
}

// Map the just-fired new keys back to their per-item detail ({ key, href, text })
// so an alert can deep-link each arrival to its own study. Departures (inverse
// mode) aren't in the current set and have no live link, so return none there.
// Order follows newKeys. `currDetails` is a collectItems() result for this cycle.
function arrivalItems(currDetails, newKeys, inverse) {
  if (inverse || !Array.isArray(currDetails) || !Array.isArray(newKeys) || !newKeys.length) return [];
  const byKey = new Map(currDetails.map(c => [c.key, c]));
  const out = [];
  for (let i = 0; i < newKeys.length; i++) {
    const d = byKey.get(newKeys[i]);
    if (d) out.push(d);
  }
  return out;
}

// ── Dead-watch detection ───────────────────────────────────────────────────
// A detecting job whose page has turned into a sign-in screen, a captcha, or a
// page that won't load keeps cycling without ever alerting — studies get
// missed with no signal. After each detection cycle, probe the page and let
// ARPWatchHealth decide when to raise (once) a "watch blocked" alert.

function watchesForChanges(settings) {
  return !!(settings && (settings.monitorMode ||
    (typeof settings.keyword === 'string' && settings.keyword.trim())));
}

// Injected into the page: 'captcha' | 'login' | null. Only VISIBLE password
// fields count (many pages carry a hidden login form).
function probePageHealth() {
  const captcha = !!document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"],' +
    ' .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running')
    || /^just a moment/i.test(document.title || '');
  if (captcha) return 'captcha';
  const fields = document.querySelectorAll('input[type="password"]');
  for (let i = 0; i < fields.length; i++) {
    const el = /** @type {HTMLElement} */ (fields[i]);
    if (el.offsetWidth || el.offsetHeight || el.getClientRects().length) return 'login';
  }
  return null;
}

async function checkWatchHealth(tabId, job) {
  let probe = null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: probePageHealth });
    probe = (results && results[0] && results[0].result) || null;
  } catch (e) { /* unscriptable — the failure streak covers this case */ }
  if (activeJobs[tabId] !== job) return;
  const failures = job._consecutiveFailures || 0;
  const reason = ARPWatchHealth.classify(probe, failures, job._healthIgnore);
  const r = ARPWatchHealth.step(job._health, reason);
  job._health = r.state;
  if (r.alert) {
    await deliverStallAlert(tabId, job, ARPWatchHealth.describe(reason, failures));
    await saveJobToStorage(tabId, job.settings); // don't re-alert after a worker restart
  } else if (r.recovered) {
    const meta = await tabMeta(tabId);
    await logAlert({ tabId, url: meta.url, title: meta.title, type: 'recovered', snippet: 'Watch is working again' }, { unacked: false });
    await saveJobToStorage(tabId, job.settings);
  }
}

// ── Navigate-away pause (#12): pause instead of stop, resume on return ──────
// Navigating the watched tab off the job's original URL used to STOP the job —
// silently. In the hunt workflow (alert fires → user clicks through → takes the
// study → returns to the list) that meant the watch died at the exact moment it
// proved useful, and everything arriving afterwards was missed with no signal
// beyond a missing overlay. Now it PAUSES: the baseline is frozen (no reads
// happen on the wrong page, so items arriving while away still diff as NEW on
// return), a single notification announces the pause, and returning to the
// watched URL resumes automatically. Three cooperating edges:
//   • tabs.onUpdated (below)   — the fast path for both directions
//   • fireRefresh's away gate  — alarm-driven backstop for missed SPA routes
//   • doDomScan's tab check    — per-tick guard so a missed route can't let a
//     live-watch read poison the frozen baseline
function notifyAwayPause(tabId) {
  notify('away', tabId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Watch paused — you left the page',
    message: 'Monitoring is paused while this tab is elsewhere. It resumes automatically when the tab returns to the watched page.',
  });
}

// Best-effort: tell the content script its job just paused, so the in-page
// overlay freezes its countdown and shows the reason instead of draining to 0:00
// as if still running. broadcastStatus() only reaches extension pages (popup /
// Manage), so the overlay needs this dedicated signal. Fire-and-forget — no
// retry/inject: if there's no content script the overlay isn't showing anyway,
// and the resume path re-syncs it with a fresh COUNTDOWN_START.
function sendOverlayPaused(tabId, reason) {
  chrome.tabs.sendMessage(tabId, { type: 'PAUSED', reason }).catch(() => {});
}

// Event-edge entry (onUpdated URL change, live-watch tick). Idempotent — the
// _pauseReason check also makes it one-notification-per-edge. Manual pause
// dominates: the job is already dormant, so announcing an "away" pause on top
// of it would be noise (fireRefresh's gate re-derives 'away' after RESUME_JOB).
async function enterAwayPause(tabId, job) {
  if (job._manualPause || job._pauseReason === 'away') return;
  job._pauseReason = 'away';
  clearDomScan(job); // freeze the baseline: no reads while on the wrong page
  const recheck = pauseRecheckMs(job.settings.currentInterval || computeInterval(job.settings), false);
  job.nextRefresh = Date.now() + recheck;
  scheduleNext(tabId, recheck); // keep the job alive (and rehydratable) while away
  broadcastStatus();
  sendOverlayPaused(tabId, 'away'); // freeze the overlay too (SPA route change: same tab, live overlay)
  notifyAwayPause(tabId);
  await saveJobToStorage(tabId, job.settings); // away survives worker restarts
}

// The tab is back on the watched page: run a cycle almost immediately — its
// detection diffs against the FROZEN pre-departure baseline, so items that
// arrived while away alert within moments of returning.
async function resumeFromAwayPause(tabId, job) {
  if (job._pauseReason !== 'away') return;
  job._pauseReason = null;
  job.nextRefresh = Date.now() + AWAY_RESUME_DELAY_MS;
  scheduleNext(tabId, AWAY_RESUME_DELAY_MS);
  scheduleDomScan(tabId);
  broadcastStatus();
  await saveJobToStorage(tabId, job.settings); // clear the persisted away flag
}

// ── Live watch (#11): scan the DOM between reloads ──────────────────────────
// A per-item job normally only observes the page once per reload cycle — but on
// an SPA (Prolific, ticket queues) the site itself pushes new items into the DOM
// between reloads. Live watch runs the SAME per-item detection on a fast
// setTimeout chain WITHOUT reloading: each tick is one executeScript read (no
// server request), so detection latency drops to seconds while the reload
// interval — the thing rate limiters see — can stay slow.
//
// Worker lifetime: the tick's executeScript is extension-API activity, which
// resets the MV3 idle timeout — so a chain ticking faster than ~30s keeps the
// worker alive between alarm-driven reload cycles (same mechanism the
// short-interval loop in scheduleNext relies on). DOM_SCAN_MAX_MS stays well
// under that ceiling. If the worker is killed anyway (sleep/suspend), the chain
// dies with it and the next alarm's rehydrateJob re-arms it.
const DOM_SCAN_MIN_MS = 2000;
const DOM_SCAN_MAX_MS = 20000;
const DOM_SCAN_DEFAULT_MS = 4000;

// Live watch is gated on the same prerequisites as per-item detection itself —
// it IS per-item detection, just off-cycle. Settings-only check: the compiled
// matcher is validated per tick (doDomScan), matching doMonitorRefresh's gate.
function domScanEnabled(job) {
  return !!(job && job.settings && job.settings.domWatch &&
    job.settings.kwPerItem && job.settings.watchSelector);
}

// (Re-)arm a job's scan chain. Always clears first, so this is also how the
// chain is DISARMED after a settings change turned live watch off — every
// lifecycle edge (start, rehydrate, update, pause/resume) just calls this.
function scheduleDomScan(tabId) {
  const job = activeJobs[tabId];
  if (!job) return;
  clearDomScan(job);
  if (!domScanEnabled(job)) return;
  // A manually-paused job (including one rehydrated as paused) stays disarmed;
  // RESUME_JOB re-arms. Same for an away-paused job (rehydrateJob calls this
  // unconditionally — the chain must NOT re-arm while the tab is elsewhere, or
  // its reads would poison the frozen baseline; resumeFromAwayPause re-arms).
  // Quiet/offline pauses are caught per tick instead — they're clock/network
  // states with no message-driven resume edge here.
  if (job._manualPause || job._pauseReason === 'away') return;
  const raw = Number(job.settings.domWatchInterval);
  const delay = Math.min(DOM_SCAN_MAX_MS,
    Math.max(DOM_SCAN_MIN_MS, Number.isFinite(raw) && raw > 0 ? raw : DOM_SCAN_DEFAULT_MS));
  job._domTimer = setTimeout(() => doDomScan(tabId), delay);
}

function clearDomScan(job) {
  if (job && job._domTimer) { clearTimeout(job._domTimer); job._domTimer = null; }
  if (job && job._mutationTimer) { clearTimeout(job._mutationTimer); job._mutationTimer = null; }
}

// One live-watch tick: read the per-item array, diff against the shared
// _seenKeys baseline, alert on arrivals/departures, re-arm. Mirrors the
// per-item branch of doMonitorRefresh minus the reload — both paths advance the
// SAME baseline, so whichever observes a new item first alerts and the other
// stays silent (the diff-then-advance section is synchronous, so an overlapping
// reload cycle can't double-fire).
// Per-item reads can overlap — the reload cycle, the live-watch timer, and a
// page-change trigger. Each read takes a ticket BEFORE its executeScript; its
// result may advance the seen-set only if no newer read already has. Without
// this, a slow older read finishing last rewinds the baseline and the next
// read re-alerts the same study.
function beginItemRead(job) {
  job._readSeq = (job._readSeq || 0) + 1;
  return job._readSeq;
}
function claimItemRead(job, ticket) {
  if (ticket < (job._appliedReadSeq || 0)) return false;
  job._appliedReadSeq = ticket;
  return true;
}

// One live-watch scan at a time per job. A scan requested while one is in
// flight (timer tick or page-change trigger) is folded into one rerun after it.
async function doDomScan(tabId) {
  const job = activeJobs[tabId];
  if (!job) return;
  if (job._scanning) { job._rescan = true; return; }
  job._scanning = true;
  try {
    await domScanOnce(tabId);
  } finally {
    job._scanning = false;
  }
  if (job._rescan && activeJobs[tabId] === job) {
    job._rescan = false;
    requestMutationScan(tabId);
  }
}

// Instant live watch: the job page's content script reports DOM changes
// (DOM_MUTATED) and the scan runs at once instead of waiting for the next
// timer tick. Rate-limited per job — a page with a ticking clock mutates
// constantly — and the timer chain keeps running as the backstop.
const MUTATION_SCAN_MIN_GAP_MS = 1000;
function requestMutationScan(tabId) {
  const job = activeJobs[tabId];
  if (!job || !domScanEnabled(job) || job._mutationTimer) return;
  const wait = Math.max(0, (job._lastMutationScan || 0) + MUTATION_SCAN_MIN_GAP_MS - Date.now());
  job._mutationTimer = setTimeout(() => {
    job._mutationTimer = null;
    if (activeJobs[tabId] !== job) return;
    job._lastMutationScan = Date.now();
    doDomScan(tabId);
  }, wait);
}

async function domScanOnce(tabId) {
  const job = activeJobs[tabId];
  if (!job || !domScanEnabled(job)) return; // stopped or reconfigured — chain ends
  // While paused, END the chain rather than tick-and-skip: an idle chain would
  // keep the MV3 worker awake for a deliberately dormant job. Every resume edge
  // re-arms it (fireRefresh's resumed branch for quiet/offline — its pause gate
  // re-checks on a capped recheck alarm — and RESUME_JOB for manual pauses).
  if (job._manualPause || job._pauseReason === 'away' ||
      ARPQuietHours.quietAction(new Date(), job.settings.quietHours) === 'pause' ||
      isOffline()) {
    return;
  }
  // Away check (#12): an SPA route change can slip past the onUpdated listener;
  // without this a tick on the wrong page reads zero items ([]) and advances the
  // frozen baseline — on return, EVERYTHING would re-fire as new instead of just
  // the items that arrived while away. tabs.get is cheap (no page process hop),
  // and entering the away pause here also detects the departure within one tick
  // (seconds) instead of waiting for the reload cycle's backstop.
  if (job.startUrl) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; } // tab gone; onRemoved cleans up
    if (ARPRehydrate.isNavigateAway(job.startUrl, tab.url || tab.pendingUrl || '')) {
      await enterAwayPause(tabId, job);
      return; // chain ends; the resume edges re-arm it
    }
  }
  // Skip the read (but keep the chain alive) while a full refresh cycle's
  // detection is in flight — its read is seconds away and strictly fresher.
  if (!job._detectionBusy) {
    const matcher = job._matcher || (job._matcher = buildMatcher(job.settings));
    if (matcher.ok && !matcher.empty) {
      let raw = null;
      const readTicket = beginItemRead(job);
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: readPageText,
          args: [job.settings.watchSelector || '', true],
        });
        raw = results && results[0] && results[0].result;
      } catch (e) { /* mid-reload / non-scriptable — skip this tick, keep the chain */ }
      // The job may have been stopped/replaced during the await; only the live
      // object may advance the baseline. null = no read (page mid-render);
      // an ARRAY — including [] — is a real observation (same policy as the
      // cycle path).
      if (activeJobs[tabId] === job && Array.isArray(raw) && claimItemRead(job, readTicket)) {
        const exclude = job._excludeMatcher || (job._excludeMatcher = buildExcludeMatcher(job.settings));
        const curr = ARPItemDetect.collectItems(raw, matcher, itemKeyOpts(job.settings), exclude);
        const currKeys = curr.map(c => c.key);
        const prevKeys = Array.isArray(job._seenKeys) ? job._seenKeys : null;
        const newKeys = prevKeys
          ? ARPItemDetect.computeNewKeys(prevKeys, currKeys, job.settings.kwInverse)
          : []; // first observation seeds the baseline without firing
        job._seenKeys = currKeys;
        if (newKeys.length > 0) {
          const nowDate = new Date();
          const snoozed = job._snoozeUntil && Date.now() < job._snoozeUntil;
          const muted = (channel) => !!snoozed ||
            ARPQuietHours.isChannelMuted(nowDate, job.settings.quietHours, channel);
          const stopped = await deliverKeywordAlert(tabId, job, muted, {
            count: newKeys.length,
            message: perItemMessage(job.settings, newKeys.length),
            snippet: newKeys.length + (job.settings.kwInverse ? ' gone' : ' new'),
            items: arrivalItems(curr, newKeys, job.settings.kwInverse),
          });
          if (stopped) return; // stopOnKeyword — stopRefresh already cleared the chain
          // Persist the advanced baseline so a worker death right after the
          // alert can't rehydrate the OLD seen-set and re-alert the same items.
          // Per-tick persistence would hammer storage; alert-frequency writes
          // are bounded by genuinely-new arrivals.
          await saveJobToStorage(tabId, job.settings);
        }
      }
    }
  }
  scheduleDomScan(tabId);
}

const RELOAD_COMPLETE_TIMEOUT_MS = 15_000;
// App-shell pages can finish their document load before the API-backed list is
// rendered. Give the new document a minimum hold plus a short quiet window so a
// card inserted just after `status: complete` is included in THIS cycle instead
// of waiting for the next reload. The timeout keeps a busy/live page from
// delaying a refresh forever.
const POST_LOAD_SETTLE_QUIET_MS = 300;
const POST_LOAD_SETTLE_MIN_MS = 750;
const POST_LOAD_SETTLE_TIMEOUT_MS = 3_000;

function createReloadCompletionWaiter(tabId, timeoutMs = RELOAD_COMPLETE_TIMEOUT_MS) {
  let settled = false;
  let timer = null;
  /** @type {(completed: boolean) => void} */
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

// Injected into the page after a reload completes. Resolve after the DOM has
// been quiet for a short window, or at the bounded timeout. Ignore mutations
// inside our own countdown overlay; its clock ticks independently of the page
// content and must not keep every detecting refresh at the timeout.
function waitForPageSettle(quietMs, timeoutMs, minimumMs) {
  if (!document.body || typeof MutationObserver !== 'function') return Promise.resolve(false);
  const quiet = Math.max(0, Number(quietMs) || 0);
  const timeout = Math.max(quiet, Number(timeoutMs) || quiet);
  const minimum = Math.min(timeout, Math.max(0, Number(minimumMs) || 0));
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer = null;
    let timeoutTimer = null;
    const insideOverlay = (node) => {
      const element = node && node.nodeType === 1 ? node : node && node.parentElement;
      return !!(element && element.closest && element.closest('#__ar_overlay'));
    };
    const observer = new MutationObserver((records) => {
      const pageMutation = records.some((record) => {
        if (insideOverlay(record.target)) return false;
        if (record.type !== 'childList') return true;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return nodes.some((node) => !insideOverlay(node));
      });
      if (pageMutation) armQuietTimer();
    });
    const finish = (didSettle) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(didSettle);
    };
    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      const holdRemaining = Math.max(0, minimum - (Date.now() - startedAt));
      quietTimer = setTimeout(() => finish(true), Math.max(quiet, holdRemaining));
    };
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    armQuietTimer();
    timeoutTimer = setTimeout(() => finish(false), timeout);
  });
}

async function doMonitorRefresh(tabId, job) {
  // A keyword takes precedence over generic change-monitoring. When one is set,
  // the keyword is the signal of interest, so we skip the page-change path
  // entirely below — otherwise every dynamic page (timestamps, ads, counters)
  // would beep on essentially every reload regardless of the keyword.
  // The matcher (multi-keyword / whole-word / case / regex) is compiled once at
  // job start and cached on job._matcher; recompile lazily if it's missing.
  const matcher = job._matcher || (job._matcher = buildMatcher(job.settings));
  const hasKeyword = matcher.ok && !matcher.empty;

  // Reload first, then evaluate the document produced by THIS scheduled cycle.
  // The start-time snapshot remains the previous baseline, so content introduced
  // by reload 1 can alert during cycle 1 without treating content already present
  // when Start was pressed as a new arrival.
  // Per-item detection ("alert on each new match") needs a LIVE keyword matcher
  // AND a selector (each matched element is one item); when on, readPageText
  // returns one entry per element instead of a single blob so we can diff which
  // items are present. Gated on the compiled matcher — not the raw keyword text
  // — so a refused/broken regex or a degenerate keyword falls through to the
  // string path, where change detection (monitorMode) still runs instead of
  // being silently swallowed by an alert path that can never match.
  const perItem = !!(job.settings.kwPerItem && job.settings.watchSelector && hasKeyword);
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

  // `tabs.onUpdated` reports the document load, not completion of an app's
  // client-side data fetch. Wait for a bounded quiet window before the read so
  // React/Vue/other SPA cards inserted just after load are evaluated in cycle 1.
  // This is best-effort: if the settle probe cannot run, the normal read below
  // still provides the existing scriptability/error handling.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: waitForPageSettle,
      args: [POST_LOAD_SETTLE_QUIET_MS, POST_LOAD_SETTLE_TIMEOUT_MS, POST_LOAD_SETTLE_MIN_MS],
    });
  } catch (e) {}
  if (activeJobs[tabId] !== job) return;

  let results;
  const readTicket = beginItemRead(job);
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageText,
      args: [job.settings.watchSelector || '', perItem], // scoped detection ('' = whole body)
    });
  } catch (e) {
    // Page won't script (chrome://, web store, error page, hang). Count it so the
    // failure backoff (#9) in fireRefresh ramps the interval instead of hammering
    // a page that will never yield a read. The scheduled reload already happened.
    job._consecutiveFailures = (job._consecutiveFailures || 0) + 1;
    return;
  }

  const currentContent = (results && results[0] && results[0].result) || '';
  const prevContent = job.previousContent; // null/undefined = no baseline yet

  // A failed read means the page hadn't rendered when executeScript landed (slow
  // load at a short interval, mid-navigation) — it is not evidence about the
  // page. Treating it as real would fire false alerts in both directions: the
  // next full read looks like "keyword appeared"/"page changed", and in inverse
  // mode the empty read itself looks like "keyword disappeared" (worse, stop-on-
  // keyword/change would then kill the job). Same policy as startRefresh's
  // initialContent guard: skip detection and keep the old baseline.
  // String path: a failed read IS the empty string. Per-item path: a failed read
  // is null (→ '' above); an EMPTY ARRAY is a real "rendered page, zero items"
  // observation and must flow through — it is the state an alert-on-arrival
  // watch typically starts from, and in inverse mode it is the fire condition.
  if (perItem ? !Array.isArray(currentContent) : currentContent.length === 0) {
    return;
  }
  job._consecutiveFailures = 0; // a real read landed — clear any failure backoff

  // Alert-DELIVERY suppression for this cycle. Detection, baseline, counts,
  // badge, and the persisted alert log are NEVER suppressed — only the noisy
  // channels (sound / desktop notification / screen flash / webhook / ack-beeps):
  //   • quiet-hours 'suppress' mode mutes the configured channels overnight (#5)
  //   • a notification "Snooze 15m" mutes everything until _snoozeUntil (#2)
  const nowDate = new Date();
  const snoozed = job._snoozeUntil && Date.now() < job._snoozeUntil;
  const muted = (channel) => !!snoozed || ARPQuietHours.isChannelMuted(nowDate, job.settings.quietHours, channel);

  // ── Per-item detection ("alert on each new match") ──
  // currentContent is the per-element array from the perItem read (the guard
  // above ensured it; [] = a real empty list). Rather than a page-level
  // absent→present boolean, diff the SET of matching item keys against last
  // cycle's set and alert on each NEW one (or each DEPARTED one in inverse
  // mode) — so a fresh matching card fires even while earlier matches stay on
  // screen. job._seenKeys is the baseline (persisted across worker restarts); a
  // null set means "no baseline yet" and never fires (cycle 1). Taken whenever the
  // read was per-item, so the item array never flows into the string path below.
  if (perItem) {
    // A live-watch read that started AFTER this one may already have advanced
    // the baseline; applying this older read would rewind it.
    if (!claimItemRead(job, readTicket)) return;
    // Exclusion filter, compiled once per job like _matcher (lazily after a
    // worker restart — rehydrated jobs don't carry it).
    const exclude = job._excludeMatcher || (job._excludeMatcher = buildExcludeMatcher(job.settings));
    const curr = ARPItemDetect.collectItems(currentContent, matcher, itemKeyOpts(job.settings), exclude);
    const currKeys = curr.map(c => c.key);
    const prevKeys = Array.isArray(job._seenKeys) ? job._seenKeys : null;
    const newKeys = prevKeys
      ? ARPItemDetect.computeNewKeys(prevKeys, currKeys, job.settings.kwInverse)
      : [];
    job._seenKeys = currKeys;   // advance the baseline every cycle
    job.previousContent = null; // per-item uses _seenKeys, not the flat snapshot
    if (newKeys.length > 0) {
      const stopped = await deliverKeywordAlert(tabId, job, muted, {
        count: newKeys.length,
        message: perItemMessage(job.settings, newKeys.length),
        snippet: newKeys.length + (job.settings.kwInverse ? ' gone' : ' new'),
        items: arrivalItems(curr, newKeys, job.settings.kwInverse),
      });
      if (stopped) return; // stopOnKeyword stopped the job — no reload
    }
    return;
  }

  // ── Keyword detection ──
  // Alert on a transition between cycles: absent→present normally, or
  // present→absent in inverse mode ("alert when the keyword disappears").
  const hasBaseline = prevContent !== null && prevContent !== undefined;
  if (hasKeyword) {
    const foundNow  = matcher.test(currentContent);
    // foundPrev is last cycle's foundNow — reuse it instead of re-running the
    // matcher over the (up to 200k-char) previous snapshot every cycle. Falls
    // back to a real test when there's no cached verdict: first cycle after a
    // worker restart (the baseline text IS persisted, the boolean isn't) or
    // after UPDATE_INTERVAL rebuilt the matcher (which clears the cache —
    // a new keyword must be re-judged against the old text).
    const foundPrev = typeof job._prevFound === 'boolean'
      ? job._prevFound
      : (hasBaseline && matcher.test(prevContent));
    job._prevFound = foundNow;
    const fired = ARPMonitor.computeKeywordFire({
      foundNow, foundPrev, hasBaseline, kwInverse: job.settings.kwInverse,
    });

    if (fired) {
      // Page-level hit: one alert via the shared deliverer (count 1, classic
      // single-keyword message). stopOnKeyword returns true → stop, no reload.
      const stopped = await deliverKeywordAlert(tabId, job, muted);
      if (stopped) return;
    }
  }

  // ── Page change detection ──
  // Only alert when we have a real baseline and content actually changed.
  // Skipped entirely when a keyword is set — the keyword owns the signal so the
  // generic change beep/notification doesn't drown it out (see hasKeyword above).
  if (ARPMonitor.shouldCheckChange({ hasKeyword, monitorMode: job.settings.monitorMode, hasBaseline })) {
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
      job._changedThisCycle = true; // adaptive backoff: snap back to the fast base
      // What changed — a short token diff so the log/notification says more than
      // the old opaque "a change was detected". Digit-collapse follows the job's
      // own setting so a price ticking 19→24 is still shown when noise tolerance
      // keeps digits, and hidden when it collapses them.
      const diff = ARPNormalize.diffTokens(prevContent, currentContent, {
        collapseDigits: job.settings.collapseDigits !== false && job.settings.noiseTolerant,
      });
      const meta = await tabMeta(tabId);
      // Same ordering as deliverKeywordAlert: outward channels first, then the
      // journal write and the beep.
      if (!muted('notify')) sendWebhook(job, { tabId, type: 'chg', title: meta.title || meta.url, url: meta.url, snippet: diff.summary, count: job.refreshCount });
      const beep = (job.settings.sound && !muted('sound')) ? playBeep(soundOpts(job.settings)) : null;
      if (!muted('notify')) notify('chg', tabId, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Page Changed!',
        message: diff.summary ? ('Changed: ' + diff.summary) : 'A change was detected on the monitored page.',
        requireInteraction: true,
        buttons: [{ title: 'Stop' }, { title: 'Snooze 15m' }],
      });
      await logAlert({ tabId, url: meta.url, title: meta.title, type: 'chg', snippet: diff.summary });
      if (beep) await beep;
      if (job.settings.stopOnChange) {
        await stopRefresh(tabId);
        return;
      }
      if (!muted('sound')) startAckBeeps(tabId); // repeat beep until acknowledged (if enabled)
    }
  }

  // Save the non-empty snapshot for the next reload cycle. The empty-read guard
  // above returned early, so '' can never become the baseline.
  job.previousContent = currentContent;
}

// Refresh-interval computation lives in interval.js (ARPInterval.computeInterval)
// so it is unit-testable and the fixed path is NaN-hardened. Thin local alias
// keeps the call sites below unchanged.
const computeInterval = ARPInterval.computeInterval;

// ── Start refresh ──────────────────────────────────────────────────────────
async function startRefresh(tabId, settings, suppliedToken) {
  const token = suppliedToken === undefined
    ? lifecycleRegistry.begin(tabId)
    : suppliedToken;
  const isCancelled = () => !lifecycleRegistry.isCurrent(tabId, token);
  try {
    // Stop any existing job without invalidating this new Start's token.
    if (activeJobs[tabId]) {
      await teardownJob(tabId);
      if (isCancelled()) return 'cancelled';
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
      if (isCancelled()) return 'cancelled';
      // pendingUrl: an auto-start job is created right after chrome.tabs.create,
      // while the tab is still loading — url is '' but pendingUrl has the target.
      // Without the fallback such jobs get startUrl null, permanently disabling
      // the navigate-away stop and the restart-time identity check (restoreJobs).
      startUrl = tab.url || tab.pendingUrl || null;
    } catch (e) {}
    if (isCancelled()) return 'cancelled';

    // Domain denylist (#7): never attach a job to a user-blocked origin. This ONE
    // guard covers every launch path — popup, hotkey, URL rule, auto-start — because
    // they all funnel through startRefresh. Checked BEFORE the baseline executeScript
    // so a denied page (bank, webmail, health portal) is never even read.
    if (startUrl) {
      const { domainDenylist = [] } = await chrome.storage.local.get('domainDenylist');
      if (isCancelled()) return 'cancelled';
      if (ARPValidators.isUrlDenied(startUrl, domainDenylist)) {
        chrome.tabs.sendMessage(tabId, { type: 'STOPPED' }).catch(() => {}); // clear any overlay
        return 'denied';
      }
    }

    // Compiled once here so the per-item baseline below and the job's cached
    // _matcher / _excludeMatcher share one compile.
    const matcher = buildMatcher(settings);
    const excludeMatcher = buildExcludeMatcher(settings);
    // Per-item baseline: seed the seen-set so cycle 1 doesn't alert for every
    // matching item already present at start (mirrors previousContent's role).
    // Same gate as doMonitorRefresh: a live compiled matcher, not raw keyword text.
    const perItem = !!(settings.kwPerItem && settings.watchSelector && matcher.ok && !matcher.empty);
    let initialSeenKeys = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: readPageText,
        args: [settings.watchSelector || '', perItem], // scoped baseline read ('' = whole body)
      });
      if (isCancelled()) return 'cancelled';
      const raw = results && results[0] && results[0].result;
      if (perItem) {
        // Any ARRAY read — including [] — is a real baseline. [] means "the page
        // rendered and zero items are present", the normal starting state for an
        // alert-on-arrival watch: the FIRST later arrival must fire against it.
        // null (couldn't read / not rendered / bad selector) ⇒ no baseline yet =
        // the first successful cycle re-baselines without firing, same as below.
        initialSeenKeys = Array.isArray(raw)
          ? ARPItemDetect.collectMatches(raw, matcher, itemKeyOpts(settings), excludeMatcher)
          : null;
      } else {
        // Only use as baseline if we got real content (non-empty).
        // If empty/null, leave previousContent as null — the keyword check
        // will skip alerting on cycle 1 and wait for cycle 2 when the page
        // has had a chance to fully render.
        initialContent = (raw && raw.length > 0) ? raw : null;
      }
    } catch (e) {
      if (isCancelled()) return 'cancelled';
      initialContent = null; // not scriptable — skip alert on first cycle (seenKeys stays null too)
    }

    if (isCancelled()) return 'cancelled';

    // Dead-watch baseline: a sign-in box or captcha ALREADY on the page at start
    // is part of what the user chose to watch, so it must never read as a stall.
    let healthIgnore = [];
    if (watchesForChanges(settings)) {
      try {
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: probePageHealth });
        const probe = results && results[0] && results[0].result;
        if (probe) healthIgnore = [probe];
      } catch (e) { /* not scriptable — nothing to ignore */ }
      if (isCancelled()) return 'cancelled';
    }

    activeJobs[tabId] = {
      settings,
      refreshCount: 0,
      keywordCount: 0,
      nextRefresh: Date.now() + interval,
      alarmName: `refresh_${tabId}`,
      startUrl,
      previousContent: initialContent,  // null = no baseline yet, skip first cycle
      _seenKeys: initialSeenKeys,       // per-item baseline (null = no baseline yet)
      _matcher: matcher,                // compiled once; reused every cycle
      _excludeMatcher: excludeMatcher,  // per-item "skip items containing" filter
      _lastRefresh: 0,                  // no refresh has fired yet
      _timer: null,                     // short-interval setTimeout handle
      _domTimer: null,                  // live-watch scan chain handle
      _healthIgnore: healthIgnore,      // page signals present at start (never a stall)
      _health: null,                    // dead-watch state (ARPWatchHealth)
    };

    scheduleNext(tabId, interval);
    scheduleDomScan(tabId); // live watch (#11): no-op unless domWatch + per-item are on

    // Notify content script — retry until it responds, since the content script
    // may not be injected yet (tab still loading) when Start is pressed.
    sendCountdownStart(tabId, 0);

    // Persist to storage
    await saveJobToStorage(tabId, settings);
    broadcastStatus();
    refreshBadge(); // active-job count changed
    return 'started';
  } finally {
    lifecycleRegistry.finish(tabId, token);
  }
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
  const hotkey = await shortcutLabel();
  if (!activeJobs[tabId]) return;
  // liveWatch: arm the page's change observer (instant live watch).
  const liveWatch = domScanEnabled(job);
  chrome.tabs.sendMessage(tabId, { type: 'COUNTDOWN_START', nextRefresh, total, stopOnClick, showCountdown, preserveScroll, hotkey, liveWatch }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // No live content script yet (a fresh Start, or the page-load injection
      // hasn't landed). Inject it — content.js is idempotent (guards via
      // window.__autoRefreshInjected), so racing the onUpdated injection is safe.
      if (attempt === 0) ensureContentScript(tabId);
      // Retry — the injected script's own GET_STATUS sync will also show the
      // overlay, and the resend lands once its onMessage listener is registered.
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendCountdownStart(tabId, attempt + 1), delay);
      }
    }
  });
}

// Deliver the screen-edge flash for a keyword alert. Same poll/backoff/inject
// skeleton as sendCountdownStart, with one deliberate difference: no
// activeJobs[tabId] guard — in the stopOnKeyword case the job is deleted
// while the flash is still in flight, and it must land anyway.
async function sendKeywordFlash(tabId, attempt) {
  // Wait until the tab has finished loading — in the non-stop case the flash is
  // sent right after the post-detection reload kicks off.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') {
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendKeywordFlash(tabId, attempt + 1), delay);
      }
      return;
    }
  } catch (e) {
    return; // Tab gone
  }

  chrome.tabs.sendMessage(tabId, { type: 'KEYWORD_FLASH' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // No live content script yet — inject once, then retry until its
      // onMessage listener is registered. Swallow failures (chrome:// etc.).
      if (attempt === 0) ensureContentScript(tabId);
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendKeywordFlash(tabId, attempt + 1), delay);
      }
    }
  });
}

async function teardownJob(tabId) {
  if (activeJobs[tabId]) {
    clearAckBeeps(tabId); // stop any repeat-until-ack loop before dropping the job
    clearTimerLoop(activeJobs[tabId]); // stop the short-interval setTimeout loop
    clearDomScan(activeJobs[tabId]);   // stop the live-watch scan chain
    delete activeJobs[tabId];
  }
  // Always clear the alarm, even if memory was wiped by a restart — a stray
  // alarm would otherwise rehydrate a job the user just stopped.
  chrome.alarms.clear(`refresh_${tabId}`);
  chrome.tabs.sendMessage(tabId, { type: 'STOPPED' }).catch(() => {});
  await removeJobFromStorage(tabId);
  broadcastStatus();
  refreshBadge(); // active-job count changed
}

async function stopRefresh(tabId) {
  // Invalidate any asynchronous Start before doing any awaits. A suspended
  // start will observe the stale generation and exit without publishing state.
  lifecycleRegistry.invalidate(tabId);
  await teardownJob(tabId);
}

// ── Pause when the user navigates away from the original URL (#12) ─────────
// The fast path for both away edges: navigating off the watched page pauses the
// job (baseline frozen, one notification), navigating back resumes it. The
// fireRefresh gate and doDomScan's per-tick check are the backstops for SPA
// route changes this listener can miss.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return; // only care about URL changes
  // Fast path: while the worker is warm and the store is known fresh, a tab with
  // no in-memory job has no job at all — skip the rehydrate path entirely. This
  // listener fires for every URL-changing navigation in EVERY tab, and without
  // the gate each one paid a storage read just to learn "no job here".
  if (jobsStoreFresh && !activeJobs[tabId]) return;
  // Rehydrate if the worker restarted, so a navigate-away is still caught and the
  // comparison uses the persisted original URL — not the post-restart one.
  const job = activeJobs[tabId] || await rehydrateJob(tabId);
  if (!job || !job.startUrl) return;
  if (ARPRehydrate.isNavigateAway(job.startUrl, changeInfo.url)) {
    await enterAwayPause(tabId, job);
  } else if (job._pauseReason === 'away') {
    await resumeFromAwayPause(tabId, job);
  }
});

// ── Per-domain URL rules: auto-start a job when a tab finishes loading a URL
// that matches an enabled rule. Sequences cleanly with the navigate-away stop
// above (which fires earlier, on changeInfo.url) and with autoStartUrls (the
// activeJobs guard prevents double-starting). ──────────────────────────────
const startingTabs = new Set(); // in-flight guard against duplicate 'complete' events
let urlRulesCache = null; // null = not read yet this worker life; storage.onChanged keeps it current
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.url) return;
  if (activeJobs[tabId] || startingTabs.has(tabId)) return; // don't stomp an existing/in-flight job
  if (!ARPValidators.isSafeNavigableUrl(tab.url)) return;

  // Don't stomp a job persisted before a worker restart — restore it instead.
  // Only consulted while the store may be stale: when jobsStoreFresh the
  // in-memory map (checked above) is authoritative, and this handler fires on
  // EVERY completed page load in every tab — reading the whole activeJobs blob
  // (with per-job detection baselines up to 200k chars) here was a per-
  // navigation tax the steady state never needed to pay.
  if (!jobsStoreFresh) {
    const data = await chrome.storage.local.get('activeJobs');
    const storedJob = (data.activeJobs || {})[tabId];
    if (storedJob && await rehydrateJob(tabId, storedJob)) return;
  }

  if (urlRulesCache === null) {
    const data = await chrome.storage.local.get('urlRules');
    urlRulesCache = Array.isArray(data.urlRules) ? data.urlRules : [];
  }
  const rules = urlRulesCache;
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

// ── On-demand content script ───────────────────────────────────────────────
// content.js (overlay, click-to-stop, scroll restore, keyword flash) is NOT
// declared for <all_urls>: it is injected only into pages that host a job, so
// ordinary browsing never pays for it. Every load of a job's page — a refresh
// cycle, a manual reload, a return from navigating away — re-injects it here,
// and the script then syncs its overlay via GET_STATUS.
function ensureContentScript(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => true, () => false); // not scriptable (chrome://, Web Store, etc.)
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.url) return;
  // Same fast path as the navigate-away listener: a warm worker with no
  // in-memory job for this tab knows there's nothing to inject.
  if (jobsStoreFresh && !activeJobs[tabId]) return;
  const job = activeJobs[tabId] || await rehydrateJob(tabId);
  if (!job) return;
  // Paused away on some other page: don't put the overlay there.
  if (job.startUrl && ARPRehydrate.isNavigateAway(job.startUrl, tab.url)) return;
  await ensureContentScript(tabId);
});

// ── Keyboard shortcut (manifest `commands`) ────────────────────────────────
// Chrome owns the binding (default Alt+R, rebindable at
// chrome://extensions/shortcuts), so no per-page key listener is needed.
const TOGGLE_COMMAND = 'toggle-refresh';

async function shortcutLabel() {
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = (cmds || []).find((c) => c.name === TOGGLE_COMMAND);
    return (cmd && cmd.shortcut) || '';
  } catch (e) {
    return '';
  }
}

async function toggleFromShortcut(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  const tabId = tab.id;
  await rehydrateAll(); // a restarted worker has an empty activeJobs; refill it
  if (activeJobs[tabId]) { await stopRefresh(tabId); return; }
  // The shortcut fires on every tab, including chrome:// pages and the Web
  // Store, where a job can't run — only start on ordinary web pages.
  if (!ARPValidators.isSafeNavigableUrl(tab.url || tab.pendingUrl || '')) return;
  // Compose the job exactly the way the popup does — the per-launch state
  // from popupSettings plus the refresh-behavior defaults from globalSettings —
  // via the single shared constructor, so a shortcut launch can never drift
  // from a popup launch.
  const data = await chrome.storage.local.get(['popupSettings', 'globalSettings']);
  await startRefresh(tabId, ARPCompose.composeJobSettings(data.popupSettings || {}, data.globalSettings || {}));
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === TOGGLE_COMMAND) return toggleFromShortcut(tab);
});

// ── Worker modules ─────────────────────────────────────────────────────────
// Loaded last so their top-level declarations can't observe background.js
// state in its temporal dead zone; everything they share is reached from
// event handlers, after this whole script has run.
importScripts('bg-alerts.js');
importScripts('bg-store.js');
importScripts('bg-messages.js');
importScripts('bg-sync.js');
