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
  AlertSounds.populateSelect(document.getElementById('optSoundTone')); // before loadSettings sets the value
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
  document.getElementById('customValue').addEventListener('input', applyCustomInterval);
  document.getElementById('customUnit').addEventListener('change', applyCustomInterval);

  // Start/Stop
  document.getElementById('btnStart').addEventListener('click', startRefresh);
  document.getElementById('btnStop').addEventListener('click', stopRefresh);

  // Collapsible sections (progressive disclosure). Each .section-toggle is a
  // native <button> that controls the panel named in its aria-controls, so
  // Enter/Space activation comes for free.
  document.querySelectorAll('.section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('open', open);
      if (panel) panel.classList.toggle('open', open);
    });
  });

  // Keyboard activation for the non-native controls (Enter / Space).
  ['manageLink', 'optionsLink'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });

  // Monitor / random / sound conditionals
  document.getElementById('optMonitor').addEventListener('change', updateConditionalRows);
  document.getElementById('optRandom').addEventListener('change', updateConditionalRows);
  document.getElementById('optNoiseTolerant').addEventListener('change', updateConditionalRows);
  document.getElementById('optSound').addEventListener('change', updateConditionalRows);

  // Live volume percentage readout next to the slider.
  document.getElementById('optSoundVolume').addEventListener('input', syncVolumeReadout);

  // Preview the currently selected tone at the chosen volume. Plays locally in
  // the popup (this click is a user gesture, so autoplay is allowed) — no
  // offscreen round-trip — using the same AlertSounds catalog the alert uses.
  document.getElementById('btnPreviewSound').addEventListener('click', previewSound);

  // A keyword takes precedence over generic change-monitoring (the background
  // ignores Monitor while a keyword is set), so lock those controls to match.
  document.getElementById('optKeyword').addEventListener('input', updateKeywordLock);

  // Live-validate the regex when Regex mode is on, so an unsafe/invalid pattern
  // is flagged (and refused) before it can be saved or started.
  document.getElementById('optKeyword').addEventListener('input', validateKeywordRegex);
  document.getElementById('optKwRegex').addEventListener('change', validateKeywordRegex);

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
   'optStopAfter','optKeyword','optStopOnKeyword','optStopOnChange','optStopOnClick','optPreserveScroll','optRandomMin','optRandomMax',
   'optSoundTone','optSoundRepeat','optSoundVolume',
   'optKwCase','optKwWhole','optKwRegex','optKwInverse','optBeepUntilAck',
   'optNoiseTolerant','optCollapseDigits','optMinChange'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
    if (el && el.type === 'text') el.addEventListener('input', saveSettings);
  });
}

// Read the custom interval row, clamp to the 2s minimum, and surface a hint
// when the typed value was below that floor (instead of clamping silently).
function applyCustomInterval() {
  const input = document.getElementById('customValue');
  const hint  = document.getElementById('customHint');
  const val   = parseFloat(input.value);
  const unit  = parseInt(document.getElementById('customUnit').value);

  if (!(val > 0)) {
    input.classList.remove('invalid');
    if (hint) hint.classList.remove('show');
    return;
  }

  document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
  const raw = val * unit;
  const clamped = raw < 2000;
  selectedMs = Math.max(2000, raw);
  input.classList.toggle('invalid', clamped);
  if (hint) hint.classList.toggle('show', clamped);
  applyIntervalChange();
}

function updateConditionalRows() {
  const random = document.getElementById('optRandom').checked;
  const randomRangeRow = document.getElementById('randomRangeRow');
  if (randomRangeRow) randomRangeRow.style.display = random ? '' : 'none';
  // The change-sensitivity fields only matter when "Ignore noise" is on.
  const noise = document.getElementById('optNoiseTolerant').checked;
  const noiseRow = document.getElementById('noiseRow');
  if (noiseRow) noiseRow.style.display = noise ? '' : 'none';
  // Sound tone/repeat/volume only matter when the sound alert is enabled.
  const sound = document.getElementById('optSound').checked;
  const soundRow = document.getElementById('soundRow');
  if (soundRow) soundRow.style.display = sound ? '' : 'none';
}

