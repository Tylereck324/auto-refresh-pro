// popup.js
//
// The popup is a LAUNCHER, not a control panel. It owns the per-launch
// decisions — interval, randomize timing, stop-on-click, keyword detection,
// and change monitoring — plus Start/Stop. The remaining refresh-behavior
// preferences (hard refresh, overlay, notify, keep-scroll, stop-after, and the
// sound tone/repeat/volume) live on the Settings page as `globalSettings`
// defaults and are merged in at gather time below.

let currentTabId = null;
let selectedMs = 30000;
let isActive = false;

// Grace window (epoch ms) during which a broadcast that CONTRADICTS the
// optimistic Start/Stop state is treated as stale and ignored. The background
// inserts/removes the job asynchronously, and other tabs' jobs broadcast the
// full map every cycle — without this, those snapshots flicker the UI and a
// confused second click can restart the job (resetting its refresh count).
// A broadcast that CONFIRMS the state clears the window early.
let optimisticUntil = 0;
const OPTIMISTIC_GRACE_MS = 2000;

// Settings-page defaults (globalSettings). Loaded once in loadSettings and read
// by gatherSettings for the preferences the popup no longer exposes directly.
let globalDefaults = {};

// Built-in fallback presets — the single source of truth lives in preset-row.js
// (loaded before this script in popup.html) and is shared with options.js so the
// two surfaces can't drift. Overridden by the user's custom presets from the
// Settings page (globalSettings.presets) when present.
const DEFAULT_PRESETS = self.DEFAULT_PRESETS;

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

  // Slow safety-net poll. The STATUS_UPDATE push above is the primary sync (the
  // background fires it on every start/refresh/stop/update), and the countdown
  // paints from the absolute deadline independently of any poll — so this only
  // needs to recover a dropped broadcast or a job started in another tab. A 1 Hz
  // poll would wake the service worker and (pre-freshness-guard) read storage
  // every second for data the push already delivers; 15 s is ample.
  setInterval(refreshStatus, 15000);
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

  // The change-sensitivity fields only matter when "Ignore noise" is on.
  document.getElementById('optNoiseTolerant').addEventListener('change', updateConditionalRows);
  // Toggling "Randomize interval" syncs the random range row, persists, and
  // restarts a running job into the new mode; editing the range does the same
  // (debounced). Both handle their own persistence, so optRandom/optRandomMin/
  // optRandomMax are omitted from the plain saveSettings list below.
  document.getElementById('optRandom').addEventListener('change', applyRandomToggle);
  ['optRandomMin', 'optRandomMax'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('change', applyRandomRangeDebounced);
    el.addEventListener('input', applyRandomRangeDebounced);
  });

  // A keyword takes precedence over generic change-monitoring (the background
  // ignores Monitor while a keyword is set), so lock those controls to match.
  document.getElementById('optKeyword').addEventListener('input', updateKeywordLock);

  // Live-validate the regex when Regex mode is on, so an unsafe/invalid pattern
  // is flagged (and refused) before it can be saved or started.
  document.getElementById('optKeyword').addEventListener('input', validateKeywordRegex);
  document.getElementById('optKwRegex').addEventListener('change', validateKeywordRegex);
  // The per-item toggle's "needs a selector" hint is keyword-aware (it only nudges
  // while keyword detection is in use), so refresh it as the keyword changes too.
  document.getElementById('optKeyword').addEventListener('input', validateSelector);

  // Adaptive backoff is mutually exclusive with Randomize (one fixed-ish base
  // interval to ramp vs. a re-rolled random range). Toggling one clears the other,
  // then persists + live-applies to a running job — the same contract as the
  // random toggle above it.
  document.getElementById('optAdaptive').addEventListener('change', applyAdaptiveToggle);

  // Live-validate the CSS selector so an invalid one is flagged before it silently
  // falls back to whole-page reads.
  document.getElementById('optWatchSelector').addEventListener('input', validateSelector);
  // The exclude filter's enabled state follows the per-item toggle (see
  // updatePerItemEnabled), so re-evaluate when it's flipped.
  document.getElementById('optKwPerItem').addEventListener('change', validateSelector);

  // Adaptive-max cap: live-apply on edit (debounced).
  document.getElementById('optAdaptiveMax').addEventListener('input', applyAdaptiveMaxDebounced);

  // Options link
  document.getElementById('optionsLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Manage tabs
  document.getElementById('manageLink').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });

  // Save the per-launch popup state on any change.
  ['optKeyword','optSound','optStopOnKeyword','optMonitor','optStopOnChange',
   'optKwCase','optKwWhole','optKwRegex','optKwInverse','optKwPerItem','optBeepUntilAck',
   'optFlashOnKeyword','optWatchSelector','optKwExclude','optDomWatch','optDomWatchSec',
   'optNoiseTolerant','optCollapseDigits','optMinChange','optStopOnClick'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
    // Per-keystroke events get a debounced save — one storage write per pause
    // in typing instead of one per character. 'change' still saves immediately.
    if (el && (el.type === 'text' || el.type === 'number')) el.addEventListener('input', saveSettingsDebounced);
  });
}

