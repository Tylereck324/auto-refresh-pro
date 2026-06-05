// popup.js

let currentTabId = null;
let selectedMs = 30000;
let countdownTimer = null;
let countdownRemaining = 0;
let countdownTotal = 1;
let isActive = false;

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  loadSettings();
  await refreshStatus();
  bindEvents();

  // Poll for status updates
  setInterval(refreshStatus, 1000);
});

// ── Events ──────────────────────────────────────────────────────────────────
function bindEvents() {
  // Preset buttons
  document.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMs = parseInt(btn.dataset.ms);
      document.getElementById('customValue').value = '';
      applyIntervalChange();
    });
  });

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
    toggle.classList.toggle('open');
    panel.classList.toggle('open');
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

  // Immediately reset the popup countdown to the new duration
  startPopupCountdown(selectedMs);
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
  startPopupCountdown(settings.currentInterval || settings.interval);
  saveSettings();
}

async function stopRefresh() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'STOP_REFRESH', tabId: currentTabId });
  isActive = false;
  setActiveUI(false);
  stopPopupCountdown();
}

// ── Settings gather ─────────────────────────────────────────────────────────
function gatherSettings() {
  const randomTimer = document.getElementById('optRandom').checked;
  const randomMinSec = parseFloat(document.getElementById('optRandomMin').value) || 5;
  const randomMaxSec = parseFloat(document.getElementById('optRandomMax').value) || 60;

  return {
    interval: selectedMs,
    hardRefresh: document.getElementById('optHardRefresh').checked,
    showCountdown: document.getElementById('optCountdown').checked,
    notify: document.getElementById('optNotify').checked,
    sound: document.getElementById('optSound').checked,
    monitorMode: document.getElementById('optMonitor').checked,
    monitorChange: document.getElementById('optMonitor').checked && document.getElementById('optStopOnChange').checked,
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

function startPopupCountdown(duration) {
  stopPopupCountdown();
  countdownRemaining = duration;
  countdownTotal     = duration;

  const display = document.getElementById('countdownDisplay');
  const fill    = document.getElementById('progressFill');

  function tick() {
    if (display) display.textContent = formatTime(Math.max(0, countdownRemaining));
    if (fill)    fill.style.width    = Math.max(0, (countdownRemaining / countdownTotal) * 100) + '%';
    if (countdownRemaining <= 0) {
      countdownRemaining = countdownTotal;
    } else {
      countdownRemaining -= 1000;
    }
  }

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function stopPopupCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
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
    if (!resp) return;
    const job     = resp.job;
    const allJobs = resp.jobs || {};
    const activeCount = Object.keys(allJobs).length;

    const statActive    = document.getElementById('statActive');
    const statRefreshes = document.getElementById('statRefreshes');
    if (statActive)    statActive.textContent    = activeCount;
    if (statRefreshes) statRefreshes.textContent = job ? (job.refreshCount || 0) : 0;

    if (job) {
      if (!isActive) {
        isActive = true;
        setActiveUI(true);
        // Sync to actual remaining time, not the full interval
        const fullInterval = job.settings.currentInterval || job.settings.interval;
        const timeLeft = Math.max(1000, job.nextRefresh - Date.now());
        startPopupCountdown(timeLeft);
        countdownTotal = fullInterval; // fix the progress bar denominator
      }
    } else {
      if (isActive) {
        isActive = false;
        setActiveUI(false);
        stopPopupCountdown();
      }
    }
  });
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

function loadSettings() {
  chrome.storage.local.get('popupSettings', ({ popupSettings: s }) => {
    if (!s) return;
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

    // Highlight matching preset
    if (s.selectedMs) {
      document.querySelectorAll('.pill').forEach(btn => {
        if (parseInt(btn.dataset.ms) === s.selectedMs) btn.classList.add('active');
      });
    }

    updateConditionalRows();
  });
}

function setCheckbox(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}