// When a keyword is set, the background uses the keyword as the sole signal and
// skips the page-change path entirely (see doMonitorRefresh in background.js).
// Reflect that in the UI by disabling Monitor + Stop-on-change so they can't be
// toggled to no effect. The checkboxes keep their stored state, so clearing the
// keyword restores whatever the user had selected before.
function updateKeywordLock() {
  const hasKeyword = document.getElementById('optKeyword').value.trim().length > 0;
  [['cardMonitor', 'optMonitor'], ['cardStopOnChange', 'optStopOnChange'], ['cardNoise', 'optNoiseTolerant']].forEach(([cardId, inputId]) => {
    const card  = document.getElementById(cardId);
    const input = document.getElementById(inputId);
    if (card)  card.classList.toggle('disabled', hasKeyword);
    if (input) input.disabled = hasKeyword;
  });
  const sub = document.getElementById('subMonitor');
  if (sub) sub.textContent = hasKeyword ? 'Ignored — keyword set' : 'Watch for any change';
  const note = document.getElementById('keywordLockNote');
  if (note) note.classList.toggle('show', hasKeyword);
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

  // Refuse to start with an invalid/unsafe regex keyword — flag it instead.
  if (!validateKeywordRegex()) {
    document.getElementById('optKeyword').focus();
    return;
  }

  const settings = gatherSettings();

  chrome.runtime.sendMessage({
    type: 'START_REFRESH',
    tabId: currentTabId,
    settings
  });

  isActive = true;
  setActiveUI(true);
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
    noiseTolerant: document.getElementById('optNoiseTolerant').checked,
    collapseDigits: document.getElementById('optCollapseDigits').checked,
    minChangedFraction: clampFraction(document.getElementById('optMinChange').value),
    randomTimer,
    randomMin: randomMinSec * 1000,
    randomMax: randomMaxSec * 1000,
    stopAfter: parseInt(document.getElementById('optStopAfter').value) || 0,
    keyword: document.getElementById('optKeyword').value.trim(),
    kwCaseSensitive: document.getElementById('optKwCase').checked,
    kwWholeWord: document.getElementById('optKwWhole').checked,
    kwRegex: document.getElementById('optKwRegex').checked,
    kwInverse: document.getElementById('optKwInverse').checked,
    stopOnKeyword: document.getElementById('optStopOnKeyword').checked,
    stopOnChange: document.getElementById('optStopOnChange').checked,
    stopOnClick: document.getElementById('optStopOnClick').checked,
    preserveScroll: document.getElementById('optPreserveScroll').checked,
    soundVolume: clampSoundVolume(document.getElementById('optSoundVolume').value),
    soundTone: document.getElementById('optSoundTone').value || 'beep',
    soundRepeat: clampSoundRepeat(document.getElementById('optSoundRepeat').value),
    beepUntilAck: document.getElementById('optBeepUntilAck').checked,
    currentInterval: selectedMs
  };
}

// Volume (0–100 UI → 0–1 gain) and repeat clamping live in the shared catalog
// so the popup, options page, and offscreen player all agree on the bounds.
const clampSoundVolume = AlertSounds.clampVolume;
const clampSoundRepeat = AlertSounds.clampRepeat;
// "Min change %" is 0–100 in the UI but stored/sent as a 0–1 fraction.
function clampFraction(raw) {
  const pct = parseInt(raw, 10);
  return Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
}

