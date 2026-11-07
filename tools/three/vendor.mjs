/**
 * Refresh vendor/three from a three package: the only sanctioned way to change it.
 *
 *   npm pack three@0.185.1 && tar xf three-0.185.1.tgz          # or npm install three
 *   node tools/three/vendor.mjs --from ./package                 # default: node_modules/three
 *   node tools/three/vendor.mjs --from ./package --readable      # also the unminified builds
 *   node tools/three/vendor.mjs --from ./package --allow-version-change
 *
 * What it copies: the four bundles the import map names, and exactly the addon files that
 * are vendored today (so an upgrade never silently grows or shrinks the addon set; add a
 * file by copying it once, then this keeps it current). With --readable the unminified
 * `three.webgpu.js`, `three.core.js` and `three.tsl.js` land beside the minified ones for
 * local debugging: point the import map at them in a scratch copy of index.html, never in
 * the shipped one (they are 3x the bytes).
 *
 * It refuses a package whose revision differs from package.json unless told otherwise,
 * because a revision change is an engine change (core/Renderer.js lists r185.1 behaviour
 * the boot sequence depends on) and has to be reviewed as one: bump package.json, re-read
 * vendor/three/PATCHES.md, run the probes, then pass --allow-version-change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENDOR = path.join(ROOT, 'vendor/three');
const argv = process.argv.slice(2);
const fromAt = argv.indexOf('--from');
const from = path.resolve(ROOT, fromAt >= 0 ? argv[fromAt + 1] : 'node_modules/three');
const readable = argv.includes('--readable');
const allowVersionChange = argv.includes('--allow-version-change');
const dryRun = argv.includes('--dry-run');

const pkgPath = path.join(from, 'package.json');
if (!fs.existsSync(pkgPath)) { console.error(`no three package at ${from} (expected ${pkgPath})`); process.exit(2); }
const incoming = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (incoming.name !== 'three') { console.error(`${from} is ${incoming.name}, not three`); process.exit(2); }
const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).peerDependencies?.three ?? '';
const declaredMinor = declared.match(/0\.(\d+)/)?.[1];
const incomingMinor = incoming.version.match(/^0\.(\d+)/)?.[1];
if (declaredMinor !== incomingMinor && !allowVersionChange) {
  console.error(`package.json declares three ${declared} but ${from} is ${incoming.version}. Bump package.json and pass --allow-version-change to vendor a different revision.`);
  process.exit(1);
}

const BUNDLES = ['three.webgpu.min.js', 'three.core.min.js', 'three.tsl.min.js', 'three.module.min.js'];
const READABLE = ['three.webgpu.js', 'three.core.js', 'three.tsl.js'];
const copies = [];
for (const f of [...BUNDLES, ...(readable ? READABLE : [])]) copies.push([path.join(from, 'build', f), path.join(VENDOR, 'build', f)]);
/** The addon set is whatever is vendored now. */
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { const rel = path.relative(path.join(VENDOR, 'examples/jsm'), p); copies.push([path.join(from, 'examples/jsm', rel), p]); }
  }
})(path.join(VENDOR, 'examples/jsm'));

let changed = 0, missing = 0;
for (const [src, dst] of copies) {
  if (!fs.existsSync(src)) { console.error(`  missing in package: ${path.relative(from, src)}`); missing++; continue; }
  const same = fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst));
  if (same) continue;
  changed++;
  console.log(`  ${fs.existsSync(dst) ? 'update' : 'add   '} ${path.relative(ROOT, dst)}`);
  if (!dryRun) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}
if (missing) { console.error(`${missing} vendored file(s) do not exist in three ${incoming.version}; the addon set needs a decision before vendoring.`); process.exit(1); }
console.log(`three ${incoming.version}: ${copies.length} files checked, ${changed} ${dryRun ? 'would change' : 'changed'}${readable ? ', readable builds included' : ''}.`);
if (changed && !dryRun) console.log('Now: node tools/three/check.mjs, then the render probes (tools/test/probe-render.mjs) before committing.');
