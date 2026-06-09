// options.js — logic for the Settings page.
// Kept in an external file because Manifest V3's default CSP
// (script-src 'self') forbids inline <script> in extension pages.

// ── Keybinding state ──────────────────────────────────────────────────────
let currentHotkey = null; // { key, ctrl, alt, shift, meta }
let pendingHotkey = null;
let recording = false;

const displayEl = document.getElementById('hotkeyDisplay');
const textEl = document.getElementById('hotkeyText');
const recordBtn = document.getElementById('recordBtn');
const clearBtn = document.getElementById('clearBtn');
const recordingHint = document.getElementById('recordingHint');

function formatHotkey(hk) {
  if (!hk) return null;
  const parts = [];
  if (hk.ctrl)  parts.push('Ctrl');
  if (hk.alt)   parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  if (hk.meta)  parts.push('⌘');
  parts.push(hk.key.length === 1 ? hk.key.toUpperCase() : hk.key);
  return parts;
}

function renderHotkey(hk) {
  textEl.innerHTML = '';
  if (!hk) {
    textEl.style.color = 'var(--text2)';
    textEl.style.fontSize = '12px';
    textEl.textContent = 'Using default (Alt+R)';
    return;
  }
  const parts = formatHotkey(hk);
  parts.forEach((p, i) => {
    const badge = document.createElement('kbd');
    badge.className = 'key-badge';
    badge.textContent = p;
    textEl.appendChild(badge);
    if (i < parts.length - 1) {
      const plus = document.createElement('span');
      plus.style.cssText = 'color:var(--text2);font-size:11px;';
      plus.textContent = '+';
      textEl.appendChild(plus);
    }
  });
  textEl.style.color = '';
  textEl.style.fontSize = '';
}

// Keys that are only modifiers — don't accept them alone
const MODIFIER_KEYS = new Set(['Control','Alt','Shift','Meta','CapsLock','NumLock','ScrollLock']);
// Keys to always block from recording (browser critical)
const BLOCKED_KEYS = new Set(['F5','F11','F12','Tab']);

const RECORD_HINT = 'Press any key combination… (Esc to cancel)';
const CONFIRM_HINT = 'Press a different combo to change, or click “Use this” — Esc to cancel';

function startRecording() {
  recording = true;
  pendingHotkey = null;
  displayEl.classList.add('recording');
  recordBtn.textContent = '⏹ Cancel';
  recordBtn.classList.add('recording');
  recordBtn.classList.remove('confirm');
  recordingHint.textContent = RECORD_HINT;
  recordingHint.style.display = 'block';
  textEl.innerHTML = '';
  textEl.style.color = 'var(--accent)';
  textEl.style.fontSize = '12px';
  textEl.textContent = 'Listening…';
}

function stopRecording(apply) {
  recording = false;
  displayEl.classList.remove('recording');
  recordBtn.textContent = '⏺ Record';
  recordBtn.classList.remove('recording');
  recordBtn.classList.remove('confirm');
  recordingHint.style.display = 'none';
  recordingHint.textContent = RECORD_HINT;

  if (apply && pendingHotkey) {
    currentHotkey = pendingHotkey;
  }
  renderHotkey(currentHotkey);
  pendingHotkey = null;
}

recordBtn.addEventListener('click', () => {
  if (!recording) { startRecording(); return; }
  // While recording: confirm the captured combo if there is one, else cancel.
  if (pendingHotkey) { stopRecording(true); save(); }
  else { stopRecording(false); }
});

clearBtn.addEventListener('click', () => {
  if (recording) stopRecording(false);
  currentHotkey = null;
  renderHotkey(null);
  save();
});

document.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') { stopRecording(false); return; }
  if (MODIFIER_KEYS.has(e.key)) return; // wait for actual key
  if (BLOCKED_KEYS.has(e.key)) {
    textEl.textContent = `${e.key} is reserved — try another key`;
    return;
  }

  // Require at least one modifier unless it's a function key
  const isFunctionKey = /^F\d+$/.test(e.key);
  if (!isFunctionKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    textEl.textContent = 'Add Ctrl, Alt, or Shift with that key';
    return;
  }

  pendingHotkey = {
    key: e.key,
    code: e.code, // physical key — layout- and macOS-Option-key-safe matching
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey
  };

  // Preview it
  const parts = formatHotkey(pendingHotkey);
  textEl.innerHTML = '';
  parts.forEach((p, i) => {
    const badge = document.createElement('kbd');
    badge.className = 'key-badge';
    badge.style.borderColor = 'var(--accent)';
    badge.style.color = 'var(--accent)';
    badge.textContent = p;
    textEl.appendChild(badge);
    if (i < parts.length - 1) {
      const plus = document.createElement('span');
      plus.style.cssText = 'color:var(--accent);font-size:11px;';
      plus.textContent = '+';
      textEl.appendChild(plus);
    }
  });

  // Wait for explicit confirmation instead of auto-applying, so the user can
  // adjust the combo before committing.
  recordBtn.textContent = '✓ Use this';
  recordBtn.classList.add('confirm');
  recordingHint.textContent = CONFIRM_HINT;
}, true);

// ── Presets ───────────────────────────────────────────────────────────────
// Single source of truth shared with popup.js, defined in preset-row.js (loaded
// before this script in options.html).
const defaultPresets = self.DEFAULT_PRESETS;