// ── UI helpers ──────────────────────────────────────────────────────────────
function setActiveUI(active) {
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
    noiseTolerant: document.getElementById('optNoiseTolerant').checked,
    collapseDigits: document.getElementById('optCollapseDigits').checked,
    minChangedFraction: clampFraction(document.getElementById('optMinChange').value),
    random: document.getElementById('optRandom').checked,
    stopAfter: document.getElementById('optStopAfter').value,
    keyword: document.getElementById('optKeyword').value,
    kwCaseSensitive: document.getElementById('optKwCase').checked,
    kwWholeWord: document.getElementById('optKwWhole').checked,
    kwRegex: document.getElementById('optKwRegex').checked,
    kwInverse: document.getElementById('optKwInverse').checked,
    stopOnKeyword: document.getElementById('optStopOnKeyword').checked,
    stopOnChange: document.getElementById('optStopOnChange').checked,
    stopOnClick: document.getElementById('optStopOnClick').checked,
    preserveScroll: document.getElementById('optPreserveScroll').checked,
    randomMin: document.getElementById('optRandomMin').value,
    randomMax: document.getElementById('optRandomMax').value,
    soundVolume: clampSoundVolume(document.getElementById('optSoundVolume').value),
    soundTone: document.getElementById('optSoundTone').value || 'beep',
    soundRepeat: clampSoundRepeat(document.getElementById('optSoundRepeat').value),
    beepUntilAck: document.getElementById('optBeepUntilAck').checked,
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
    setSoundControls(g);

    // ── 3. Overlay the user's last-used popup state (takes precedence) ──
    if (s) {
      if (s.selectedMs) selectedMs = s.selectedMs;

      setCheckbox('optHardRefresh', s.hardRefresh);
      setCheckbox('optCountdown', s.showCountdown !== false);
      setCheckbox('optNotify', s.notify);
      setCheckbox('optSound', s.sound);
      setCheckbox('optMonitor', s.monitor);
      setCheckbox('optNoiseTolerant', s.noiseTolerant);
      if (s.collapseDigits !== undefined) setCheckbox('optCollapseDigits', s.collapseDigits);
      if (typeof s.minChangedFraction === 'number') {
        document.getElementById('optMinChange').value = Math.round(s.minChangedFraction * 100);
      }
      setCheckbox('optRandom', s.random);
      setCheckbox('optStopOnKeyword', s.stopOnKeyword);
      setCheckbox('optStopOnChange', s.stopOnChange);
      setCheckbox('optStopOnClick', s.stopOnClick);
      setCheckbox('optPreserveScroll', s.preserveScroll);
      setCheckbox('optKwCase', s.kwCaseSensitive);
      setCheckbox('optKwWhole', s.kwWholeWord);
      setCheckbox('optKwRegex', s.kwRegex);
      setCheckbox('optKwInverse', s.kwInverse);
      setCheckbox('optBeepUntilAck', s.beepUntilAck);

      if (s.stopAfter !== undefined) document.getElementById('optStopAfter').value = s.stopAfter;
      if (s.keyword) document.getElementById('optKeyword').value = s.keyword;
      if (s.randomMin) document.getElementById('optRandomMin').value = s.randomMin;
      if (s.randomMax) document.getElementById('optRandomMax').value = s.randomMax;
      setSoundControls(s);
    }

    highlightSelectedPreset();
    updateConditionalRows();
    updateKeywordLock();
    validateKeywordRegex();
  });
}

function setCheckbox(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

// Returns true when the keyword field is OK to use. When Regex mode is on, the
// pattern is checked against ARPValidators.isSafeRegex and the UI is flagged on
// failure. Non-regex keywords are always valid.
function validateKeywordRegex() {
  const input = document.getElementById('optKeyword');
  const hint  = document.getElementById('kwRegexHint');
  const regexOn = document.getElementById('optKwRegex').checked;
  const val = input.value.trim();
  const bad = regexOn && val.length > 0 &&
    !(typeof ARPValidators !== 'undefined' && ARPValidators.isSafeRegex(val));
  input.classList.toggle('invalid', bad);
  if (hint) hint.classList.toggle('show', bad);
  return !bad;
}

// Apply sound settings from either globalSettings (gain 0–1) or popupSettings.
// Only writes a control when the source actually carries that field, so the
// defaults→last-used layering in loadSettings is preserved.
function setSoundControls(src) {
  if (!src) return;
  if (typeof src.soundVolume === 'number') {
    document.getElementById('optSoundVolume').value = Math.round(src.soundVolume * 100);
  }
  if (src.soundTone) document.getElementById('optSoundTone').value = src.soundTone;
  if (src.soundRepeat) document.getElementById('optSoundRepeat').value = src.soundRepeat;
  syncVolumeReadout();
}

// Mirror the sound-volume slider value into its percentage readout.
function syncVolumeReadout() {
  const slider = document.getElementById('optSoundVolume');
  const out = document.getElementById('optSoundVolumeVal');
  if (slider && out) out.textContent = (parseInt(slider.value, 10) || 0) + '%';
}

// Preview the selected tone once, at the chosen volume.
function previewSound() {
  const tone   = document.getElementById('optSoundTone').value || 'beep';
  const volume = clampSoundVolume(document.getElementById('optSoundVolume').value);
  AlertSounds.playTone(tone, { volume: volume, repeat: 1 });
}
