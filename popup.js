// popup.js

let currentTabId = null;
let selectedMs = 30000;
let isActive = false;

// Built-in fallback presets, mirrors options.js. Overridden by the user's
// custom presets from the Settings page (globalSettings.presets) when present.
const DEFAULT_PRESETS = [
  { label: '5s', ms: 5000 },   { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 }, { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 }, { label: '10m', ms: 600000 },
  { label: '30m', ms: 1800000 }, { label: '1h', ms: 3600000 }
];

// Countdown is a pure render of the background's authoritative deadline.
// jobDeadline is an absolute timestamp (job.nextRefresh); jobTotal is the
// current cycle's interval, used only as the progress-bar denominator.
let jobDeadline = 0;
let jobTotal = 1;
let renderTimer = null;

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  renderPresets(DEFAULT_PRESETS); // immediate paint; loadSettings re-renders with custom presets
  loadSettings();
  await refreshStatus();
  bindEvents();

  // Primary sync: the background pushes STATUS_UPDATE on start/refresh/stop so
  // the countdown resets in lockstep with the authoritative deadline.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STATUS_UPDATE') applyStatus(msg);
  });

  // Fallback: poll once a second in case a broadcast was missed or the service
  // worker was restarted. Also keeps refreshCount/active-count stats fresh.
  setInterval(refreshStatus, 1000);
});

// ── Events ──────────────────────────────────────────────────────────────────
function bindEvents() {
  // Preset buttons are rendered + bound dynamically in renderPresets().

  // Custom interval
  document.getElementById('customValue').addEventListener('input', () => {
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    const val = parseFloat(document.getElementById('customValue').value);
    const unit = parseInt(document.getElementById('customUnit').value);
    if (val > 0) {
      selectedMs = Math.max(2000, val * unit);
      applyIntervalChange();
    }
  });

  document.getElementById('customUnit').addEventListener('change', () => {
    const val = parseFloat(document.getElementById('customValue').value);
    if (val > 0) {
      const unit = parseInt(document.getElementById('customUnit').value);
      selectedMs = Math.max(2000, val * unit);
      applyIntervalChange();
    }
  });

  // Start/Stop
  document.getElementById('btnStart').addEventListener('click', startRefresh);
  document.getElementById('btnStop').addEventListener('click', stopRefresh);

  // Advanced toggle
  document.getElementById('advancedToggle').addEventListener('click', () => {
    const toggle = document.getElementById('advancedToggle');
    const panel  = document.getElementById('advancedPanel');
    const open = toggle.classList.toggle('open');
    panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Keyboard activation for the non-native controls (Enter / Space).
  ['advancedToggle', 'manageLink', 'optionsLink'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });

  // Monitor / random conditionals
  document.getElementById('optMonitor').addEventListener('change', updateConditionalRows);
  document.getElementById('optRandom').addEventListener('change', updateConditionalRows);

  // Options link
  document.getElementById('optionsLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Manage tabs
  document.getElementById('manageLink').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });

  // Save settings on any toggle change
  ['optHardRefresh','optCountdown','optNotify','optSound','optMonitor','optRandom',
   'optStopAfter','optKeyword','optStopOnKeyword','optStopOnChange','optStopOnClick','optRandomMin','optRandomMax'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
    if (el && el.type === 'text') el.addEventListener('input', saveSettings);
  });
}

function updateConditionalRows() {
  const random = document.getElementById('optRandom').checked;
  const randomRangeRow = document.getElementById('randomRangeRow');
  if (randomRangeRow) randomRangeRow.style.display = random ? '' : 'none';
}

// Called whenever the interval selection changes.
// If a job is already running, sends UPDATE_INTERVAL to restart it immediately
// with the new duration and resets the popup countdown.
function applyIntervalChange() {
  saveSettings();
  if (!isActive || !currentTabId) return;

  const settings = gatherSettings();
  chrome.runtime.sendMessage({
    type: 'UPDATE_INTERVAL',
    tabId: currentTabId,
    settings
  });

  // Optimistically reset the countdown to the new duration for instant feedback.
  // The background's STATUS_UPDATE push will correct it (e.g. under random mode).
  setDeadline(Date.now() + selectedMs, selectedMs);
}

// ── Start / Stop ────────────────────────────────────────────────────────────
async function startRefresh() {
  if (!currentTabId) return;

  const settings = gatherSettings();

  chrome.runtime.sendMessage({
    type: 'START_REFRESH',
    tabId: currentTabId,
    settings
  });

  isActive = true;
  setActiveUI(true, settings.interval);
  // Optimistic deadline; corrected by the background's STATUS_UPDATE push.
  const total = settings.currentInterval || settings.interval;
  setDeadline(Date.now() + total, total);
  saveSettings();
}