// Trailing-edge debounce for live-apply paths driven by per-keystroke input
// events. Restarting a running job per keystroke is destructive: typing "25"
// first applies "2", and two seconds is enough for the job to reload the page
// under the user mid-edit.
function debounce(fn, ms) {
  let t = null;
  const debounced = function () {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(); }, ms);
  };
  // For callers that supersede a pending edit with an immediate action (e.g. a
  // preset click while a custom-row apply is still pending) — without this the
  // stale apply would fire ~500ms after the deliberate one.
  debounced.cancel = function () {
    if (t) { clearTimeout(t); t = null; }
  };
  // Run a pending call NOW (no-op when idle) — for the popup's pagehide flush,
  // where a timer scheduled in a closing page would never fire.
  debounced.flush = function () {
    if (t) { clearTimeout(t); t = null; fn(); }
  };
  return debounced;
}

// Read the custom interval row, clamp to the 2s minimum, and surface a hint
// when the typed value was below that floor (instead of clamping silently).
// The visual feedback (pill deselection, invalid hint, selectedMs) is immediate;
// only the persist + running-job restart is debounced, so intermediate values
// never reach the job (see debounce above).
const applyIntervalChangeDebounced = debounce(applyIntervalChange, 500);
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
  applyIntervalChangeDebounced();
}

// Turn random mode off and sync the dependent UI (hides the random range row).
// No-op when random is already off, so selecting an interval with random off
// leaves everything untouched. Callers persist the change via saveSettings().
function disableRandomMode() {
  const random = document.getElementById('optRandom');
  if (!random || !random.checked) return;
  random.checked = false;
  updateConditionalRows();
}

function updateConditionalRows() {
  // The change-sensitivity fields only matter when "Ignore noise" is on.
  const noise = document.getElementById('optNoiseTolerant').checked;
  const noiseRow = document.getElementById('noiseRow');
  if (noiseRow) noiseRow.classList.toggle('hidden', !noise);

  // The random range only matters when "Randomize interval" is on.
  const random = document.getElementById('optRandom').checked;
  const randomRow = document.getElementById('randomRow');
  if (randomRow) randomRow.classList.toggle('hidden', !random);

  // The adaptive-max cap only matters when "Adaptive interval" is on.
  const adaptive = document.getElementById('optAdaptive').checked;
  const adaptiveRow = document.getElementById('adaptiveRow');
  if (adaptiveRow) adaptiveRow.classList.toggle('hidden', !adaptive);
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
  // Picking an explicit interval (a preset pill or the custom row) is a request
  // for a fixed timer, which is mutually exclusive with the random range — under
  // random mode the chosen interval is ignored entirely (compose-settings.js).
  // So selecting one turns random mode off; when a job is running, the restart
  // below then applies the new fixed interval immediately.
  disableRandomMode();
  saveSettings();
  restartActiveJob(selectedMs);
}

