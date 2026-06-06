// Build a Chrome Web Store-ready zip of the extension into dist/.
// Ships ONLY the runtime files the manifest loads — manifest.json, the
// root-level .js/.html/.css, and icons/. Everything dev-only (.agents/, test/,
// scripts/, .claude/, *.md, node_modules/, dist/) is excluded by whitelisting.
// No external deps: shells out to the system `zip`.
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const zipPath = join(dist, `auto-refresh-pro-v${version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);

// Whitelist: manifest + icons/ + every root-level runtime asset. All dev .js
// lives in subdirs (scripts/, test/, .agents/), so root *.js is runtime-only.
const files = ['manifest.json', 'icons'];
for (const f of readdirSync(root)) {
  if (/\.(js|html|css)$/.test(f)) files.push(f);
}
files.sort();

execFileSync('zip', ['-r', zipPath, ...files, '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log(`\n✔ packaged ${files.length} entries → dist/auto-refresh-pro-v${version}.zip`);
