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

let toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show ' + (isError ? 'error' : 'success');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ── Load active jobs ─────────────────────────────────────────────────────
async function loadJobs() {
  // A waking (cold-start) service worker can miss the first message and reply
  // with no response. Treat that as transient: keep the current view and retry
  // shortly, rather than flashing the empty state.
  const resp = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_ALL_JOBS' }, r => resolve(chrome.runtime.lastError ? null : r))
  );
  if (!resp) { setTimeout(loadJobs, 400); return; }
  const jobs = resp.jobs || {};

  const tabIds = Object.keys(jobs).map(Number);
  const tabList = document.getElementById('tabList');

  if (tabIds.length === 0) {
    tabList.innerHTML = `<div class="empty-state"><div class="empty-icon">⏸</div><div class="empty-title">No active refresh jobs</div><div>Open a tab and start auto refresh from the extension popup.</div></div>`;
    return;
  }

  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)));
  tabList.innerHTML = '';

  tabs.forEach((tab, i) => {
    if (!tab) return;
    const tabId = tabIds[i];
    const job = jobs[tabId];
    const intervalSec = Math.round((job.settings.currentInterval || job.settings.interval) / 1000);

    const card = document.createElement('div');
    card.className = 'tab-card active';
    card.innerHTML = `
      <img class="tab-favicon" src="${escapeHtml(tab.favIconUrl || 'icons/icon16.png')}">
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
      <button class="autostart-remove" data-idx="${escapeHtml(i)}">✕</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.autostart-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { autoStartUrls = [] } = await chrome.storage.local.get('autoStartUrls');
      autoStartUrls.splice(parseInt(btn.dataset.idx), 1);
      await chrome.storage.local.set({ autoStartUrls });
      loadAutoStart();
    });
  });
}

document.getElementById('addAutoStart').addEventListener('click', async () => {
  const url = document.getElementById('asUrl').value.trim();
  const sec = parseInt(document.getElementById('asInterval').value) || 0;
  if (!url) return;

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

// ── Stop all ─────────────────────────────────────────────────────────────
document.getElementById('stopAllBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_ALL' });
  loadJobs();
});

// ── Export ───────────────────────────────────────────────────────────────
document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(null);
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
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    showToast('Invalid settings file: expected a JSON object.', true);
    return;
  }
  try {
    await chrome.storage.local.set(data);
    showToast('Settings imported successfully!', false);
    loadJobs();
    loadAutoStart();
  } catch {
    showToast('Failed to save imported settings.', true);
  }
});

// ── Refresh on focus ─────────────────────────────────────────────────────
loadJobs();
loadAutoStart();
setInterval(loadJobs, 3000);
