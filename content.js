// content.js - Injected into every page

(function () {
  if (window.__autoRefreshInjected) return;
  window.__autoRefreshInjected = true;

  let overlayEl  = null;
  let tickInterval = null;
  let deadline      = 0;  // absolute timestamp of the next refresh (job.nextRefresh)
  let totalDuration = 0;  // current cycle interval — progress-bar denominator only
  let contextValid  = true;
  let stopOnClickEnabled = false; // when true, a left-click on the page stops the job
  let preserveScrollEnabled = false; // when true, scroll position survives refreshes



  // ── Safe chrome API wrappers ──────────────────────────────────────────────
  function safeMessage(msg, cb) {
    if (!contextValid) return;
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { handleContextInvalidated(); return; }
        if (cb) cb(resp);
      });
    } catch (e) { handleContextInvalidated(); }
  }

  function safeStorageGet(key, cb) {
    if (!contextValid) return;
    try {
      chrome.storage.local.get(key, (data) => {
        if (chrome.runtime.lastError) { handleContextInvalidated(); return; }
        cb(data);
      });
    } catch (e) { handleContextInvalidated(); }
  }

  function safeStorageSet(obj) {
    if (!contextValid) return;
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) handleContextInvalidated();
      });
    } catch (e) { handleContextInvalidated(); }
  }

  function handleContextInvalidated() {
    contextValid = false;
    stopTick();
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  // ── Position helpers ──────────────────────────────────────────────────────
  const STORAGE_POS_KEY = '__ar_overlay_pos';

  function loadPos(cb) {
    safeStorageGet(STORAGE_POS_KEY, (data) => cb((data && data[STORAGE_POS_KEY]) || null));
  }

  function savePos(x, y) {
    safeStorageSet({ [STORAGE_POS_KEY]: { x, y } });
  }

  function applyPos(x, y) {
    if (!overlayEl) return;
    const maxX = window.innerWidth  - overlayEl.offsetWidth  - 4;
    const maxY = window.innerHeight - overlayEl.offsetHeight - 4;
    overlayEl.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
    overlayEl.style.top  = Math.max(4, Math.min(y, maxY)) + 'px';
  }

  // ── Build the overlay ─────────────────────────────────────────────────────
  function ensureOverlay() {
    if (!contextValid) return;
    if (overlayEl && document.body && document.body.contains(overlayEl)) return;

    // ── Inject styles once ──
    if (!document.getElementById('__ar_styles')) {
      const style = document.createElement('style');
      style.id = '__ar_styles';
      style.textContent = `
        @keyframes __ar_pulse {
          0%,100% { opacity:1; box-shadow:0 0 5px rgba(52,211,153,0.6); }
          50%      { opacity:0.7; box-shadow:0 0 12px rgba(52,211,153,1); }
        }
        #__ar_overlay, #__ar_overlay * { box-sizing:border-box; margin:0; padding:0; }
        #__ar_overlay {
          position:fixed; z-index:2147483647;
          background:rgba(8,10,14,0.97);
          backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px);
          border:1px solid rgba(255,255,255,0.12);
          box-shadow:0 12px 48px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.07) inset;
          border-radius:18px;
          user-select:none;
          opacity:0; transition:opacity 0.2s ease;
          min-width:140px; min-height:80px;
          width:240px;
          overflow:hidden;
          font-family:-apple-system,'Inter','Segoe UI',sans-serif;
          display:flex; flex-direction:column;
        }
        #__ar_drag {
          display:flex; align-items:center; justify-content:space-between;
          border-bottom:1px solid rgba(255,255,255,0.07);
          cursor:grab; flex-shrink:0;
        }
        #__ar_drag:active { cursor:grabbing; }
        #__ar_dot {
          border-radius:50%; flex-shrink:0;
          background:#34d399;
          box-shadow:0 0 6px rgba(52,211,153,0.7);
          animation:__ar_pulse 2s ease-in-out infinite;
        }
        #__ar_lbl {
          flex:1;
          font-weight:700;
          text-transform:uppercase; color:rgba(255,255,255,0.45);
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        #__ar_stop {
          background:rgba(248,113,113,0.12);
          color:rgba(248,113,113,0.8);
          border:1px solid rgba(248,113,113,0.25);
          border-radius:7px;
          font-weight:700;
          cursor:pointer;
          font-family:inherit;
          transition:all 0.15s; flex-shrink:0;
          white-space:nowrap;
        }
        #__ar_stop:hover {
          background:rgba(248,113,113,0.25);
          color:#f87171;
          border-color:rgba(248,113,113,0.6);
        }
        #__ar_body {
          display:flex; flex-direction:column; align-items:center;
          justify-content:center; flex:1; min-height:0;
        }
        #__ar_timer {
          font-family:'JetBrains Mono','SF Mono','Fira Code','Courier New',monospace;
          font-weight:700; color:#ffffff; line-height:1;
          text-align:center; width:100%;
          font-variant-numeric:tabular-nums;
        }
        #__ar_sublabel {
          font-weight:600;
          color:rgba(255,255,255,0.3); text-transform:uppercase;
        }
        #__ar_track {
          width:100%;
          background:rgba(255,255,255,0.08);
          border-radius:4px; overflow:hidden;
          flex-shrink:0;
        }
        #__ar_fill {
          height:100%;
          background:linear-gradient(90deg,#4f9eff,#a78bfa);
          border-radius:4px; width:100%;
          transition:width 1s linear;
        }
        #__ar_hint {
          font-weight:500;
          color:rgba(255,255,255,0.28);
        }
        #__ar_resize {
          position:absolute; bottom:0; right:0;
          width:20px; height:20px;
          cursor:se-resize;
          display:flex; align-items:flex-end; justify-content:flex-end;
          padding:4px;
          opacity:0.3; transition:opacity 0.15s;
        }
        #__ar_resize:hover { opacity:0.8; }
        #__ar_resize svg { display:block; }
      `;
      document.head.appendChild(style);
    }

    overlayEl = document.createElement('div');
    overlayEl.id = '__ar_overlay';

    // ── Drag bar ──
    const dragBar = document.createElement('div');
    dragBar.id = '__ar_drag';

    const dot = document.createElement('div');
    dot.id = '__ar_dot';

    const labelText = document.createElement('div');
    labelText.id = '__ar_lbl';
    labelText.textContent = 'Auto Refresh';

    const stopBtn = document.createElement('button');
    stopBtn.id = '__ar_stop';
    stopBtn.setAttribute('data-ar-stop', '1');
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeMessage({ type: 'STOP_REFRESH', tabId: null });
      hideOverlay();
    });

    dragBar.appendChild(dot);
    dragBar.appendChild(labelText);
    dragBar.appendChild(stopBtn);
    overlayEl.appendChild(dragBar);

    // ── Body ──
    const body = document.createElement('div');
    body.id = '__ar_body';

    const timer = document.createElement('div');
    timer.id = '__ar_timer';
    timer.textContent = '0:00';

    const sublabel = document.createElement('div');
    sublabel.id = '__ar_sublabel';
    sublabel.textContent = 'until next refresh';

    const track = document.createElement('div');
    track.id = '__ar_track';
    const fill = document.createElement('div');
    fill.id = '__ar_fill';
    track.appendChild(fill);

    const hint = document.createElement('div');
    hint.id = '__ar_hint';
    const hintText = document.createElement('span');
    hintText.className = '__ar_hint_text';
    hintText.textContent = hintLabel();
    // customHotkey may still be loading from storage; refresh once it's in.
    safeStorageGet('customHotkey', (data) => {
      customHotkey = (data && data.customHotkey) || customHotkey;
      refreshHint();
    });
    hint.appendChild(hintText);

    body.appendChild(timer);
    body.appendChild(sublabel);
    body.appendChild(track);
    body.appendChild(hint);
    overlayEl.appendChild(body);

    // ── Resize handle ──
    const resizeHandle = document.createElement('div');
    resizeHandle.id = '__ar_resize';
    resizeHandle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M9 1L1 9M9 5L5 9M9 9" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
    overlayEl.appendChild(resizeHandle);

    // Store refs for renderTick
    overlayEl._timer = timer;
    overlayEl._fill  = fill;

    // ── Scale everything proportionally with overlay size ──
    function scaleOverlay() {
      if (!overlayEl) return;
      const w = overlayEl.offsetWidth  || 240;
      const h = overlayEl.offsetHeight || 140;
      const s = Math.min(w, h * 1.6); // base scaling unit

      // Drag bar
      dragBar.style.padding = Math.round(s * 0.04) + 'px ' + Math.round(s * 0.055) + 'px';
      dragBar.style.gap = Math.round(s * 0.035) + 'px';
      dot.style.width  = Math.max(5, Math.round(s * 0.032)) + 'px';
      dot.style.height = dot.style.width;
      labelText.style.fontSize = Math.max(8, Math.round(s * 0.04)) + 'px';
      labelText.style.letterSpacing = Math.max(0.5, s * 0.005) + 'px';
      stopBtn.style.fontSize = Math.max(8, Math.round(s * 0.042)) + 'px';
      stopBtn.style.padding = Math.round(s * 0.012) + 'px ' + Math.round(s * 0.035) + 'px';
      stopBtn.style.borderRadius = Math.round(s * 0.028) + 'px';
      stopBtn.style.letterSpacing = '0.5px';
      stopBtn.style.lineHeight = '1.5';

      // Body
      const bp = Math.round(s * 0.06);
      body.style.padding = bp + 'px ' + Math.round(s * 0.07) + 'px ' + Math.round(s * 0.05) + 'px';
      body.style.gap = '0';

      // Timer
      timer.style.fontSize = Math.max(20, Math.round(s * 0.2)) + 'px';
      timer.style.letterSpacing = (s > 300 ? -2 : s > 200 ? -1 : 0) + 'px';

      // Sublabel
      sublabel.style.fontSize = Math.max(7, Math.round(s * 0.036)) + 'px';
      sublabel.style.letterSpacing = Math.max(0.5, s * 0.004) + 'px';
      sublabel.style.marginTop  = Math.round(s * 0.015) + 'px';
      sublabel.style.marginBottom = Math.round(s * 0.04) + 'px';

      // Track
      track.style.height = Math.max(2, Math.round(s * 0.016)) + 'px';
      track.style.marginBottom = Math.round(s * 0.04) + 'px';

      // Hint
      hint.style.fontSize = Math.max(7, Math.round(s * 0.038)) + 'px';
      hint.style.letterSpacing = '0.3px';

      // Border radius
      overlayEl.style.borderRadius = Math.max(10, Math.round(s * 0.07)) + 'px';

      // Resize handle
      const rSz = Math.max(14, Math.round(s * 0.07));
      resizeHandle.style.width  = rSz + 'px';
      resizeHandle.style.height = rSz + 'px';
    }

    // ── Resize logic ──
    makeResizable(overlayEl, resizeHandle, scaleOverlay);

    if (!document.body) return;
    document.body.appendChild(overlayEl);

    // Position
    requestAnimationFrame(() => {
      if (!overlayEl) return;
      loadPos((saved) => {
        if (!overlayEl) return;
        overlayEl.style.transform = '';
        if (saved) {
          applyPos(saved.x, saved.y);
        } else {
          const w = overlayEl.offsetWidth || 160;
          applyPos(Math.round((window.innerWidth - w) / 2), 18);
        }
        // Load saved size
        safeStorageGet('__ar_overlay_size', (sizeData) => {
          const sz = sizeData && sizeData['__ar_overlay_size'];
          if (sz && overlayEl) {
            overlayEl.style.width  = Math.max(140, sz.w) + 'px';
            overlayEl.style.height = Math.max(80, sz.h) + 'px';
          }
          scaleOverlay();
          requestAnimationFrame(() => { if (overlayEl) overlayEl.style.opacity = '1'; });
        });
      });
    });

    makeDraggable(overlayEl, dragBar);
  }

  function makeDraggable(el, handle) {
    let dragging = false;
    let startMouseX, startMouseY, startElX, startElY;

    handle.addEventListener('mousedown', (e) => {
      // Skip if the click is on the stop button (or any descendant of it)
      if (e.target.closest && e.target.closest('[data-ar-stop]')) return;
      e.preventDefault();
      dragging = true;
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startElX = parseInt(el.style.left) || el.getBoundingClientRect().left;
      startElY = parseInt(el.style.top)  || el.getBoundingClientRect().top;
      el.style.cursor     = 'grabbing';
      el.style.boxShadow  = '0 12px 50px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.08) inset';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      applyPos(startElX + e.clientX - startMouseX, startElY + e.clientY - startMouseY);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor    = 'grab';
      el.style.boxShadow = '0 8px 40px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.06) inset';
      savePos(parseInt(el.style.left), parseInt(el.style.top));
    });
  }

  // ── Resize logic ─────────────────────────────────────────────────────────
  function makeResizable(el, handle, onResize) {
    let resizing = false;
    let startX, startY, startW, startH;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = el.offsetWidth;
      startH = el.offsetHeight;
      document.body.style.cursor = 'se-resize';
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const newW = Math.max(140, startW + (e.clientX - startX));
      const newH = Math.max(80, startH + (e.clientY - startY));
      el.style.width  = newW + 'px';
      el.style.height = newH + 'px';
      if (onResize) onResize();
    });

    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.cursor = '';
      // Save size
      safeStorageSet({
        '__ar_overlay_size': {
          w: el.offsetWidth,
          h: el.offsetHeight
        }
      });
    });
  }

  // ── Hide overlay ──────────────────────────────────────────────────────────
  function hideOverlay() {
    stopTick();
    if (!overlayEl) return;
    overlayEl.style.opacity = '0';
    const el = overlayEl;
    overlayEl = null;
    setTimeout(() => { if (el && el.parentNode) el.remove(); }, 240);
  }

  // ── Tick logic ────────────────────────────────────────────────────────────
  // Render the countdown as a pure function of the absolute deadline, mirroring
  // the popup. The tick is self-scheduled to land just past each wall-clock
  // second boundary, so the displayed second flips at the same instant as the
  // popup (which uses the identical scheme over the same deadline) — no residual
  // phase skew. Absolute timing also self-corrects any COUNTDOWN_START latency.
  function startCountdown(deadlineTs, total) {
    stopTick();
    deadline      = deadlineTs;
    totalDuration = total || Math.max(0, deadlineTs - Date.now());
    tickAligned();
  }

  function tickAligned() {
    renderTick();
    const remaining = Math.max(0, deadline - Date.now());
    // ms until ceil(remaining/1000) next changes, +15ms to land just past it.
    const delay = remaining > 0 ? (remaining % 1000) + 15 : 250;
    tickInterval = setTimeout(tickAligned, delay);
  }

  function stopTick() {
    if (tickInterval) { clearTimeout(tickInterval); tickInterval = null; }
  }

  function renderTick() {
    if (!overlayEl) return;
    const remaining = Math.max(0, deadline - Date.now());
    if (overlayEl._timer) overlayEl._timer.textContent = formatTime(remaining);
    if (overlayEl._fill)  overlayEl._fill.style.width  = totalDuration > 0
      ? Math.max(0, Math.min(100, remaining / totalDuration * 100)) + '%' : '0%';
  }

  function formatTime(ms) {
    const s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ── Scroll preservation ───────────────────────────────────────────────────
  // The background reloads the tab via chrome.tabs.reload, which destroys this
  // content script. We persist scrollY to sessionStorage (per-tab, per-URL) just
  // before unload and restore it once the new page's sync confirms the feature is
  // on. Listeners are armed only while enabled, to avoid touching sessionStorage
  // on unrelated pages.
  const SCROLL_KEY = '__ar_scroll_' + location.pathname + location.search;
  let scrollListenersArmed = false;

  function captureScroll() {
    if (!preserveScrollEnabled) return;
    try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || window.pageYOffset || 0)); } catch (e) {}
  }

  function armScrollCapture() {
    if (scrollListenersArmed) return;
    scrollListenersArmed = true;
    window.addEventListener('beforeunload', captureScroll);
    // beforeunload is unreliable on some platforms; capture on hide too.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') captureScroll();
    });
  }

  // Restore once, after the sync tells us the feature is on. Retried briefly to
  // outlast late-laying-out pages, then the key is cleared so a later manual
  // navigation doesn't snap-scroll.
  let scrollRestored = false;
  function restoreScroll() {
    if (scrollRestored || !preserveScrollEnabled) return;
    let saved;
    try { saved = sessionStorage.getItem(SCROLL_KEY); } catch (e) { return; }
    if (saved == null) return;
    scrollRestored = true;
    const y = parseInt(saved, 10);
    if (!Number.isFinite(y)) return;
    const apply = () => { try { window.scrollTo(0, y); } catch (e) {} };
    apply();
    requestAnimationFrame(apply);
    setTimeout(() => { apply(); try { sessionStorage.removeItem(SCROLL_KEY); } catch (e) {} }, 400);
  }

  // Call when a settings payload (COUNTDOWN_START / GET_STATUS) tells us whether
  // scroll preservation is enabled.
  function applyPreserveScroll(enabled) {
    preserveScrollEnabled = !!enabled;
    if (preserveScrollEnabled) { armScrollCapture(); restoreScroll(); }
  }

  // ── Sync on page load ─────────────────────────────────────────────────────
  // Retry several times with backoff — the background service worker may be
  // waking up, or the content script may have injected before the popup's
  // START_REFRESH message was fully processed.
  let synced = false;

  function syncWithBackground(attempt) {
    if (synced || !contextValid) return;
    attempt = attempt || 0;
    safeMessage({ type: 'GET_STATUS', tabId: null }, (resp) => {
      if (synced || !contextValid) return;
      if (resp && resp.job) {
        synced = true;
        const s = resp.job.settings || {};
        stopOnClickEnabled = !!s.stopOnClick;
        applyPreserveScroll(s.preserveScroll);
        // Respect the "Show countdown overlay" setting (click-to-stop still works).
        if (s.showCountdown !== false) {
          const total = (s.currentInterval || s.interval)
            || Math.max(0, resp.job.nextRefresh - Date.now());
          ensureOverlay();
          startCountdown(resp.job.nextRefresh, total);
          refreshHint();
        }
      } else if (attempt < 8) {
        // Exponential backoff: 100, 200, 400, 800, 1000, 1000, 1000, 1000 ms
        const delay = Math.min(100 * Math.pow(2, attempt), 1000);
        setTimeout(() => syncWithBackground(attempt + 1), delay);
      }
    });
  }
  syncWithBackground(0);

  // ── Custom keybinding ─────────────────────────────────────────────────────
  // The in-page hotkey is the single source of truth for toggling refresh.
  // When the user hasn't recorded a custom combo, this default applies so the
  // shortcut works out of the box. `code` is the physical key (layout- and
  // Option-key-safe on macOS, where Alt+R mangles `e.key`).
  const DEFAULT_HOTKEY = { key: 'r', code: 'KeyR', ctrl: false, alt: true, shift: false, meta: false };

  let customHotkey = null;
  safeStorageGet('customHotkey', (d) => { customHotkey = (d && d.customHotkey) || null; });

  function activeHotkey() { return customHotkey || DEFAULT_HOTKEY; }

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (!contextValid) return;
      if (changes.customHotkey) {
        customHotkey = changes.customHotkey.newValue || null;
        refreshHint();
      }
    });
  } catch (e) {}

  function matchesHotkey(e, hk) {
    if (!hk) return false;
    // Prefer matching the physical key (e.code) when the combo carries one —
    // robust across keyboard layouts and macOS Option-key remapping. Fall back
    // to e.key for older recorded combos that predate the code field.
    const keyMatch = hk.code ? e.code === hk.code : e.key === hk.key;
    return keyMatch &&
      !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt &&
      !!e.shiftKey === !!hk.shift && !!e.metaKey === !!hk.meta;
  }

  function formatHotkeyDisplay(hk) {
    if (!hk) return '';
    const p = [];
    if (hk.ctrl)  p.push('Ctrl');
    if (hk.alt)   p.push('Alt');
    if (hk.shift) p.push('Shift');
    if (hk.meta)  p.push('⌘');
    p.push(hk.key.length === 1 ? hk.key.toUpperCase() : hk.key);
    return p.join('+');
  }

  // The overlay footer hint. When click-to-stop is armed, surface it so the
  // next-click-stops behavior isn't a surprise; otherwise show the hotkey.
  function hintLabel() {
    const hk = formatHotkeyDisplay(activeHotkey());
    return stopOnClickEnabled ? ('Click page or ' + hk + ' to stop') : (hk + ' to toggle');
  }

  function refreshHint() {
    const h = overlayEl && overlayEl.querySelector('.__ar_hint_text');
    if (h) h.textContent = hintLabel();
  }

  document.addEventListener('keydown', (e) => {
    if (!contextValid) return;
    if (matchesHotkey(e, activeHotkey())) {
      e.preventDefault();
      safeMessage({ type: 'HOTKEY_TOGGLE' });
    }
  }, true);

  // ── Click-to-stop ─────────────────────────────────────────────────────────
  // When enabled, a left-click anywhere on the page stops the refresh job.
  // Pass-through: the click is NOT cancelled, so links/buttons still work.
  // Clicks inside the overlay are ignored — it has its own Stop button.
  document.addEventListener('click', (e) => {
    if (!contextValid || !stopOnClickEnabled) return;
    if (e.button) return; // left-button only
    if (e.target && e.target.closest && e.target.closest('#__ar_overlay')) return;
    // Stop the job, then disarm only once the stop is acknowledged. Disarming
    // before the message round-trips could otherwise drop the click silently if
    // the send failed. The flag is re-armed on the next COUNTDOWN_START anyway.
    safeMessage({ type: 'STOP_REFRESH', tabId: null }, () => { stopOnClickEnabled = false; });
    hideOverlay();
  }, true);

  // ── Messages from background ─────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!contextValid) return;
      switch (msg.type) {
        case 'COUNTDOWN_START':
          stopOnClickEnabled = !!msg.stopOnClick;
          applyPreserveScroll(msg.preserveScroll);
          // Respect the "Show countdown overlay" setting. Click-to-stop still
          // works without the overlay, so it's wired above regardless.
          if (msg.showCountdown === false) {
            hideOverlay();
          } else {
            ensureOverlay();
            startCountdown(msg.nextRefresh, msg.total);
            refreshHint();
          }
          synced = true;
          sendResponse({ ok: true });
          break;
        case 'STOPPED':
          stopOnClickEnabled = false;
          hideOverlay();
          sendResponse({ ok: true });
          break;

      }
    });
  } catch (e) { handleContextInvalidated(); }

})();
