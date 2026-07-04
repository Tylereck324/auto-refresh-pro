// content.js - Injected into every page

(function () {
  if (window.__autoRefreshInjected) return;
  window.__autoRefreshInjected = true;

  // Sweep DOM left by an orphaned pre-reload copy of this script. After an
  // extension reload/update the background re-injects content.js into a FRESH
  // isolated world — the old world's window guard isn't visible here, and its
  // script only removes its own overlay when it next touches a chrome API and
  // notices the dead runtime (handleContextInvalidated). Until then the page
  // would show two stacked overlays: the live one and the orphan's, frozen at
  // whatever countdown it last painted. On a normal page load these elements
  // can't exist, so this is a no-op. (#__ar_styles is swept too so an updated
  // version's overlay isn't styled by the previous version's stale CSS; the
  // flash element self-removes on a plain-DOM timer, so it needs no sweep.)
  for (const id of ['__ar_overlay', '__ar_styles']) {
    const stale = document.getElementById(id);
    if (stale) stale.remove();
  }

  let overlayEl  = null;
  let tickInterval = null;
  let deadline      = 0;  // absolute timestamp of the next refresh (job.nextRefresh)
  let totalDuration = 0;  // current cycle interval — progress-bar denominator only
  let contextValid  = true;
  let stopOnClickEnabled = false; // when true, a left-click on the page stops the job
  let preserveScrollEnabled = false; // when true, scroll position survives refreshes
  let paused = false; // local mirror of the overlay's pause toggle (no COUNTDOWN_START follows PAUSE_JOB)
  // Shared drag/resize state, read by the document-level pointer listeners that
  // are registered once (see below) rather than per overlay rebuild.
  let dragState = null;
  let resizeState = null;



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
    // Unwire the document-level drag/resize listeners — the overlay they serve
    // is gone for good (extension reloaded/updated), so leaving them attached
    // would churn on every pointer move for the page's remaining lifetime.
    dragState = null;
    resizeState = null;
    if (pointerListenersAbort) { pointerListenersAbort.abort(); pointerListenersAbort = null; }
    pointerListenersWired = false;
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

    // Wire the shared drag/resize document listeners now that an overlay is about
    // to exist (one-shot; no-op on subsequent rebuilds).
    wireGlobalPointerListeners();

    // ── Inject styles once ──
    if (!document.getElementById('__ar_styles')) {
      const style = document.createElement('style');
      style.id = '__ar_styles';
      style.textContent = `
        /* Opacity-only pulse: opacity animates on the compositor, while the old
           box-shadow keyframes forced a main-thread repaint every frame for the
           overlay's whole lifetime. The dot keeps a static glow below. */
        @keyframes __ar_pulse {
          0%,100% { opacity:1; }
          50%      { opacity:0.55; }
        }
        #__ar_overlay, #__ar_overlay * { box-sizing:border-box; margin:0; padding:0; }
        #__ar_overlay {
          position:fixed; z-index:2147483647;
          /* parity with theme.css --bg #0a0c10 = rgb(10,12,16). No backdrop-filter:
             at 0.97 alpha a blur is essentially invisible, but it forced the GPU to
             re-blur the page region under the overlay on every underlying paint —
             a constant tax on exactly the pages this extension watches. */
          background:rgba(10,12,16,0.97);
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
          /* 0.62 white over the ~#111317 overlay clears WCAG AA (≈7:1); the old
             0.45 sat at ~4.5 and the sublabel/hint below were well under. */
          text-transform:uppercase; color:rgba(255,255,255,0.62);
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
        #__ar_ctl {
          display:flex; align-items:center; flex-shrink:0;
        }
        #__ar_pause, #__ar_extend {
          background:rgba(255,255,255,0.08);
          color:rgba(255,255,255,0.7);
          border:1px solid rgba(255,255,255,0.18);
          border-radius:7px;
          font-weight:700;
          cursor:pointer;
          font-family:inherit;
          transition:all 0.15s; flex-shrink:0;
          white-space:nowrap;
        }
        #__ar_pause:hover, #__ar_extend:hover {
          background:rgba(255,255,255,0.16);
          color:#ffffff;
          border-color:rgba(255,255,255,0.35);
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
          color:rgba(255,255,255,0.62); text-transform:uppercase;
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
          /* Drain via transform, not width: a width transition re-triggered every
             second means continuous layout+paint for the page's whole job lifetime;
             scaleX stays on the compositor. */
          transform-origin:left;
          transition:transform 1s linear;
        }
        #__ar_hint {
          font-weight:500;
          color:rgba(255,255,255,0.55);
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
        /* Honor the OS "reduce motion" preference: the overlay can't link
           theme.css (it renders into the host page), so it carries its own
           guard — stop the pulsing dot and drop the per-second bar/transition
           animations. */
        @media (prefers-reduced-motion: reduce) {
          #__ar_dot { animation:none; }
          #__ar_overlay, #__ar_fill, #__ar_stop, #__ar_pause, #__ar_extend, #__ar_resize { transition:none; }
        }
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

    // Quick controls live in a flex group so the three buttons stay grouped at
    // the right edge with a small gap, while the label keeps ellipsizing on the
    // left (the drag bar's space-between pushes the group right).
    const ctl = document.createElement('div');
    ctl.id = '__ar_ctl';

    // Pause/Resume toggle. data-ar-stop makes the drag-start guard skip it (it
    // already skips [data-ar-stop]), so a click here never begins a drag.
    const pauseBtn = document.createElement('button');
    pauseBtn.id = '__ar_pause';
    pauseBtn.setAttribute('data-ar-stop', '1');
    pauseBtn.textContent = paused ? '▶' : '⏸';
    pauseBtn.setAttribute('aria-label', 'Pause or resume');
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (paused) {
        safeMessage({ type: 'RESUME_JOB', tabId: null });
        setPaused(false);
      } else {
        safeMessage({ type: 'PAUSE_JOB', tabId: null });
        setPaused(true);
      }
    });

    // +30s — push the next refresh out. The background re-sends COUNTDOWN_START
    // in reply, so the timer updates itself; nothing to reflect locally.
    const extendBtn = document.createElement('button');
    extendBtn.id = '__ar_extend';
    extendBtn.setAttribute('data-ar-stop', '1');
    extendBtn.textContent = '+30s';
    extendBtn.setAttribute('aria-label', 'Add 30 seconds');
    extendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeMessage({ type: 'EXTEND_JOB', tabId: null, ms: 30000 });
    });

    const stopBtn = document.createElement('button');
    stopBtn.id = '__ar_stop';
    stopBtn.setAttribute('data-ar-stop', '1');
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeMessage({ type: 'STOP_REFRESH', tabId: null });
      hideOverlay();
    });

    ctl.appendChild(pauseBtn);
    ctl.appendChild(extendBtn);
    ctl.appendChild(stopBtn);
    dragBar.appendChild(dot);
    dragBar.appendChild(labelText);
    dragBar.appendChild(ctl);
    overlayEl.appendChild(dragBar);

    // Mirror module state onto the pause button + sublabel. Called by the click
    // handler and by COUNTDOWN_START/STOPPED resets below (via overlayEl._setPaused).
    function setPaused(p) {
      paused = p;
      pauseBtn.textContent = p ? '▶' : '⏸';
      if (sublabel) sublabel.textContent = p ? 'paused' : 'until next refresh';
    }
    overlayEl._setPaused = setPaused;

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
    // customHotkey may still be loading; the single module-level read below calls
    // refreshHint() once it lands, and storage.onChanged keeps it current — so no
    // separate per-overlay read is needed here.
    hintText.textContent = hintLabel();
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
    // forcedW/forcedH let the resize handler pass the dimensions it just computed,
    // so we don't read offsetWidth/offsetHeight right after writing width/height
    // (which would force a synchronous reflow on every resize mousemove tick). The
    // non-resize callers omit them and fall back to measuring the element.
    function scaleOverlay(forcedW, forcedH) {
      if (!overlayEl) return;
      const w = forcedW || overlayEl.offsetWidth  || 240;
      const h = forcedH || overlayEl.offsetHeight || 140;
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

      // Quick-control buttons scale with the overlay just like Stop, but stay a
      // touch more compact so the three fit at the default 240px width.
      ctl.style.gap = Math.round(s * 0.022) + 'px';
      const qFont = Math.max(8, Math.round(s * 0.04)) + 'px';
      const qPad  = Math.round(s * 0.012) + 'px ' + Math.round(s * 0.026) + 'px';
      const qRad  = Math.round(s * 0.028) + 'px';
      [pauseBtn, extendBtn].forEach((b) => {
        b.style.fontSize = qFont;
        b.style.padding = qPad;
        b.style.borderRadius = qRad;
        b.style.lineHeight = '1.5';
      });

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

      // At small sizes the sublabel/hint would shrink to ~7px (illegible) and
      // crowd the timer, so drop them and let the countdown own the space. They
      // return as the user grows the overlay back. Timer + progress bar stay.
      sublabel.style.display = h < 104 ? 'none' : '';
      hint.style.display     = h < 124 ? 'none' : '';

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
          // Default to the bottom-right corner so the overlay never lands over
          // the page's headline/top content. The user can still drag it anywhere
          // (the chosen spot is then remembered via savePos).
          const w = overlayEl.offsetWidth  || 160;
          const h = overlayEl.offsetHeight || 100;
          applyPos(window.innerWidth - w - 24, window.innerHeight - h - 24);
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

  // Only wires the per-overlay mousedown (on the drag bar, removed with the
  // overlay so it can't leak). The document-level move/up listeners are shared
  // and registered once, after makeResizable.
  function makeDraggable(el, handle) {
    handle.addEventListener('mousedown', (e) => {
      // Skip if the click is on the stop button (or any descendant of it)
      if (e.target.closest && e.target.closest('[data-ar-stop]')) return;
      e.preventDefault();
      dragState = {
        el,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startElX: parseInt(el.style.left) || el.getBoundingClientRect().left,
        startElY: parseInt(el.style.top)  || el.getBoundingClientRect().top,
      };
      el.style.cursor    = 'grabbing';
      el.style.boxShadow = '0 12px 50px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.08) inset';
    });
  }

  // ── Resize logic ─────────────────────────────────────────────────────────
  // Like makeDraggable: only the per-overlay mousedown (on the resize handle) is
  // wired here; the shared document move/up listeners below do the work.
  function makeResizable(el, handle, onResize) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizeState = {
        el, onResize,
        startX: e.clientX,
        startY: e.clientY,
        startW: el.offsetWidth,
        startH: el.offsetHeight,
      };
      document.body.style.cursor = 'se-resize';
    });
  }

  // Single set of document-level pointer listeners for drag + resize, wired once
  // the first time an overlay is built (see ensureOverlay) rather than at
  // injection. They only ever act on dragState/resizeState, which are set by the
  // overlay's own drag-bar/resize-handle mousedown handlers — so before any
  // overlay exists they are dead weight on every page. Deferring them keeps the
  // common no-job page from carrying a document-level mousemove listener that
  // fires on every pointer move for the page's whole lifetime.
  let pointerListenersWired = false;
  let pointerListenersAbort = null; // lets handleContextInvalidated unwire them
  function endPointerInteraction() {
    if (dragState) {
      const el = dragState.el;
      el.style.cursor    = 'grab';
      el.style.boxShadow = '0 8px 40px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.06) inset';
      savePos(parseInt(el.style.left), parseInt(el.style.top));
      dragState = null;
    }
    if (resizeState) {
      const el = resizeState.el;
      document.body.style.cursor = '';
      safeStorageSet({ '__ar_overlay_size': { w: el.offsetWidth, h: el.offsetHeight } });
      resizeState = null;
    }
  }
  function wireGlobalPointerListeners() {
    if (pointerListenersWired) return;
    pointerListenersWired = true;
    pointerListenersAbort = new AbortController();
    const signal = pointerListenersAbort.signal;
    document.addEventListener('mousemove', (e) => {
      if (!dragState && !resizeState) return;
      // The button was released OUTSIDE the window (we never got that mouseup),
      // so the first move back in arrives with no buttons down. Without this the
      // overlay would glue itself to the cursor until the next click.
      if (e.buttons === 0) { endPointerInteraction(); return; }
      if (dragState) {
        applyPos(dragState.startElX + e.clientX - dragState.startMouseX,
                 dragState.startElY + e.clientY - dragState.startMouseY);
      } else {
        const el = resizeState.el;
        const w = Math.max(140, resizeState.startW + (e.clientX - resizeState.startX));
        const h = Math.max(80,  resizeState.startH + (e.clientY - resizeState.startY));
        el.style.width  = w + 'px';
        el.style.height = h + 'px';
        // Pass the just-computed dimensions so scaleOverlay doesn't re-measure
        // (which would force a reflow right after the writes above).
        if (resizeState.onResize) resizeState.onResize(w, h);
      }
    }, { signal });

    document.addEventListener('mouseup', endPointerInteraction, { signal });
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
    if (overlayEl._fill)  overlayEl._fill.style.transform = 'scaleX(' + (totalDuration > 0
      ? Math.max(0, Math.min(1, remaining / totalDuration)) : 0) + ')';
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
  // Computed at CALL time, not injection time: an SPA pushState that changes
  // the query string doesn't re-inject this script, so a key frozen at injection
  // would write under the old URL while the post-reload script reads under the
  // new one — silently missing the restore.
  function scrollKey() {
    return '__ar_scroll_' + location.pathname + location.search;
  }
  let scrollListenersArmed = false;

  function captureScroll() {
    if (!preserveScrollEnabled) return;
    try { sessionStorage.setItem(scrollKey(), String(window.scrollY || window.pageYOffset || 0)); } catch (e) {}
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
    try { saved = sessionStorage.getItem(scrollKey()); } catch (e) { return; }
    if (saved == null) return;
    scrollRestored = true;
    const y = parseInt(saved, 10);
    if (!Number.isFinite(y)) return;
    const apply = () => { try { window.scrollTo(0, y); } catch (e) {} };
    apply();
    requestAnimationFrame(apply);
    setTimeout(() => { apply(); try { sessionStorage.removeItem(scrollKey()); } catch (e) {} }, 400);
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
      } else if (attempt < 3) {
        // No job for this tab is the common case (most pages never start one),
        // and `synced` is only set when a job IS found — so these retries fire on
        // every ordinary page load. Each one wakes the service worker, so keep
        // the ceiling low: the only thing the retries buy is winning the race
        // where the popup's START_REFRESH lands just after this script injected,
        // which resolves within a few hundred ms. Backoff: 100, 200, 400 ms.
        const delay = Math.min(100 * Math.pow(2, attempt), 1000);
        setTimeout(() => syncWithBackground(attempt + 1), delay);
      }
    });
  }
  // Gate the initial sync on a tiny URL-index read straight from storage —
  // chrome.storage reads are served by the browser process, so unlike
  // sendMessage they do NOT wake the MV3 service worker. Without this gate the
  // sync (plus its retries) fired on EVERY page load in every tab, waking the
  // worker each time even though most pages never host a job. activeJobUrls is
  // maintained by the background alongside every activeJobs write; a page whose
  // origin+path matches no job's startUrl skips the sync entirely — a job
  // started later still reaches it via the background's COUNTDOWN_START push
  // (sendCountdownStart retries until this script answers).
  safeStorageGet('activeJobUrls', (data) => {
    const urls = (data && data.activeJobUrls) || [];
    const here = location.origin + location.pathname;
    const mayHaveJob = Array.isArray(urls) && urls.some((u) => {
      try { const p = new URL(u); return p.origin + p.pathname === here; }
      catch (e) { return false; }
    });
    if (mayHaveJob) syncWithBackground(0);
  });

  // ── Custom keybinding ─────────────────────────────────────────────────────
  // The in-page hotkey is the single source of truth for toggling refresh.
  // When the user hasn't recorded a custom combo, this default applies so the
  // shortcut works out of the box. `code` is the physical key (layout- and
  // Option-key-safe on macOS, where Alt+R mangles `e.key`).
  const DEFAULT_HOTKEY = { key: 'r', code: 'KeyR', ctrl: false, alt: true, shift: false, meta: false };

  // Single page-lifetime read of the custom hotkey. The keydown handler needs it
  // even with no overlay (the hotkey can START a job), so this is not overlay-
  // gated. refreshHint() corrects an already-built overlay's footer once it lands
  // (no-op when no overlay exists).
  let customHotkey = null;
  safeStorageGet('customHotkey', (d) => { customHotkey = (d && d.customHotkey) || null; refreshHint(); });

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

  // True when the keystroke is going into an editable target — the hotkey must
  // not fire there. The default Alt+R is how macOS types '®' (and Alt-combos
  // type accented characters on many layouts); swallowing it inside a form
  // field would both eat the character AND start a job that reloads the page
  // under the user's unsaved input.
  function isEditableTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  document.addEventListener('keydown', (e) => {
    if (!contextValid) return;
    if (isEditableTarget(e.target)) return;
    if (matchesHotkey(e, activeHotkey())) {
      e.preventDefault();
      safeMessage({ type: 'HOTKEY_TOGGLE' });
    }
  }, true);

  // ── Click-to-stop ─────────────────────────────────────────────────────────
  // When enabled, the first press anywhere on the page stops the refresh job.
  // Listens on `pointerdown` (capture), NOT `click`: a `click` only fires after a
  // full press+release on the SAME element with no movement, so it silently misses
  // drags, text selections, and presses on elements that re-render between down and
  // up (menus, feeds, SPA content) — which is most of why a click "didn't stop it."
  // `pointerdown` fires on press, every time, and reacts a beat sooner.
  // Pass-through: the press is NOT cancelled, so links/buttons/selection still work.
  // Presses inside the overlay are ignored — it has its own Stop button.
  document.addEventListener('pointerdown', (e) => {
    if (!contextValid || !stopOnClickEnabled) return;
    if (e.button || !e.isPrimary) return; // primary button / first touch point only
    if (e.target && e.target.closest && e.target.closest('#__ar_overlay')) return;
    // Stop the job, then disarm only once the stop is acknowledged. Disarming
    // before the message round-trips could otherwise drop the press silently if
    // the send failed. The flag is re-armed on the next COUNTDOWN_START anyway.
    safeMessage({ type: 'STOP_REFRESH', tabId: null }, () => { stopOnClickEnabled = false; });
    hideOverlay();
  }, true);

  // ── Keyword flash ─────────────────────────────────────────────────────────
  // Pulses a glow around the viewport edges when a keyword alert fires.
  // Deliberately independent of the countdown overlay (its styles only exist
  // once ensureOverlay() runs, and the flash must work with the overlay
  // disabled). pointer-events:none keeps the page — and the overlay's Stop
  // button — fully interactive underneath.
  let flashTimer = null;

  function startKeywordFlash() {
    if (!document.body) return;
    if (!document.getElementById('__ar_flash_styles')) {
      const style = document.createElement('style');
      style.id = '__ar_flash_styles';
      style.textContent = `
        @keyframes __ar_flash_pulse { 0%,100% { opacity:0; } 50% { opacity:1; } }
        #__ar_flash {
          position:fixed; inset:0;
          pointer-events:none;
          z-index:2147483647;
          opacity:0;
          box-shadow:inset 0 0 0 3px rgba(248,113,113,0.95),
                     inset 0 0 70px 18px rgba(251,146,60,0.5);
          animation:__ar_flash_pulse 0.85s ease-in-out 4;
        }
        @media (prefers-reduced-motion: reduce) {
          #__ar_flash { animation:none; opacity:0.8; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    // Idempotent: a re-delivered message restarts the flash instead of stacking.
    const old = document.getElementById('__ar_flash');
    if (old) old.remove();
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    const el = document.createElement('div');
    el.id = '__ar_flash';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    const cleanup = () => {
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      el.remove();
    };
    el.addEventListener('animationend', cleanup);
    // Backstop: prefers-reduced-motion shows a static glow with no animationend.
    flashTimer = setTimeout(cleanup, 4000);
  }

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
            // A fresh COUNTDOWN_START means a real refresh/resume happened — clear
            // any local paused state and restore the pause button + sublabel.
            if (overlayEl && overlayEl._setPaused) overlayEl._setPaused(false);
            else paused = false;
            startCountdown(msg.nextRefresh, msg.total);
            refreshHint();
          }
          synced = true;
          sendResponse({ ok: true });
          break;
        case 'STOPPED':
          stopOnClickEnabled = false;
          paused = false; // so the next overlay starts un-paused (⏸ / "until next refresh")
          hideOverlay();
          sendResponse({ ok: true });
          break;
        case 'KEYWORD_FLASH':
          startKeywordFlash();
          sendResponse({ ok: true });
          break;

      }
    });
  } catch (e) { handleContextInvalidated(); }

})();
