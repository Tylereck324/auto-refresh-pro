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

// In-memory store for active refresh jobs
// Structure: { tabId: { interval, nextRefresh, countdown, settings, alarmName } }
const activeJobs = {};

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

// Tear the offscreen document down after a quiet spell. Without this it lived
// forever after the first beep — a whole extra renderer process idling for the
// rest of the browser session. The window is generous enough that the longest
// repeat sequence (bounded ~10s in sounds.js) always finishes first; the next
// beep just recreates the document via ensureOffscreen.
const OFFSCREEN_IDLE_MS = 60000;
let offscreenIdleTimer = null;
function armOffscreenTeardown() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    offscreenIdleTimer = null;
    chrome.offscreen.closeDocument().catch(() => {});
  }, OFFSCREEN_IDLE_MS);
}

async function playBeep(opts = {}) {
  const { volume = 0.9, tone = 'beep', repeat = 1 } = opts;
  // Disarm any pending teardown BEFORE ensureOffscreen, so it can't close the
  // document between the hasDocument() check and the message delivery.
  if (offscreenIdleTimer) { clearTimeout(offscreenIdleTimer); offscreenIdleTimer = null; }
  try {
    await ensureOffscreen();
    return await deliverBeep({ volume, tone, repeat });
  } catch (e) {
    console.warn('Offscreen audio failed:', e);
    return false;
  } finally {
    armOffscreenTeardown();
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

// Compile the per-item exclusion matcher from a job's kwExclude terms ("skip
// items containing …" — comma-separated, like the keyword). An item the keyword
// accepts is dropped when this matcher ALSO accepts it. Always compiled as
// literal terms with whole-word boundaries — deliberately NOT inheriting
// kwWholeWord/kwRegex: the headline use is excluding numeric phrases like
// "1 place" (a broken single-slot listing), and as a plain substring that term
// is CONTAINED in "21 places"/"61 places"/"121 places", silently skipping the
// exact items the user is hunting. Case sensitivity does follow the keyword's
// flag. Empty kwExclude compiles to the empty matcher (test() → false), which
// collectMatches treats as "exclude nothing".
function buildExcludeMatcher(settings) {
  return ARPKeyword.compileMatcher({
    keyword: (settings && typeof settings.kwExclude === 'string') ? settings.kwExclude : '',
    kwCaseSensitive: !!(settings && settings.kwCaseSensitive),
    kwWholeWord: true,
  });
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
  clearUnacked(); // viewing an alert acknowledges the unacked badge count
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

// Action buttons on keyword/change notifications (#2): button 0 = Stop the job,
// button 1 = Snooze its alerts for 15 minutes. For an away-from-tab monitoring
// tool the notification IS the interaction surface — without this the only action
// is click-to-focus, so you can't quiet a flickering keyword without hunting for
// the tab. Tab id is recovered the same way as a click (warm map → encoded id),
// so the buttons still work after a worker restart.
chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  delete notifTabMap[id];
  chrome.notifications.clear(id);
  clearUnacked();
  if (tabId == null) return;
  clearAckBeeps(tabId);
  if (buttonIndex === 0) {
    await stopRefresh(tabId);
  } else if (buttonIndex === 1) {
    const job = activeJobs[tabId] || await rehydrateJob(tabId);
    if (job) {
      job._snoozeUntil = Date.now() + SNOOZE_MS;
      // Persist: the MV3 worker idles out within ~30s, so an in-memory-only
      // snooze would silently un-mute on the next alarm-driven restart — the
      // one window where snooze matters most (user is away from the tab).
      await saveJobToStorage(tabId, job.settings);
    }
  }
});

chrome.notifications.onClosed.addListener((id) => {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  delete notifTabMap[id];
  clearUnacked();
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

// How long a notification "Snooze" button mutes a job's alerts (#2).
const SNOOZE_MS = 15 * 60 * 1000;

// ── Toolbar badge: live state + unacked-alert indicator (#1) ─────────────────
// The action icon is the cheapest persistent "something happened" signal — every
// other alert (sound, OS notification, screen flash) is ephemeral, so a missed
// one leaves no trace. Shows a neutral count of active jobs normally, flipping to
// a red unacknowledged-alert count when a keyword/change fires. The unacked count
// is persisted (unackedAlerts) so it survives a worker restart; the badge text
// itself is browser UI state that also persists, but recomputing it on every
// start/stop/fire/ack/rehydrate keeps it honest.
let unackedMirror = 0; // in-memory mirror of the persisted unackedAlerts counter
function refreshBadge() {
  try {
    const active = Object.keys(activeJobs).length;
    if (unackedMirror > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // red — needs attention
      chrome.action.setBadgeText({ text: String(Math.min(unackedMirror, 999)) });
    } else if (active > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' }); // blue — running
      chrome.action.setBadgeText({ text: String(active) });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* chrome.action unavailable (shouldn't happen with action declared) */ }
}

// ── Alert + change journal (#3) ──────────────────────────────────────────────
// A ring-buffered log of keyword/change detections, persisted so the ephemeral
// beep becomes an auditable trail (the headline gap for the overnight restock /
// price-watch use case) and the opaque "a change was detected" string gains a
// diff snippet of WHAT changed. Its own mutex — NOT jobsStoreMutex — so a
// multi-tab burst of concurrent fires can't interleave with (and clobber) the
// jobs-map read-modify-write, or vice-versa.
const alertLogMutex = ARPSerialize.createMutex();
const MAX_ALERT_LOG = 200;
function withAlertStore(mutate) {
  return alertLogMutex(async () => {
    const data = await chrome.storage.local.get(['alertLog', 'unackedAlerts']);
    const store = {
      alertLog: Array.isArray(data.alertLog) ? data.alertLog : [],
      unackedAlerts: Number(data.unackedAlerts) || 0,
    };
    await mutate(store);
    // Oldest-evicted ring buffer (keep the newest MAX_ALERT_LOG).
    if (store.alertLog.length > MAX_ALERT_LOG) {
      store.alertLog = store.alertLog.slice(store.alertLog.length - MAX_ALERT_LOG);
    }
    if (store.unackedAlerts < 0) store.unackedAlerts = 0;
    unackedMirror = store.unackedAlerts;
    await chrome.storage.local.set({ alertLog: store.alertLog, unackedAlerts: store.unackedAlerts });
    return store;
  });
}
// Record one detection and bump the unacked counter. Every field is bounded so a
// hostile page's title/url/snippet can't bloat the persisted log.
async function logAlert(entry) {
  try {
    await withAlertStore((s) => {
      s.alertLog.push({
        ts: Date.now(),
        tabId: entry.tabId,
        url: String(entry.url || '').slice(0, 2048),
        title: String(entry.title || '').slice(0, 200),
        type: entry.type,                       // 'kw' | 'chg'
        keyword: String(entry.keyword || '').slice(0, 200),
        snippet: String(entry.snippet || '').slice(0, 240),
      });
      s.unackedAlerts = (s.unackedAlerts || 0) + 1;
    });
  } catch (e) { console.warn('logAlert failed', e); }
  refreshBadge();
}
// Clear the unacked count once the user has seen the alerts (notification ack,
// or the popup opening via GET_STATUS).
async function clearUnacked() {
  if (unackedMirror === 0) return;
  try { await withAlertStore((s) => { s.unackedAlerts = 0; }); } catch (e) {}
  refreshBadge();
}
// Load the persisted unacked counter into the in-memory mirror after a restart.
async function loadUnacked() {
  try {
    const data = await chrome.storage.local.get('unackedAlerts');
    unackedMirror = Number(data.unackedAlerts) || 0;
  } catch (e) {}
  refreshBadge();
}
// Capture a tab's URL/title for a log entry / webhook without throwing if it's gone.
async function tabMeta(tabId) {
  try { const t = await chrome.tabs.get(tabId); return { url: t.url || '', title: t.title || '' }; }
  catch (e) { return { url: '', title: '' }; }
}

// ── Outbound webhook alerts (#6) ─────────────────────────────────────────────
// Reach the user when they're away from the tab (Discord / Slack / generic JSON
// POST). The URL is re-validated here (https-only + SSRF guard) even though it
// was validated on input — defense in depth against a poisoned storage value.
// fetch is AWAITED (a fire-and-forget fetch is cut off when the worker idles out)
// behind an AbortController timeout so a hung endpoint can't wedge the cycle.
//
// When the alert carries per-item arrivals (info.items — each { href, text }),
// the message is upgraded to a one-tap form: a Discord embed / Slack link per
// study, so tapping it on a phone lands on the study itself, not the listing
// page. With no items it emits exactly the legacy flat message.
//
// Per-item alert renders at most this many arrivals inline; a larger burst is
// summarized as "…and N more" so one cycle can't exceed Discord/Slack limits.
const WEBHOOK_ITEM_CAP = 5;

// Slack mrkdwn treats & < > as control characters and uses <url|label> for
// links, so a label carrying any of them corrupts parsing. Escape the three and
// neutralize a stray pipe.
function slackEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/');
}

// Parse one arrival's card text into { meta, detail }: meta is the raw optional
// fields (title/pay/places/researcher); detail is a compact "£/hr · N places ·
// By X" one-liner for the alert body ('' when nothing parsed).
function webhookItemDetail(text) {
  const meta = ARPItemDetect.parseItemMeta(text || '');
  const parts = [];
  if (meta.pay) parts.push(meta.pay);
  if (meta.places) parts.push(meta.places);
  if (meta.researcher) parts.push('By ' + meta.researcher);
  return { meta, detail: parts.join(' · ') };
}

async function sendWebhook(job, info) {
  const url = job.settings && job.settings.webhookUrl;
  if (!url || !ARPValidators.isSafeWebhookUrl(url)) return;
  const fmt = job.settings.webhookFormat || 'json';
  const line = info.type === 'kw'
    ? ('🔔 Keyword ' + (info.inverse ? 'disappeared from' : 'found on') + ' “' + info.title + '”: ' + info.keyword)
    : ('🔔 Page changed: “' + info.title + '”' + (info.snippet ? ('\n' + info.snippet) : ''));
  const message = line + '\n' + info.url;

  // Per-item arrivals carry their own deep-link (the study), so when present we
  // render a richer one-tap payload instead of the flat listing-page line. Only
  // arrivals reach here (inverse/departures pass no items), so an item with no
  // usable link still shows its title. Absent items ⇒ exactly the legacy message.
  const items = Array.isArray(info.items) ? info.items.filter(it => it && it.text) : [];
  const shown = items.slice(0, WEBHOOK_ITEM_CAP);
  const more = items.length - shown.length;
  const summary = '🔔 ' + items.length + ' new for “' + (info.keyword || '') + '”'
    + (info.title ? (' on ' + info.title) : '');

  let body;
  if (fmt === 'discord') {
    if (shown.length) {
      const embeds = shown.map((it) => {
        const { meta, detail } = webhookItemDetail(it.text);
        const embed = { title: (meta.title || info.keyword || 'New match').slice(0, 256) };
        if (it.href && ARPValidators.isSafeNavigableUrl(it.href)) embed.url = it.href;
        if (detail) embed.description = detail.slice(0, 4096);
        return embed;
      });
      let content = summary;
      if (more > 0) content += '\n…and ' + more + ' more';
      body = { content: content.slice(0, 2000), embeds };
    } else {
      body = { content: message };
    }
  } else if (fmt === 'slack') {
    if (shown.length) {
      const rows = shown.map((it) => {
        const { meta, detail } = webhookItemDetail(it.text);
        const label = slackEscape((meta.title || 'match').slice(0, 200));
        const linked = (it.href && ARPValidators.isSafeNavigableUrl(it.href))
          ? ('<' + it.href + '|' + label + '>') : label;
        return '• ' + linked + (detail ? (' — ' + slackEscape(detail)) : '');
      });
      if (more > 0) rows.push('…and ' + more + ' more');
      body = { text: slackEscape(summary) + '\n' + rows.join('\n') };
    } else {
      body = { text: message };
    }
  } else {
    body = {
      event: info.type === 'kw' ? 'keyword' : 'change',
      title: info.title, url: info.url, keyword: info.keyword,
      snippet: info.snippet || '', count: info.count, timestamp: Date.now(),
      items: shown.map((it) => {
        const { meta } = webhookItemDetail(it.text);
        return {
          title: meta.title || '',
          url: (it.href && ARPValidators.isSafeNavigableUrl(it.href)) ? it.href : '',
          pay: meta.pay || '', places: meta.places || '', researcher: meta.researcher || '',
        };
      }),
      itemsTruncated: more > 0 ? more : 0,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      // SSRF defense: refuse redirects. isSafeWebhookUrl only vets the INITIAL
      // URL — without this a public endpoint could 30x-redirect the POST to
      // http://169.254.169.254/… and fetch would transparently re-send the body
      // to the internal target. Real webhooks (Discord/Slack/generic) never
      // legitimately redirect.
      redirect: 'error',
    });
  } catch (e) {
    console.warn('Webhook delivery failed', e);
  } finally {
    clearTimeout(timer);
  }
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
    if (ARPGuards.shouldNotifyRefresh(job._lastRefreshNotify, now, REFRESH_NOTIFY_MIN_GAP_MS)) {
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
        const node = nodes[i];
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
          const a = (node.tagName === 'A' && node.href) ? node
            : (node.querySelector && node.querySelector('a[href]'))
            || (node.closest && node.closest('a[href]'));
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
      const nodes = document.querySelectorAll(selector);
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
  // Journal + unacked badge — independent of delivery suppression, so a muted
  // overnight hit is still captured.
  const meta = await tabMeta(tabId);
  await logAlert({ tabId, url: meta.url, title: meta.title, type: 'kw', keyword: job.settings.keyword, snippet: opts.snippet || '' });
  // Outbound webhook (not awaited: its internal fetch is timed-out, and blocking
  // the reload on a slow endpoint would stall the cycle).
  if (!muted('notify')) sendWebhook(job, { type: 'kw', title: meta.title || meta.url, url: meta.url, keyword: job.settings.keyword, inverse: !!job.settings.kwInverse, count: job.keywordCount, items: opts.items });
  if (job.settings.sound && !muted('sound')) await playBeep(soundOpts(job.settings));
  const verb = job.settings.kwInverse ? 'disappeared from' : 'found on';
  if (!muted('notify')) notify('kw', tabId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Keyword Detected!',
    message: opts.message || ('"' + job.settings.keyword + '" ' + verb + ' page!'),
    requireInteraction: true,                              // persist until acted on (Win/Linux/ChromeOS)
    buttons: [{ title: 'Stop' }, { title: 'Snooze 15m' }], // #2 actionable buttons
  });
  // Screen-edge flash: with stopOnKeyword the page stays put, so flash the
  // still-live content script now. Otherwise the reload below would destroy the
  // flash mid-animation — defer it until after doRefresh (see _pendingFlash).
  // Muted-flash collapses to flashOnKeyword=false ⇒ computeFlashDelivery 'none'.
  const flashPlan = ARPMonitor.computeFlashDelivery({
    fired: true,
    flashOnKeyword: job.settings.flashOnKeyword && !muted('flash'),
    stopOnKeyword: job.settings.stopOnKeyword,
  });
  if (flashPlan === 'now') sendKeywordFlash(tabId, 0);
  else if (flashPlan === 'after-reload') job._pendingFlash = true;
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
}

// One live-watch tick: read the per-item array, diff against the shared
// _seenKeys baseline, alert on arrivals/departures, re-arm. Mirrors the
// per-item branch of doMonitorRefresh minus the reload — both paths advance the
// SAME baseline, so whichever observes a new item first alerts and the other
// stays silent (the diff-then-advance section is synchronous, so an overlapping
// reload cycle can't double-fire).
async function doDomScan(tabId) {
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
      if (activeJobs[tabId] === job && Array.isArray(raw)) {
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
          // No reload is coming, so a flash the deliverer deferred to
          // "after-reload" (it assumes the cycle path) must fire now.
          if (job._pendingFlash) { job._pendingFlash = false; sendKeywordFlash(tabId, 0); }
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

async function doMonitorRefresh(tabId, job) {
  // A keyword takes precedence over generic change-monitoring. When one is set,
  // the keyword is the signal of interest, so we skip the page-change path
  // entirely below — otherwise every dynamic page (timestamps, ads, counters)
  // would beep on essentially every reload regardless of the keyword.
  // The matcher (multi-keyword / whole-word / case / regex) is compiled once at
  // job start and cached on job._matcher; recompile lazily if it's missing.
  const matcher = job._matcher || (job._matcher = buildMatcher(job.settings));
  const hasKeyword = matcher.ok && !matcher.empty;

  // Step 1: Read current page content BEFORE reloading.
  // Sound must also fire BEFORE reload — the content script is destroyed during navigation.
  // Per-item detection ("alert on each new match") needs a LIVE keyword matcher
  // AND a selector (each matched element is one item); when on, readPageText
  // returns one entry per element instead of a single blob so we can diff which
  // items are present. Gated on the compiled matcher — not the raw keyword text
  // — so a refused/broken regex or a degenerate keyword falls through to the
  // string path, where change detection (monitorMode) still runs instead of
  // being silently swallowed by an alert path that can never match.
  const perItem = !!(job.settings.kwPerItem && job.settings.watchSelector && hasKeyword);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageText,
      args: [job.settings.watchSelector || '', perItem], // scoped detection ('' = whole body)
    });
  } catch (e) {
    // Page won't script (chrome://, web store, error page, hang). Count it so the
    // failure backoff (#9) in fireRefresh ramps the interval instead of hammering
    // a page that will never yield a read.
    job._consecutiveFailures = (job._consecutiveFailures || 0) + 1;
    await doRefresh(tabId, job);
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
  // initialContent guard: skip detection, keep the old baseline, just reload.
  // String path: a failed read IS the empty string. Per-item path: a failed read
  // is null (→ '' above); an EMPTY ARRAY is a real "rendered page, zero items"
  // observation and must flow through — it is the state an alert-on-arrival
  // watch typically starts from, and in inverse mode it is the fire condition.
  if (perItem ? !Array.isArray(currentContent) : currentContent.length === 0) {
    await doRefresh(tabId, job);
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
    // Reload + deliver any deferred (after-reload) flash, mirroring the tail of
    // the string path below.
    await doRefresh(tabId, job);
    if (job._pendingFlash) { job._pendingFlash = false; sendKeywordFlash(tabId, 0); }
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
      await logAlert({ tabId, url: meta.url, title: meta.title, type: 'chg', snippet: diff.summary });
      if (!muted('notify')) sendWebhook(job, { type: 'chg', title: meta.title || meta.url, url: meta.url, snippet: diff.summary, count: job.refreshCount });
      if (job.settings.sound && !muted('sound')) await playBeep(soundOpts(job.settings));
      if (!muted('notify')) notify('chg', tabId, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Page Changed!',
        message: diff.summary ? ('Changed: ' + diff.summary) : 'A change was detected on the monitored page.',
        requireInteraction: true,
        buttons: [{ title: 'Stop' }, { title: 'Snooze 15m' }],
      });
      if (job.settings.stopOnChange) {
        await stopRefresh(tabId);
        return;
      }
      if (!muted('sound')) startAckBeeps(tabId); // repeat beep until acknowledged (if enabled)
    }
  }

  // Save snapshot then reload (non-empty — the empty-read guard above returned
  // early, so '' can never become the baseline).
  job.previousContent = currentContent;
  await doRefresh(tabId, job);

  // Deliver the flash deferred at fire time. Cleared on consumption (not on
  // ack) so a delivery that exhausts its retries can't flash on a later cycle.
  if (job._pendingFlash) {
    job._pendingFlash = false;
    sendKeywordFlash(tabId, 0);
  }
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
    // pendingUrl: an auto-start job is created right after chrome.tabs.create,
    // while the tab is still loading — url is '' but pendingUrl has the target.
    // Without the fallback such jobs get startUrl null, permanently disabling
    // the navigate-away stop and the restart-time identity check (restoreJobs).
    startUrl = tab.url || tab.pendingUrl || null;
  } catch (e) {}

  // Domain denylist (#7): never attach a job to a user-blocked origin. This ONE
  // guard covers every launch path — popup, hotkey, URL rule, auto-start — because
  // they all funnel through startRefresh. Checked BEFORE the baseline executeScript
  // so a denied page (bank, webmail, health portal) is never even read.
  if (startUrl) {
    const { domainDenylist = [] } = await chrome.storage.local.get('domainDenylist');
    if (ARPValidators.isUrlDenied(startUrl, domainDenylist)) {
      chrome.tabs.sendMessage(tabId, { type: 'STOPPED' }).catch(() => {}); // clear any overlay
      return false;
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
    initialContent = null; // not scriptable — skip alert on first cycle (seenKeys stays null too)
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
  return true;
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
      if (attempt === 0) {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
          .catch(() => {});
      }
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendKeywordFlash(tabId, attempt + 1), delay);
      }
    }
  });
}

