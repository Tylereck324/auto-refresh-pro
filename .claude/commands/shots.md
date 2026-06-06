---
description: Screenshot all extension surfaces (popup, settings, manage, overlay)
argument-hint: "[label]"
---
Capture screenshots of every extension surface using the project harness, then review them.

1. Run (use `shots` as the label if `$ARGUMENTS` is empty):

   `node .agents/shots.mjs $ARGUMENTS`

2. Read the resulting PNGs in `.agents/proof/shots-$ARGUMENTS/`:
   `popup-idle.png`, `popup-expanded.png`, `options.png`, `manage.png`,
   `options-narrow.png`, `manage-narrow.png`, `overlay.png`.

3. Summarize what rendered and flag anything visually off (misalignment,
   contrast, broken layout, theme drift between surfaces).

The harness loads the unpacked extension in Chrome for Testing (regular Chrome
137+ blocks `--load-extension`). To capture a before/after pair, run it once on
the base branch with a `before` label and again on the change with `after`.