// Optimistic countdown placeholder while switching into/within random mode: the
// range floor, clamped to the job's real 2s minimum so the placeholder can't
// show a duration the background would never roll. The background re-rolls
// within the range and its STATUS_UPDATE push supplies the real deadline.
function randomPlaceholderMs() {
  const min = parseFloat(document.getElementById('optRandomMin').value) || 5;
  return Math.max(2000, min * 1000);
}

// Toggling "Randomize interval" is the mirror of the preset/custom path: sync the
// dependent UI, persist, and — when a job is running — restart it so the new mode
// takes effect immediately (fixed ⇄ random) instead of only on the next Start.
function applyRandomToggle() {
  const randomOn = document.getElementById('optRandom').checked;
  // Mutually exclusive with adaptive backoff — see applyAdaptiveToggle.
  if (randomOn) { const a = document.getElementById('optAdaptive'); if (a) a.checked = false; }
  updateConditionalRows();
  saveSettings();
  restartActiveJob(randomOn ? randomPlaceholderMs() : selectedMs);
}

// Adaptive backoff and Randomize are mutually exclusive (one base interval to
// ramp vs. a re-rolled random range). Turning adaptive on clears random, then
// persists and live-restarts a running job since the scheduling mode changed.
function applyAdaptiveToggle() {
  const adaptive = document.getElementById('optAdaptive');
  if (adaptive.checked) {
    const random = document.getElementById('optRandom');
    if (random && random.checked) { random.checked = false; }
  }
  updateConditionalRows(); // show/hide the adaptive-max row (and the random row)
  saveSettings();
  restartActiveJob(selectedMs);
}

// Editing the adaptive-max cap follows the same live-apply contract as the random
// range: persist (debounced — it's a per-keystroke number input) and, when an
// adaptive job is running, restart it so the new cap takes effect now.
const applyAdaptiveMaxDebounced = debounce(() => {
  saveSettings();
  if (document.getElementById('optAdaptive').checked) restartActiveJob(selectedMs);
}, 500);

// Validate the CSS selector: it must pass the shared safety guard AND actually
// compile (querySelector throws SyntaxError on invalid CSS). On failure the field
// is flagged and the background falls back to whole-page reads — so this is
// advisory and never blocks Start (unlike an unsafe regex, which is refused).
function validateSelector() {
  const input = document.getElementById('optWatchSelector');
  const hint  = document.getElementById('selectorHint');
  const val = input.value.trim();
  let bad = false;
  if (val.length > 0) {
    const safe = typeof ARPValidators !== 'undefined' && ARPValidators.isSafeSelector(val);
    let compiles = true;
    try { document.querySelector(val); } catch (e) { compiles = false; }
    bad = !safe || !compiles;
  }
  input.classList.toggle('invalid', bad);
  if (hint) hint.classList.toggle('show', bad);
  updatePerItemEnabled(val.length > 0 && !bad);
}

// Per-item detection needs a (valid) selector to define item boundaries, so the
// toggle is disabled until one is entered. Disabling also visually dims it (the
// kw-flag picks up :disabled styling) and the "enter a selector" hint shows.
function updatePerItemEnabled(hasSelector) {
  const cb   = document.getElementById('optKwPerItem');
  const flag = document.getElementById('perItemFlag');
  const hint = document.getElementById('perItemHint');
  if (!cb) return;
  cb.disabled = !hasSelector;
  if (flag) flag.style.opacity = hasSelector ? '' : '0.5';
  // Explain the disabled state: per-item needs a selector for item boundaries.
  // Surface the "enter a selector" nudge whenever the box is disabled while the
  // user is actually doing keyword detection (or has ticked it) — otherwise a
  // greyed checkbox reads as "the keyword disabled this", which it didn't.
  const hasKeyword = document.getElementById('optKeyword').value.trim().length > 0;
  if (hint) hint.classList.toggle('show', !hasSelector && (hasKeyword || cb.checked));
  // The "skip items containing" filter and live watch only act in per-item
  // mode, so they follow the toggle: editable only while per-item is available
  // AND checked (stored values survive either way — disabling just dims them).
  const exEnabled = hasSelector && cb.checked;
  for (const [inputId, rowId] of [
    ['optKwExclude', 'kwExcludeRow'],
    ['optDomWatch', 'domWatchRow'],
    ['optDomWatchSec', null],
  ]) {
    const input = document.getElementById(inputId);
    if (input) input.disabled = !exEnabled;
    const row = rowId && document.getElementById(rowId);
    if (row) row.style.opacity = exEnabled ? '' : '0.5';
  }
}

