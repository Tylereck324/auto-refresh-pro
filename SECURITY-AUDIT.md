# Security Audit — Auto Refresh Pro (Chrome MV3 extension)

Date: 2026-06-05 · Scope: full codebase (manifest, service worker, content
script, popup/options/manage pages, offscreen audio, image/PNG handling).

All findings below were remediated. A regression test suite (`test/`, 35 tests)
locks each fix in place. `npm test` and `npm run lint` both pass; the extension
loads (manifest + all referenced files validated).

---

## Findings & remediations

### F1 — Stored DOM-XSS on the Settings page (HIGH)
- **Location:** `options.js` (preset list render).
- **Root cause:** preset labels were concatenated into `div.innerHTML`:
  `'<input ... value="' + p.label + '" ...>'`. Preset data comes from
  `chrome.storage` (`globalSettings.presets`), which is populated by the Manage
  page's **Import Settings** feature — i.e. fully attacker-controllable. A label
  such as `"><img src=x onerror=alert(1)>` broke out of the attribute and ran
  script on the privileged extension page.
- **Fix:** rows are now built with `createElement` + `value`/`textContent`
  assignment in `preset-row.js` (no `innerHTML`). Imported preset labels are also
  length-bounded and coerced to strings at the storage boundary (F4).
- **Tests:** `test/preset-row.test.js` (innerHTML usage trapped & fails the test;
  payload survives only as inert `input.value`).

### F2 — Unsafe auto-start URLs executed on browser startup (HIGH)
- **Location:** `manage.js` (add auto-start), `background.js` `restoreJobs()`.
- **Root cause:** auto-start entries were stored with only an `if (!url)` check
  and later opened via `chrome.tabs.create({ url })` on every browser start. A
  `javascript:`, `data:`, or `file:` URL — addable directly or via Import —
  could be auto-navigated.
- **Fix:** `ARPValidators.isSafeNavigableUrl` (http/https only, length-capped)
  gates the add path, the import path (F4), and the startup `restoreJobs` loop
  (defense in depth — storage poisoned by any means is filtered before navigation).
- **Tests:** `test/url.test.js`, `test/import.test.js`.

### F3 — Untrusted favicon `src` / unvalidated image (PNG) handling (MEDIUM)
- **Location:** `manage.js` (`<img src="${tab.favIconUrl}">`).
- **Root cause:** `tab.favIconUrl` is set by the visited (possibly hostile) page.
  HTML-injection was already blocked by `escapeHtml`, but the **scheme and image
  payload were unvalidated**: a `data:image/svg+xml` (active content),
  `javascript:`/`file:` scheme, or a multi-MB / corrupt / type-confused data:
  URI was rendered as-is.
- **Fix:** `ARPValidators.isSafeImageSrc` allows only http(s) or a *validated*
  raster `data:` image — MIME allow-list (no SVG), base64-decoded, size-capped
  (256 KB), and **magic-byte verified**. PNG bytes are validated by
  `isValidPng`: 8-byte signature, leading `IHDR`, non-zero dimensions within
  bounds (decompression-bomb guard), valid bit-depth/colour-type, size cap.
  Anything else falls back to the bundled icon.
- **Tests:** `test/png.test.js` — accepts valid PNGs (incl. the extension's own
  `icon16/48/128.png`), rejects corrupt signature, truncated, non-IHDR,
  zero/huge dimensions, bad depth/colour-type, oversized, and JPEG-as-PNG;
  `isSafeImageSrc` rejects svg/js/file/oversized/MIME-lie inputs.

### F4 — Unsanitized settings import (HIGH)
- **Location:** `manage.js` import handler.
- **Root cause:** `chrome.storage.local.set(data)` wrote the parsed JSON file
  verbatim. This is the delivery vector for F1/F2 and could overwrite any storage
  key with attacker-shaped data.
- **Fix:** `ARPValidators.sanitizeImportedSettings` rebuilds the dangerous sinks
  from scratch — strips non-http(s) `autoStartUrls`, regenerates
  `refreshSettings` (no injected fields), bounds/cleans preset labels, shape-
  checks `customHotkey` — while preserving unrelated keys for forward-compat.
  The user is told when unsafe entries were dropped.
- **Tests:** `test/import.test.js`.

### F5 — `runtime.onMessage` had no sender trust check (MEDIUM)
- **Location:** `background.js` message handler.
- **Root cause:** the handler acted on any message (`START_REFRESH`,
  `STOP_REFRESH`, `STOP_ALL`, `UPDATE_INTERVAL`, …) without verifying the sender.
  `externally_connectable` is unset so web pages can't reach it directly, but the
  boundary was implicit.
- **Fix:** the listener now fails closed unless
  `sender.id === chrome.runtime.id` (`ARPValidators.isTrustedSender`), so only
  the extension's own pages/content scripts are honoured.
- **Tests:** `test/sender.test.js`.

### F6 — No explicit Content-Security-Policy (LOW / hardening)
- **Location:** `manifest.json`.
- **Root cause:** relied solely on MV3's implicit default.
- **Fix:** explicit strict policy added —
  `script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'`.
  Lint asserts it is never weakened (`unsafe-inline`/`unsafe-eval`/`http:`).

## Reviewed — no change required
- **Permissions / `<all_urls>`:** broad but functionally required for a
  refresh-any-tab tool; no narrower scope is feasible. No `externally_connectable`,
  no `web_accessible_resources`, no remote code, no `eval`/`new Function`.
- **content.js:** all overlay DOM built via `createElement`/`textContent`; the
  only `innerHTML` is a static inline SVG. Reads page text via `innerText` only
  (no injection). Storage values it reads (`__ar_overlay_pos`, size) are numeric
  and clamped.
- **manage.js card rows:** every interpolation passes through `escapeHtml`.
- **offscreen.js:** plays a locally-synthesized WAV; no external/remote input.
- **Network:** the extension makes no `fetch`/XHR and loads no remote fonts/code.

## Verification
- `npm test` → 35/35 pass (`node --test`).
- `npm run lint` → JS syntax-check, manifest reference integrity, script-src
  resolution, and CSP-strictness all pass.
- Bundled icons confirmed valid PNGs by `file(1)` and by `isValidPng`.
