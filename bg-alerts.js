// bg-alerts.js — alert delivery: offscreen audio, notifications, badge, alert journal, webhooks.
//
// A classic script loaded by background.js via importScripts: it shares the
// service worker's global scope (activeJobs, the ARP* modules, and the other
// bg-*.js files), so it is split out for readability, not isolation. Top-level
// code here must only register listeners and declare state — anything that
// touches background.js state runs later, from an event.

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
  if (closingOffscreen) await closingOffscreen; // let an in-flight teardown finish, then recreate
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
// In-flight closeDocument. Disarming the timer only helps while it hasn't
// fired; a beep landing while the close is already in flight would otherwise
// see hasDocument() still true (message lost to a closing document) or hit
// createDocument's "only a single offscreen document" rejection. ensureOffscreen
// awaits this first so a coinciding beep recreates the document instead.
let closingOffscreen = null;
function armOffscreenTeardown() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    offscreenIdleTimer = null;
    closingOffscreen = chrome.offscreen.closeDocument()
      .catch(() => {})
      .finally(() => { closingOffscreen = null; });
  }, OFFSCREEN_IDLE_MS);
  // Node's test harness should not stay alive for the browser-only idle
  // cleanup timer; Chrome timers do not expose `unref`, so this is a no-op there.
  if (offscreenIdleTimer && typeof offscreenIdleTimer.unref === 'function') {
    offscreenIdleTimer.unref();
  }
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
//
// The minimum reward/hour filter (minPayPerHour) rides on the same matcher, so
// every collect — start baseline, reload cycle, live-watch tick — applies both
// filters identically. A card below the minimum never enters the seen-set; if
// its pay is later raised past the minimum it fires as a new arrival.
function buildExcludeMatcher(settings) {
  const terms = ARPKeyword.compileMatcher({
    keyword: (settings && typeof settings.kwExclude === 'string') ? settings.kwExclude : '',
    kwCaseSensitive: !!(settings && settings.kwCaseSensitive),
    kwWholeWord: true,
  });
  const minPay = settings && Number(settings.minPayPerHour);
  if (!(minPay > 0)) return terms;
  return {
    ...terms,
    empty: false,
    test: (text) => terms.test(text) || ARPItemDetect.belowMinPay(text, minPay),
  };
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

// `openUrl` (optional): a study deep-link the click should open instead of
// focusing the tab. Kept in the warm map AND in session storage, because the
// click often comes minutes later, after the worker has idled out.
function notify(prefix, tabId, options, openUrl) {
  const id = ARPNotif.buildNotifId(prefix, tabId, Date.now());
  notifTabMap[id] = openUrl ? { tabId, openUrl } : { tabId };
  // Evict oldest (insertion-ordered keys) once over the cap.
  const ids = Object.keys(notifTabMap);
  if (ids.length > MAX_NOTIF_ENTRIES) delete notifTabMap[ids[0]];
  if (openUrl) rememberNotifUrl(id, openUrl);
  chrome.notifications.create(id, options);
  return id;
}

// Session-persisted notification id → study URL (bounded, newest kept).
const NOTIF_URLS_KEY = 'arpNotifUrls';
const MAX_NOTIF_URLS = 50;
const notifUrlMutex = ARPSerialize.createMutex();
function rememberNotifUrl(id, url) {
  return notifUrlMutex(async () => {
    try {
      const map = /** @type {Record<string, string>} */ ((await chrome.storage.session.get(NOTIF_URLS_KEY))[NOTIF_URLS_KEY] || {});
      map[id] = url;
      const ids = Object.keys(map);
      for (let i = 0; i < ids.length - MAX_NOTIF_URLS; i++) delete map[ids[i]];
      await chrome.storage.session.set({ [NOTIF_URLS_KEY]: map });
    } catch (e) { /* session storage unavailable — the warm map still works */ }
  });
}
// Look up and forget a notification's study URL ('' if none).
function takeNotifUrl(id) {
  const warm = notifTabMap[id] && notifTabMap[id].openUrl;
  return notifUrlMutex(async () => {
    let url = warm || '';
    try {
      const map = /** @type {Record<string, string>} */ ((await chrome.storage.session.get(NOTIF_URLS_KEY))[NOTIF_URLS_KEY] || {});
      if (!url && typeof map[id] === 'string') url = map[id];
      if (id in map) { delete map[id]; await chrome.storage.session.set({ [NOTIF_URLS_KEY]: map }); }
    } catch (e) {}
    return url;
  });
}

async function handleNotifClick(id) {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  const openUrl = await takeNotifUrl(id);
  delete notifTabMap[id];
  chrome.notifications.clear(id);
  clearUnacked(); // viewing an alert acknowledges the unacked badge count
  if (tabId == null && !openUrl) return;
  // A click is an acknowledgement — stop any repeat-until-ack beeping.
  if (tabId != null) clearAckBeeps(tabId);
  let windowId;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
    if (windowId != null) await chrome.windows.update(windowId, { focused: true });
    // A single new study: open IT (one click to the study) in a new tab beside
    // the watch, which keeps refreshing undisturbed. Re-validated: the link
    // came from page content.
    if (openUrl && ARPValidators.isSafeNavigableUrl(openUrl)) {
      await chrome.tabs.create({
        url: openUrl, active: true, windowId,
        index: Number.isInteger(tab.index) ? tab.index + 1 : undefined,
      });
      return;
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    // Watched tab gone: still honor the study link.
    if (openUrl && ARPValidators.isSafeNavigableUrl(openUrl)) {
      try { await chrome.tabs.create({ url: openUrl, active: true }); } catch (_) {}
    }
  }
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
  takeNotifUrl(id); // forget any study link
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

chrome.notifications.onClosed.addListener((id, byUser) => {
  const tabId = (notifTabMap[id] && notifTabMap[id].tabId) || ARPNotif.parseNotifTabId(id);
  takeNotifUrl(id); // forget any study link
  delete notifTabMap[id];
  // Only a USER dismissal is an acknowledgement. The OS auto-dismisses banners
  // after a few seconds (the norm on macOS even with requireInteraction) with
  // byUser=false — treating that as an ack would clear the overnight unacked
  // badge and kill the beep-until-ack loop with nobody at the keyboard.
  if (!byUser) return;
  clearUnacked();
  if (tabId != null) clearAckBeeps(tabId);
});

// A detecting job's watch has stopped working (sign-in page, captcha, page
// won't load). Journal + badge always; notification and webhook honor the
// same mutes as keyword alerts (snooze, quiet-hours notify channel).
async function deliverStallAlert(tabId, job, reasonText) {
  const meta = await tabMeta(tabId);
  await logAlert({ tabId, url: meta.url, title: meta.title, type: 'stall', snippet: reasonText });
  const snoozed = job._snoozeUntil && Date.now() < job._snoozeUntil;
  if (snoozed || ARPQuietHours.isChannelMuted(new Date(), job.settings.quietHours, 'notify')) return;
  sendWebhook(job, { tabId, type: 'stall', title: meta.title || meta.url, url: meta.url, reason: reasonText });
  notify('stall', tabId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Watch blocked',
    message: reasonText + '. Alerts can\'t fire until it\'s fixed.',
    requireInteraction: true,
    buttons: [{ title: 'Stop' }, { title: 'Snooze 15m' }],
  });
}

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
// opts.unacked === false records the entry without bumping the badge count
// (informational entries such as "watch resumed").
async function logAlert(entry, opts) {
  const bump = !(opts && opts.unacked === false);
  try {
    await withAlertStore((s) => {
      s.alertLog.push({
        ts: Date.now(),
        tabId: entry.tabId,
        url: String(entry.url || '').slice(0, 2048),
        title: String(entry.title || '').slice(0, 200),
        type: entry.type,                       // 'kw' | 'chg' | 'stall' | 'recovered'
        keyword: String(entry.keyword || '').slice(0, 200),
        snippet: String(entry.snippet || '').slice(0, 240),
      });
      if (bump) s.unackedAlerts = (s.unackedAlerts || 0) + 1;
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
// The body itself is built by the pure webhook-format.js (ARPWebhookFormat).
// Deliver one alert to the job's webhook. Never throws. A delivery that still
// fails after ARPWebhook's retries is recorded in the alert journal — a dead or
// rate-limited webhook is otherwise invisible until the user notices missing
// alerts on their phone.
//
// Deliveries to the SAME webhook URL run one at a time. Several tabs alerting in
// one burst would otherwise hit Discord/Slack concurrently and trip its rate
// limit together; queued, each waits for the previous one (including any 429
// Retry-After wait), so the burst is paced instead of partly dropped.
const webhookQueues = new Map(); // url → mutex
function webhookQueue(url) {
  let q = webhookQueues.get(url);
  if (!q) { q = ARPSerialize.createMutex(); webhookQueues.set(url, q); }
  return q;
}

// The webhooks an alert goes to: up to two independent slots ({ url, fmt }).
// Read from the CURRENT Settings at send time, so changing a URL (e.g. a
// tunnel that got a new hostname) takes effect for running jobs immediately.
// Only when Settings has never been saved does a job's start-time copy apply.
// Each URL is re-validated (https + SSRF guard) — storage could be poisoned.
async function webhookTargets(job) {
  let src = null;
  try { src = (await chrome.storage.local.get('globalSettings')).globalSettings || null; } catch (e) {}
  if (!src || typeof src !== 'object') src = (job && job.settings) || {};
  const out = [];
  for (const slot of ['', '2']) {
    const url = typeof src['webhookUrl' + slot] === 'string' ? src['webhookUrl' + slot].trim() : '';
    if (!url || !ARPValidators.isSafeWebhookUrl(url) || out.some((t) => t.url === url)) continue;
    const fmt = ['discord', 'slack', 'json'].includes(src['webhookFormat' + slot]) ? src['webhookFormat' + slot] : 'json';
    out.push({ url, fmt });
  }
  return out;
}

// Deliver one alert to every configured webhook, in parallel; one failing or
// slow endpoint never delays the other. Never throws. Returns one result per
// target (empty when no webhook is set).
async function sendWebhook(job, info) {
  const targets = await webhookTargets(job);
  return Promise.all(targets.map(async ({ url, fmt }) => {
    const body = ARPWebhookFormat.buildBody(fmt, info);
    const result = await webhookQueue(url)(() => ARPWebhook.deliver(url, body));
    if (!result.ok) {
      console.warn('Webhook delivery failed', result);
      await logWebhookFailure(info, result);
    }
    return result;
  }));
}

// Journal entry for a webhook that could not be delivered. Not counted as an
// unacked alert: the alert itself was already logged (and badged).
async function logWebhookFailure(info, result) {
  try {
    await withAlertStore((s) => {
      s.alertLog.push({
        ts: Date.now(),
        tabId: info.tabId,
        url: String(info.url || '').slice(0, 2048),
        title: String(info.title || '').slice(0, 200),
        type: 'webhook',
        keyword: '',
        snippet: ('Webhook not delivered: ' + result.error +
          ' after ' + result.attempts + ' attempt' + (result.attempts === 1 ? '' : 's')).slice(0, 240),
      });
    });
  } catch (e) { console.warn('logWebhookFailure failed', e); }
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
    chrome.runtime.sendMessage({
      // runtime.sendMessage broadcasts to extension contexts. The explicit
      // target keeps the service worker's generic message handler from winning
      // the response race and falsely acknowledging a beep the offscreen page
      // never received.
      target: 'offscreen',
      type: 'PLAY_BEEP',
      volume: opts.volume,
      tone: opts.tone,
      repeat: opts.repeat,
    }, () => {
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
