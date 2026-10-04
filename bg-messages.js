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
    // Instant live watch: tells the job page's content script to observe DOM changes.
    liveWatch: domScanEnabled(job) || undefined,
  };
}

function serializeJobs() {
  const out = {};
  for (const [tabId, job] of Object.entries(activeJobs)) out[tabId] = serializeJob(job);
  return out;
}

// ── Message handlers ───────────────────────────────────────────────────────
// One async handler per message type. Each receives the message and a context
// computed once by the router, and RETURNS the response object; the router
// sends it. Two tab resolutions are kept as they always were:
//   ctx.commandTabId — senderTabId ?? msg.tabId (Start / Stop)
//   ctx.targetTabId  — senderTabId || msg.tabId (everything else)
// senderTabId is set only for content scripts, whose tab always wins: a forged
// message from a compromised page process can only control its own tab. Our
// own pages (popup, Settings, Manage) leave it unset and name msg.tabId.
const MESSAGE_HANDLERS = {
  async START_REFRESH(msg, ctx) {
    const started = await startRefresh(ctx.commandTabId, msg.settings, ctx.startToken);
    if (started === 'denied') return { ok: false, denied: true };
    if (started === 'cancelled') return { ok: false, cancelled: true };
    return { ok: true, started: true };
  },

  async STOP_REFRESH(msg, ctx) {
    if (ctx.commandTabId != null) await stopRefresh(ctx.commandTabId);
    return { ok: true };
  },

  async GET_STATUS(msg, ctx) {
    // A GET_STATUS with no sender.tab comes from the popup/extension page (a
    // content-script sync always carries sender.tab) — the user is looking at
    // the UI, so acknowledge the unacked-alert badge (#1). Content-script
    // syncs must NOT clear it (the user hasn't seen anything yet).
    if (!ctx.senderTabId) clearUnacked();
    const tabId = ctx.targetTabId;
    const job = tabId && activeJobs[tabId] ? activeJobs[tabId] : null;
    return {
      jobs: serializeJobs(),
      job: job ? serializeJob(job) : null,
      // The overlay footer shows the toggle shortcut; content scripts can't
      // read chrome.commands themselves.
      hotkey: ctx.senderTabId ? await shortcutLabel() : undefined,
      // The overlay's lifetime detection count (keyword jobs only).
      detections: ctx.senderTabId && job ? await overlayDetections(job) : undefined,
    };
  },

  async STOP_ALL(msg, ctx) {
    // Rehydration can repopulate activeJobs between the router's synchronous
    // invalidation and this handler. Include those entries so a worker-restart
    // Stop All cannot leave a persisted job alive.
    const allStopTabs = [...new Set([
      ...ctx.stopAllTabs,
      ...Object.keys(activeJobs).map(Number),
    ])];
    for (const tabId of allStopTabs) await stopRefresh(tabId);
    return { ok: true };
  },

  async UPDATE_INTERVAL(msg, ctx) {
    // Restart the alarm with the new interval, preserving the existing job state
    // (refresh count, previousContent baseline, startUrl — just update the timing)
    const tabId = ctx.targetTabId;
    const job = activeJobs[tabId];
    if (!job) return { ok: false };

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
      job._excludeMatcher = buildExcludeMatcher(job.settings); // kwExclude / minPayPerHour changed
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
      scheduleNext(tabId, recheck);
      clearDomScan(job); // keep live watch disarmed while paused (resume re-arms it)
      sendOverlayPaused(tabId, pausedReason);
    } else {
      // Reschedule with the right mechanism for the new interval
      scheduleNext(tabId, newInterval);
      scheduleDomScan(tabId); // re-arm (or disarm) live watch per the new settings
      // Tell the content script to reset its countdown
      sendCountdownStart(tabId, 0);
    }
    await saveJobToStorage(tabId, job.settings);
    broadcastStatus();
    return { ok: true };
  },

  async TEST_WEBHOOK(msg, ctx) {
    // Settings page "Send test": POST a sample alert to the URL being edited,
    // through the same validation + delivery path as a real alert, and report
    // the outcome so a typo'd or deleted webhook is caught before it matters.
    // Extension pages only — a content script has no business probing URLs.
    const url = typeof msg.url === 'string' ? msg.url.trim() : '';
    if (ctx.senderTabId != null || !ARPValidators.isSafeWebhookUrl(url)) {
      return { ok: false, error: 'invalid webhook URL' };
    }
    const fmt = ['discord', 'slack', 'json'].includes(msg.format) ? msg.format : 'json';
    const body = ARPWebhookFormat.buildBody(fmt, {
      type: 'kw', title: 'Auto Refresh Pro', url: 'https://example.com/',
      keyword: 'test alert', count: 1,
    });
    const result = await ARPWebhook.deliver(url, body);
    return { ok: result.ok, status: result.status, attempts: result.attempts, error: result.error };
  },

  async DOM_MUTATED(msg, ctx) {
    // From the job page's content script only: the page changed, scan now.
    if (ctx.senderTabId == null) return { ok: false };
    requestMutationScan(ctx.senderTabId);
    return { ok: true };
  },

  async GET_ALL_JOBS() {
    return { jobs: serializeJobs() };
  },

  async CLEAR_ALERTS() {
    // Clear the alert journal + unacked count THROUGH the alert-log mutex, so
    // a "Clear" click can't interleave with an in-flight logAlert (a blind
    // storage.set from the Manage page would race the worker's RMW). The
    // storage.onChanged badge sync + Manage re-render follow from the write.
    try { await withAlertStore((s) => { s.alertLog = []; s.unackedAlerts = 0; }); } catch (e) {}
    refreshBadge();
    return { ok: true };
  },

  async RESET_DETECTIONS(msg, ctx) {
    // Manage page only — a page's content script must not wipe the count.
    if (ctx.senderTabId != null) return { ok: false };
    // Through the alert-log mutex, like CLEAR_ALERTS, so it can't interleave
    // with an in-flight logAlert bump.
    try { await withAlertStore((s) => { s.lifetimeDetections = 0; }); } catch (e) { return { ok: false }; }
    pushLifetimeDetections();
    return { ok: true };
  },

  // ── Overlay / Manage quick controls (#10) ──
  async PAUSE_JOB(msg, ctx) {
    const tabId = ctx.targetTabId;
    const job = activeJobs[tabId] || await rehydrateJob(tabId);
    if (!job) return { ok: false };
    job._manualPause = true;
    // Set the reason NOW rather than waiting for the next fireRefresh gate:
    // the gate's overlay notification is edge-only, and serializeJob reads
    // this for the popup/Manage paused badge.
    job._pauseReason = 'manual';
    clearAckBeeps(tabId);
    clearDomScan(job); // paused = dormant; RESUME_JOB re-arms live watch
    const recheck = pauseRecheckMs(job.settings.currentInterval || computeInterval(job.settings), false);
    job.nextRefresh = Date.now() + recheck;
    scheduleNext(tabId, recheck);
    // Freeze the in-page overlay too. A pause from the popup/Manage page
    // otherwise leaves the tab's countdown running until it drains to 0:00
    // and stalls (broadcastStatus reaches only extension pages, and the
    // fireRefresh gate won't re-signal — its edge already passed). Harmless
    // no-op when the pause originated from the overlay's own ⏸ button.
    sendOverlayPaused(tabId, 'manual');
    await saveJobToStorage(tabId, job.settings); // persist the pause flag (survives worker restart)
    broadcastStatus();
    return { ok: true };
  },

  async RESUME_JOB(msg, ctx) {
    const tabId = ctx.targetTabId;
    const job = activeJobs[tabId] || await rehydrateJob(tabId);
    if (!job) return { ok: false };
    job._manualPause = false;
    job._pauseReason = null; // clear the stale 'manual' reason so the UI doesn't show a resumed job as paused
    const interval = computeInterval(job.settings);
    job.nextRefresh = Date.now() + interval;
    scheduleNext(tabId, interval);
    scheduleDomScan(tabId); // re-arm live watch (no-op unless enabled)
    sendCountdownStart(tabId, 0);
    await saveJobToStorage(tabId, job.settings); // clear the persisted pause flag
    broadcastStatus();
    return { ok: true };
  },

  async EXTEND_JOB(msg, ctx) {
    // Push the next refresh out by a bounded amount (overlay "+30s"), without
    // changing the configured interval.
    const tabId = ctx.targetTabId;
    const job = activeJobs[tabId] || await rehydrateJob(tabId);
    if (!job) return { ok: false };
    const addMs = Math.min(60 * 60 * 1000, Math.max(1000, parseInt(msg.ms, 10) || 30000));
    job.nextRefresh = Math.max(job.nextRefresh, Date.now()) + addMs;
    // Invalidate any in-flight cycle's reschedule (same guard UPDATE_INTERVAL
    // uses). Without this, a +30s pressed while a refresh cycle is mid-flight
    // (its executeScript + reload can take seconds) is clobbered when that
    // cycle reaches its epoch-guarded reschedule and overwrites nextRefresh
    // with the pre-extend deadline — silently dropping the user's extension.
    job._epoch = (job._epoch || 0) + 1;
    scheduleNext(tabId, Math.max(0, job.nextRefresh - Date.now()));
    // A paused job stays paused-looking: re-signal PAUSED instead of an
    // un-pausing COUNTDOWN_START (same contract as UPDATE_INTERVAL above).
    // The content script treats any COUNTDOWN_START as a real resume, and
    // the fireRefresh gate re-sends PAUSED only on a reason EDGE — so an
    // overlay un-paused here would show a live countdown draining to 0:00
    // for a job that never refreshes, with the pause button inverted.
    const extendPaused = job._manualPause ? 'manual' : (job._pauseReason || null);
    if (extendPaused) sendOverlayPaused(tabId, extendPaused);
    else sendCountdownStart(tabId, 0);
    await saveJobToStorage(tabId, job.settings); // persist the extended deadline across worker restarts
    broadcastStatus();
    return { ok: true };
  },
};

