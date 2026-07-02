// Build a Chrome Web Store zip (dist/auto-refresh-pro-<version>.zip) from an
// explicit allowlist of runtime files — dev-only material (tests, scripts,
// docs, audit artifacts) must never ship inside the package.
//
// Refuses to build if manifest.json and package.json disagree on the version,
// so a release can't go out half-bumped.
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`✖ version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}

// Runtime allowlist: manifest + every root JS module (the worker importScripts
// most of them and the pages <script src> the rest — scripts/lint.mjs verifies
// those references resolve), the pages, theme, icons, and alert sounds.
// Globs are expanded here rather than left to zip: zip only wildcard-matches
// existing archive entries, not files being added.
const listDir = (dir, ext) =>
  readdirSync(join(root, dir))
    .filter((f) => !f.startsWith('.') && (!ext || f.endsWith(ext)))
    .map((f) => (dir === '.' ? f : `${dir}/${f}`));
const files = [
  'manifest.json',
  'theme.css',
  ...listDir('.', '.js'),
  ...listDir('.', '.html'),
  ...listDir('icons'),
  ...listDir('sounds'),
];

for (const f of files) {
  if (!existsSync(join(root, f))) {
    console.error(`✖ build file missing: ${f}`);
    process.exit(1);
  }
}

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `auto-refresh-pro-${manifest.version}.zip`);
rmSync(outFile, { force: true });

execFileSync('zip', ['-q', outFile, ...files], { cwd: root, stdio: 'inherit' });
console.log(`✔ built ${outFile.replace(root + '/', '')} (version ${manifest.version})`);