async function stopRefresh(tabId) {
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

// ── Storage helpers ────────────────────────────────────────────────────────
// Every activeJobs read-modify-write goes through this single mutex. Without it,
// two concurrent saves (e.g. two tabs refreshing at once) interleave get→set and
// the second write clobbers the first tab's entry — silently un-persisting a live
// job so it's lost on the next worker restart. withJobsStore re-reads inside the
// lock, so each mutation sees the previous one's result.
const jobsStoreMutex = ARPSerialize.createMutex();
// Count of our own in-flight activeJobs writes, so the storage.onChanged
// listener can tell them apart from an out-of-band write. Without this, every
// saveJobToStorage (one per refresh cycle) flipped jobsStoreFresh and forced the
// next message to re-read the whole activeJobs blob — including each job's
// up-to-200k-char detection baseline — for data this worker just wrote itself.
let selfJobsWrites = 0;
function withJobsStore(mutate) {
  return jobsStoreMutex(async () => {
    const data = await chrome.storage.local.get('activeJobs');
    const jobs = data.activeJobs || {};
    await mutate(jobs);
    selfJobsWrites++;
    try {
      await chrome.storage.local.set({
        activeJobs: jobs,
        // Tiny URL index for the content script's page-load gate: it reads this
        // (a storage read never wakes the worker) and only sends GET_STATUS when
        // the page's origin+path matches a job — instead of waking the worker on
        // every page load in every tab. Kept in the same set() as activeJobs so
        // the two can't drift.
        activeJobUrls: [...new Set(
          Object.values(jobs).map((j) => j && j.startUrl).filter(Boolean)
        )],
      });
    } catch (e) {
      selfJobsWrites--;
      throw e;
    }
  });
}

async function saveJobToStorage(tabId, settings) {
  // Persist the detection baseline for monitor/keyword jobs. Without it, every
  // alarm-driven cycle at intervals past the MV3 idle timeout rehydrates with no
  // baseline, monitor-decision refuses to fire, and detection silently never
  // works. Plain refresh jobs skip it — no detection, no point paying the write.
  // readPageText caps the snapshot at 200k chars, bounding this write.
  const monitors = !!(settings && (settings.monitorMode ||
    (typeof settings.keyword === 'string' && settings.keyword.trim())));
  await withJobsStore((jobs) => {
    const job = activeJobs[tabId];
    jobs[tabId] = {
      settings,
      refreshCount: (job && job.refreshCount) || 0,
      keywordCount: (job && job.keywordCount) || 0,
      nextRefresh: (job && job.nextRefresh) || (Date.now() + computeInterval(settings)),
      startUrl: (job && job.startUrl) || null, // navigate-away baseline across restarts
      previousContent: (monitors && job && typeof job.previousContent === 'string')
        ? job.previousContent : null, // keyword/change baseline across restarts
      // Per-item detection baseline: the seen matching-item keys, so a worker
      // restart mid-session doesn't re-alert for every item already on the page.
      // Keys are short hashes; cap the count to bound the write (readPageText
      // already caps items at 500, so this is just defense in depth).
      seenKeys: (job && Array.isArray(job._seenKeys)) ? job._seenKeys.slice(0, 1000) : null,
      // Adaptive-backoff streak (#8): persist so the ramp resumes at the right
      // step after a worker restart at long (alarm-driven) intervals, instead of
      // snapping back to the fast base every time the worker idles out.
      noChangeStreak: (job && Number(job._noChangeStreak)) || 0,
      // Manual pause (#10): persist so a job paused via the overlay/Manage stays
      // paused across a worker restart instead of silently resuming (the
      // alarm-backed recheck lets the MV3 worker idle out). Quiet/offline pauses
      // are re-derived from the clock/navigator.onLine and need no persistence.
      manualPause: !!(job && job._manualPause),
      // Navigate-away pause (#12): persist so an away pause survives a worker
      // restart — the rehydrated job stays dormant on the wrong page (no baseline
      // poisoning, no repeat notification) until a resume edge fires. Quiet/
      // offline pauses are re-derived and need no persistence; 'away' can't be
      // re-derived without a tabs.get, and losing it would re-notify per restart.
      awayPause: !!(job && job._pauseReason === 'away'),
      // Snooze deadline (#2): persist so a 15-minute snooze outlives the
      // worker (which idles out in ~30s). Expired deadlines are dropped at
      // rehydrate time; the job's stop path deletes the whole entry.
      snoozeUntil: (job && Number(job._snoozeUntil)) || 0,
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
// this worker (withJobsStore), which mirrors every mutation in memory. So once
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
    // Our own writes (withJobsStore mirrors every mutation in memory first)
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
chrome.runtime.onInstalled.addListener(() => restoreJobs({ autoStart: false }));

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
      sendCountdownStart(tabId, 0);
    }
  }
  broadcastStatus();
  refreshBadge();

  if (!autoStart) return;

  // Auto-start URLs. Only open entries whose URL is a safe http(s) navigation —
  // a poisoned storage value (e.g. an imported javascript:/file: URL) must never
  // be auto-opened on browser startup — and never one on the denylist (#7).
  const autoStartUrls = data.autoStartUrls || [];
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
  (async () => {
    await rehydrateAll(); // a restarted worker has an empty activeJobs; refill it
    switch (msg.type) {
      case 'START_REFRESH': {
        // startRefresh returns false when the URL is on the domain denylist (#7),
        // so the popup can surface "disabled on this site" instead of silently
        // showing no job.
        const started = await startRefresh(senderTabId || msg.tabId, msg.settings);
        sendResponse({ ok: started !== false, denied: started === false });
        break;
      }
      case 'STOP_REFRESH': {
        const stopTabId = senderTabId || msg.tabId;
        if (stopTabId) await stopRefresh(stopTabId);
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
          job: resolvedTabId && activeJobs[resolvedTabId] ? serializeJob(activeJobs[resolvedTabId]) : null
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
        const updateTabId = senderTabId || msg.tabId;
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
        job._excludeMatcher = buildExcludeMatcher(job.settings); // kwExclude too
        job._prevFound = undefined; // cached verdict is for the OLD matcher — re-judge
        // Per-item seen-set is keyed by the OLD keyword/selector; a changed
        // keyword would make every new-keyword match look "new" and fire a burst.
        // Drop it so the next cycle re-establishes a fresh baseline (no fire),
        // mirroring the _prevFound reset above.
        job._seenKeys = null;
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

      case 'HOTKEY_TOGGLE': {
        // Triggered by the custom in-page keybinding
        const toggleTabId = sender.tab && sender.tab.id;
        if (!toggleTabId) { sendResponse({ ok: false }); break; }
        if (activeJobs[toggleTabId]) {
          await stopRefresh(toggleTabId);
        } else {
          // Compose the job exactly the way the popup does — the per-launch state
          // from popupSettings (s) plus the refresh-behavior defaults from
          // globalSettings (g) — via the single shared constructor, so a hotkey
          // launch can never drift from a popup launch.
          const data = await chrome.storage.local.get(['popupSettings', 'globalSettings']);
          await startRefresh(toggleTabId, ARPCompose.composeJobSettings(data.popupSettings || {}, data.globalSettings || {}));
        }
        sendResponse({ ok: true });
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
        clearAckBeeps(pTabId);
        clearDomScan(job); // paused = dormant; RESUME_JOB re-arms live watch
        const recheck = pauseRecheckMs(job.settings.currentInterval || computeInterval(job.settings), false);
        job.nextRefresh = Date.now() + recheck;
        scheduleNext(pTabId, recheck);
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
        sendCountdownStart(eTabId, 0);
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
