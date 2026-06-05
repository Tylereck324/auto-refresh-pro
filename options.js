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

function startRecording() {
  recording = true;
  pendingHotkey = null;
  displayEl.classList.add('recording');
  recordBtn.textContent = '⏹ Cancel';
  recordBtn.classList.add('recording');
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
  recordingHint.style.display = 'none';

  if (apply && pendingHotkey) {
    currentHotkey = pendingHotkey;
  }
  renderHotkey(currentHotkey);
  pendingHotkey = null;
}

recordBtn.addEventListener('click', () => {
  if (recording) { stopRecording(false); } else { startRecording(); }
});

clearBtn.addEventListener('click', () => {
  if (recording) stopRecording(false);
  currentHotkey = null;
  renderHotkey(null);
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

  // Auto-confirm after a short delay
  setTimeout(() => { if (recording) stopRecording(true); }, 800);
}, true);

// chrome://extensions/shortcuts — options pages can't open chrome:// URLs,
// so copy to clipboard and hint the user to paste it.
document.getElementById('chromeShortcutLink').addEventListener('click', (e) => {
  e.preventDefault();
  navigator.clipboard.writeText('chrome://extensions/shortcuts').catch(() => {});
  const link = e.currentTarget;
  const orig = link.textContent;
  link.textContent = '✓ Copied! Paste in address bar';
  link.style.color = 'var(--accent2)';
  setTimeout(() => { link.textContent = orig; link.style.color = ''; }, 2500);
});

// ── Presets ───────────────────────────────────────────────────────────────
const defaultPresets = [
  { label: '5s', ms: 5000 }, { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 }, { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 }, { label: '10m', ms: 600000 },
  { label: '30m', ms: 1800000 }, { label: '1h', ms: 3600000 }
];

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
    if (s.defaultInterval) document.getElementById('defInterval').value = s.defaultInterval;

    // Presets
    const presets = s.presets || defaultPresets;
    const list = document.getElementById('presetsList');
    list.innerHTML = '';
    presets.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'preset-item';
      div.innerHTML =
        '<span class="preset-label">Preset ' + (i + 1) + '</span>' +
        '<input type="text" value="' + p.label + '" id="pLabel' + i + '" placeholder="Label">' +
        '<input type="number" value="' + Math.round(p.ms / 1000) + '" id="pSec' + i + '" placeholder="Sec" min="2">';
      list.appendChild(div);
    });
  });
}

document.getElementById('saveBtn').addEventListener('click', function() {
  const presets = defaultPresets.map(function(_, i) {
    const labelEl = document.getElementById('pLabel' + i);
    const secEl = document.getElementById('pSec' + i);
    const label = (labelEl && labelEl.value) || String(i);
    const sec = parseFloat(secEl && secEl.value) || 30;
    return { label: label, ms: Math.max(2000, sec * 1000) };
  });

  const settings = {
    hardRefresh: document.getElementById('defHardRefresh').checked,
    showCountdown: document.getElementById('defCountdown').checked,
    notify: document.getElementById('defNotify').checked,
    sound: document.getElementById('defSound').checked,
    defaultInterval: parseInt(document.getElementById('defInterval').value) || 30,
    presets: presets
  };

  chrome.storage.local.set({ globalSettings: settings, customHotkey: currentHotkey || null }, function() {
    const msg = document.getElementById('successMsg');
    msg.style.display = 'block';
    setTimeout(function() { msg.style.display = 'none'; }, 2000);
  });
});

load();
