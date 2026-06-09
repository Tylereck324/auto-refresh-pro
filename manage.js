// manage.js — logic for the "Manage All Tabs" page.
// Kept in an external file because Manifest V3's default CSP
// (script-src 'self') forbids inline <script> in extension pages.

// ── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// showToast comes from the shared toast.js (loaded before this script).

// ── Load active jobs ─────────────────────────────────────────────────────
// Invocations overlap freely (8s poll + post-action refreshes + cold-start
// retries); only the NEWEST may touch the DOM. Each call takes a generation
// ticket and bails after every await if a newer call has started — without
// this, an older call's render could land after a newer one's and leave stale
// data stuck on screen (the sig check would then skip every later rebuild).
loadJobs._gen = 0;
loadJobs._retries = 0;
async function loadJobs() {
  const gen = ++loadJobs._gen;
  // A waking (cold-start) service worker can miss the first message and reply
  // with no response. Treat that as transient: keep the current view and retry
  // shortly, rather than flashing the empty state. Capped to consecutive
  // failures so an unresponsive worker can't stack unbounded retry chains on
  // top of the poll (a later success resets the budget).
  const resp = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_ALL_JOBS' }, r => resolve(chrome.runtime.lastError ? null : r))
  );
  if (gen !== loadJobs._gen) return; // superseded while awaiting — newer call owns the DOM
  if (!resp) {
    if (loadJobs._retries < 5) { loadJobs._retries++; setTimeout(loadJobs, 400); }
    return;
  }
  loadJobs._retries = 0;
  const jobs = resp.jobs || {};

  const tabIds = Object.keys(jobs).map(Number);
  const tabList = document.getElementById('tabList');

  // "Stop All" only does something when jobs exist — disable it otherwise so it
  // isn't a prominent destructive button that's actually a no-op.
  const stopAllBtn = document.getElementById('stopAllBtn');
  if (stopAllBtn) stopAllBtn.disabled = tabIds.length === 0;

  // Skip the DOM rebuild when nothing material changed since the last render.
  // The 3s poll would otherwise wipe out keyboard focus / hover on every tick.
  const sig = JSON.stringify(tabIds.map(id => [
    id, jobs[id].refreshCount || 0,
    jobs[id].settings.currentInterval || jobs[id].settings.interval,
  ]));
  if (sig === loadJobs._sig) return;

  if (tabIds.length === 0) {
    loadJobs._sig = sig;
    tabList.innerHTML = `<div class="empty-state"><div class="empty-icon">⏸</div><div class="empty-title">No active refresh jobs</div><div>Open a tab and start auto refresh from the extension popup.</div></div>`;
    return;
  }

  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)));
  if (gen !== loadJobs._gen) return; // superseded during tabs.get — don't commit or render stale data
  loadJobs._sig = sig; // committed only with the render it describes
  tabList.innerHTML = '';

  tabs.forEach((tab, i) => {
    if (!tab) return;
    const tabId = tabIds[i];
    const job = jobs[tabId];
    const intervalSec = Math.round((job.settings.currentInterval || job.settings.interval) / 1000);

    // tab.favIconUrl is controlled by the visited (possibly hostile) page. Only
    // render it when it's a safe http(s) or validated raster-image data: URL;
    // anything else (javascript:, file:, svg, oversized/corrupt data:) falls back
    // to the bundled icon. escapeHtml already blocks HTML-attribute breakout;
    // this additionally blocks unsafe schemes and malformed image payloads.
    const favIcon = ARPValidators.isSafeImageSrc(tab.favIconUrl) ? tab.favIconUrl : 'icons/icon16.png';

    const card = document.createElement('div');
    card.className = 'tab-card active';
    card.innerHTML = `
      <img class="tab-favicon" src="${escapeHtml(favIcon)}">
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Unknown Tab')}</div>
        <div class="tab-url">${escapeHtml(tab.url)}</div>
      </div>
      <div class="tab-stats">
        <span class="stat-pill active-badge">ACTIVE</span>
        <span class="stat-pill">Every ${intervalSec}s</span>
        <span class="stat-pill">${job.refreshCount || 0} refreshes</span>
      </div>
      <div class="tab-actions">
        <button class="btn-sm btn-sm-go" data-id="${escapeHtml(tabId)}">Go to Tab</button>
        <button class="btn-sm btn-sm-stop" data-id="${escapeHtml(tabId)}">Stop</button>
      </div>
    `;
    // Favicon fallback — set programmatically; inline onerror= is blocked by
    // the MV3 content security policy.
    const fav = card.querySelector('.tab-favicon');
    if (fav) fav.addEventListener('error', () => { fav.src = 'icons/icon16.png'; });

    tabList.appendChild(card);
  });

  document.querySelectorAll('.btn-sm-stop').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId: parseInt(btn.dataset.id) });
      loadJobs();
    });
  });

  document.querySelectorAll('.btn-sm-go').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.tabs.update(parseInt(btn.dataset.id), { active: true });
    });
  });
}

