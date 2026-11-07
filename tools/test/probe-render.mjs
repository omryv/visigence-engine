/**
 * Bisect the render modules in headless Chromium, no assets:
 *
 *   node tools/test/probe-render.mjs sky fog street rig shadow post   # cumulative, one page each
 *   node tools/test/probe-render.mjs --each sky fog street             # one part per page
 *   node tools/test/probe-render.mjs --set quality=balanced --set lighting=dawn sky post
 *   node tools/test/probe-render.mjs --webgpu sky fog street post   # SwiftShader's WebGPU adapter, where Chromium has one
 *
 * Reports, per page, whether frames were drawn and what the page said went wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser, openPage } from '../lib/_headless.mjs';

const argv = process.argv.slice(2);
const each = argv.includes('--each');
const sets = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--set') sets.push(argv[++i]);
const parts = argv.filter(a => !a.startsWith('--') && !sets.includes(a));
const renderer = argv.includes('--webgpu') ? 'webgpu' : null;
const PORT = 8131;
const outDir = path.join(ROOT, 'assets/review/shots/probe');
fs.mkdirSync(outDir, { recursive: true });

const server = await serveRepo(PORT);
const browser = await launchBrowser({ width: 960, height: 540, webgpu: argv.includes('--webgpu') });
const runs = each ? parts.map(p => [p]) : parts.map((_, i) => parts.slice(0, i + 1));
if (!runs.length) runs.push([]);
let failures = 0;
for (const run of runs) {
  const params = new URLSearchParams({ parts: run.join(','), frames: '6' });
  for (const s of sets) { const [k, v] = s.split('='); params.set(k, v); }
  if (renderer) params.set('renderer', renderer);
  const url = `http://127.0.0.1:${PORT}/tools/test/render-probe.html?${params}`;
  const r = await openPage(browser, url, { timeoutMs: 300000 });
  const ok = !!r.state?.ready && !r.state?.errors?.length && !r.consoleErrors.length;
  if (!ok) failures++;
  const name = run.join('+') || 'bare';
  fs.writeFileSync(path.join(outDir, `${name}.png`), r.png);
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${name}]  ${r.state?.frames ?? 0} frames  ${r.state?.draws ?? '?'} draws  ${r.elapsed.toFixed(1)} s`);
  for (const e of [...(r.state?.errors ?? []), ...r.consoleErrors].slice(0, 4)) console.log(`       ${String(e).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
}
browser.close(); server.close();
process.exit(failures ? 1 : 0);
