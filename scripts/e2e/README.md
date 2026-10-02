# Real-browser scripts

Puppeteer scripts that load the unpacked extension into Chrome for Testing and
drive it end to end. They are local tools, not part of `npm test`/CI: each
hard-codes the Puppeteer install and Chrome binary paths near the top.

Output (screenshots, logs) goes to `scripts/e2e/out/` (git-ignored), except the
audit capture scripts, which write the evidence kept under `docs/evidence/`.

`verify-severe-fixes.mjs` is the maintained regression check — it verifies
on-demand content-script injection and that synthetic page events cannot
operate the overlay:

```bash
node scripts/e2e/verify-severe-fixes.mjs
```

The others (`verify-*.mjs`, `shots.mjs`, `critique-shots.mjs`, `capture*.mjs`)
were written for earlier features and predate on-demand injection and the
Chrome-command shortcut; expect to adapt them before relying on their results.
