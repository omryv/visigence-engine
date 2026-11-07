/**
 * WORLD, THEN PLAY HERE, IN A BROWSER: the world engine's editor (world.html) makes a world, and a mission is played
 * on THAT world.
 *
 *   node tools/test/stand-in-assets.mjs     # once, where the R2 origin is unreachable (Play's art)
 *   node tools/test/e2e-world.mjs
 *
 * Through the pages' own surfaces:
 *   1. world.html opens the world engine on the engine's renderer, with the tool's modes in its top bar;
 *   2. the command palette builds Farshore (⌘K, "Farshore", Enter), as an author would: a town, its props, its scatter;
 *   3. "Play here" opens Play in a new tab, the world in the link (the editor stores nothing);
 *   4. Play names the world it was handed, and the mission it prepares stands on it: the level's world parameter
 *      hash is Farshore's as the editor holds it, not the plain seed's;
 *   5. a frame of each page is drawn (pixels read on the page's own canvas, WebGL2 backend: see e2e notes in
 *      tools/test/check-wgsl.mjs for why WebGPU frames cannot be read here).
 *
 * Shots go to docs/reports/world/ (PNGs stay local). Not in tools/test/run.mjs: it needs a browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';
import { decodePNG } from '../lib/png.mjs';

const PORT = 8173, W = 1280, H = 800;
const OUT = path.join(ROOT, 'docs/reports/world');
fs.mkdirSync(OUT, { recursive: true });
const server = await serveRepo(PORT, { fallbackRoot: STAND_IN_ROOT, ...(process.argv.includes('--dist') ? { root: path.join(ROOT, 'dist') } : {}) });
const browser = await launchBrowser({ width: W, height: H, webgpu: false });
const { send, on } = browser;
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
const opened = [];
on('Target.targetCreated', (p) => { if (p.targetInfo.type === 'page' && p.targetInfo.url.includes('world=')) opened.push(p.targetInfo.url); });
await send('Target.setDiscoverTargets', { discover: true });

async function page(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300)); });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(expression).catch(() => false)) return Date.now() - t0; await sleep(500); }
    throw new Error(`timed out after ${ms} ms waiting for ${what}`);
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const png = Buffer.from(data, 'base64'), file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, png);
    const img = decodePNG(png), seen = new Set();
    for (let y = 100; y < img.h - 100; y += 9) for (let x = 200; x < img.w - 200; x += 9) {
      const o = (y * img.w + x) * 4; seen.add((img.px[o] >> 3) << 10 | (img.px[o + 1] >> 3) << 5 | img.px[o + 2] >> 3);
    }
    return { file: path.relative(ROOT, file), colours: seen.size };
  };
  const key = async (opts) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, ...opts }, sessionId); };
  return { targetId, sessionId, js, until, shot, key, insertText: (text) => send('Input.insertText', { text }, sessionId) };
}

try {
  // ── 1. World ─────────────────────────────────────────────────────────────────
  const w = await page(`http://127.0.0.1:${PORT}/world.html?renderer=webgl&gfx=low`);
  await w.until(`!!(window.engine && engine.terrain && engine.terrain.tiles.size > 0)`, 180000, 'the world engine');
  check('World opens the world engine on the engine\'s renderer', (await w.js('engine.backend')) === 'webgl2');
  const modes = await w.js(`[...document.querySelectorAll('#modes a')].map(a => a.textContent.trim()).join(' ')`);
  check('its top bar carries the tool\'s modes', modes === 'World Play Remix Build', modes);
  // ── 2. build Farshore through the command palette ─────────────────────────────
  await w.key({ key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await w.until(`!document.querySelector('#cmdk').hidden`, 10000, 'the command palette');
  await w.insertText('Farshore');
  await sleep(400);
  await w.key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await w.until(`engine.props.items.size > 100 && !document.body.classList.contains('building')`, 300000, 'Farshore');
  const built = JSON.parse(await w.js(`JSON.stringify({ props: engine.props.items.size, scatter: engine.scatterCount(), seed: engine.params.seed })`));
  check('the palette builds Farshore: its town and its scatter', built.props > 100 && built.scatter > 100, `${built.props} props, ${built.scatter} plants, seed ${built.seed}`);
  await sleep(4000);
  const ws = await w.shot('world-farshore');
  check('and draws it', ws.colours > 60, `${ws.colours} colours; ${ws.file}`);
  const expected = await w.js(`(async () => {
    const { worldParamsFor } = await import('/src/world/kernelGround.js');
    const { terrainParameterHash, hex } = await import('/src/kernel/terrain/fingerprint.js');
    return hex(terrainParameterHash(worldParamsFor(engine.params.seed, { terrain: engine.params.terrain, water: engine.params.water })));
  })()`);
  // ── 3. Play here ─────────────────────────────────────────────────────────────
  await w.js(`document.querySelector('#play-here').click()`);
  const t0 = Date.now();
  while (!opened.length && Date.now() - t0 < 10000) await sleep(200);
  check('"Play here" opens Play in a new tab, the world in the link', opened.length === 1 && /\/\?mode=play#world=/.test(opened[0]), opened[0]?.slice(0, 90));
  // ── 4. Play, on that world ───────────────────────────────────────────────────
  const link = opened[0].replace('?mode=play#', '?mode=play&debug=1#');
  const p = await page(link);
  await p.until(`!!document.querySelector('.featured-mission [data-play-world]')`, 60000, 'the launcher');
  const chip = await p.js(`(() => { const c = document.querySelector('.carried-world'); return c && !c.hidden ? c.querySelector('strong').textContent : null; })()`);
  check('Play names the world it was handed', chip === `Farshore · ${built.seed}`, String(chip));
  await p.js(`document.querySelector('.featured-mission [data-play-world]').click()`);
  const prepared = await p.until(`!!document.querySelector('#preview-panel.expanded') || !!document.querySelector('.front-alert:not([hidden])')`, 240000, 'the mission').catch(e => e);
  const alert = await p.js(`document.querySelector('.front-alert:not([hidden]) pre')?.textContent ?? ''`);
  check('the mission is prepared', !(prepared instanceof Error) && !alert, prepared instanceof Error ? prepared.message : alert || `${prepared} ms`);
  const ground = JSON.parse(await p.js(`JSON.stringify(window.__studio?.session?.level?.ground ?? null)`) || 'null');
  check('the level stands on the world World made', ground?.kind === 'world' && ground.world.parameterHash === expected,
    ground ? `${ground.kind}: ${ground.world?.parameterHash} vs Farshore ${expected}${ground.reason ? '; ' + ground.reason : ''}` : 'no level');
  const plainHash = await p.js(`(async () => { const { makeParams } = await import('/src/kernel/presets.js'); const { terrainParameterHash, hex } = await import('/src/kernel/terrain/fingerprint.js'); return hex(terrainParameterHash(makeParams({ seed: ${JSON.stringify(built.seed)} }))); })()`);
  check('and not on the plain world of its seed', ground?.world?.parameterHash !== plainHash, `plain ${plainHash}`);
  await sleep(4000);
  const ps = await p.shot('play-on-farshore');
  console.log(`       play: ${ps.file} (${ps.colours} colours)`);
} catch (err) {
  check('the run finished', false, err.message);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  browser.close(); server.close();
}
console.log(failures ? `World → Play: ${failures} failed` : 'World → Play: OK');
process.exit(failures ? 1 : 0);