// Editing the random range is part of the same live-apply contract as the
// toggle above it: persist, and when random mode drives a running job, restart
// it so the new bounds take effect now rather than on the next Start. Debounced
// — these are number inputs edited per keystroke (see debounce above).
const applyRandomRangeDebounced = debounce(applyRandomRange, 500);
function applyRandomRange() {
  saveSettings();
  if (document.getElementById('optRandom').checked) {
    restartActiveJob(randomPlaceholderMs());
  }
}

// Push the current popup settings to the running job and optimistically reset the
// countdown to optimisticMs for instant feedback. No-op when idle. The background
// recomputes the authoritative deadline (random mode re-rolls within the range)
// and its STATUS_UPDATE push corrects the placeholder.
function restartActiveJob(optimisticMs) {
  if (!isActive || !currentTabId) return;
  // Same gate as Start: UPDATE_INTERVAL ships the WHOLE settings object, so an
  // invalid/unsafe regex typed mid-run must not ride along with an interval
  // change — the background would refuse the matcher and the running job's
  // keyword detection would silently die while the popup still shows it armed.
  // The job keeps its last-good settings until the pattern is fixed.
  if (!validateKeywordRegex()) return;
  const settings = gatherSettings();
  chrome.runtime.sendMessage({
    type: 'UPDATE_INTERVAL',
    tabId: currentTabId,
    settings
  }, (resp) => {
    // The job may have vanished between our isActive check and the background
    // handling the message (stop-on-keyword fired, tab closed). Without this,
    // the optimistic countdown below keeps ticking for a job that isn't there
    // until the next broadcast happens to correct it. Re-sync immediately.
    if (chrome.runtime.lastError || !resp || resp.ok === false) refreshStatus();
  });
  setDeadline(Date.now() + optimisticMs, optimisticMs);
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
  const deniedNote = document.getElementById('deniedNote');
  if (deniedNote) deniedNote.classList.remove('show'); // clear any prior block message

  chrome.runtime.sendMessage({
    type: 'START_REFRESH',
    tabId: currentTabId,
    settings
  }, (resp) => {
    if (chrome.runtime.lastError) return;
    // Domain denylist (#7) refused the start — revert the optimistic active
    // state and surface why, instead of silently showing no job.
    if (resp && resp.denied) {
      isActive = false;
      optimisticUntil = 0;
      setActiveUI(false);
      stopRenderLoop();
      jobDeadline = 0;
      if (deniedNote) deniedNote.classList.add('show');
    }
  });

  isActive = true;
  optimisticUntil = Date.now() + OPTIMISTIC_GRACE_MS;
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
  optimisticUntil = Date.now() + OPTIMISTIC_GRACE_MS;
  setActiveUI(false);
  stopRenderLoop();
  jobDeadline = 0;
}

// ── Settings gather ─────────────────────────────────────────────────────────
// Read the popup's per-launch controls into the popupSettings shape, then hand
// off to the shared constructor (compose-settings.js) which merges in the
// Settings-page defaults (globalDefaults) and applies the 2s floor / inverted-
// range swap. The background's hotkey-toggle path calls the same constructor, so
// popup- and hotkey-launched jobs can't drift.
function gatherSettings() {
  const s = readPopupState();
  s.keyword = s.keyword.trim(); // stored raw; the job/matcher wants it trimmed
  return ARPCompose.composeJobSettings(s, globalDefaults);
}