// ── Auto-start URLs ──────────────────────────────────────────────────────
async function loadAutoStart() {
  const { autoStartUrls = [] } = await chrome.storage.local.get('autoStartUrls');
  const list = document.getElementById('autoStartList');
  list.innerHTML = '';
  autoStartUrls.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'autostart-item';
    div.innerHTML = `
      <span class="autostart-url">${escapeHtml(item.url)}</span>
      <span style="color:var(--text2);font-size:11px;">${item.intervalSec ? escapeHtml(item.intervalSec) + 's' : 'no refresh'}</span>
      <button class="autostart-remove" data-url="${escapeHtml(item.url)}" aria-label="Remove ${escapeHtml(item.url)}" title="Remove">✕</button>
    `;
    list.appendChild(div);
  });

  // Remove by VALUE, not render-time index: the array can change between render
  // and click (a second Manage window, an import landing, a double-click racing
  // the re-render), and a stale index deletes the wrong entry.
  list.querySelectorAll('.autostart-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { autoStartUrls = [] } = await chrome.storage.local.get('autoStartUrls');
      const idx = autoStartUrls.findIndex(item => item && item.url === btn.dataset.url);
      if (idx !== -1) {
        autoStartUrls.splice(idx, 1);
        await chrome.storage.local.set({ autoStartUrls });
      }
      loadAutoStart();
    });
  });
}

document.getElementById('addAutoStart').addEventListener('click', async () => {
  const url = document.getElementById('asUrl').value.trim();
  // Mirror sanitizeAutoStartUrls: below the 2s floor means "no refresh" (the
  // HTML min="2" doesn't constrain typed input). Storing a sub-floor value
  // used to silently flip to no-refresh on an export→import round-trip.
  const raw = parseInt(document.getElementById('asInterval').value) || 0;
  const sec = raw >= 2 ? raw : 0;
  if (!url) return;
  // Only persist http(s) URLs — these are later auto-opened via chrome.tabs.create
  // on browser startup, so a javascript:/file:/data: entry must never be stored.
  if (!ARPValidators.isSafeNavigableUrl(url)) {
    showToast('Only http(s) URLs can be auto-started.', true);
    return;
  }

  const { autoStartUrls = [] } = await chrome.storage.local.get('autoStartUrls');
  autoStartUrls.push({
    url,
    intervalSec: sec,
    autoRefresh: sec > 0,
    refreshSettings: sec > 0 ? { interval: sec * 1000, hardRefresh: false, stopAfter: 0, notify: false, sound: false, monitorMode: false, randomTimer: false } : null
  });
  await chrome.storage.local.set({ autoStartUrls });
  document.getElementById('asUrl').value = '';
  document.getElementById('asInterval').value = '';
  loadAutoStart();
});