function setCheck(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function load() {
  chrome.storage.local.get(['globalSettings', 'customHotkey'], function(data) {
    const s = data.globalSettings || {};

    // Hotkey
    currentHotkey = data.customHotkey || null;
    renderHotkey(currentHotkey);

    // Toggles
    setCheck('defHardRefresh', s.hardRefresh);
    setCheck('defCountdown', s.showCountdown !== false);
    setCheck('defNotify', s.notify);
    setCheck('defSound', s.sound);
    if (s.soundTone) document.getElementById('defSoundTone').value = s.soundTone;
    document.getElementById('defSoundRepeat').value = s.soundRepeat || 1;
    document.getElementById('defSoundVolume').value =
      typeof s.soundVolume === 'number' ? Math.round(s.soundVolume * 100) : 90;
    syncVolumeReadout();
    if (s.defaultInterval) document.getElementById('defInterval').value = s.defaultInterval;

    // Refresh-behavior defaults. (Randomize + stop-on-click are per-launch and
    // live in the popup; only the global defaults remain here.)
    setCheck('defPreserveScroll', s.preserveScroll);
    if (s.stopAfter !== undefined) document.getElementById('defStopAfter').value = s.stopAfter;

    // Presets. An empty array is truthy, so `s.presets || defaultPresets` would
    // leave the editor permanently blank after an import that cleared presets —
    // and there's no "add preset" control to recover. Treat empty as "use the
    // built-in defaults" so the editor is always populated and editable.
    const presets = (Array.isArray(s.presets) && s.presets.length) ? s.presets : defaultPresets;
    presetCount = presets.length; // remember how many rows we render, so save reads them all
    const list = document.getElementById('presetsList');
    list.innerHTML = '';
    // Build each row with createElement (see preset-row.js) — never innerHTML —
    // so a malicious stored preset label can't inject HTML/script here.
    presets.forEach((p, i) => {
      list.appendChild(buildPresetRow(document, p, i));
    });

    // Auto-save when any preset field changes.
    list.querySelectorAll('input').forEach(function(el) {
      el.addEventListener('input', save);
    });

    loaded = true;
  });
}

// ── Auto-save ───────────────────────────────────────────────────────────────
// Settings persist on every change (no explicit Save button), matching the
// popup's behavior. Writes are debounced so typing doesn't spam storage.
let saveTimer = null;
let loaded = false;
let presetCount = defaultPresets.length; // number of preset rows currently rendered

function gatherAndSave() {
  if (!loaded) return; // don't persist before the initial load populates the form
  // Read back exactly the rows we rendered (presetCount) — not a fixed template
  // length — so importing/having ≠8 presets doesn't drop or fabricate rows.
  const presets = readPresets(document, presetCount);

  const settings = {
    hardRefresh: document.getElementById('defHardRefresh').checked,
    showCountdown: document.getElementById('defCountdown').checked,
    notify: document.getElementById('defNotify').checked,
    sound: document.getElementById('defSound').checked,
    soundTone: document.getElementById('defSoundTone').value || 'beep',
    soundRepeat: AlertSounds.clampRepeat(document.getElementById('defSoundRepeat').value),
    soundVolume: AlertSounds.clampVolume(document.getElementById('defSoundVolume').value),
    defaultInterval: parseInt(document.getElementById('defInterval').value) || 30,
    // Refresh-behavior defaults. (Randomize + stop-on-click moved to the popup.)
    preserveScroll: document.getElementById('defPreserveScroll').checked,
    stopAfter: Math.max(0, parseInt(document.getElementById('defStopAfter').value) || 0),
    presets: presets
  };

  chrome.storage.local.set({ globalSettings: settings, customHotkey: currentHotkey || null }, showSaved);
}

function showSaved() {
  const msg = document.getElementById('successMsg');
  if (msg) {
    msg.style.display = 'inline';
    clearTimeout(showSaved._t);
    showSaved._t = setTimeout(function() { msg.style.display = 'none'; }, 1500);
  }
  // Also surface a toast: the inline note sits at the bottom of a long page, so
  // a change made near the top would otherwise confirm off-screen.
  showToast('✓ Saved');
}

let _toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast show ' + (isError ? 'error' : 'success');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { toast.className = 'toast'; }, 1800);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(gatherAndSave, 350);
}

// Static default controls — attach once.
['defHardRefresh', 'defCountdown', 'defNotify', 'defSound', 'defSoundTone',
 'defPreserveScroll'].forEach(function(id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', save);
});
['defInterval', 'defSoundRepeat', 'defSoundVolume',
 'defStopAfter'].forEach(function(id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', save);
});

// Keep the volume percentage readout in sync with the slider.
function syncVolumeReadout() {
  const slider = document.getElementById('defSoundVolume');
  const out = document.getElementById('defSoundVolumeVal');
  if (slider && out) out.textContent = (parseInt(slider.value, 10) || 0) + '%';
}
document.getElementById('defSoundVolume').addEventListener('input', syncVolumeReadout);

// Preview the selected default tone once, at the chosen volume. Plays locally
// (this click is a user gesture) using the shared AlertSounds catalog.
document.getElementById('btnPreviewSound').addEventListener('click', function () {
  const tone = document.getElementById('defSoundTone').value || 'beep';
  const volume = AlertSounds.clampVolume(document.getElementById('defSoundVolume').value);
  AlertSounds.playTone(tone, { volume: volume, repeat: 1 });
});

AlertSounds.populateSelect(document.getElementById('defSoundTone')); // before load() sets the value
load();
