/**
 * THE SITE BUILDS, AND WHAT IT SERVES IS WHOLE. Vercel runs `node tools/build/build-preview.mjs` and serves dist/
 * (vercel.json); a build that throws is a deployment that fails, which no other suite here would notice. So this runs
 * the same build, then reads every page in dist/ and checks that each local script, stylesheet and module it names is
 * in dist/ too: a page that ships pointing at a file the build left out is a blank page on the site.
 *
 *   node tools/test/check-site-build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const PAGES = ['index.html', 'game.html', '2d.html', 'my-3d-engine.html'];

const r = spawnSync(process.execPath, ['tools/build/build-preview.mjs'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  console.error((r.stdout + r.stderr).trim());
  console.error('FAIL the site build (tools/build/build-preview.mjs) did not finish');
  process.exit(1);
}
const problems = [];
for (const page of PAGES) {
  const file = path.join(DIST, page);
  if (!fs.existsSync(file)) { problems.push(`${page} is not in dist/`); continue; }
  const html = fs.readFileSync(file, 'utf8');
  // Real src and href attributes only: data-asset-src names art the page asks the art server for (assetDelivery.js).
  const refs = [...html.matchAll(/(?<![-\w])(?:src|href)="(\/[^"#?]+)/g)].map((m) => m[1]);
  for (const map of html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g))
    for (const v of Object.values(JSON.parse(map[1]).imports)) if (!v.endsWith('/')) refs.push(v);
  for (const ref of refs) if (!fs.existsSync(path.join(DIST, ref))) problems.push(`${page} names ${ref}, which dist/ does not have`);
}
if (problems.length) {
  for (const p of problems) console.error('FAIL ' + p);
  process.exit(1);
}
console.log(`ok   the site builds, and its ${PAGES.length} pages name only files it serves`);
