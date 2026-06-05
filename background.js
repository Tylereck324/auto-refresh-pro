// background.js - Service Worker for Auto Refresh Pro

// In-memory store for active refresh jobs
// Structure: { tabId: { interval, nextRefresh, countdown, settings, alarmName } }
const activeJobs = {};

// ── Offscreen audio ────────────────────────────────────────────────────────
// Service workers can't play audio directly. We use an offscreen document
// (Chrome 116+) which has full audio access and no gesture-policy restrictions.

async function playBeep() {
  try {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play keyword-detected alert beep'
      });
    }
    chrome.runtime.sendMessage({ type: 'PLAY_BEEP' }).catch(() => {});
  } catch (e) {
    console.warn('Offscreen audio failed:', e);
  }
}

// ── Alarm handler ──────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('refresh_')) return;
  const tabId = parseInt(alarm.name.replace('refresh_', ''));
  const job = activeJobs[tabId];
  if (!job) return;

  job.refreshCount = (job.refreshCount || 0) + 1;

  // Compute next interval (random or fixed)
  const nextInterval = computeInterval(job.settings);
  job.settings.currentInterval = nextInterval;

  try {
    // Run keyword/monitor check if: keyword is set, OR monitor-change mode is on
    const hasKeyword = job.settings.keyword && job.settings.keyword.trim().length > 0;
    const hasMonitor = job.settings.monitorMode || job.settings.monitorChange;
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

  // Reschedule
  if (activeJobs[tabId]) {
    chrome.alarms.create(alarm.name, { delayInMinutes: nextInterval / 60000 });
    activeJobs[tabId].nextRefresh = Date.now() + nextInterval;
  }

  // Notify content script of countdown start.
  // Small head-start delay: the page just reloaded so tab.status is 'loading'.
  // sendCountdownStart will poll tab.status and retry until it's 'complete'.
  setTimeout(() => sendCountdownStart(tabId, nextInterval, 0), 300);
});

async function doRefresh(tabId, job) {
  if (job.settings.hardRefresh) {
    // Hard refresh: bypass cache
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } else {
    await chrome.tabs.reload(tabId);
  }

  // Notification
  if (job.settings.notify) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Auto Refresh Pro',
      message: `Page refreshed (${job.refreshCount} times)`
    });
  }
  // NOTE: Sound is intentionally NOT played here.
  // Sound only fires when a keyword is detected or a page change is found.
}

async function doMonitorRefresh(tabId, job) {
  // Step 1: Read current page content BEFORE reloading.
  // Sound must also fire BEFORE reload — the content script is destroyed during navigation.
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ text: document.body ? document.body.innerText : '' })
    });
  } catch (e) {
    await doRefresh(tabId, job);
    return;
  }

  const pageData = results && results[0] && results[0].result;
  const currentContent = pageData ? pageData.text : '';
  const prevContent = job.previousContent; // null/undefined = no baseline yet

  // ── Keyword detection ──
  // Only alert when we have a real previous snapshot AND the keyword
  // transitions from absent to present between cycles.
  if (job.settings.keyword) {
    const kw        = job.settings.keyword.toLowerCase();
    const foundNow  = currentContent.toLowerCase().includes(kw);
    const hasBaseline = prevContent !== null && prevContent !== undefined;
    const foundPrev   = hasBaseline && prevContent.toLowerCase().includes(kw);

    if (foundNow && hasBaseline && !foundPrev) {
      if (job.settings.sound) await playBeep();
      chrome.notifications.create('kw_' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Keyword Detected!',
        message: '"' + job.settings.keyword + '" found on page!'
      });
      if (job.settings.stopOnKeyword) {
        await stopRefresh(tabId);
        return;
      }
    }
  }

  // ── Page change detection ──
  // Only alert when we have a real baseline and content actually changed.
  if (job.settings.monitorChange && prevContent !== null && prevContent !== undefined) {
    if (currentContent !== prevContent) {
      if (job.settings.sound) await playBeep();
      chrome.notifications.create('chg_' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Page Changed!',
        message: 'A change was detected on the monitored page.'
      });
      if (job.settings.stopOnChange) {
        await stopRefresh(tabId);
        return;
      }
    }
  }

  // Save snapshot then reload
  job.previousContent = currentContent;
  await doRefresh(tabId, job);
}

function computeInterval(settings) {
  if (settings.randomTimer) {
    const min = settings.randomMin || 5000;
    const max = settings.randomMax || 30000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  return settings.interval;
}

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
      func: () => document.body ? document.body.innerText : null
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
    previousContent: initialContent  // null = no baseline yet, skip first cycle
  };

  chrome.alarms.create(`refresh_${tabId}`, { delayInMinutes: interval / 60000 });

  // Notify content script — retry until it responds, since the content script
  // may not be injected yet (tab still loading) when Start is pressed.
  sendCountdownStart(tabId, interval, 0);

  // Persist to storage
  await saveJobToStorage(tabId, settings);
  broadcastStatus();
}