// Single reader for the popup's per-launch controls — both the persisted
// popupSettings (saveSettings) and a launched job (gatherSettings) derive from
// this one shape. They used to read the DOM independently and drifted (parseInt
// vs parseFloat on the random range, trimmed vs raw keyword), so a job and the
// reopened popup disagreed about the same fields.
function readPopupState() {
  const el = (id) => document.getElementById(id);
  return {
    selectedMs,
    random: el('optRandom').checked,
    randomMin: parseFloat(el('optRandomMin').value) || 5,
    randomMax: parseFloat(el('optRandomMax').value) || 60,
    stopOnClick: el('optStopOnClick').checked,
    sound: el('optSound').checked,
    monitor: el('optMonitor').checked,
    noiseTolerant: el('optNoiseTolerant').checked,
    collapseDigits: el('optCollapseDigits').checked,
    minChangedFraction: clampFraction(el('optMinChange').value),
    keyword: el('optKeyword').value,
    kwCaseSensitive: el('optKwCase').checked,
    kwWholeWord: el('optKwWhole').checked,
    kwRegex: el('optKwRegex').checked,
    kwInverse: el('optKwInverse').checked,
    kwPerItem: el('optKwPerItem').checked,
    kwExclude: el('optKwExclude').value.trim().slice(0, 200),
    domWatch: el('optDomWatch').checked,
    // Live-watch scan cadence, entered in seconds, stored as ms (bounds mirror
    // the background's DOM_SCAN_MIN/MAX_MS).
    domWatchInterval: (() => {
      const v = parseFloat(el('optDomWatchSec').value);
      return (Number.isFinite(v) ? Math.min(20, Math.max(2, v)) : 4) * 1000;
    })(),
    stopOnKeyword: el('optStopOnKeyword').checked,
    stopOnChange: el('optStopOnChange').checked,
    beepUntilAck: el('optBeepUntilAck').checked,
    flashOnKeyword: el('optFlashOnKeyword').checked,
    watchSelector: el('optWatchSelector').value.trim().slice(0, 200),
    adaptive: el('optAdaptive').checked,
    // Optional backoff cap, entered in minutes, stored as ms (0 / blank = the
    // computeAdaptiveInterval default of 8× base).
    adaptiveMax: (() => {
      const v = parseFloat(el('optAdaptiveMax').value);
      return Number.isFinite(v) && v > 0 ? Math.round(v * 60000) : 0;
    })(),
  };
}

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
  // Show exactly one action button so it always reflects the real state:
  // Start when idle, Stop when running. (A disabled-looking faint button is
  // ambiguous; hiding the inapplicable one removes the guesswork.)
  btnStart.disabled = active;
  btnStop.disabled  = !active;
  btnStart.classList.toggle('hidden', active);
  btnStop.classList.toggle('hidden', !active);
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

