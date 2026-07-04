# Auto Refresh Pro

A personal Chrome extension for auto-refreshing pages with keyword detection, page change monitoring, and a polished countdown overlay.

## Features

- **Flexible intervals** — 8 quick presets (5s → 1hr) plus fully custom intervals
- **Keyword detection** — plays a sound alert and optionally stops when a word/phrase (or comma-separated list, whole-word, case-sensitive, or regex) appears on the page; an inverse mode alerts when it *disappears*
- **Page change monitoring** — detects when page content changes between refreshes, and reports a short token diff of *what* changed
- **Scoped detection** — an optional CSS selector limits keyword/change detection to a single element (e.g. `#price`, `.stock-status`) so a one-word change isn't drowned out by unrelated page churn
- **Per-item detection** — with a selector set, treat each matched element as a separate item and alert on *every new match* (e.g. each new listing in a feed), not just the first page-level appearance — so arrivals aren't missed while earlier matches stay on screen; pairs with **Ignore noise** so an item whose numbers tick between reloads (spots left, “2 min ago”) isn't re-alerted as new. An optional **“Skip items containing”** filter drops a matching item that also contains any of the given comma-separated terms (e.g. `1 place` to ignore a broken single-slot listing) — terms are matched as whole words/phrases, so `1 place` doesn't accidentally skip a card showing `21 places` or `120 places`
- **Live watch** — with per-item detection on, optionally re-scan the already-loaded page for new matching items every few seconds *between* reloads. Each scan reads the page's current DOM — **zero requests to the site** — so items the site pushes into an open page (SPA live updates) are caught within seconds while the reload interval stays slow and rate-limiter-friendly; the periodic reload remains as the safety net for anything the live push misses
- **Noise-tolerant change detection** — optionally ignore whitespace/digit churn (clocks, counters, ads) and require a minimum changed fraction before alerting
- **Alert journal** — a persistent, exportable log of every keyword/change detection (timestamp, tab, what changed), viewable on the Manage page; the toolbar badge shows a live job count and an unacknowledged-alert count
- **Actionable notifications** — keyword/change desktop notifications carry **Stop** and **Snooze 15m** buttons
- **Outbound webhooks** — optionally POST an alert to Discord, Slack, or a generic JSON endpoint (https-only, with an SSRF guard) so you're notified away from the tab. Per-item alerts are **one-tap**: each newly-arrived matching card is sent with its *own* deep-link (the study itself, not just the listing page) plus best-effort reward/hour, places, and researcher — rendered as a Discord embed, a Slack `<link|title>` list, or an `items[]` array in the JSON payload. Links are validated http(s)-only before they're placed in the message (a `javascript:`/`mailto:` href on a card can't ride into the webhook), and a large burst is capped with an "…and N more" summary
- **Quiet hours** — mute alerts (or pause refreshing entirely) during a configurable time window / weekday mask, with per-channel control (sound / flash / notification)
- **Adaptive interval** — back the interval off while a watched page stays quiet and snap back to full speed the moment something is detected
- **Resilience** — pauses (instead of hammering) while offline, and backs off exponentially on a page that won't load/script
- **Domain denylist** — never start a job on listed origins (banking, webmail, health portals); enforced across every launch path
- **Overlay quick controls** — pause/resume and **+30s** buttons right on the in-page countdown widget
- **Hard refresh** — bypass cache on every cycle
- **Random intervals** — randomize the delay between a configurable min/max range
- **Stop after X refreshes** — automatically stop after a set number of cycles
- **Click-to-stop** — optionally stop the job on the next click anywhere on the page (links/buttons still work); see [docs/click-to-stop.md](docs/click-to-stop.md)
- **Repeat beep until acknowledged** — keep beeping on an alert until you click/dismiss the notification (bounded)
- **Per-domain URL rules** — auto-start a job when a tab finishes loading a URL matching a match-pattern glob
- **Draggable, resizable overlay** — countdown widget injected into the page; drag to reposition, resize from the corner; position and size are remembered
- **Hotkey** — `Alt+R` by default (customizable in Settings) to toggle refresh on/off from the keyboard
- **Popup countdown** — the extension popup shows a live hero countdown synced to the actual remaining time
- **Scroll preservation** — optionally restore the scroll position across refreshes
- **Navigation detection** — pauses (with a notification) when you navigate away from the original URL, and resumes automatically when the tab returns to it; the detection baseline is frozen while away, so matches that arrived in the meantime still alert on return
- **Manage All Tabs** — view and stop all active refresh jobs across every open tab
- **Import / Export** — back up and restore all settings as JSON (imports are sanitized — see below)
- **Auto-start URLs** — open specific URLs and start refreshing automatically when Chrome launches

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select this folder
5. The Auto Refresh Pro icon will appear in your toolbar

## Usage

1. Click the extension icon to open the popup
2. Select a refresh interval using the presets or enter a custom value
3. Optionally enter a keyword to watch for and enable sound/stop-on-found
4. Click **Start** — the countdown overlay appears on the page
5. Press `Alt+R` (or your custom hotkey) to toggle refresh at any time

### Changing the hotkey

Open **Settings** from the popup footer → Keyboard Shortcut → click **⏺ Record** → press your desired combo.

### Customizing the overlay

- **Drag** from the header bar to reposition
- **Resize** from the bottom-right grip handle
- Position and size are saved and restored after every page refresh

## File Structure

```
├── manifest.json         # Extension manifest (MV3)
├── background.js         # Service worker: alarms, job management, keyword detection
├── content.js           # Injected into pages: countdown overlay, drag/resize, click-to-stop
├── popup.html/js        # Extension popup UI (the launcher)
├── options.html/js      # Settings page (hotkey recorder, defaults, presets)
├── manage.html/js       # Manage all active tabs, auto-start URLs, URL rules, import/export
├── offscreen.html/js    # Hidden page used for audio playback (offscreen API)
│
│   # Pure, dependency-free modules (loaded via importScripts in the worker,
│   # <script src> in pages, and require() in the Node test suite):
├── validators.js        # SECURITY trust boundary: URL / image / import / regex / sender validation
├── compose-settings.js  # Canonical job-settings constructor (shared by popup + hotkey launch)
├── interval.js          # Refresh-interval computation (fixed / random, NaN-hardened)
├── keyword-match.js     # Keyword matcher (multi-term, whole-word, case, regex)
├── normalize.js         # Noise-tolerant change-significance helpers
├── monitor-decision.js  # "Should an alert fire this cycle?" keyword/change logic
├── refresh-guards.js    # Refresh-loop timing guards (backstop dedup, notify throttle)
├── rehydrate.js         # Rebuild job state after a service-worker restart
├── serialize.js         # Async mutex for storage read-modify-write
├── notif-id.js          # Encode/decode tab id in a notification id
├── preset-row.js        # Preset row builder + shared DEFAULT_PRESETS
├── sounds.js            # Shared alert-tone catalog + playback
│
├── test/                # node --test suite for every pure module
├── scripts/lint.mjs     # Syntax / manifest / CSP / script-ref / version-sync check (npm run lint)
├── scripts/build.mjs    # Web Store zip packager (npm run build)
├── .github/workflows/   # CI: test + lint on every push/PR
└── icons/               # Extension icons
```

## Development

```bash
npm test      # run the unit suite (node --test)
npm run lint  # syntax-check all JS + verify manifest/CSP/script references resolve + version sync
npm run build # package a Web Store zip into dist/ (refuses on version mismatch)
```

Both `npm test` and `npm run lint` run in CI (GitHub Actions) on every push and pull request.

## Notes

- Sound alerts use Chrome's [Offscreen API](https://developer.chrome.com/docs/extensions/reference/offscreenDocuments/) to bypass autoplay restrictions — requires Chrome 116+
- Navigating the watched tab to a different URL pauses the job (one notification, popup shows "Paused — away from page") rather than stopping it; returning the tab to the original URL resumes within seconds. Closing the tab or pressing Stop still ends the job
- Keyword detection compares page content between cycles — by default it only alerts when the keyword *appears* (absent → present transition), not on every cycle it's present. With **per-item detection** (a selector + "Alert on each new match"), it instead diffs the *set* of matching items each cycle and alerts on each newly-arrived one, so a fresh match still fires while earlier matches remain on screen