// ── Router ─────────────────────────────────────────────────────────────────
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
  // Own-property lookup only: a message type like "constructor" or
  // "__proto__" must not reach an inherited Object property.
  const handler = typeof msg.type === 'string' && Object.hasOwn(MESSAGE_HANDLERS, msg.type)
    ? MESSAGE_HANDLERS[msg.type] : null;

  // A content script's sender carries its tab; bind such messages to THAT tab
  // regardless of any msg.tabId. Our own content script never sends a foreign
  // tabId, so this only constrains a forged message from a compromised page
  // process (which can imitate a content-script sender, but cannot fake
  // sender.tab) to controlling its own tab. Extension pages keep using
  // msg.tabId: Settings and Manage run in real tabs too, so they are told apart
  // by sender.url (see isExtensionPageSender) — binding them to sender.tab made
  // Manage's Stop/Pause/Resume/+30s act on the Manage tab itself.
  const senderTabId = ARPValidators.isExtensionPageSender(sender)
    ? undefined
    : (sender.tab && sender.tab.id);
  const commandTabId = senderTabId ?? msg.tabId;
  // Lifecycle bookkeeping runs SYNCHRONOUSLY, before any await: a Stop must
  // invalidate a pending Start before the Start's async work can publish it.
  const startToken = msg.type === 'START_REFRESH' && commandTabId != null
    ? lifecycleRegistry.begin(commandTabId)
    : null;
  const stopAllTabs = msg.type === 'STOP_ALL'
    ? [...new Set([
      ...Object.keys(activeJobs).map(Number),
      ...lifecycleRegistry.pendingTabIds(),
    ])]
    : [];
  if (msg.type === 'STOP_REFRESH' && commandTabId != null) {
    lifecycleRegistry.invalidate(commandTabId);
  } else if (msg.type === 'STOP_ALL') {
    for (const tabId of stopAllTabs) lifecycleRegistry.invalidate(tabId);
  }
  const ctx = {
    senderTabId,
    commandTabId,
    targetTabId: senderTabId || msg.tabId,
    startToken,
    stopAllTabs,
  };

  (async () => {
    await rehydrateAll(); // a restarted worker has an empty activeJobs; refill it
    // Unknown type: respond instead of leaving the caller's port hanging
    // until the worker dies ("message port closed").
    sendResponse(handler ? await handler(msg, ctx) : { ok: false, error: 'unknown message type' });
  })().catch((e) => {
    // Without this, any rejection above (a chrome.* call failing mid-handler)
    // is an unhandled promise AND the caller never gets a response — its
    // callback/promise just hangs. Always settle the channel.
    console.warn('Message handler error', msg && msg.type, e);
    try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
  });
  return true; // Keep channel open for async
});