// Freeze the hero countdown while the job is paused: stop the ticking loop and
// show a paused glyph instead of a time that would contradict the "⏸ Paused"
// note. The hero's refresh/detection/active-tab stats stay live. The next
// non-paused sync calls setDeadline, which restarts the loop and repaints.
function showPausedCountdown() {
  stopRenderLoop();
  const display = document.getElementById('countdownDisplay');
  const fill    = document.getElementById('progressFill');
  if (display) display.textContent = '⏸';
  if (fill)    fill.style.width = '100%';
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

  // Keyword-detection tally — only meaningful (and only shown) when this tab's
  // job is actually watching for a keyword. Hidden for plain refresh/monitor
  // jobs so the hero doesn't show a permanent "Detections 0".
  const statKeywords = document.getElementById('statKeywords');
  const keywordStat  = document.getElementById('keywordStat');
  const hasKeyword   = !!(job && job.settings && typeof job.settings.keyword === 'string'
    && job.settings.keyword.trim().length > 0);
  if (statKeywords) statKeywords.textContent = job ? (job.keywordCount || 0) : 0;
  if (keywordStat)  keywordStat.style.display = hasKeyword ? '' : 'none';

  // Paused (offline / quiet-hours) or snoozed indicator (#5/#9/#2). Runs every
  // sync regardless of the optimistic early-returns below, so it can't get stuck.
  const pauseNote = document.getElementById('pauseNote');
  if (pauseNote) {
    if (job && job.paused) {
      const reasonText = job.pauseReason === 'offline' ? ' — offline'
        : job.pauseReason === 'quiet' ? ' — quiet hours'
        : job.pauseReason === 'away' ? ' — away from page'
        : ''; // 'manual' (or unknown) → just "Paused"
      pauseNote.textContent = '⏸ Paused' + reasonText;
      pauseNote.classList.add('show');
    } else if (job && job.snoozeUntil) {
      const mins = Math.max(1, Math.ceil((job.snoozeUntil - Date.now()) / 60000));
      pauseNote.textContent = '🔕 Alerts snoozed (~' + mins + ' min)';
      pauseNote.classList.add('show');
    } else {
      pauseNote.classList.remove('show');
    }
  }
  // A live job for this tab means it wasn't denied — clear any stale block note.
  if (job) { const dn = document.getElementById('deniedNote'); if (dn) dn.classList.remove('show'); }

  if (job) {
    if (!isActive) {
      // A broadcast says this tab has a job while the UI shows idle. Right
      // after an optimistic Stop that's just a stale snapshot from before the
      // background processed it — flipping back would flicker Stop→Start→Stop
      // (and invite a double-click that restarts the job). Hold the optimistic
      // state through the grace window; the post-stop broadcast settles it.
      if (Date.now() < optimisticUntil) return;
      isActive = true;
      setActiveUI(true);
    }
    optimisticUntil = 0; // state confirmed by the background
    if (job.paused) {
      // Paused: job.nextRefresh is a short re-check deadline (up to 5 min), not a
      // real countdown to a refresh — draining it under "until next refresh"
      // contradicts the "⏸ Paused" note above and stalls at 0:00. Freeze the hero
      // timer instead; a later non-paused sync restarts it via setDeadline.
      showPausedCountdown();
    } else {
      const total = (job.settings && (job.settings.currentInterval || job.settings.interval)) || jobTotal;
      setDeadline(job.nextRefresh, total);
    }
  } else if (isActive) {
    // Mirror case: UI optimistically active, broadcast has no job for this tab.
    // START_REFRESH inserts into activeJobs only after async work (tabs.get +
    // executeScript), so another tab's job broadcasting in that window — which
    // a fast job does every cycle — would briefly revert the UI to idle.
    if (Date.now() < optimisticUntil) return;
    isActive = false;
    setActiveUI(false);
    stopRenderLoop();
    jobDeadline = 0;
  } else {
    optimisticUntil = 0; // idle confirmed
  }
}

