// offscreen.js — runs in the hidden offscreen document, handles audio playback.
// Offscreen documents are exempt from the autoplay gesture policy.
//
// The tone catalog and playback live in sounds.js (shared with the popup and
// options pages so a Preview plays exactly what an alert plays). sounds.js is
// loaded before this script and exposes the global `AlertSounds`.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.target === 'offscreen' && msg.type === 'PLAY_BEEP') {
    AlertSounds.playTone(msg.tone, { volume: msg.volume, repeat: msg.repeat });
    // Acknowledge synchronously so the background knows this document's listener
    // is live and the message landed. Without this, the background can't tell a
    // dropped first-message (listener not ready yet) from a delivered one, and
    // would either lose the beep or risk replaying it.
    sendResponse({ ok: true });
  }
});
