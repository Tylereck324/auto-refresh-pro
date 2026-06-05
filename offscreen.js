// offscreen.js — runs in the hidden offscreen document, handles audio playback.
// Offscreen documents are exempt from the autoplay gesture policy.

// Build a mono 16-bit PCM WAV (as a data: URI) of `beats` short tones at `hz`.
// Parameterized so we can pre-render a few distinct alert tones up front.
function buildWav({ hz = 1000, beats = 3, beepMs = 120, gapMs = 80 } = {}) {
  const rate    = 22050;
  const beepSmp = Math.floor(rate * (beepMs / 1000));
  const gapSmp  = Math.floor(rate * (gapMs / 1000));
  const total   = (beepSmp + gapSmp) * beats;
  const buf     = new ArrayBuffer(44 + total * 2);
  const v       = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, total * 2, true);
  let p = 44;
  for (let b = 0; b < beats; b++) {
    for (let i = 0; i < beepSmp; i++) {
      const env = 1 - (i / beepSmp) * 0.5;
      v.setInt16(p, Math.round(Math.sin(2 * Math.PI * hz * i / rate) * env * 0.7 * 32767), true);
      p += 2;
    }
    for (let i = 0; i < gapSmp; i++) { v.setInt16(p, 0, true); p += 2; }
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

// Pre-rendered alert tones. Each carries its approximate clip length (ms) so a
// multi-repeat can space the plays without overlapping.
const TONES = {
  beep:  { uri: buildWav({ hz: 1000, beats: 3, beepMs: 120, gapMs: 80 }), lenMs: 600 },
  chime: { uri: buildWav({ hz: 1568, beats: 2, beepMs: 180, gapMs: 90 }), lenMs: 540 },
  alarm: { uri: buildWav({ hz: 760,  beats: 5, beepMs: 110, gapMs: 70 }), lenMs: 900 },
};

const clamp = (n, lo, hi, dflt) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'PLAY_BEEP') {
    const tone   = TONES[msg.tone] || TONES.beep;
    const volume = clamp(msg.volume, 0, 1, 0.9);
    const repeat = clamp(msg.repeat, 1, 5, 1); // clamp server-side: poisoned storage must not cause audio DoS
    const playOnce = () => {
      const audio = new Audio(tone.uri);
      audio.volume = volume;
      audio.play().catch(e => console.warn('Offscreen audio error:', e));
    };
    playOnce();
    for (let i = 1; i < repeat; i++) setTimeout(playOnce, i * (tone.lenMs + 60));
    // Acknowledge synchronously so the background knows this document's listener
    // is live and the message landed. Without this, the background can't tell a
    // dropped first-message (listener not ready yet) from a delivered one, and
    // would either lose the beep or risk replaying it.
    sendResponse({ ok: true });
  }
});
