// Bump the extension version in manifest.json AND package.json together — they
// must always match. Touches only the "version" line in each file so the rest
// of the formatting is left untouched.
//   node scripts/bump.mjs 1.1.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: node scripts/bump.mjs <major.minor.patch>   e.g. 1.1.0');
  process.exit(1);
}

let ok = 0;
for (const file of ['manifest.json', 'package.json']) {
  const p = join(root, file);
  const txt = readFileSync(p, 'utf8');
  const m = txt.match(/"version":\s*"(\d+\.\d+\.\d+)"/);
  if (!m) { console.error(`✖ no "version" field found in ${file}`); continue; }
  writeFileSync(p, txt.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`));
  console.log(`✔ ${file}: ${m[1]} → ${version}`);
  ok++;
}
process.exit(ok === 2 ? 0 : 1);
