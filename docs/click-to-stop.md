# Feature Spec: Click-to-Stop ("Stop when I click the page")

> Status: Implemented — the toggle lives in the popup's Refresh Behavior section
> Last updated: 2026-07-04 (listener is `pointerdown`, not `click` — see below)

Let the user stop an active refresh job by clicking anywhere on the page that's
currently refreshing. Opt-in, per-job.

## Behavior

- **Opt-in, per-job** stop-condition, **defaults off**. Lives in the popup's
  Refresh Behavior section (`optStopOnClick`), a per-launch decision alongside
  Randomize interval.
- When enabled, a **primary (left) press anywhere in the top document** stops
  that tab's refresh job. The listener is `pointerdown` (capture), not `click` —
  see [Implementation](#implementation) for why.
- **Pass-through:** the press is never cancelled — clicking a link still
  navigates, a press that begins a text selection still selects, the job just
  also stops. No `preventDefault` / `stopPropagation`.
- **Excluded from triggering a stop:**
  - presses inside `#__ar_overlay` (the widget keeps its own dedicated Stop button)
  - any non-primary button and secondary touch points — the handler bails on
    `e.button || !e.isPrimary`, so right- and middle-clicks are ignored; only a
    primary (left) press counts
  - keyboard input (a `pointerdown` is required)
  - NOTE: unlike a `click`-based design, a press that begins a text-selection
    drag **does** stop the job (it is still a `pointerdown`). That is deliberate —
    see Implementation.
- **Feedback:** overlay-vanish only — the countdown widget sliding away is the
  sole cue. No toast, no system notification (the action is user-initiated, so a
  notification would be noisy).

## Implementation

### `content.js`
- Attach **one** document-level **capture-phase `pointerdown` listener** once, on
  injection. Gate it on a cached module-level `stopOnClickEnabled` boolean
  (same pattern the file already uses for `customHotkey`).
  - **Why `pointerdown`, not `click`:** a `click` only fires after a full
    press+release on the *same* element with no movement, so it silently misses
    drags, text selections, and presses on elements that re-render between down
    and up (menus, feeds, SPA content) — most of why a click "didn't stop it."
    `pointerdown` fires on press, every time, and a beat sooner.
- Handler: bail on `!stopOnClickEnabled`, on `e.button || !e.isPrimary`
  (primary/left press, first touch point only), and on
  `e.target.closest('#__ar_overlay')`; otherwise
  `safeMessage({ type: 'STOP_REFRESH', tabId: null }, …)` (disarm on ack) +
  `hideOverlay()`.
- Set `stopOnClickEnabled`:
  - from the `GET_STATUS` sync — `resp.job.settings.stopOnClick`
  - from `COUNTDOWN_START` — `msg.stopOnClick`
  - clear it on `STOPPED`

### `background.js`
- Add `stopOnClick` to the **`COUNTDOWN_START` payload** in `sendCountdownStart`
  so the flag arrives the moment a job starts (not one refresh cycle later, when
  the re-injected content script would otherwise first learn it via
  `GET_STATUS`).
- Add `stopOnClick` to the default-settings object in the **`HOTKEY_TOGGLE`**
  message handler, so hotkey-started jobs honor it.

### `popup.html` / `popup.js`
- `id="optStopOnClick"` toggle in the Refresh Behavior section.
- Wire into:
  - `bindEvents()` save-on-change array
  - `gatherSettings()` → `stopOnClick: document.getElementById('optStopOnClick').checked`
  - `saveSettings()` / `loadSettings()` for persistence across sessions

### Label
**"Stop when I click the page"** — plain-language, signals the consequence
clearly.

## Why these decisions

- **Opt-in, not always-on:** always-on would break normal page interaction —
  the user couldn't read, scroll-by-click, select text, or click a link on a
  refreshing page without killing the job.
- **Per-job, not global:** it's conceptually a *stop condition*, exactly like
  `stopOnKeyword` / `stopOnChange`, so it belongs with them. The delivery
  mechanism already exists (`job.settings` reaches the content script).
- **Pass-through, not swallow-first-click:** the mental model is "I'm
  interacting now, so stop refreshing" — the user expects their click to work.
  Swallowing makes the page feel dead; capture-phase `preventDefault` is also
  unreliable against React synthetic events / `mousedown`-driven widgets.
- **Left-click only:** "click anywhere" colloquially means a normal left click;
  reacting to right-clicks would kill the job when someone just opens a context
  menu.

## Accepted v1 limitations

- **Mid-job toggling** the checkbox takes effect only on the next Start —
  changing the checkbox calls `saveSettings()` but not `UPDATE_INTERVAL` (which
  only fires on interval change). Live toggling is out of scope for v1.
- **Top-frame only** — the manifest doesn't set `all_frames`, so a click inside
  a cross-origin iframe won't bubble to the top document and won't stop the job.
  Fine for the typical full-page-refresh use case; widening to all frames is a
  separate change.