async function sendCountdownStart(tabId, duration, attempt) {
  if (!activeJobs[tabId]) return;

  // Wait until the tab has finished loading before trying to message the content script.
  // This handles the post-reload case where the alarm fires but the new page isn't ready.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') {
      // Page still loading — wait and retry
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendCountdownStart(tabId, duration, attempt + 1), delay);
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
  chrome.tabs.sendMessage(tabId, { type: 'COUNTDOWN_START', duration, stopOnClick }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // Content script not ready yet — retry
      if (attempt < 12) {
        const delay = Math.min(150 * Math.pow(1.6, attempt), 1500);
        setTimeout(() => sendCountdownStart(tabId, duration, attempt + 1), delay);
      }
    }
  });
}

async function stopRefresh(tabId) {
  if (activeJobs[tabId]) {
    chrome.alarms.clear(`refresh_${tabId}`);
    delete activeJobs[tabId];
  }
  chrome.tabs.sendMessage(tabId, { type: 'STOPPED' }).catch(() => {});
  await removeJobFromStorage(tabId);
  broadcastStatus();
}

// ── Storage helpers ────────────────────────────────────────────────────────
async function saveJobToStorage(tabId, settings) {
  const data = await chrome.storage.local.get('activeJobs');
  const jobs = data.activeJobs || {};
  jobs[tabId] = { settings, savedAt: Date.now() };
  await chrome.storage.local.set({ activeJobs: jobs });
}

async function removeJobFromStorage(tabId) {
  const data = await chrome.storage.local.get('activeJobs');
  const jobs = data.activeJobs || {};
  delete jobs[tabId];
  await chrome.storage.local.set({ activeJobs: jobs });
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

  // Auto-start URLs
  const autoStartUrls = data.autoStartUrls || [];
  for (const item of autoStartUrls) {
    if (item.url) {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      if (item.autoRefresh && item.refreshSettings) {
        await startRefresh(tab.id, item.refreshSettings);
      }
    }
  }
}

// ── Tab removal cleanup ────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeJobs[tabId]) {
    await stopRefresh(tabId);
  }
});

// ── Stop refresh if user navigates away from the original URL ──────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const job = activeJobs[tabId];
  if (!job || !changeInfo.url) return; // only care about URL changes

  const newUrl  = changeInfo.url;
  const origUrl = job.startUrl;
  if (!origUrl) return;

  // Compare origins + pathnames — ignore hash/query so normal page refreshes
  // (which preserve the URL) don't accidentally trigger a stop.
  try {
    const orig = new URL(origUrl);
    const next = new URL(newUrl);
    const samePage = orig.origin === next.origin && orig.pathname === next.pathname;
    if (!samePage) {
      await stopRefresh(tabId);
    }
  } catch (e) {
    // Unparseable URL (e.g. chrome://) — stop to be safe
    await stopRefresh(tabId);
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

// ── Keyboard shortcut: Alt+Shift+R toggles refresh on active tab ───────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-refresh') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const tabId = tab.id;

  if (activeJobs[tabId]) {
    // Currently active — stop it
    await stopRefresh(tabId);
  } else {
    // Not active — start with last saved settings, or sensible defaults
    const data = await chrome.storage.local.get('popupSettings');
    const s = data.popupSettings || {};
    const interval = s.selectedMs || 30000;
    await startRefresh(tabId, {
      interval,
      hardRefresh: s.hardRefresh || false,
      showCountdown: s.showCountdown !== false,
      notify: s.notify || false,
      sound: s.sound || false,
      monitorMode: s.monitor || false,
      monitorChange: (s.monitor && s.stopOnChange) || false,
      randomTimer: s.random || false,
      randomMin: (parseFloat(s.randomMin) || 5) * 1000,
      randomMax: (parseFloat(s.randomMax) || 60) * 1000,
      stopAfter: parseInt(s.stopAfter) || 0,
      keyword: s.keyword || '',
      stopOnKeyword: s.stopOnKeyword || false,
      stopOnChange: s.stopOnChange || false,
      stopOnClick: s.stopOnClick || false,
      currentInterval: interval
    });
  }
});

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
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

        // Cancel existing alarm
        chrome.alarms.clear(`refresh_${updateTabId}`);

        // Merge new settings, keeping existing state
        const newInterval = computeInterval(msg.settings);
        msg.settings.currentInterval = newInterval;
        job.settings = { ...job.settings, ...msg.settings };
        job.nextRefresh = Date.now() + newInterval;

        // Create new alarm with new interval
        chrome.alarms.create(`refresh_${updateTabId}`, { delayInMinutes: newInterval / 60000 });

        // Tell the content script to reset its countdown
        sendCountdownStart(updateTabId, newInterval, 0);

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
          const hkData = await chrome.storage.local.get('popupSettings');
          const s = hkData.popupSettings || {};
          const interval = s.selectedMs || 30000;
          await startRefresh(toggleTabId, {
            interval, hardRefresh: s.hardRefresh || false,
            showCountdown: s.showCountdown !== false, notify: s.notify || false,
            sound: s.sound || false, monitorMode: s.monitor || false,
            monitorChange: (s.monitor && s.stopOnChange) || false, randomTimer: s.random || false,
            randomMin: (parseFloat(s.randomMin) || 5) * 1000,
            randomMax: (parseFloat(s.randomMax) || 60) * 1000,
            stopAfter: parseInt(s.stopAfter) || 0, keyword: s.keyword || '',
            stopOnKeyword: s.stopOnKeyword || false, stopOnChange: s.stopOnChange || false,
            stopOnClick: s.stopOnClick || false,
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
