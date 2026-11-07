/**
 * Is the vendored three the one the package declares, and complete?
 *
 * Runs as part of `npm run check`. Three facts are held together here so an upgrade cannot
 * be half done: package.json's `three` peer range names the revision the engine is written
 * against (core/Renderer.js documents r185.1 behaviour it depends on); the vendored bundle
 * carries its own REVISION constant; and every `three/addons/...` import in the engine,
 * the studio and the tools has to resolve to a vendored file. A mismatch in any of these
 * is a build that will run on one machine and not another.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENDOR = path.join(ROOT, 'vendor/three');
const problems = [];

// 1. The declared revision.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const range = pkg.peerDependencies?.three ?? pkg.dependencies?.three ?? '';
const declared = range.match(/0\.(\d+)/)?.[1];
if (!declared) problems.push(`package.json does not declare a three version (found ${JSON.stringify(range)})`);

// 2. The vendored revision, from the bundle's own constant.
export function vendoredRevision(buildDir = path.join(VENDOR, 'build')) {
  const core = path.join(buildDir, 'three.core.min.js');
  if (!fs.existsSync(core)) return null;
  const head = fs.readFileSync(core, 'utf8').slice(0, 20000);
  return head.match(/const [A-Za-z_$]+="(\d{3})(?:[^"]*)"/)?.[1] ?? null;
}
const vendored = vendoredRevision();
if (!vendored) problems.push('vendor/three/build/three.core.min.js is missing or carries no REVISION constant');
else if (declared && vendored !== declared) problems.push(`package.json declares three 0.${declared} but vendor/three/build is r${vendored}`);

// 3. Every bundle the import map names.
for (const f of ['three.webgpu.min.js', 'three.core.min.js', 'three.tsl.min.js', 'three.module.min.js']) {
  if (!fs.existsSync(path.join(VENDOR, 'build', f))) problems.push(`vendor/three/build/${f} is missing`);
}

// 4. Every addon import resolves.
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(m?js|html)$/.test(e.name)) files.push(p);
  }
})(ROOT);
const addons = new Set();
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/['"]three\/addons\/([^'"]+)['"]/g)) addons.add(m[1]);
for (const a of [...addons].sort()) {
  if (!fs.existsSync(path.join(VENDOR, 'examples/jsm', a))) problems.push(`three/addons/${a} is imported but not vendored (vendor/three/examples/jsm/${a})`);
}

// 5. The patch ledger exists: every deviation from upstream is written down there.
if (!fs.existsSync(path.join(VENDOR, 'PATCHES.md'))) problems.push('vendor/three/PATCHES.md is missing');

if (problems.length) {
  console.error(`three vendoring: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: three r${vendored} vendored as declared (^0.${declared}), ${addons.size} addon imports resolve`);
