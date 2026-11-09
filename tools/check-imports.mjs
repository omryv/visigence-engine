// Parses every source the browser runs (src/ and editor/) and fails on an import that does not resolve, that leaves
// the repository, or that resolves differently on disk and as a URL from the site's root (tools/lib/modules.mjs says
// why those must agree). Two boundaries more: the kernel (src/kernel/) is pure,
// so it imports nothing outside themselves and nothing bare, not even three; and nothing reaches into a game.
// The engine has no build step, so this is what stands in for one.
//
// Comments and template literals are stripped first: this codebase explains itself at length,
// and prose about importing is not an import.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, inRepo, inKernel, moduleSpecifiers, resolveRelative, servedTarget, runtimeFiles } from './lib/modules.mjs';

const BARE_OK = /^three(\/|$)/;
const files = runtimeFiles();
const problems = [];
let edges = 0, pure = 0;
for (const file of files) {
  const where = path.relative(ROOT, file), kernel = inKernel(file);
  for (const spec of moduleSpecifiers(fs.readFileSync(file, 'utf8'))) {
    edges++;
    if (!spec.startsWith('.')) {
      if (kernel) problems.push(`${where}: a pure module imports "${spec}"`);
      else if (!BARE_OK.test(spec)) problems.push(`${where}: unexpected bare import "${spec}"`);
      continue;
    }
    if (spec.includes('/game/levels/')) { problems.push(`${where}: reaches into a game -> ${spec}`); continue; }
    const target = resolveRelative(file, spec);
    if (!inRepo(target)) { problems.push(`${where}: leaves the repository -> ${spec}`); continue; }
    if (servedTarget(file, spec) !== target) { problems.push(`${where}: resolves on disk but not as a URL from the site's root -> ${spec}`); continue; }
    if (!fs.existsSync(target)) { problems.push(`${where}: unresolved -> ${spec}`); continue; }
    if (kernel && !inKernel(target)) problems.push(`${where}: the kernel imports outside src/kernel -> ${spec}`);
    if (kernel) pure++;
  }
}
console.log(`${files.length} files, ${edges} imports checked (${pure} inside the kernel)`);
if (problems.length) { for (const p of problems) console.error('  ' + p); process.exit(1); }
console.log('OK: every import resolves inside the repository, only three.js is external, the kernel stays pure');
