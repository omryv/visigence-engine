/**
 * DOES THE PRODUCT PATH DRAW? A GPU gate for game/ShooterSession.js, the host every
 * player actually sees.
 *
 *   node tools/test/shoot-studio.mjs                          # the reference shot list
 *   node tools/test/shoot-studio.mjs --only arcade-night    # one shot by name
 *   node tools/test/shoot-studio.mjs --out assets/review/shots/studio --frames 120 --webgpu
 *   node tools/test/shoot-studio.mjs --stand-ins --only arcade-world-aerial   # no art cache: box stand-ins
 *
 * Drives headless Chromium over the DevTools protocol (node 22's global WebSocket, no
 * dependency) rather than `--screenshot --virtual-time-budget`: the session streams tens
 * of megabytes of GLBs and compiles a post graph, and a fixed budget either cuts that
 * short or wastes minutes; waiting on the page's own "I drew N frames" signal does
 * neither. SwiftShader stands in for the GPU, so a shot proves the graph compiles and
 * draws on WebGL2, not what a real device's frame costs.
 *
 * NOT WIRED INTO tools/test/run.mjs, on purpose: that runner's contract is bare node,
 * no network, no assets, and this needs a browser binary and a port.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser, openPage } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const outDir = path.resolve(ROOT, flag('out', 'assets/review/shots/studio'));
const frames = flag('frames', '90');
const only = flag('only');
const PORT = Number(flag('port', '8123'));
const WIDTH = Number(flag('width', '1280')), HEIGHT = Number(flag('height', '720'));
const TIMEOUT_MS = Number(flag('timeout', '600000'));

/**
 * The reference shots. One per theme/lighting pair the studio offers, at the quality the
 * art is authored against, plus one lean shot so the no-post path is covered. Poses are
 * fixed so two runs of this script are comparable pixel for pixel.
 */
const SHOTS = [
  { name: 'arcade-dawn', q: { theme: 'arcade', lighting: 'dawn', quality: 'quality', palette: 'violet', yaw: 0.3, pitch: 0.04 } },
  { name: 'arcade-night', q: { theme: 'arcade', lighting: 'night', quality: 'quality', palette: 'violet', yaw: -0.3, pitch: -0.05 } },
  { name: 'arcade-dawn-lean', q: { theme: 'arcade', lighting: 'dawn', quality: 'performance', palette: 'violet', yaw: 0.3, pitch: 0.04 } },
  // The same mission card on its seed's Visigenesis world (world/kernelGround.js) and on the village's own hills, from
  // the player's eye and from above: the level editor's camera hook draws the aerials.
  { name: 'arcade-world-dawn', q: { quick: 1, theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', ground: 'world', lighting: 'dawn', quality: 'quality', yaw: 0.3, pitch: -0.02 } },
  { name: 'arcade-world-aerial', q: { quick: 1, theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', ground: 'world', lighting: 'dawn', quality: 'quality', aerial: '46,34,58' } },
  { name: 'arcade-village-aerial', q: { quick: 1, theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', ground: 'village', lighting: 'dawn', quality: 'quality', aerial: '46,34,58' } },
  // The world past the rim (render/ArcadeGround.js `beyond`): its hills, its coast and its sea, from high over the village.
  // See yourself: a photograph made into a figure (src/atlas/web/figure.js) standing on the world's ground.
  { name: 'arcade-world-figure', q: { quick: 1, theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', ground: 'world', lighting: 'dawn', quality: 'quality', figure: '0,22.5', yaw: 0.0, pitch: 0.02, viewmodel: 'off' } },
  { name: 'arcade-world-vista', q: { quick: 1, theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', ground: 'world', lighting: 'dawn', quality: 'quality', aerial: '120,85,170' } },
];

// `--stand-ins`: boxes for the art (tools/test/stand-in-assets.mjs) where the R2 origin is unreachable. The ground, the
// water and the lighting are the real code either way; only the GLBs are stood in for.
const server = await serveRepo(PORT, { fallbackRoot: has('stand-ins') ? STAND_IN_ROOT : null });
const browser = await launchBrowser({ width: WIDTH, height: HEIGHT, webgpu: has('webgpu') });
fs.mkdirSync(outDir, { recursive: true });
console.log(`chromium ${browser.path}`);
console.log(`serving  ${ROOT} on 127.0.0.1:${PORT}\n`);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`    ok   ${name}${detail ? '  (' + detail + ')' : ''}`); return; }
  failures++; console.log(`    FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

const report = [];
for (const shot of SHOTS) {
  if (only && shot.name !== only) continue;
  console.log(shot.name);
  const params = new URLSearchParams({ ...shot.q, frames });
  if (has('webgpu')) params.set('renderer', 'webgpu');
  // `--set quality=performance --set fx=-traa,-dof` overrides any page parameter, for bisecting.
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--set') { const [k, v] = argv[i + 1].split('='); params.set(k, v); }
  const url = `http://127.0.0.1:${PORT}/tools/test/studio-capture.html?${params}`;
  const { state, consoleErrors, elapsed: seconds, png } = await openPage(browser, url, { timeoutMs: TIMEOUT_MS, onStatus: st => console.log(`    ...  ${st}`) });
  const elapsed = seconds.toFixed(1);
  const file = path.join(outDir, `${shot.name}.png`);
  fs.writeFileSync(file, png);

  check('the session built and drew the requested frames', !!state?.ready, state ? `${state.frames} frames, status "${state.status}"` : 'no state');
  if (!state?.ready) for (const line of browser.log.text.split('\n').filter(l => /GL_|ERROR|error|lost|Failed|shader/i.test(l) && !/DevTools/.test(l)).slice(-8)) console.log(`    log  ${line.slice(0, 220)}`);
  check('no errors reached the page', !state?.errors?.length && !consoleErrors.length,
    [...(state?.errors ?? []), ...consoleErrors].slice(0, 3).join(' | ').slice(0, 400));
  check('the screenshot exists and is not blank', fs.statSync(file).size > 20000, `${fs.statSync(file).size} bytes`);
  if (shot.q.figure) check('a figure was made from a photograph and passed the importer', state?.figure?.triangles > 1000 && state.figure.triangles <= 50000, JSON.stringify(state?.figure));
  if (shot.q.ground) check(`the level stands on ${shot.q.ground === 'world' ? "its seed's world" : "the village's hills"}`, state?.ground?.kind === shot.q.ground, JSON.stringify(state?.ground));
  const line = `${state?.backend ?? '?'}  ${state?.draws ?? '?'} draws  ${Number(state?.triangles ?? 0).toLocaleString()} tris  ` +
    `lights ${state?.lights ? `${state.lights.visible} live / ${state.lights.emitters} emitters` : '?'}  post ${state?.post ? Object.entries(state.post).filter(([, v]) => v).map(([k]) => k).join('+') || 'on' : 'off'}  ${elapsed} s`;
  console.log(`    -> ${path.relative(ROOT, file)}  ${line}\n`);
  report.push({ shot: shot.name, ...state, consoleErrors, elapsed: Number(elapsed) });
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

browser.close(); server.close();
console.log(failures ? `FAILED: ${failures}` : 'The studio draws every reference shot.');
process.exit(failures ? 1 : 0);