// ── Persist settings ─────────────────────────────────────────────────────────
// popupSettings is the popup's sticky per-launch state. It only holds the
// fields the popup still owns; refresh-behavior preferences live in
// globalSettings (Settings page) and are merged back in at gather time, both
// here and in the background's hotkey-toggle handler.
function saveSettings() {
  chrome.storage.local.set({ popupSettings: readPopupState() }, () => {
    // Surface a rejected write (quota, corruption): the popup saves silently in
    // the background on every edit, so without this banner a failed save means
    // the user's changes just quietly revert the next time the popup opens.
    const banner = document.getElementById('saveError');
    if (!banner) return;
    if (chrome.runtime.lastError) {
      banner.textContent = '⚠ Settings not saved: ' + chrome.runtime.lastError.message;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  });
}
const saveSettingsDebounced = debounce(saveSettings, 300);

// Flush the pending debounced save when the popup closes. The popup can be
// dismissed (click-away, Esc, starting a job that focuses the page) within the
// 300ms debounce window, and a timer in a closing popup never fires — the last
// edit would silently revert. pagehide is the last event Chrome reliably
// delivers to a closing popup, and the storage write outlives the page.
window.addEventListener('pagehide', () => {
  saveSettingsDebounced.flush();
});

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
      // Clear the custom row INCLUDING its validation state — setting .value
      // programmatically fires no input event, so a leftover "minimum is 2s"
      // hint/red border from a sub-2s entry would otherwise stick around.
      const customValue = document.getElementById('customValue');
      customValue.value = '';
      customValue.classList.remove('invalid');
      const customHint = document.getElementById('customHint');
      if (customHint) customHint.classList.remove('show');
      applyIntervalChangeDebounced.cancel(); // a pending custom-row apply is superseded
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
    globalDefaults = g; // read by gatherSettings for the moved-to-Settings prefs

    // ── 1. Custom presets from the Settings page (or built-in defaults) ──
    renderPresets(g.presets);

    // ── 2. Seed from the Settings-page defaults ──
    // The default interval and the sound on/off default apply on first use; the
    // user's last-used popup state below takes precedence when present.
    if (g.defaultInterval) selectedMs = g.defaultInterval * 1000;
    setCheckbox('optSound', g.sound);

    // Randomize + stop-on-click moved from Settings into the popup. Seed them
    // from any previously-stored Settings values so an existing config carries
    // over on first open; the last-used popup state below then takes precedence.
    setCheckbox('optRandom', g.random);
    if (g.randomMin) document.getElementById('optRandomMin').value = g.randomMin;
    if (g.randomMax) document.getElementById('optRandomMax').value = g.randomMax;
    setCheckbox('optStopOnClick', g.stopOnClick);

    // ── 3. Overlay the user's last-used popup state (takes precedence) ──
    if (s) {
      if (s.selectedMs) selectedMs = s.selectedMs;

      if (s.random !== undefined) setCheckbox('optRandom', s.random);
      if (s.randomMin) document.getElementById('optRandomMin').value = s.randomMin;
      if (s.randomMax) document.getElementById('optRandomMax').value = s.randomMax;
      if (s.stopOnClick !== undefined) setCheckbox('optStopOnClick', s.stopOnClick);

      setCheckbox('optSound', s.sound);
      setCheckbox('optMonitor', s.monitor);
      setCheckbox('optNoiseTolerant', s.noiseTolerant);
      if (s.collapseDigits !== undefined) setCheckbox('optCollapseDigits', s.collapseDigits);
      if (typeof s.minChangedFraction === 'number') {
        document.getElementById('optMinChange').value = Math.round(s.minChangedFraction * 100);
      }
      setCheckbox('optStopOnKeyword', s.stopOnKeyword);
      setCheckbox('optStopOnChange', s.stopOnChange);
      setCheckbox('optKwCase', s.kwCaseSensitive);
      setCheckbox('optKwWhole', s.kwWholeWord);
      setCheckbox('optKwRegex', s.kwRegex);
      setCheckbox('optKwInverse', s.kwInverse);
      setCheckbox('optKwPerItem', s.kwPerItem);
      setCheckbox('optBeepUntilAck', s.beepUntilAck);
      setCheckbox('optFlashOnKeyword', s.flashOnKeyword);
      setCheckbox('optAdaptive', s.adaptive);
      if (typeof s.adaptiveMax === 'number' && s.adaptiveMax > 0) {
        document.getElementById('optAdaptiveMax').value = Math.round(s.adaptiveMax / 60000);
      }

      if (s.keyword) document.getElementById('optKeyword').value = s.keyword;
      if (s.watchSelector) document.getElementById('optWatchSelector').value = s.watchSelector;
      if (s.kwExclude) document.getElementById('optKwExclude').value = s.kwExclude;
      setCheckbox('optDomWatch', s.domWatch);
      if (typeof s.domWatchInterval === 'number' && s.domWatchInterval > 0) {
        document.getElementById('optDomWatchSec').value = Math.round(s.domWatchInterval / 1000);
      }
    }

    highlightSelectedPreset();
    updateConditionalRows();
    updateKeywordLock();
    validateKeywordRegex();
    validateSelector();
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
  // Reflect the blocking error on the primary CTA so it isn't a dead click:
  // a bad pattern disables Start (with an explanatory title). Only touch it
  // while idle — setActiveUI owns the Start/Stop enabled state while running.
  const btnStart = document.getElementById('btnStart');
  if (btnStart && !isActive) {
    btnStart.disabled = bad;
    btnStart.title = bad ? 'Fix the invalid regex pattern to start' : '';
  }
  return !bad;
}
