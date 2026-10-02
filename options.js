// options.js — logic for the Settings page.
// Kept in an external file because Manifest V3's default CSP
// (script-src 'self') forbids inline <script> in extension pages.

// ── Keyboard shortcut ─────────────────────────────────────────────────────
// The toggle shortcut is a manifest `commands` entry, so Chrome owns the
// binding (rebindable at chrome://extensions/shortcuts) and it works on every
// page without a content script listening for keys in each one.
const textEl = document.getElementById('hotkeyText');

function renderShortcut() {
  chrome.commands.getAll(function(cmds) {
    const cmd = (cmds || []).find(function(c) { return c.name === 'toggle-refresh'; });
    const shortcut = cmd && cmd.shortcut;
    textEl.innerHTML = '';
    if (!shortcut) {
      textEl.style.color = 'var(--text2)';
      textEl.style.fontSize = '12px';
      textEl.textContent = 'Not set';
      return;
    }
    textEl.style.color = '';
    textEl.style.fontSize = '';
    // Chrome reports e.g. "Alt+R" or "⌥R" (macOS); render each key as a badge.
    const parts = shortcut.includes('+') ? shortcut.split('+') : [shortcut];
    parts.forEach(function(p, i) {
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
  });
}

document.getElementById('changeShortcutBtn').addEventListener('click', function() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
// Pick up a rebinding made on the shortcuts page when the user comes back.
window.addEventListener('focus', renderShortcut);
renderShortcut();

// ── Presets ───────────────────────────────────────────────────────────────
// Single source of truth shared with popup.js, defined in preset-row.js (loaded
// before this script in options.html).
const defaultPresets = self.DEFAULT_PRESETS;

function setCheck(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

// ── Quiet Hours / Webhook helpers ────────────────────────────────────────────
const QH_DAY_IDS = ['qhDay0','qhDay1','qhDay2','qhDay3','qhDay4','qhDay5','qhDay6'];

// Channel checkboxes only matter in 'suppress' mode (a paused window skips the
// reload before any channel fires), so hide that row when mode = 'pause'.
function syncQuietChannelsRow() {
  const mode = document.getElementById('qhMode').value;
  const row = document.getElementById('qhChannelsRow');
  if (row) row.classList.toggle('row-hidden', mode !== 'suppress');
}

// Show the muted hint (and flag the input) only when the URL is non-empty AND
// fails the shared SSRF/https guard. Empty is a valid "no webhook" state.
function validateWebhookUrl() {
  const input = document.getElementById('webhookUrl');
  const hint = document.getElementById('webhookHint');
  const raw = (input.value || '').trim();
  const bad = raw.length > 0 && !ARPValidators.isSafeWebhookUrl(raw);
  input.classList.toggle('invalid', bad);
  if (hint) hint.classList.toggle('show', bad);
  return !bad;
}

// Send a sample alert through the worker's real delivery path (validation +
// retry), so a typo'd or deleted webhook shows up now, not when a study is missed.
document.getElementById('btnTestWebhook').addEventListener('click', async function() {
  const btn = this;
  const url = (document.getElementById('webhookUrl').value || '').trim();
  if (!url || !validateWebhookUrl()) { showToast('Enter a valid HTTPS webhook URL first.', true); return; }
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TEST_WEBHOOK', url, format: document.getElementById('webhookFormat').value,
    });
    if (res && res.ok) showToast('✓ Test alert delivered');
    else showToast('Webhook failed: ' + ((res && res.error) || 'no response'), true);
  } catch (e) {
    showToast('Webhook failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

function load() {
  chrome.storage.local.get(['globalSettings'], function(data) {
    const s = data.globalSettings || {};


    // Toggles
    setCheck('defHardRefresh', s.hardRefresh);
    setCheck('defCountdown', s.showCountdown !== false);
    setCheck('defNotify', s.notify);
    setCheck('defSound', s.sound);
    // A tone this version doesn't know (imported from a newer version) leaves
    // the <select> unselected (''), and the next auto-save used to silently
    // persist 'beep' over it. Remember the raw value so saves keep it intact
    // until the user deliberately picks a different tone.
    unknownSoundTone = null;
    if (s.soundTone) {
      const toneSel = document.getElementById('defSoundTone');
      toneSel.value = s.soundTone;
      if (toneSel.value !== s.soundTone) unknownSoundTone = s.soundTone;
    }
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

    // ── Quiet Hours ──
    // Default to a 22:00→07:00 suppress window when absent; keep stored times
    // (and days/channels) on the controls so toggling enabled preserves them.
    const qh = s.quietHours || {};
    setCheck('qhEnabled', qh.enabled);
    document.getElementById('qhStart').value =
      typeof qh.startMin === 'number' ? ARPQuietHours.minutesToTime(qh.startMin) : '22:00';
    document.getElementById('qhEnd').value =
      typeof qh.endMin === 'number' ? ARPQuietHours.minutesToTime(qh.endMin) : '07:00';
    document.getElementById('qhMode').value = qh.mode === 'pause' ? 'pause' : 'suppress';
    // days: null (or absent) = every day ⇒ all seven checked.
    const days = Array.isArray(qh.days) && qh.days.length === 7 ? qh.days : null;
    QH_DAY_IDS.forEach(function(id, i) { setCheck(id, days ? days[i] : true); });
    // channels: null (or absent) = mute all ⇒ all three checked.
    const chans = qh.channels && typeof qh.channels === 'object' ? qh.channels : null;
    setCheck('qhChanSound', chans ? chans.sound !== false : true);
    setCheck('qhChanFlash', chans ? chans.flash !== false : true);
    setCheck('qhChanNotify', chans ? chans.notify !== false : true);
    syncQuietChannelsRow();

    // ── Webhook ──
    document.getElementById('webhookUrl').value = typeof s.webhookUrl === 'string' ? s.webhookUrl : '';
    document.getElementById('webhookFormat').value =
      ['discord','slack','json'].includes(s.webhookFormat) ? s.webhookFormat : 'json';
    validateWebhookUrl();

    loaded = true;
  });
}

// ── Auto-save ───────────────────────────────────────────────────────────────
// Settings persist on every change (no explicit Save button), matching the
// popup's behavior. Writes are debounced so typing doesn't spam storage.
let saveTimer = null;
let loaded = false;
let presetCount = defaultPresets.length; // number of preset rows currently rendered
let unknownSoundTone = null; // a newer version's tone we must not clobber (see load)

// Build the quietHours object from the controls. Always returns the FULL shape
// (even when disabled) so toggling enabled off and back on preserves the
// window, days, and channels the user set.
function buildQuietHours() {
  const startMin = ARPQuietHours.parseTimeToMinutes(document.getElementById('qhStart').value);
  const endMin = ARPQuietHours.parseTimeToMinutes(document.getElementById('qhEnd').value);
  const dayBools = QH_DAY_IDS.map(function(id) { return document.getElementById(id).checked; });
  // All seven checked ⇒ "every day" ⇒ store null (the worker treats null as no
  // weekday filter); otherwise store the explicit 7-bool mask.
  const days = dayBools.every(Boolean) ? null : dayBools;
  return {
    enabled: document.getElementById('qhEnabled').checked,
    // parseTimeToMinutes can return null for an empty/garbage field; fall back to
    // the documented defaults so we never persist a NaN/null window bound.
    startMin: startMin == null ? 22 * 60 : startMin,
    endMin: endMin == null ? 7 * 60 : endMin,
    mode: document.getElementById('qhMode').value === 'pause' ? 'pause' : 'suppress',
    days,
    channels: {
      sound: document.getElementById('qhChanSound').checked,
      flash: document.getElementById('qhChanFlash').checked,
      notify: document.getElementById('qhChanNotify').checked,
    },
  };
}

function gatherAndSave() {
  if (!loaded) return; // don't persist before the initial load populates the form
  // Read back exactly the rows we rendered (presetCount) — not a fixed template
  // length — so importing/having ≠8 presets doesn't drop or fabricate rows.
  const presets = readPresets(document, presetCount);

  // Webhook: the worker fetches this with the extension's host access, so a
  // bad/SSRF URL must never be stored. Trim, then persist '' if it fails the
  // guard (and surface the hint). Empty stays empty (no webhook).
  const webhookRaw = (document.getElementById('webhookUrl').value || '').trim();
  const webhookOk = validateWebhookUrl();
  const webhookUrl = (webhookRaw && webhookOk) ? webhookRaw : '';

  const settings = {
    hardRefresh: document.getElementById('defHardRefresh').checked,
    showCountdown: document.getElementById('defCountdown').checked,
    notify: document.getElementById('defNotify').checked,
    sound: document.getElementById('defSound').checked,
    soundTone: document.getElementById('defSoundTone').value || unknownSoundTone || 'beep',
    soundRepeat: AlertSounds.clampRepeat(document.getElementById('defSoundRepeat').value),
    soundVolume: AlertSounds.clampVolume(document.getElementById('defSoundVolume').value),
    // Clamp to the 2s job floor — HTML min="2" doesn't constrain typed input,
    // and a stored negative would surface as a "-5s" pre-selection in the popup.
    defaultInterval: Math.max(2, parseInt(document.getElementById('defInterval').value) || 30),
    // Refresh-behavior defaults. (Randomize + stop-on-click moved to the popup.)
    preserveScroll: document.getElementById('defPreserveScroll').checked,
    stopAfter: Math.max(0, parseInt(document.getElementById('defStopAfter').value) || 0),
    presets: presets,
    // Quiet Hours + Webhook ride along into the Object.assign merge below.
    quietHours: buildQuietHours(),
    webhookUrl: webhookUrl,
    webhookFormat: document.getElementById('webhookFormat').value || 'json'
  };

  // MERGE into the stored object, never replace it. globalSettings also carries
  // keys this form doesn't own: forward-compat keys a newer version's import
  // deliberately preserved (sanitizeImportedSettings) and legacy per-launch
  // values (g.random / g.stopOnClick) that compose-settings.js still reads as
  // fallbacks for un-migrated popup state. Rebuilding from the fixed key list
  // above used to erase all of those on the first toggle flip.
  chrome.storage.local.get(['globalSettings'], function(data) {
    const merged = Object.assign({}, data.globalSettings, settings);
    chrome.storage.local.set({ globalSettings: merged }, function() {
      // A failed write (quota, corruption) surfaces only via lastError — without
      // this check the page would flash "✓ Saved" over a save that didn't happen.
      if (chrome.runtime.lastError) {
        showToast('Save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        showSaved();
      }
    });
  });
}

// Re-sync the form when storage changes underneath it — e.g. the user imports a
// settings file on the Manage page while this page sits open in another tab;
// the next toggle here would otherwise persist the whole stale form over the
// import. Only while hidden: when visible, the form is what the user is
// actively editing (and our own debounced saves fire onChanged too — reloading
// then would rebuild the preset rows under the user's cursor mid-keystroke).
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area !== 'local') return;
  if (!changes.globalSettings) return;
  if (!document.hidden) return;
  load();
});

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

// showToast comes from the shared toast.js (loaded before this script).

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(gatherAndSave, 350);
}

// Static default controls — attach once. Checkboxes/selects save on 'change';
// the quiet-hours day/channel checkboxes and both selects join this group.
['defHardRefresh', 'defCountdown', 'defNotify', 'defSound', 'defSoundTone',
 'defPreserveScroll',
 'qhEnabled', 'qhMode', 'qhChanSound', 'qhChanFlash', 'qhChanNotify',
 'qhDay0', 'qhDay1', 'qhDay2', 'qhDay3', 'qhDay4', 'qhDay5', 'qhDay6',
 'webhookFormat'].forEach(function(id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', save);
});
// Text/time/number inputs save on 'input' (save() debounces).
['defInterval', 'defSoundRepeat', 'defSoundVolume',
 'defStopAfter',
 'qhStart', 'qhEnd', 'webhookUrl'].forEach(function(id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', save);
});

// Mode drives whether the channel row is relevant — re-sync on change.
document.getElementById('qhMode').addEventListener('change', syncQuietChannelsRow);
// Live-validate the webhook URL as the user types (separate from the debounced
// save so the hint reacts immediately).
document.getElementById('webhookUrl').addEventListener('input', validateWebhookUrl);

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
