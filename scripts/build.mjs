// Build a Chrome Web Store zip (dist/auto-refresh-pro-<version>.zip) from an
// explicit allowlist of runtime files — dev-only material (tests, scripts,
// docs, audit artifacts) must never ship inside the package.
//
// Refuses to build if manifest.json and package.json disagree on the version,
// so a release can't go out half-bumped.
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The manifest's `key` pins the extension ID for unpacked installs (so Chrome
// sync matches across computers). The Web Store assigns its own key and
// rejects an uploaded one, so the packaged manifest omits it.
const { key: _pinnedKey, ...storeManifest } = manifest;
const stage = mkdtempSync(join(tmpdir(), 'arp-build-'));
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(storeManifest, null, 2) + '\n');
const rest = files.filter((f) => f !== 'manifest.json');
execFileSync('zip', ['-q', outFile, ...rest], { cwd: root, stdio: 'inherit' });
execFileSync('zip', ['-q', '-j', outFile, join(stage, 'manifest.json')], { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`✔ built ${outFile.replace(root + '/', '')} (version ${manifest.version})`);
