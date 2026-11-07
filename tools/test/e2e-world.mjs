/**
 * WORLD MODE, IN A BROWSER: the page opens on the seed's world, grows it in a worker, draws it on the engine's
 * renderer, and hands the seed to Play.
 *
 *   node tools/test/stand-in-assets.mjs     # once, where the R2 origin is unreachable (Play's art)
 *   node tools/test/e2e-world.mjs            # the engine's renderer on its WebGL2 backend (?renderer=webgl): every check
 *   node tools/test/e2e-world.mjs --webgpu   # on WebGPU (SwiftShader's adapter): every check but the pixels and Play
 *   node tools/test/e2e-world.mjs --dist     # against the deployable build (node tools/build/build-preview.mjs first)
 *
 * What it holds the page to:
 *   1. it opens in World mode, and the ground it shows is the kernel's: the height hash on the panel is the one
 *      src/world/worldMap.js bakeWorld gives in Node for the same seed, and so are the level sites;
 *   2. the frame is drawn (many colours, not the clear colour), on the backend the panel names: read back from the
 *      GPU on both backends (WorldView.capture), and screenshotted on WebGL2 too;
 *   3. a new seed grows a new world, again the one Node grows;
 *   4. "Play here" switches to Play with that seed, and (on WebGL2) the mission is prepared on it;
 *   5. World again shows the same seed, and Play's session has let its renderer go (one GPU context at a time); a
 *      mission still being prepared when World is entered does not open over it (the WebGPU run leaves mid-build);
 *   6. (WebGL2) "Play here" a second time prepares the mission again, on a session made afresh;
 *   7. World, Play and World again without waiting: the view that ends up shown draws on the canvas on the page.
 *
 * WHY THE PIXELS ARE CHECKED ON WEBGL2. Headless Chromium's WebGPU here is SwiftShader's adapter, and it can neither
 * show nor return a frame: a red clear with a green box captures as black (white under an animation loop), and reading
 * a render target back fails in mapAsync with "A valid external Instance reference no longer exists" (measured on a
 * bare page, World not involved). It also loses the game session's device on its own (measured with Play opened
 * directly). The same renderer on its WebGL2 backend shows and returns frames correctly, and the scene is the same
 * TSL node graph compiled to GLSL instead of WGSL, so the pixels, the screenshots and Play are checked there; the WebGPU
 * run holds the page to everything else (it opens, grows the kernel's world, runs its frame loop without an error, and
 * hands the seed to Play) and says plainly that it did not see a pixel.
 *
 * Drives Chromium over the DevTools protocol (tools/lib/_headless.mjs, `--headless=new`). Shots go to
 * docs/reports/world/ (PNGs stay local). Not in tools/test/run.mjs: it needs a browser, like the other e2e harnesses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';
import { decodePNG } from '../lib/png.mjs';
import { bakeWorld } from '../../src/world/worldMap.js';

const WEBGL = !process.argv.includes('--webgpu'), PORT = 8171, W = 1280, H = 800;
const OUT = path.join(ROOT, 'docs/reports/world');
fs.mkdirSync(OUT, { recursive: true });
const server = await serveRepo(PORT, { fallbackRoot: STAND_IN_ROOT, ...(process.argv.includes('--dist') ? { root: path.join(ROOT, 'dist') } : {}) });
const browser = await launchBrowser({ width: W, height: H, webgpu: !WEBGL });
const { send, on } = browser;
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const errors = [];
let phase = 'open';
on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) errors.push(`[${phase}] ` + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)); });
on('Runtime.consoleAPICalled', (p, sid) => {
  if (sid !== sessionId || p.type !== 'error') return;
  const text = p.args.map(a => a.value ?? a.description).join(' ');
  if (!/Failed to load resource|ERR_TUNNEL|net::|WebGPU is not available/.test(text)) errors.push(`[${phase}] ${text}`);
});
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
const js = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
const until = async (expression, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await js(expression)) return Date.now() - t0; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
};
/** The GPU's own frame of the view (WorldView.capture), on either backend. */
const gpu = () => js(`(async () => { const v = window.__world?.view(); if (!v) return null; try { return await v.capture(); } catch (e) { return { error: String(e && e.stack || e).slice(0, 400) }; } })()`);
const shot = async name => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(OUT, `${name}${WEBGL ? '-webgl' : ''}.png`), png = Buffer.from(data, 'base64');
  fs.writeFileSync(file, png);
  // The world's half of the frame (right of the panel): drawn means many colours, not the clear colour.
  const img = decodePNG(png), seen = new Set();
  let lum = 0, n = 0;
  for (let y = 120; y < img.h - 40; y += 7) for (let x = 460; x < img.w - 40; x += 7) {
    const o = (y * img.w + x) * 4, r = img.px[o], g = img.px[o + 1], b = img.px[o + 2];
    seen.add((r >> 3) << 10 | (g >> 3) << 5 | b >> 3); lum += 0.2126 * r + 0.7152 * g + 0.0722 * b; n++;
  }
  return { file: path.relative(ROOT, file), colours: seen.size, mean: lum / n };
};
const panel = () => js(`({ mode: document.body.dataset.mode, seed: document.querySelector('#world-seed')?.value,
  hash: document.querySelector('.world-facts code')?.textContent, ground: document.querySelector('.world-facts dd')?.textContent,
  sites: document.querySelectorAll('.world-sites [data-site]').length, note: document.querySelector('.world-note')?.textContent })`);

