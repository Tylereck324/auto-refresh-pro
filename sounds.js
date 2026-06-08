// sounds.js — shared alert-tone catalog + playback.
//
// Loaded as a classic script (before the page's own script) by the offscreen
// document, the popup, and the options page. Exposes a single global,
// `AlertSounds`, so all three contexts play the exact same tones the same way:
//   - the offscreen document plays them when a keyword/change fires;
//   - the popup and options pages play them for the Preview button.
//
// Tones are either procedurally synthesized (beep/chime/alarm) or backed by a
// bundled audio asset under sounds/ (the macOS-style notification sounds).

(function (global) {
  'use strict';

  // Build a mono 16-bit PCM WAV (as a data: URI) of `beats` short tones at `hz`.
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

  // Resolve a packaged asset path to a loadable URL from any extension context.
  function asset(path) {
    return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL(path)
      : path;
  }

  // A tone's `uri` is resolved lazily on first access and then cached, so merely
  // loading this script (e.g. when the popup or options page opens) never pays
  // the WAV synthesis cost — that only happens once Preview or an alert fires.
  // `build` synthesizes a tone; `file` points at a bundled asset.
  function makeTone({ label, lenMs, build, file }) {
    let uri;
    return {
      label, lenMs,
      get uri() {
        if (uri === undefined) uri = build ? buildWav(build) : asset(file);
        return uri;
      },
    };
  }

  // Alert tones. `lenMs` is the approximate clip length so a multi-repeat can
  // space the plays without overlapping. File-backed tones use their real
  // (afinfo-measured) durations, rounded up a little for headroom.
  const TONES = {
    beep:  makeTone({ label: 'Beep',  lenMs: 600, build: { hz: 1000, beats: 3, beepMs: 120, gapMs: 80 } }),
    chime: makeTone({ label: 'Chime', lenMs: 540, build: { hz: 1568, beats: 2, beepMs: 180, gapMs: 90 } }),
    alarm: makeTone({ label: 'Alarm', lenMs: 900, build: { hz: 760,  beats: 5, beepMs: 110, gapMs: 70 } }),
    glass:     makeTone({ label: 'Glass',     lenMs: 1700, file: 'sounds/glass.wav' }),
    tink:      makeTone({ label: 'Tink',      lenMs: 600,  file: 'sounds/tink.wav' }),
    bottle:    makeTone({ label: 'Bottle',    lenMs: 820,  file: 'sounds/bottle.wav' }),
    hero:      makeTone({ label: 'Hero',      lenMs: 1100, file: 'sounds/hero.wav' }),
    submarine: makeTone({ label: 'Submarine', lenMs: 1550, file: 'sounds/submarine.wav' }),
  };

  const clamp = (n, lo, hi, dflt) => {
    const num = typeof n === 'number' ? n : parseFloat(n);
    return Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : dflt;
  };

  // UI helpers shared by the popup and options pages, so the tone list and the
  // 0–100 → 0–1 volume / 1–5 repeat conversions live in exactly one place.

  // Fill a <select> with one <option> per tone, labelled from the catalog.
  function populateSelect(select) {
    if (!select) return;
    select.innerHTML = '';
    for (const id in TONES) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = TONES[id].label;
      select.appendChild(opt);
    }
  }

  // Volume slider is 0–100 in the UI but stored/sent as a 0–1 gain.
  const clampVolume = (raw) => clamp(parseInt(raw, 10) / 100, 0, 1, 0.9);
  const clampRepeat = (raw) => clamp(parseInt(raw, 10), 1, 5, 1);

  // Play a tone, optionally repeated. Returns immediately; repeats are spaced by
  // the clip length so they don't overlap. `repeat` is clamped to 1–5 here too,
  // so poisoned storage can't turn an alert into an audio DoS.
  function playTone(toneId, opts) {
    const o      = opts || {};
    const tone   = TONES[toneId] || TONES.beep;
    const volume = clamp(o.volume, 0, 1, 0.9);
    const repeat = clamp(o.repeat, 1, 5, 1);
    const playOnce = () => {
      const audio = new Audio(tone.uri);
      audio.volume = volume;
      audio.play().catch((e) => console.warn('Alert audio error:', e));
    };
    playOnce();
    for (let i = 1; i < repeat; i++) setTimeout(playOnce, i * (tone.lenMs + 60));
  }

  global.AlertSounds = { TONES, playTone, populateSelect, clampVolume, clampRepeat };
})(typeof self !== 'undefined' ? self : this);