async function stopRefresh() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId: currentTabId });
  isActive = false;
  setActiveUI(false);
  stopRenderLoop();
  jobDeadline = 0;
}

// ── Settings gather ─────────────────────────────────────────────────────────
function gatherSettings() {
  const randomTimer = document.getElementById('optRandom').checked;
  // Validate the random range: floor at 2s, and swap if min > max so the
  // interval computation never gets an inverted/negative-width range.
  let randomMinSec = Math.max(2, parseFloat(document.getElementById('optRandomMin').value) || 5);
  let randomMaxSec = Math.max(2, parseFloat(document.getElementById('optRandomMax').value) || 60);
  if (randomMinSec > randomMaxSec) { [randomMinSec, randomMaxSec] = [randomMaxSec, randomMinSec]; }

  return {
    interval: selectedMs,
    hardRefresh: document.getElementById('optHardRefresh').checked,
    showCountdown: document.getElementById('optCountdown').checked,
    notify: document.getElementById('optNotify').checked,
    sound: document.getElementById('optSound').checked,
    monitorMode: document.getElementById('optMonitor').checked,
    randomTimer,
    randomMin: randomMinSec * 1000,
    randomMax: randomMaxSec * 1000,
    stopAfter: parseInt(document.getElementById('optStopAfter').value) || 0,
    keyword: document.getElementById('optKeyword').value.trim(),
    stopOnKeyword: document.getElementById('optStopOnKeyword').checked,
    stopOnChange: document.getElementById('optStopOnChange').checked,
    stopOnClick: document.getElementById('optStopOnClick').checked,
    currentInterval: selectedMs
  };
}

// ── UI helpers ──────────────────────────────────────────────────────────────
function setActiveUI(active, interval) {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const hero  = document.getElementById('hero');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');

  if (dot)   { dot.className   = 'status-dot'   + (active ? ' active'   : ' inactive'); }
  if (label) { label.className = 'status-label'  + (active ? ' active'   : '');
               label.textContent = active ? 'ACTIVE' : 'IDLE'; }
  if (hero)  { hero.className  = 'hero'          + (active ? ' visible'  : ''); }
  btnStart.disabled = active;
  btnStop.disabled  = !active;
}

// Point the countdown at an absolute deadline and start rendering it.
// total is the cycle interval, used only as the progress-bar denominator.
function setDeadline(deadline, total) {
  const changed = deadline !== jobDeadline;
  jobDeadline = deadline;
  if (total) jobTotal = total;
  // Only force an immediate repaint when the deadline actually moved (start /
  // refresh / reset). On a steady-state poll the deadline is unchanged, so we
  // leave the boundary-aligned loop to paint and avoid a once-a-second stutter.
  if (changed) renderCountdown();
  startRenderLoop();
}

// Self-scheduling render aligned to the wall-clock second boundary. Both this
// and the in-page overlay use the identical scheme over the same absolute
// deadline, so their displayed second flips at the same instant — no residual
// sub-second phase skew between the two timers. The number is a pure function
// of the deadline, so there is nothing to drift or self-reset.
function startRenderLoop() {
  if (renderTimer) return;
  tickAligned();
}

function tickAligned() {
  renderCountdown();
  const remaining = Math.max(0, jobDeadline - Date.now());
  // ms until ceil(remaining/1000) next changes, +15ms to land just past it.
  // While waiting for a post-refresh reset (remaining 0), poll at 250ms.
  const delay = remaining > 0 ? (remaining % 1000) + 15 : 250;
  renderTimer = setTimeout(tickAligned, delay);
}

function stopRenderLoop() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
}

function renderCountdown() {
  const display = document.getElementById('countdownDisplay');
  const fill    = document.getElementById('progressFill');
  const remaining = Math.max(0, jobDeadline - Date.now());
  if (display) display.textContent = formatTime(remaining);
  if (fill)    fill.style.width    =
    (jobTotal > 0 ? Math.max(0, Math.min(100, remaining / jobTotal * 100)) : 0) + '%';
}

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Status polling ──────────────────────────────────────────────────────────
async function refreshStatus() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: currentTabId }, (resp) => {
    if (resp) applyStatus(resp);
  });
}

