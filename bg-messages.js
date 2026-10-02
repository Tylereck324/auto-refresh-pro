// bg-messages.js — status broadcast and the runtime.onMessage router for the popup, Settings, Manage, and content scripts.
//
// A classic script loaded by background.js via importScripts: it shares the
// service worker's global scope (activeJobs, the ARP* modules, and the other
// bg-*.js files), so it is split out for readability, not isolation. Top-level
// code here must only register listeners and declare state — anything that
// touches background.js state runs later, from an event.

// ── Broadcast status to all extension pages ────────────────────────────────
function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', jobs: serializeJobs() }).catch(() => {});
}

// One job's wire shape, shared by serializeJobs (the broadcast map) and the
// GET_STATUS single-job payload so the two can't drift — the pause/snooze fields
// below were once only in the map, so the popup's GET_STATUS sync hid the
// indicator on open.
function serializeJob(job) {
  return {
    settings: job.settings,
    refreshCount: job.refreshCount,
    keywordCount: job.keywordCount,
    nextRefresh: job.nextRefresh,
    // Paused state (#5 quiet-hours pause, #9 offline, #10 manual) so the
    // popup/Manage UI can show "Paused — …" instead of a misleading countdown.
    paused: (job._pauseReason || job._manualPause) ? true : undefined,
    pauseReason: job._manualPause ? 'manual' : (job._pauseReason || undefined),
    // Snooze (#2): when the alerts are muted via a notification button, surface
    // the remaining time so the popup can show a "snoozed" pill.
    snoozeUntil: (job._snoozeUntil && Date.now() < job._snoozeUntil) ? job._snoozeUntil : undefined,
  };
}

