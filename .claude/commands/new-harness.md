---
description: Scaffold a new Chrome-for-Testing behavioral verify harness
argument-hint: "<feature-name>"
---
Create a new behavioral verification harness at `.agents/verify-$ARGUMENTS.mjs`
for the feature "$ARGUMENTS", modeled on the existing harnesses.

First read `.agents/verify-scroll.mjs` as the canonical template, then generate
a new harness that reuses the same boilerplate:

- Start a local `http` server returning a simple test page (content scripts
  match `<all_urls>`, so they need a real http origin).
- Launch Chrome for Testing from the hardcoded Playwright path with
  `--load-extension`, `--disable-extensions-except`, and
  `--disable-features=DisableLoadExtensionCommandLineSwitch`.
- Derive `EXT_ID` from the repo path via the sha256→a-p scheme.
- Open the test page, resolve its `tabId` via `chrome.tabs.query` from an
  extension page, and define `start(settings)` / `stop()` helpers that
  `chrome.runtime.sendMessage` START_REFRESH / STOP_REFRESH.
- Exercise the "$ARGUMENTS" behavior, assert outcomes into a `results` object,
  screenshot proof into `.agents/proof/`, and log a clear pass/fail summary.

Keep it dependency-free (Node built-ins + the bundled `puppeteer` require shim
already used by the other harnesses). After writing it, run it once with
`node .agents/verify-$ARGUMENTS.mjs` to confirm it executes, and it will be
picked up automatically by `npm run verify`.
