// validators.js — shared input validation & sanitization for Auto Refresh Pro.
//
// SECURITY MODULE. This file is the single trust boundary for every piece of
// data that originates outside the extension's own UI:
//   • URLs that will be navigated to (autoStartUrls → chrome.tabs.create)
//   • image sources rendered into <img> (tab.favIconUrl on the Manage page)
//   • PNG / image bytes (data: favicons, decoded and validated by magic bytes)
//   • imported settings JSON (arbitrary attacker-supplied object)
//   • runtime message senders (background onMessage trust boundary)
//
// Loaded three ways, so it must stay dependency-free and side-effect-free:
//   • service worker:   importScripts('validators.js')        → globalThis.ARPValidators
//   • extension pages:  <script src="validators.js"></script> → window.ARPValidators
//   • Node test runner: require('./validators.js')            → module.exports
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPValidators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Schemes a stored URL is allowed to navigate to. Everything else
  // (javascript:, data:, file:, chrome:, blob:, vbscript:, …) is rejected so a
  // poisoned autoStartUrls entry can't open a privileged or scripting URL on
  // browser startup.
  const NAV_SCHEMES = new Set(['http:', 'https:']);
  const MAX_URL_LEN = 2048;

  // Cap on inline image (data:) payloads rendered as a favicon. A hostile site
  // controls its own favIconUrl; without a cap it could hand us a multi-MB
  // data: URI to decode and paint (memory / UI-jank DoS).
  const MAX_IMAGE_BYTES = 256 * 1024; // 256 KB
  // Upper bound on PNG canvas dimensions. Guards against decompression-bomb
  // headers that declare an enormous canvas from a few bytes.
  const MAX_PNG_DIMENSION = 8192;

  const IMAGE_MIME = {
    'image/png':  'png',
    'image/jpeg': 'jpeg',
    'image/gif':  'gif',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/bmp':  'bmp',
  };
  // NOTE: image/svg+xml is deliberately absent. SVG is an active document that
  // can carry <script>; even though scripts don't execute in an <img>, keeping
  // it out of the allow-list avoids relying on that subtlety.

  // ── URL validation ─────────────────────────────────────────────────────────
  function isSafeNavigableUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.length === 0 || url.length > MAX_URL_LEN) return false;
    let parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    return NAV_SCHEMES.has(parsed.protocol);
  }

  // ── base64 decode (browser atob OR Node Buffer) ────────────────────────────
  function decodeBase64ToBytes(b64) {
    if (typeof b64 !== 'string') return null;
    // Strip whitespace the spec allows inside base64.
    const clean = b64.replace(/\s+/g, '');
    if (clean.length === 0 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
    try {
      if (typeof atob === 'function') {
        const bin = atob(clean);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      if (typeof Buffer !== 'undefined') {
        return Uint8Array.from(Buffer.from(clean, 'base64'));
      }
    } catch (e) { return null; }
    return null;
  }

  function readUInt32BE(bytes, off) {
    return (bytes[off] * 0x1000000) +
      ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]);
  }

  // ── PNG validation ─────────────────────────────────────────────────────────
  // Validate that `bytes` is a structurally sound PNG: correct 8-byte signature,
  // a leading IHDR chunk, sane non-zero dimensions within bounds, and a total
  // size within `maxBytes`. This rejects truncated, corrupt, wrongly-typed, and
  // decompression-bomb / oversized inputs before any decoder touches them.
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function isValidPng(bytes, opts) {
    opts = opts || {};
    const maxBytes = opts.maxBytes || MAX_IMAGE_BYTES;
    if (!bytes || typeof bytes.length !== 'number') return false;
    // Need: 8 sig + 4 len + 4 'IHDR' + 13 data + 4 crc = 33 bytes minimum.
    if (bytes.length < 33) return false;
    if (bytes.length > maxBytes) return false;

    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIG[i]) return false;
    }
    // First chunk must be IHDR with a 13-byte payload.
    if (readUInt32BE(bytes, 8) !== 13) return false;
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 ||
        bytes[14] !== 0x44 || bytes[15] !== 0x52) return false; // 'IHDR'

    const width  = readUInt32BE(bytes, 16);
    const height = readUInt32BE(bytes, 20);
    if (width === 0 || height === 0) return false;
    if (width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) return false;

    // Bit depth / colour type sanity (PNG spec: depth ∈ {1,2,4,8,16}).
    const bitDepth  = bytes[24];
    const colorType = bytes[25];
    if (![1, 2, 4, 8, 16].includes(bitDepth)) return false;
    if (![0, 2, 3, 4, 6].includes(colorType)) return false;

    return true;
  }

  // Lightweight magic-byte check for the other allowed raster formats, so a
  // data:image/jpeg URL that actually carries something else is rejected.
  function matchesMagic(kind, b) {
    switch (kind) {
      case 'png':  return isValidPng(b);
      case 'jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      case 'gif':  return b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46; // GIF
      case 'webp': return b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // RIFF…WEBP
      case 'bmp':  return b.length > 1 && b[0] === 0x42 && b[1] === 0x4d; // BM
      case 'ico':  return b.length > 3 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02);
      default:     return false;
    }
  }

  // ── Image src validation (for <img src>) ───────────────────────────────────
  // Accepts http(s) URLs as-is. For data: URLs, the MIME must be an allowed
  // raster image, the payload must decode, fit the size cap, and match the
  // format's magic bytes. Anything else (svg, javascript:, file:, oversized,
  // corrupt, type-confused) is rejected — callers fall back to the bundled icon.
  function isSafeImageSrc(src) {
    if (typeof src !== 'string' || src.length === 0) return false;
    const lower = src.slice(0, 16).toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      return src.length <= MAX_URL_LEN;
    }
    if (lower.startsWith('data:')) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
      if (!m) return false;
      const mime = m[1].toLowerCase();
      const isBase64 = !!m[2];
      const kind = IMAGE_MIME[mime];
      if (!kind) return false;
      if (!isBase64) return false; // require base64 image payloads (no raw svg/text)
      const bytes = decodeBase64ToBytes(m[3]);
      if (!bytes) return false;
      if (bytes.length > MAX_IMAGE_BYTES) return false;
      return matchesMagic(kind, bytes);
    }
    return false;
  }

  // ── Imported-settings sanitization ─────────────────────────────────────────
  // The Manage page lets a user import a settings JSON file. That file is fully
  // attacker-controllable, so it is sanitized here before it can touch storage:
  //   • must be a plain object (not array / primitive / null)
  //   • autoStartUrls   → only well-formed entries with safe http(s) URLs
  //   • globalSettings.presets → labels coerced to bounded strings, ms numeric
  //   • customHotkey    → shape-checked
  // Unknown keys are preserved (forward-compat) but the dangerous sinks above
  // are always rebuilt from scratch.
  const MAX_LABEL_LEN = 40;
  const MAX_AUTOSTART = 100;
  const MAX_PRESETS = 24;

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function sanitizeAutoStartUrls(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr.slice(0, MAX_AUTOSTART)) {
      if (!isPlainObject(item)) continue;
      if (!isSafeNavigableUrl(item.url)) continue;
      const sec = Number(item.intervalSec);
      const intervalSec = Number.isFinite(sec) && sec >= 2 ? Math.floor(sec) : 0;
      const entry = { url: item.url, intervalSec, autoRefresh: intervalSec > 0 };
      entry.refreshSettings = intervalSec > 0
        ? { interval: intervalSec * 1000, hardRefresh: false, stopAfter: 0,
            notify: false, sound: false, monitorMode: false, randomTimer: false }
        : null;
      out.push(entry);
    }
    return out;
  }

  function sanitizePresets(arr) {
    if (!Array.isArray(arr)) return null; // null = "not present", caller keeps default
    const out = [];
    for (const p of arr.slice(0, MAX_PRESETS)) {
      if (!isPlainObject(p)) continue;
      const label = String(p.label == null ? '' : p.label).slice(0, MAX_LABEL_LEN);
      const ms = Number(p.ms);
      if (!Number.isFinite(ms)) continue;
      out.push({ label, ms: Math.max(2000, Math.floor(ms)) });
    }
    return out;
  }

  function sanitizeHotkey(hk) {
    if (!isPlainObject(hk)) return null;
    if (typeof hk.key !== 'string' || hk.key.length === 0 || hk.key.length > 16) return null;
    return {
      key: hk.key,
      code: typeof hk.code === 'string' ? hk.code.slice(0, 24) : undefined,
      ctrl: !!hk.ctrl, alt: !!hk.alt, shift: !!hk.shift, meta: !!hk.meta,
    };
  }

  // Returns { ok, value, errors }. value is a sanitized object safe to write to
  // chrome.storage.local. ok is false (with a reason) when the top-level shape
  // is unusable.
  function sanitizeImportedSettings(data) {
    if (!isPlainObject(data)) {
      return { ok: false, value: null, errors: ['expected a JSON object'] };
    }
    const errors = [];
    const out = {};
    for (const [key, val] of Object.entries(data)) {
      if (key === 'autoStartUrls') {
        const safe = sanitizeAutoStartUrls(val);
        if (Array.isArray(val) && safe.length !== val.length) {
          errors.push('removed ' + (val.length - safe.length) + ' unsafe auto-start URL(s)');
        }
        out.autoStartUrls = safe;
      } else if (key === 'globalSettings') {
        if (!isPlainObject(val)) { out.globalSettings = {}; continue; }
        const gs = Object.assign({}, val);
        const presets = sanitizePresets(val.presets);
        if (presets) gs.presets = presets;
        out.globalSettings = gs;
      } else if (key === 'customHotkey') {
        out.customHotkey = sanitizeHotkey(val);
      } else {
        out[key] = val; // booleans / numbers / last-used popup state, etc.
      }
    }
    return { ok: true, value: out, errors };
  }

  // ── Runtime message sender trust ───────────────────────────────────────────
  // background onMessage must only honour messages from THIS extension's own
  // surfaces (its popup/options/manage pages and its injected content scripts).
  // For all of those, sender.id === the extension's own id. A message from a web
  // page or another extension carries a different id (or none).
  function isTrustedSender(sender, ownId) {
    if (!sender) return false;
    const id = ownId ||
      (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null;
    if (!id) return false;
    return sender.id === id;
  }

  return {
    isSafeNavigableUrl,
    isSafeImageSrc,
    isValidPng,
    decodeBase64ToBytes,
    sanitizeImportedSettings,
    sanitizeAutoStartUrls,
    sanitizePresets,
    isTrustedSender,
    MAX_IMAGE_BYTES,
    MAX_PNG_DIMENSION,
  };
});
