# Feature Spec: Click-to-Stop ("Stop when I click the page")

> Status: Designed, not yet implemented
> Last updated: 2026-06-05

Let the user stop an active refresh job by clicking anywhere on the page that's
currently refreshing. Opt-in, per-job.

## Behavior

- **Opt-in, per-job** stop-condition, **defaults off**. Lives in the popup's
  Advanced panel beside the other "Stop on…" toggles (`optStopOnKeyword`,
  `optStopOnChange`, `optStopAfter`).
- When enabled, a **left-click anywhere in the top document** stops that tab's
  refresh job.
- **Pass-through:** the click is never cancelled — clicking a link still
  navigates, clicking the body just stops the job. No `preventDefault` /
  `stopPropagation`.
- **Excluded from triggering a stop:**
  - clicks inside `#__ar_overlay` (the widget keeps its own dedicated Stop button)
  - right-click (`contextmenu`) and middle-click (`auxclick`) — only `click`
    (left button) counts
  - scroll, text-selection drags, and keyboard input
- **Feedback:** overlay-vanish only — the countdown widget sliding away is the
  sole cue. No toast, no system notification (the action is user-initiated, so a
  notification would be noisy).

## Implementation

### `content.js`
- Attach **one** document-level **capture-phase `click` listener** once, on
  injection. Gate it on a cached module-level `stopOnClickEnabled` boolean
  (same pattern the file already uses for `customHotkey`).
- Handler: if `stopOnClickEnabled` and `!e.target.closest('#__ar_overlay')` →
  `safeMessage({ type: 'STOP_REFRESH', tabId: null })` + `hideOverlay()`
  (mirrors the existing Stop button at line ~195).
- Set `stopOnClickEnabled`:
  - from the `GET_STATUS` sync — `resp.job.settings.stopOnClick`
  - from `COUNTDOWN_START` — `msg.stopOnClick`
  - clear it on `STOPPED`

### `background.js`
- Add `stopOnClick` to the **`COUNTDOWN_START` payload** in `sendCountdownStart`
  so the flag arrives the moment a job starts (not one refresh cycle later, when
  the re-injected content script would otherwise first learn it via
  `GET_STATUS`).
- Add `stopOnClick` to the default-settings objects in **both**
  `chrome.commands.onCommand` and `HOTKEY_TOGGLE`, so hotkey-started jobs honor
  it.

### `popup.html` / `popup.js`
- New `id="optStopOnClick"` checkbox under the existing Stop toggles.
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
