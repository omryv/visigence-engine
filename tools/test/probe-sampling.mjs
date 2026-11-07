/**
 * WHAT DOES EACH SESSION POLICY SAMPLE WITH? Drives tools/test/sampling-probe.html through
 * headless Chromium for every studio policy and prints the facts the page read off the
 * backend: context antialias, drawing-buffer samples, the renderer's samples, the world
 * pass's samples where a post stack exists, and the share of edge pixels with intermediate
 * coverage (0 means no anti-aliasing of any kind).
 *
 *   node tools/test/probe-sampling.mjs                       # every policy, WebGL2
 *   node tools/test/probe-sampling.mjs --webgpu              # SwiftShader's WebGPU adapter, where Chromium has one
 *   node tools/test/probe-sampling.mjs --out docs/reports/x  # PNGs and sampling.json there
 *   node tools/test/probe-sampling.mjs --set antialias=1     # override the tier's decision, for an A/B
 *
 * SwiftShader stands in for the GPU: sample counts and coverage are exact, frame intervals
 * are not a GPU measurement and are reported only as such.
 *
 * NOT WIRED INTO tools/test/run.mjs: needs a browser binary and a port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser, openPage } from '../lib/_headless.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const outDir = path.resolve(ROOT, flag('out', 'assets/review/shots/sampling'));
const PORT = Number(flag('port', '8137'));
const WIDTH = Number(flag('width', '1280')), HEIGHT = Number(flag('height', '720'));
const sets = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--set') sets.push(argv[++i]);

/** Every policy the studio can run, named as the URL of studio-capture.html would name it. */
const CASES = [
  { name: 'mobile-low', q: { profile: 'Mobile-Low', quality: 'quality' } },
  { name: 'mobile-high', q: { profile: 'Mobile-High', quality: 'quality' } },
  { name: 'desktop-performance', q: { profile: 'Desktop', quality: 'performance' } },
  { name: 'desktop-balanced', q: { profile: 'Desktop', quality: 'balanced' } },
  { name: 'desktop-quality', q: { profile: 'Desktop', quality: 'quality' } },
];

const server = await serveRepo(PORT);
const browser = await launchBrowser({ width: WIDTH, height: HEIGHT, webgpu: has('webgpu') });
fs.mkdirSync(outDir, { recursive: true });
console.log(`chromium ${browser.path}\nserving  ${ROOT} on 127.0.0.1:${PORT}\n`);

const report = [];
let failures = 0;
for (const c of CASES) {
  const params = new URLSearchParams({ ...c.q, frames: flag('frames', '60') });
  if (has('webgpu')) params.set('renderer', 'webgpu');
  for (const s of sets) { const [k, v] = s.split('='); params.set(k, v); }
  const url = `http://127.0.0.1:${PORT}/tools/test/sampling-probe.html?${params}`;
  const { state, consoleErrors, png } = await openPage(browser, url, { timeoutMs: 300000 });
  const ok = !!state?.ready && !state?.errors?.length && !consoleErrors.length;
  if (!ok) failures++;
  const suffix = sets.length ? '-' + sets.join('-').replace(/[^a-z0-9=-]/gi, '') : '';
  fs.writeFileSync(path.join(outDir, `${c.name}${suffix}.png`), png);
  const s = state?.surface ?? {};
  const cov = state?.coverage ?? {};
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(20)} ${s.backend ?? '?'}  antialias=${s.contextAntialias}  bufferSamples=${s.drawingBufferSamples}  renderer.samples=${s.rendererSamples}  worldPass=${s.worldPassSamples ?? '-'}  vmPass=${s.vmPassSamples ?? '-'}  scale=${s.renderScale} dpr=${s.pixelRatio?.toFixed?.(2)}  buffer=${s.buffer?.join('x')}  levels=${cov.distinctLevels ?? "?"} plateau=${cov.plateau ?? "?"} intermediateEdge=${(cov.intermediateShareOfLit * 100).toFixed(1)}%  frame=${state?.frameMs?.mean?.toFixed?.(1) ?? '?'} ms (swiftshader)`);
  for (const e of [...(state?.errors ?? []), ...consoleErrors].slice(0, 3)) console.log(`       ${String(e).split('\n').slice(0, 2).join(' | ').slice(0, 300)}`);
  report.push({ case: c.name, ok, sets, surface: s, coverage: cov, frameMs: state?.frameMs ?? null, draws: state?.draws ?? null, errors: [...(state?.errors ?? []), ...consoleErrors] });
}
fs.writeFileSync(path.join(outDir, `sampling${sets.length ? '-' + sets.join('-').replace(/[^a-z0-9=-]/gi, '') : ''}.json`), JSON.stringify({ generated: new Date().toISOString(), chromium: browser.path, backend: has('webgpu') ? 'webgpu-requested' : 'webgl2', width: WIDTH, height: HEIGHT, report }, null, 2));
browser.close(); server.close();
process.exit(failures ? 1 : 0);
