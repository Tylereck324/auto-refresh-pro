// offscreen.js — runs in the hidden offscreen document, handles audio playback.
// Offscreen documents are exempt from the autoplay gesture policy.

function buildBeepWav() {
  const rate    = 22050;
  const hz      = 1000;
  const beepSmp = Math.floor(rate * 0.12);
  const gapSmp  = Math.floor(rate * 0.08);
  const total   = (beepSmp + gapSmp) * 3;
  const buf     = new ArrayBuffer(44 + total * 2);
  const v       = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, total * 2, true);
  let p = 44;
  for (let b = 0; b < 3; b++) {
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

const BEEP_URI = buildBeepWav();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_BEEP') {
    const audio = new Audio(BEEP_URI);
    audio.volume = 0.9;
    audio.play().catch(e => console.warn('Offscreen audio error:', e));
  }
});
