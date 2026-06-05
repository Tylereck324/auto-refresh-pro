// Minimal lint/build-sanity check for the extension (no external deps):
//   1. node --check syntax for every JS file
//   2. manifest.json parses and every file it references exists
//   3. every <script src> / importScripts target exists
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
const fail = (m) => { console.error('✖ ' + m); errors++; };
const ok = (m) => console.log('✔ ' + m);

// 1. Syntax-check all JS files (skip node_modules / .git / scripts deps).
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.agents'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
      try { execFileSync(process.execPath, ['--check', p]); ok('syntax ' + p.replace(root + '/', '')); }
      catch (err) { fail('syntax error in ' + p + '\n' + (err.stderr || err).toString()); }
    }
  }
}
walk(root);

// 2. manifest references exist.
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); ok('manifest.json parses'); }
catch (e) { fail('manifest.json invalid: ' + e.message); }

if (manifest) {
  const refs = [];
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  if (manifest.options_page) refs.push(manifest.options_page);
  for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []));
  for (const sz of Object.values(manifest.icons || {})) refs.push(sz);
  for (const r of refs) {
    if (existsSync(join(root, r))) ok('manifest ref ' + r);
    else fail('manifest references missing file: ' + r);
  }
  // CSP sanity: must not weaken script-src.
  const csp = manifest.content_security_policy?.extension_pages || '';
  if (csp && /unsafe-inline|unsafe-eval|\bhttp:/.test(csp)) fail('CSP weakened: ' + csp);
  else ok('CSP present and strict');
}

// 3. <script src> and importScripts targets resolve.
function checkScriptRefs(file, re, label) {
  if (!existsSync(join(root, file))) return;
  const txt = readFileSync(join(root, file), 'utf8');
  let m;
  while ((m = re.exec(txt))) {
    const target = m[1];
    if (target.startsWith('http')) continue;
    if (existsSync(join(root, target))) ok(label + ' ' + file + ' → ' + target);
    else fail(label + ' in ' + file + ' references missing ' + target);
  }
}
for (const html of ['popup.html', 'options.html', 'manage.html', 'offscreen.html']) {
  checkScriptRefs(html, /<script\s+src="([^"]+)"/g, 'script-src');
}
checkScriptRefs('background.js', /importScripts\(['"]([^'"]+)['"]\)/g, 'importScripts');

console.log(errors ? `\n${errors} problem(s) found.` : '\nAll lint checks passed.');
process.exit(errors ? 1 : 0);