// ── URL rules ────────────────────────────────────────────────────────────
async function loadRules() {
  const { urlRules = [] } = await chrome.storage.local.get('urlRules');
  const list = document.getElementById('ruleList');
  list.innerHTML = '';
  urlRules.forEach((rule, i) => {
    const sec = Math.round(((rule.settings && rule.settings.interval) || 30000) / 1000);
    const div = document.createElement('div');
    div.className = 'autostart-item';
    div.innerHTML = `
      <span class="autostart-url">${escapeHtml(rule.pattern)}</span>
      <span style="color:var(--text2);font-size:11px;">${escapeHtml(sec)}s</span>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text2);">
        <input type="checkbox" class="rule-enabled" data-pattern="${escapeHtml(rule.pattern)}" ${rule.enabled === false ? '' : 'checked'}> on
      </label>
      <button class="autostart-remove rule-remove" data-pattern="${escapeHtml(rule.pattern)}" aria-label="Remove ${escapeHtml(rule.pattern)}" title="Remove">✕</button>
    `;
    list.appendChild(div);
  });

  // Remove/toggle by VALUE, not render-time index (same rationale as the
  // auto-start list above — a stale index hits the wrong rule).
  list.querySelectorAll('.rule-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { urlRules = [] } = await chrome.storage.local.get('urlRules');
      const idx = urlRules.findIndex(r => r && r.pattern === btn.dataset.pattern);
      if (idx !== -1) {
        urlRules.splice(idx, 1);
        await chrome.storage.local.set({ urlRules });
      }
      loadRules();
    });
  });
  list.querySelectorAll('.rule-enabled').forEach(box => {
    box.addEventListener('change', async () => {
      const { urlRules = [] } = await chrome.storage.local.get('urlRules');
      const rule = urlRules.find(r => r && r.pattern === box.dataset.pattern);
      if (rule) rule.enabled = box.checked;
      await chrome.storage.local.set({ urlRules });
    });
  });
}

document.getElementById('addRule').addEventListener('click', async () => {
  const pattern = document.getElementById('rulePattern').value.trim();
  const sec = parseInt(document.getElementById('ruleInterval').value) || 30;
  if (!pattern) return;
  if (!ARPValidators.isSafeUrlGlob(pattern)) {
    showToast('Invalid pattern. Use e.g. *://*.example.com/*', true);
    return;
  }
  const { urlRules = [] } = await chrome.storage.local.get('urlRules');
  if (urlRules.length >= ARPValidators.MAX_URL_RULES) {
    showToast('Too many rules (max ' + ARPValidators.MAX_URL_RULES + ').', true);
    return;
  }
  urlRules.push({
    pattern,
    enabled: true,
    settings: ARPValidators.sanitizeRuleSettings({ interval: Math.max(2, sec) * 1000 }),
  });
  await chrome.storage.local.set({ urlRules });
  document.getElementById('rulePattern').value = '';
  document.getElementById('ruleInterval').value = '30';
  loadRules();
});

// ── Stop all ─────────────────────────────────────────────────────────────
document.getElementById('stopAllBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_ALL' });
  loadJobs();
});

// ── Export ───────────────────────────────────────────────────────────────
document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(null);
  // Exports are settings backups, not session dumps. activeJobs is runtime job
  // state keyed by session-scoped tab ids — meaningless on another machine/
  // session, and the import side strips it anyway (a replayed entry would
  // attach a refresh job to whatever tab holds that id after a restart).
  delete data.activeJobs;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'auto-refresh-pro-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Settings exported.', false);
});

// ── Import ───────────────────────────────────────────────────────────────
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  e.target.value = '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    showToast('Invalid settings file: not valid JSON.', true);
    return;
  }
  // Sanitize before persisting: an imported file is fully attacker-controlled.
  // This strips unsafe auto-start URLs, bounds/cleans preset labels (which are
  // otherwise rendered on the Settings page), and shape-checks the hotkey.
  const result = ARPValidators.sanitizeImportedSettings(data);
  if (!result.ok) {
    showToast('Invalid settings file: ' + (result.errors[0] || 'bad format') + '.', true);
    return;
  }
  try {
    await chrome.storage.local.set(result.value);
    const note = result.errors.length
      ? 'Settings imported (' + result.errors.join('; ') + ').'
      : 'Settings imported successfully!';
    showToast(note, result.errors.length > 0);
    loadJobs();
    loadAutoStart();
    loadRules();
  } catch {
    showToast('Failed to save imported settings.', true);
  }
});

// ── Refresh on focus ─────────────────────────────────────────────────────
loadJobs();
loadAutoStart();
loadRules();
// Slow backstop poll. The _sig guard in loadJobs already skips the DOM rebuild +
// per-tab tabs.get when nothing changed, so the only residual per-poll cost is
// the GET_ALL_JOBS round-trip (which wakes the worker). This page isn't usually
// foregrounded and the refresh-count badges don't need 3 s granularity, so an
// 8 s cadence cuts the wakeups without a noticeable staleness.
setInterval(loadJobs, 8000);
