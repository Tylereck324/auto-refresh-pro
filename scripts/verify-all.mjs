// Run every Chrome-for-Testing behavioral harness (.agents/verify*.mjs) in
// sequence and report which ran. These drive the loaded unpacked extension in
// Chrome for Testing (see .agents/verify.mjs for the why), so they can't run
// under `npm test` / node --test — this is their dedicated entry point.
//   npm run verify
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agents = join(root, '.agents');
const harnesses = readdirSync(agents).filter(f => /^verify.*\.mjs$/.test(f)).sort();

if (!harnesses.length) { console.error('no .agents/verify*.mjs harnesses found'); process.exit(1); }

let failed = 0;
for (const h of harnesses) {
  console.log(`\n━━━━━━━━━━ ${h} ━━━━━━━━━━`);
  try {
    execFileSync(process.execPath, [join(agents, h)], { stdio: 'inherit' });
  } catch {
    failed++;
    console.error(`✖ ${h} exited non-zero`);
  }
}

console.log(failed
  ? `\n${failed}/${harnesses.length} harness(es) failed.`
  : `\nAll ${harnesses.length} harnesses ran.`);
process.exit(failed ? 1 : 0);