// Shared by the 1 s poll (GET_STATUS resp) and the STATUS_UPDATE push. Both
// carry a `jobs` map; GET_STATUS also carries the resolved `job`. We always
// re-point the countdown at the authoritative nextRefresh — single source of
// truth — so a real refresh moving the deadline forward is reflected at once.
function applyStatus(resp) {
  const allJobs = resp.jobs || {};
  const job = resp.job || allJobs[currentTabId] || null;
  const activeCount = Object.keys(allJobs).length;

  const statActive    = document.getElementById('statActive');
  const statRefreshes = document.getElementById('statRefreshes');
  if (statActive)    statActive.textContent    = activeCount;
  if (statRefreshes) statRefreshes.textContent = job ? (job.refreshCount || 0) : 0;

  if (job) {
    if (!isActive) {
      isActive = true;
      setActiveUI(true);
    }
    const total = (job.settings && (job.settings.currentInterval || job.settings.interval)) || jobTotal;
    setDeadline(job.nextRefresh, total);
  } else if (isActive) {
    isActive = false;
    setActiveUI(false);
    stopRenderLoop();
    jobDeadline = 0;
  }
}

// ── Persist settings ─────────────────────────────────────────────────────────
function saveSettings() {
  const settings = {
    selectedMs,
    hardRefresh: document.getElementById('optHardRefresh').checked,
    showCountdown: document.getElementById('optCountdown').checked,
    notify: document.getElementById('optNotify').checked,
    sound: document.getElementById('optSound').checked,
    monitor: document.getElementById('optMonitor').checked,
    random: document.getElementById('optRandom').checked,
    stopAfter: document.getElementById('optStopAfter').value,
    keyword: document.getElementById('optKeyword').value,
    stopOnKeyword: document.getElementById('optStopOnKeyword').checked,
    stopOnChange: document.getElementById('optStopOnChange').checked,
    stopOnClick: document.getElementById('optStopOnClick').checked,
    randomMin: document.getElementById('optRandomMin').value,
    randomMax: document.getElementById('optRandomMax').value,
  };
  chrome.storage.local.set({ popupSettings: settings });
}

// Render the interval preset pills and bind their click handlers. Called once
// immediately with the built-in defaults (avoids an empty-grid flash) and again
// from loadSettings with the user's custom presets from the Settings page.
function renderPresets(presets) {
  const grid = document.getElementById('pillGrid');
  if (!grid) return;
  const list = (presets && presets.length) ? presets : DEFAULT_PRESETS;
  grid.innerHTML = '';
  list.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.dataset.ms = p.ms;
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMs = parseInt(btn.dataset.ms);
      document.getElementById('customValue').value = '';
      applyIntervalChange();
    });
    grid.appendChild(btn);
  });
  highlightSelectedPreset();
}

function highlightSelectedPreset() {
  document.querySelectorAll('.pill').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.ms) === selectedMs);
  });
}

function loadSettings() {
  chrome.storage.local.get(['popupSettings', 'globalSettings'], ({ popupSettings: s, globalSettings: g }) => {
    g = g || {};

    // ── 1. Custom presets from the Settings page (or built-in defaults) ──
    renderPresets(g.presets);

    // ── 2. Seed from the Settings-page defaults ──
    // These apply on first use and act as the baseline; the user's last-used
    // popup state (popupSettings) below takes precedence when present.
    if (g.defaultInterval) selectedMs = g.defaultInterval * 1000;
    setCheckbox('optHardRefresh', g.hardRefresh);
    setCheckbox('optCountdown', g.showCountdown !== false);
    setCheckbox('optNotify', g.notify);
    setCheckbox('optSound', g.sound);

    // ── 3. Overlay the user's last-used popup state (takes precedence) ──
    if (s) {
      if (s.selectedMs) selectedMs = s.selectedMs;

      setCheckbox('optHardRefresh', s.hardRefresh);
      setCheckbox('optCountdown', s.showCountdown !== false);
      setCheckbox('optNotify', s.notify);
      setCheckbox('optSound', s.sound);
      setCheckbox('optMonitor', s.monitor);
      setCheckbox('optRandom', s.random);
      setCheckbox('optStopOnKeyword', s.stopOnKeyword);
      setCheckbox('optStopOnChange', s.stopOnChange);
      setCheckbox('optStopOnClick', s.stopOnClick);

      if (s.stopAfter !== undefined) document.getElementById('optStopAfter').value = s.stopAfter;
      if (s.keyword) document.getElementById('optKeyword').value = s.keyword;
      if (s.randomMin) document.getElementById('optRandomMin').value = s.randomMin;
      if (s.randomMax) document.getElementById('optRandomMax').value = s.randomMax;
    }

    highlightSelectedPreset();
    updateConditionalRows();
  });
}

function setCheckbox(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}