function serializeJobs() {
  const out = {};
  for (const [tabId, job] of Object.entries(activeJobs)) out[tabId] = serializeJob(job);
  return out;
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // PLAY_BEEP is addressed to the offscreen document. If Chrome also delivers
  // the broadcast back to this worker, do not answer it here: the first
  // response wins, and an "unknown message type" response would make the
  // caller believe audio was delivered when it was not.
  if (msg && msg.target === 'offscreen') return false;
  // Trust boundary: only honour messages from this extension's own surfaces
  // (popup/options/manage pages and our injected content scripts). All of those
  // carry sender.id === chrome.runtime.id; a web page or another extension does
  // not. Without externally_connectable, web pages can't reach us directly, but
  // this fails closed and guards against a compromised/another extension.
  if (!msg || !ARPValidators.isTrustedSender(sender)) {
    sendResponse && sendResponse({ ok: false, error: 'untrusted sender' });
    return false;
  }
  // A content script's sender carries its tab; bind such messages to THAT tab
  // regardless of any msg.tabId. Our own content script never sends a foreign
  // tabId, so this only constrains a forged message from a compromised page
  // process (which can imitate a content-script sender, but cannot fake
  // sender.tab) to controlling its own tab. The popup/options/manage pages have
  // no sender.tab and keep using msg.tabId.
  const senderTabId = sender.tab && sender.tab.id;
  const resolvedCommandTabId = senderTabId ?? msg.tabId;
  const startToken = msg.type === 'START_REFRESH' && resolvedCommandTabId != null
    ? lifecycleRegistry.begin(resolvedCommandTabId)
    : null;
  const stopAllTabs = msg.type === 'STOP_ALL'
    ? [...new Set([
      ...Object.keys(activeJobs).map(Number),
      ...lifecycleRegistry.pendingTabIds(),
    ])]
    : [];
  if (msg.type === 'STOP_REFRESH' && resolvedCommandTabId != null) {
    lifecycleRegistry.invalidate(resolvedCommandTabId);
  } else if (msg.type === 'STOP_ALL') {
    for (const tabId of stopAllTabs) lifecycleRegistry.invalidate(tabId);
  }
  (async () => {
    await rehydrateAll(); // a restarted worker has an empty activeJobs; refill it
    switch (msg.type) {
      case 'START_REFRESH': {
        const started = await startRefresh(resolvedCommandTabId, msg.settings, startToken);
        if (started === 'denied') sendResponse({ ok: false, denied: true });
        else if (started === 'cancelled') sendResponse({ ok: false, cancelled: true });
        else sendResponse({ ok: true, started: true });
        break;
      }
      case 'STOP_REFRESH': {
        const stopTabId = resolvedCommandTabId;
        if (stopTabId != null) await stopRefresh(stopTabId);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        const resolvedTabId = senderTabId || msg.tabId;
        // A GET_STATUS with no sender.tab comes from the popup/extension page (a
        // content-script sync always carries sender.tab) — the user is looking at
        // the UI, so acknowledge the unacked-alert badge (#1). Content-script
        // syncs must NOT clear it (the user hasn't seen anything yet).
        if (!senderTabId) clearUnacked();
        sendResponse({
          jobs: serializeJobs(),
          job: resolvedTabId && activeJobs[resolvedTabId] ? serializeJob(activeJobs[resolvedTabId]) : null,
          // The overlay footer shows the toggle shortcut; content scripts can't
          // read chrome.commands themselves.
          hotkey: senderTabId ? await shortcutLabel() : undefined,
        });
        break;
      }
      case 'STOP_ALL':
        // Rehydration can repopulate activeJobs between the synchronous
        // invalidation above and this awaited branch. Include those entries so
        // a worker-restart Stop All cannot leave a persisted job alive.
        const allStopTabs = [...new Set([
          ...stopAllTabs,
          ...Object.keys(activeJobs).map(Number),
        ])];
        for (const tabId of allStopTabs) await stopRefresh(tabId);
        sendResponse({ ok: true });
        break;
      case 'UPDATE_INTERVAL': {
        // Restart the alarm with the new interval, preserving the existing job state
        // (refresh count, previousContent baseline, startUrl — just update the timing)
        const updateTabId = senderTabId || msg.tabId;
        const job = activeJobs[updateTabId];
        if (!job) { sendResponse({ ok: false }); break; }

        // Drop any running short-interval loop before rescheduling
        clearTimerLoop(job);

        // Merge new settings, keeping existing state
        const newInterval = computeInterval(msg.settings);
        msg.settings.currentInterval = newInterval;
        const mergedSettings = { ...job.settings, ...msg.settings };
        const detectionChanged = !ARPDetectionIdentity.same(job.settings, mergedSettings);
        job.settings = mergedSettings;
        job.nextRefresh = Date.now() + newInterval;
        if (detectionChanged) {
          job._matcher = buildMatcher(job.settings); // keyword/flags changed
          job._excludeMatcher = buildExcludeMatcher(job.settings); // kwExclude changed
          job._prevFound = undefined; // cached verdict is for the OLD matcher — re-judge
          // Per-item keys are derived from the OLD keyword/selector/options. Drop
          // them so the next cycle establishes a quiet baseline for new identity.
          job._seenKeys = null;
        }
        job._epoch = (job._epoch || 0) + 1; // invalidate any in-flight cycle's reschedule

        // If the job is currently paused (manual / quiet / offline / away), apply
        // the new settings + matcher but KEEP it paused: reschedule the RECHECK
        // (not the new interval) and re-signal the paused overlay instead of an
        // un-pausing COUNTDOWN_START — otherwise the overlay/popup would show the
        // job running while the pause gate silently re-pauses it on the next tick.
        // The new interval takes effect when the job actually resumes.
        const pausedReason = job._manualPause ? 'manual' : (job._pauseReason || null);
        if (pausedReason) {
          const recheck = pauseRecheckMs(newInterval, pausedReason === 'offline');
          job.nextRefresh = Date.now() + recheck;
          scheduleNext(updateTabId, recheck);
          clearDomScan(job); // keep live watch disarmed while paused (resume re-arms it)
          sendOverlayPaused(updateTabId, pausedReason);
          await saveJobToStorage(updateTabId, job.settings);
          broadcastStatus();
          sendResponse({ ok: true });
          break;
        }

        // Reschedule with the right mechanism for the new interval
        scheduleNext(updateTabId, newInterval);
        scheduleDomScan(updateTabId); // re-arm (or disarm) live watch per the new settings

        // Tell the content script to reset its countdown
        sendCountdownStart(updateTabId, 0);

        await saveJobToStorage(updateTabId, job.settings);
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case 'TEST_WEBHOOK': {
        // Settings page "Send test": POST a sample alert to the URL being edited,
        // through the same validation + delivery path as a real alert, and report
        // the outcome so a typo'd or deleted webhook is caught before it matters.
        // Extension pages only — a content script has no business probing URLs.
        const url = typeof msg.url === 'string' ? msg.url.trim() : '';
        if (senderTabId != null || !ARPValidators.isSafeWebhookUrl(url)) {
          sendResponse({ ok: false, error: 'invalid webhook URL' });
          break;
        }
        const fmt = ['discord', 'slack', 'json'].includes(msg.format) ? msg.format : 'json';
        const body = ARPWebhookFormat.buildBody(fmt, {
          type: 'kw', title: 'Auto Refresh Pro', url: 'https://example.com/',
          keyword: 'test alert', count: 1,
        });
        const result = await ARPWebhook.deliver(url, body);
        sendResponse({ ok: result.ok, status: result.status, attempts: result.attempts, error: result.error });
        break;
      }
      case 'GET_ALL_JOBS':
        sendResponse({ jobs: serializeJobs() });
        break;
      case 'CLEAR_ALERTS': {
        // Clear the alert journal + unacked count THROUGH the alert-log mutex, so
        // a "Clear" click can't interleave with an in-flight logAlert (a blind
        // storage.set from the Manage page would race the worker's RMW). The
        // storage.onChanged badge sync + Manage re-render follow from the write.
        try { await withAlertStore((s) => { s.alertLog = []; s.unackedAlerts = 0; }); } catch (e) {}
        refreshBadge();
        sendResponse({ ok: true });
        break;
      }

      // ── Overlay / Manage quick controls (#10) ──
      case 'PAUSE_JOB': {
        const pTabId = senderTabId || msg.tabId;
        const job = activeJobs[pTabId] || await rehydrateJob(pTabId);
        if (!job) { sendResponse({ ok: false }); break; }
        job._manualPause = true;
        // Set the reason NOW rather than waiting for the next fireRefresh gate:
        // the gate's overlay notification is edge-only, and serializeJob reads
        // this for the popup/Manage paused badge.
        job._pauseReason = 'manual';
        clearAckBeeps(pTabId);
        clearDomScan(job); // paused = dormant; RESUME_JOB re-arms live watch
        const recheck = pauseRecheckMs(job.settings.currentInterval || computeInterval(job.settings), false);
        job.nextRefresh = Date.now() + recheck;
        scheduleNext(pTabId, recheck);
        // Freeze the in-page overlay too. A pause from the popup/Manage page
        // otherwise leaves the tab's countdown running until it drains to 0:00
        // and stalls (broadcastStatus reaches only extension pages, and the
        // fireRefresh gate won't re-signal — its edge already passed). Harmless
        // no-op when the pause originated from the overlay's own ⏸ button.
        sendOverlayPaused(pTabId, 'manual');
        await saveJobToStorage(pTabId, job.settings); // persist the pause flag (survives worker restart)
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }
      case 'RESUME_JOB': {
        const rTabId = senderTabId || msg.tabId;
        const job = activeJobs[rTabId] || await rehydrateJob(rTabId);
        if (!job) { sendResponse({ ok: false }); break; }
        job._manualPause = false;
        job._pauseReason = null; // clear the stale 'manual' reason so the UI doesn't show a resumed job as paused
        const interval = computeInterval(job.settings);
        job.nextRefresh = Date.now() + interval;
        scheduleNext(rTabId, interval);
        scheduleDomScan(rTabId); // re-arm live watch (no-op unless enabled)
        sendCountdownStart(rTabId, 0);
        await saveJobToStorage(rTabId, job.settings); // clear the persisted pause flag
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }
      case 'EXTEND_JOB': {
        // Push the next refresh out by a bounded amount (overlay "+30s"), without
        // changing the configured interval.
        const eTabId = senderTabId || msg.tabId;
        const job = activeJobs[eTabId] || await rehydrateJob(eTabId);
        if (!job) { sendResponse({ ok: false }); break; }
        const addMs = Math.min(60 * 60 * 1000, Math.max(1000, parseInt(msg.ms, 10) || 30000));
        job.nextRefresh = Math.max(job.nextRefresh, Date.now()) + addMs;
        // Invalidate any in-flight cycle's reschedule (same guard UPDATE_INTERVAL
        // uses). Without this, a +30s pressed while a refresh cycle is mid-flight
        // (its executeScript + reload can take seconds) is clobbered when that
        // cycle reaches its epoch-guarded reschedule and overwrites nextRefresh
        // with the pre-extend deadline — silently dropping the user's extension.
        job._epoch = (job._epoch || 0) + 1;
        scheduleNext(eTabId, Math.max(0, job.nextRefresh - Date.now()));
        // A paused job stays paused-looking: re-signal PAUSED instead of an
        // un-pausing COUNTDOWN_START (same contract as UPDATE_INTERVAL above).
        // The content script treats any COUNTDOWN_START as a real resume, and
        // the fireRefresh gate re-sends PAUSED only on a reason EDGE — so an
        // overlay un-paused here would show a live countdown draining to 0:00
        // for a job that never refreshes, with the pause button inverted.
        const extendPaused = job._manualPause ? 'manual' : (job._pauseReason || null);
        if (extendPaused) sendOverlayPaused(eTabId, extendPaused);
        else sendCountdownStart(eTabId, 0);
        await saveJobToStorage(eTabId, job.settings); // persist the extended deadline across worker restarts
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }
      default:
        // Unknown type: respond instead of leaving the caller's port hanging
        // until the worker dies ("message port closed").
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })().catch((e) => {
    // Without this, any rejection above (a chrome.* call failing mid-handler)
    // is an unhandled promise AND the caller never gets a response — its
    // callback/promise just hangs. Always settle the channel.
    console.warn('Message handler error', msg && msg.type, e);
    try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
  });
  return true; // Keep channel open for async
});