try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?debug=1${WEBGL ? '&renderer=webgl' : ''}` }, sessionId);
  // ── 1. World first, and the kernel's ground ────────────────────────────────
  const ms = await until(`document.querySelector('.world-facts')?.textContent.includes('eroded')`, 120000, 'the canonical ground');
  let p = await panel();
  check('the page opens in World mode', p.mode === 'world', p.mode);
  const node = bakeWorld(p.seed);
  check('the height hash on the page is the kernel\'s for that seed', p.hash === node.manifest.heightHash, `${p.seed}: page ${p.hash}, node ${node.manifest.heightHash}; grown in ${ms} ms`);
  check('and so are the level sites', p.sites === node.sites.length, `${p.sites} vs ${node.sites.length}`);
  const backend = WEBGL ? 'WebGL2' : 'WebGPU';
  check(`drawn on ${backend}`, p.note.startsWith(`Drawn on ${backend}`), p.note.split('·')[0].trim());
  // ── 2. drawn ───────────────────────────────────────────────────────────────
  await js(`window.__world.view().still()`);
  let g = WEBGL ? await gpu() : null;
  if (WEBGL) check('the GPU drew the world', g && g.colours > 40 && g.mean > 25, g ? (g.error ?? `${g.colours} colours, mean ${g.mean.toFixed(0)} in a ${g.width}×${g.height} read-back`) : 'no view');
  else console.log('  --   pixels not checked: this adapter cannot show or return a WebGPU frame (see the header); run without --webgpu');
  let s;
  if (WEBGL) {
    await new Promise(r => setTimeout(r, 1500));
    s = await shot(`world-${p.seed}`);
    check('and the page shows it', s.colours > 40 && s.mean > 25, `${s.colours} colours, mean luminance ${s.mean.toFixed(0)}; ${s.file}`);
  }
  phase = 'new seed';
  // ── 3. a new seed ──────────────────────────────────────────────────────────
  const next = 'AB12-CD34-EF56';
  await js(`(() => { const i = document.querySelector('#world-seed'); i.value = '${next}'; i.dispatchEvent(new Event('change')); })()`);
  await until(`document.querySelector('#world-seed').value === '${next}' && document.querySelector('.world-facts')?.textContent.includes('eroded')`, 120000, 'the new world');
  p = await panel();
  const other = bakeWorld(next);
  check('a new seed grows its own world, the one Node grows', p.hash === other.manifest.heightHash && p.sites === other.sites.length, `page ${p.hash}, node ${other.manifest.heightHash}`);
  await js(`document.querySelector('[data-site="0"]')?.click()`);
  if (WEBGL) { g = await gpu(); check('the level\'s site, close up, is drawn', g && g.colours > 40 && g.mean > 25, g ? (g.error ?? `${g.colours} colours, mean ${g.mean.toFixed(0)}`) : 'no view'); }
  if (WEBGL) { await new Promise(r => setTimeout(r, 1500)); s = await shot(`world-${next}-site`); console.log(`       shot: ${s.file} (${s.colours} colours)`); }
  phase = 'play';
  // ── 4. Play here ───────────────────────────────────────────────────────────
  await js(`document.querySelector('[data-world-play]').click()`);
  await until(`document.body.dataset.mode === 'play'`, 10000, 'Play mode');
  check('"Play here" switches to Play', true);
  check('Play holds the world\'s seed', (await js(`document.querySelector('#mission-seed').value`)) === next);
  check('World let go of its renderer', (await js(`window.__world.view() === null && document.querySelector('#world-mode').hidden`)) === true);
  if (WEBGL) {
  const prepared = await until(`!!document.querySelector('#preview-panel.expanded') || !!document.querySelector('.front-alert:not([hidden])')`, 180000, 'the mission').catch(e => e);
  const alert = await js(`document.querySelector('.front-alert:not([hidden]) pre')?.textContent ?? ''`);
  check('the mission is prepared on it', !(prepared instanceof Error) && !alert, prepared instanceof Error ? prepared.message : alert || `${prepared} ms`);
  const saved = await js(`(() => { for (const k of Object.keys(localStorage)) { try { const v = JSON.parse(localStorage.getItem(k)); if (v?.seed) return v.seed; if (v?.project?.seed) return v.project.seed; } catch {} } return null; })()`);
  check('the project played is on that seed', saved === next, String(saved));
  await new Promise(r => setTimeout(r, 4000));
  s = await shot(`play-${next}`);
  console.log(`       play: ${s.file} (${s.colours} colours)`);
  }
  phase = 'world again';
  // ── 5. back to World ───────────────────────────────────────────────────────
  await js(`document.querySelector('#close-preview')?.click()`);
  await js(`document.querySelector('.front-nav [data-mode="world"]').click()`);
  await until(`document.body.dataset.mode === 'world' && !!window.__world.view() && document.querySelector('.world-facts')?.textContent.includes('eroded')`, 60000, 'World again');
  p = await panel();
  check('World again shows the same seed', p.seed === next && p.hash === other.manifest.heightHash, `${p.seed} ${p.hash}`);
  await js(`window.__world.view().still()`);
  if (WEBGL) { g = await gpu(); check('and draws it', g && g.colours > 40 && g.mean > 25, g ? (g.error ?? `${g.colours} colours, mean ${g.mean.toFixed(0)}`) : 'no view'); }
  else { await new Promise(r => setTimeout(r, 1500)); check('and runs its frame loop again', (await js(`!!window.__world.view()?.renderer`)) === true); }
  if (WEBGL) { await new Promise(r => setTimeout(r, 1500)); s = await shot(`world-${next}-again`); console.log(`       shot: ${s.file} (${s.colours} colours)`); }
  await new Promise(r => setTimeout(r, WEBGL ? 3000 : 20000));
  check('Play stays closed while World is shown', (await js(`document.body.dataset.mode === 'world' && !document.querySelector('#preview-panel.expanded')`)) === true);
  // ── 6. Play again, on a fresh session ──────────────────────────────────────
  if (WEBGL) {
    phase = 'play again';
    await js(`document.querySelector('[data-world-play]').click()`);
    const again = await until(`!!document.querySelector('#preview-panel.expanded') || !!document.querySelector('.front-alert:not([hidden])')`, 180000, 'the mission again').catch(e => e);
    const alert2 = await js(`document.querySelector('.front-alert:not([hidden]) pre')?.textContent ?? ''`);
    check('"Play here" again prepares the mission on a fresh session', !(again instanceof Error) && !alert2, again instanceof Error ? again.message : alert2 || `${again} ms`);
    await js(`document.querySelector('#close-preview')?.click()`);
  }
  // ── 7. switching faster than the renderer starts ───────────────────────────
  phase = 'quick switch';
  await js(`(() => { const nav = m => document.querySelector('.front-nav [data-mode="' + m + '"]').click(); nav('world'); nav('play'); nav('world'); })()`);
  await until(`document.body.dataset.mode === 'world' && !!window.__world.view()`, 60000, 'World after a quick switch');
  await new Promise(r => setTimeout(r, 1000));
  check('after a quick switch the view draws on the page\'s canvas', (await js(`window.__world.view().canvas.isConnected && window.__world.view().canvas === document.querySelector('.world-canvas')`)) === true);
  if (WEBGL) { g = await gpu(); check('and draws', g && g.colours > 40 && g.mean > 25, g ? (g.error ?? `${g.colours} colours, mean ${g.mean.toFixed(0)}`) : 'no view'); }
} catch (err) {
  check('the run finished', false, `${err.message}; page: ${JSON.stringify(await panel().catch(() => null))}`);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await send('Target.closeTarget', { targetId }).catch(() => {});
  browser.close(); server.close();
}
console.log(failures ? `World mode: ${failures} failed` : 'World mode: OK');
process.exit(failures ? 1 : 0);
