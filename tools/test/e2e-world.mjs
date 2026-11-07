/**
 * WORLD, THEN PLAY HERE, IN A BROWSER: the world engine's editor (world.html) makes a world, and a mission is played
 * on THAT world.
 *
 *   node tools/test/stand-in-assets.mjs     # once, where the R2 origin is unreachable (Play's art)
 *   node tools/test/e2e-world.mjs
 *
 * Through the pages' own surfaces:
 *   1. world.html opens the world engine on the engine's renderer, on the default seed's own world, with the tool's
 *      modes in its top bar;
 *   2. the command palette plants the woods (⌘K, "Plant woods", Enter), as an author would, and a town is placed on
 *      the world's land through the editor's own site command (its pads sculpt the ground);
 *   3. "Play here" opens Play in a new tab, the world in the link (the editor stores nothing);
 *   4. Play names the world it was handed, and the mission it prepares stands on it: the level's world parameter
 *      hash is the built world's as the editor holds it, not the plain seed's;
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
import { landPoint } from '../lib/worldProbe.mjs';

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
// A new tab can be created on about:blank and navigated after: follow its URL until it carries the world.
const seenTab = (p) => { if (p.targetInfo.type === 'page' && p.targetInfo.url.includes('world=') && !opened.includes(p.targetInfo.url)) opened.push(p.targetInfo.url); };
on('Target.targetCreated', seenTab);
on('Target.targetInfoChanged', seenTab);
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
  // A real click (a user gesture), not element.click(): a popup opened from script is blocked, as it is for a person
  // whose click a page script imitates, and "Play here" opens a tab.
  const click = async (selector) => {
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  };
  return { targetId, sessionId, js, until, shot, key, click, insertText: (text) => send('Input.insertText', { text }, sessionId) };
}

try {
  // ── 1. World ─────────────────────────────────────────────────────────────────
  const w = await page(`http://127.0.0.1:${PORT}/world.html?renderer=webgl&gfx=low`);
  await w.until(`!!(window.engine && engine.terrain && engine.terrain.tiles.size > 0)`, 180000, 'the world engine');
  check('World opens the world engine on the engine\'s renderer', (await w.js('engine.backend')) === 'webgl2');
  const opened = await w.js(`(async () => (await import('/src/kernel/seed.js')).DEFAULT_SEED === engine.params.seed)()`);
  check('on the default seed\'s own world, nothing placed', opened && (await w.js('engine.props.items.size')) === 0 && (await w.js('engine.scatterCount()')) === 0);
  const modes = await w.js(`[...document.querySelectorAll('#modes a')].map(a => a.textContent.trim()).join(' ')`);
  check('its top bar carries the tool\'s modes', modes === 'World Play Remix Build', modes);
  // ── 2. build on it: woods through the command palette, a town through the site command ──────────────────
  await w.key({ key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await w.until(`!document.querySelector('#cmdk').hidden`, 10000, 'the command palette');
  await w.insertText('Plant woods');
  await sleep(400);
  await w.key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await w.until(`engine.scatterCount() > 500`, 120000, 'the woods');
  const at = JSON.parse(await w.js(`JSON.stringify(${landPoint.toString()}(engine))`));
  await w.js(`studio.placeSite(${at.x}, ${at.z}, 'town')`);
  await w.until(`engine.props.items.size > 50`, 300000, 'the town');
  const built = JSON.parse(await w.js(`JSON.stringify({ props: engine.props.items.size, scatter: engine.scatterCount(), seed: engine.params.seed, sculpt: engine.sculptStrokes().length })`));
  check('the world is built on: woods, a town, its pads sculpted', built.props > 50 && built.scatter > 500 && built.sculpt > 0,
    `${built.props} props, ${built.scatter} plants, ${built.sculpt} strokes at (${at.x}, ${at.z}), seed ${built.seed}`);
  await sleep(4000);
  const ws = await w.shot('world-built');
  check('and draws it', ws.colours > 60, `${ws.colours} colours; ${ws.file}`);
  const expected = await w.js(`(async () => {
    const { worldParamsFor } = await import('/src/world/kernelGround.js');
    const { terrainParameterHash, hex } = await import('/src/kernel/terrain/fingerprint.js');
    return hex(terrainParameterHash(worldParamsFor(engine.params.seed, { terrain: engine.params.terrain, water: engine.params.water })));
  })()`);
  // ── 3. Play here ─────────────────────────────────────────────────────────────
  // Software rendering of a whole town takes seconds a frame here; stand the world still so the click is handled now.
  await w.js('engine.setPaused(true)');
  await w.click('#play-here');
  const t0 = Date.now();
  while (!opened.length && Date.now() - t0 < 120000) await sleep(200);
  check('"Play here" opens Play in a new tab, the world in the link', opened.length === 1 && /\/\?mode=play#world=/.test(opened[0]), opened[0]?.slice(0, 90));
  // ── 4. Play, on that world ───────────────────────────────────────────────────
  const link = opened[0].replace('?mode=play#', '?mode=play&debug=1#');
  const p = await page(link);
  await p.until(`!!document.querySelector('.featured-mission [data-play-world]')`, 60000, 'the launcher');
  const chip = await p.js(`(() => { const c = document.querySelector('.carried-world'); return c && !c.hidden ? c.querySelector('strong').textContent : null; })()`);
  check('Play names the world it was handed', chip === `Your world · ${built.seed}`, String(chip));
  await p.js(`document.querySelector('.featured-mission [data-play-world]').click()`);
  const prepared = await p.until(`!!document.querySelector('#preview-panel.expanded') || !!document.querySelector('.front-alert:not([hidden])')`, 240000, 'the mission').catch(e => e);
  const alert = await p.js(`document.querySelector('.front-alert:not([hidden]) pre')?.textContent ?? ''`);
  check('the mission is prepared', !(prepared instanceof Error) && !alert, prepared instanceof Error ? prepared.message : alert || `${prepared} ms`);
  const ground = JSON.parse(await p.js(`JSON.stringify(window.__studio?.session?.level?.ground ?? null)`) || 'null');
  check('the level stands on the world World made', ground?.kind === 'world' && ground.world.parameterHash === expected,
    ground ? `${ground.kind}: ${ground.world?.parameterHash} vs the built world ${expected}${ground.reason ? '; ' + ground.reason : ''}` : 'no level');
  const plainHash = await p.js(`(async () => { const { makeParams } = await import('/src/kernel/presets.js'); const { terrainParameterHash, hex } = await import('/src/kernel/terrain/fingerprint.js'); return hex(terrainParameterHash(makeParams({ seed: ${JSON.stringify(built.seed)} }))); })()`);
  check('and not on the plain world of its seed', ground?.world?.parameterHash !== plainHash, `plain ${plainHash}`);
  await sleep(4000);
  const ps = await p.shot('play-on-built-world');
  console.log(`       play: ${ps.file} (${ps.colours} colours)`);
} catch (err) {
  check('the run finished', false, err.message);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  browser.close(); server.close();
}
console.log(failures ? `World → Play: ${failures} failed` : 'World → Play: OK');
process.exit(failures ? 1 : 0);
