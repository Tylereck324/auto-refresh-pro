# Auto Refresh Pro

A personal Chrome extension for auto-refreshing pages with keyword detection, page change monitoring, and a polished countdown overlay.

## Features

- **Flexible intervals** — 8 quick presets (5s → 1hr) plus fully custom intervals
- **Keyword detection** — plays a sound alert and optionally stops when a word/phrase appears on the page
- **Page change monitoring** — detects when page content changes between refreshes
- **Hard refresh** — bypass cache on every cycle
- **Random intervals** — randomize the delay between a configurable min/max range
- **Stop after X refreshes** — automatically stop after a set number of cycles
- **Draggable, resizable overlay** — countdown widget injected into the page; drag to reposition, resize from the corner; position and size are remembered
- **Hotkey** — `Alt+R` by default (customizable in Settings) to toggle refresh on/off from the keyboard
- **Popup countdown** — the extension popup shows a live hero countdown synced to the actual remaining time
- **Navigation detection** — automatically stops when you navigate away from the original URL
- **Manage All Tabs** — view and stop all active refresh jobs across every open tab
- **Import / Export** — back up and restore all settings as JSON
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
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker: alarms, job management, keyword detection
├── content.js          # Injected into pages: countdown overlay, drag/resize
├── popup.html/js       # Extension popup UI
├── options.html        # Settings page (hotkey recorder, defaults, presets)
├── manage.html         # Manage all active tabs, auto-start URLs, import/export
├── offscreen.html/js   # Hidden page used for audio playback (offscreen API)
└── icons/              # Extension icons
```

## Notes

- Sound alerts use Chrome's [Offscreen API](https://developer.chrome.com/docs/extensions/reference/offscreenDocuments/) to bypass autoplay restrictions — requires Chrome 116+
- The extension stops automatically when you navigate to a different URL in the same tab
- Keyword detection compares page content between cycles — it only alerts when the keyword *appears* (absent → present transition), not on every cycle it's present
