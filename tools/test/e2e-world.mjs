/**
 * ONE EDITOR, IN A BROWSER: the world is made in the editor (index.html, the page at /) and the game is set up and played there,
 * on that world, without leaving the page.
 *
 *   node tools/test/stand-in-assets.mjs     # once, where the R2 origin is unreachable (the game's art)
 *   node tools/test/e2e-world.mjs
 *
 * Through the page's own surfaces:
 *   1. the editor opens the world engine on the engine's renderer, on the default seed's own world;
 *   2. the command palette plants the woods (⌘K, "Plant woods", Enter), and a town is placed on the world's land
 *      through the editor's own site command (its pads sculpt the ground);
 *   3. the deck's Game button opens the Game panel; the mission is set to an arena shooter standing at the spawn
 *      marker, which is set with the Spawn tool on the town's ground;
 *   4. Play, from the World view, plays the mission ON the world, in the world engine (editor/world/play.js): no
 *      frame and no second renderer; the game's ground is the engine's own, the player starts at the spawn marker,
 *      the critters stand in the engine's scene on its ground, the body walks on it, the engine draws from the
 *      game's eye;
 *   5. Esc pauses it and says so; "Back to editing" takes the game out of the world and the editor is as it was; a
 *      first-person shooter then plays the same way, its weapon drawn over the world's frame, quicker the second time;
 *   6.-9. Mission, Level, 2D and My-3D-Engine; Play from Mission still plays the level as built, in the runtime.
 *
 * Shots go to docs/reports/world/ (PNGs stay local). Pixels are read on the WebGL2 backend (see
 * tools/test/check-wgsl.mjs for why WebGPU frames cannot be read here). Not in tools/test/run.mjs: it needs a browser.
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
  const w = await page(`http://127.0.0.1:${PORT}/?renderer=webgl&gfx=low&debug=1`);
  await w.until(`!!(window.engine && engine.terrain && engine.terrain.tiles.size > 0)`, 180000, 'the world engine');
  check('World opens the world engine on the engine\'s renderer', (await w.js('engine.backend')) === 'webgl2');
  const opened = await w.js(`(async () => (await import('/src/kernel/seed.js')).DEFAULT_SEED === engine.params.seed)()`);
  check('on the default seed\'s own world, nothing placed', opened && (await w.js('engine.props.items.size')) === 0 && (await w.js('engine.scatterCount()')) === 0);
  // ── 2. build on it: woods through the command palette, a town through the site command ──────────────────
  await w.key({ key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await w.until(`!document.querySelector('#cmdk').hidden`, 10000, 'the command palette');
  await w.insertText('Plant woods');
  await sleep(400);
  await w.key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await w.until(`engine.scatterCount() > 500`, 120000, 'the woods');
  const at = JSON.parse(await w.js(`JSON.stringify(${landPoint.toString()}(engine))`));
  await w.js(`studio.placeSite(${at.x}, ${at.z}, 'hamlet')`);
  await w.until(`engine.props.items.size > 20`, 300000, 'the hamlet');
  const built = JSON.parse(await w.js(`JSON.stringify({ props: engine.props.items.size, scatter: engine.scatterCount(), seed: engine.params.seed, sculpt: engine.sculptStrokes().length })`));
  check('the world is built on: woods, a hamlet, its pads sculpted', built.props > 20 && built.scatter > 500 && built.sculpt > 0,
    `${built.props} props, ${built.scatter} plants, ${built.sculpt} strokes at (${at.x}, ${at.z}), seed ${built.seed}`);
  await sleep(3000);
  const ws = await w.shot('world-built');
  check('and draws it', ws.colours > 60, `${ws.colours} colours; ${ws.file}`);
  // ── 3. the Game panel: an arena shooter at the spawn marker ──────────────────
  await w.click('#game-toggle');
  await w.until(`!document.querySelector('#game-panel').classList.contains('collapsed')`, 10000, 'the Game panel');
  const genres = await w.js(`[...document.querySelectorAll('#game-rows select')][0].options.length`);
  check('the Game panel opens from the deck, with the genres', genres === 5, `${genres} genres`);
  await w.js(`(() => { const s = document.querySelector('#game-rows select'); s.value = 'arena'; s.dispatchEvent(new Event('change')); })()`);
  await w.js(`[...document.querySelectorAll('#game-rows .game-site button')][1].click()`);
  check('"At the spawn" arms the Spawn tool when there is no marker yet', await w.js(`document.querySelector('#btn-spawn').classList.contains('armed')`));
  // The spawn tool is a click on the ground: aim at the town's centre through the engine's own projection.
  const px = JSON.parse(await w.js(`(() => { const v = new engine.camera.position.constructor(${at.x}, engine.sampleHeight(${at.x}, ${at.z}), ${at.z}).project(engine.camera); const r = engine.canvas.getBoundingClientRect(); return JSON.stringify({ x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }); })()`));
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: px.x, y: px.y, button: 'left', clickCount: 1 }, w.sessionId);
  await w.until(`/spawn marker \\(/.test(document.querySelector('#game-rows .opt-hint').textContent)`, 20000, 'the spawn marker');
  const settings = JSON.parse(await w.js(`JSON.stringify(studio.game.settings())`));
  check('the mission is set: an arena shooter, standing at the spawn marker', settings.genre === 'arena' && !!settings.site,
    `site (${settings.site?.x?.toFixed(0)}, ${settings.site?.z?.toFixed(0)})`);
  // ── 4. Play, on the world: the world engine plays it ─────────────────────────
  const P = 'studio.game.worldPlay';
  const card = () => w.js(`document.querySelector('#world-play .wp-title').textContent`);
  const readyCard = `!document.querySelector('#world-play').hidden && !document.querySelector('#world-play .wp-card').hidden && !document.querySelector('#world-play .wp-go').hidden`;
  const props0 = await w.js('engine.props.items.size');
  let playT0 = Date.now();
  await w.js('document.querySelector("#game-rows .game-play").click()');
  await w.until(`${readyCard} || /cannot be played/.test(document.querySelector('#world-play .wp-title')?.textContent ?? '')`, 300000, 'the mission on the world');
  const firstReady = Date.now() - playT0;
  const why = await card(), framed = await w.js(`!!document.querySelector('#game-layer, .view-layer:not([hidden])')`);
  check('Play brings the mission onto this world, in the world engine: no frame, no second renderer',
    !/cannot/.test(why) && !framed && (await w.js('engine.mode')) === 'play' && !(await w.js('engine.paused')), `${why}; ready in ${firstReady} ms`);
  const level = JSON.parse(await w.js(`JSON.stringify((() => { const s = ${P}.session, L = s.level, o = L.playArea.origin;
    const pts = [[0, 0], [12, -20], [-30, 25], [40, 40]].map(([x, z]) => [L.terrain.heightAt(x, z), engine.sampleHeight(o.x + x, o.z + z)]);
    return { origin: o, size: L.playArea.size, spawn: L.spawn.position, pts, village: L.placements.filter(p => p.village).length,
      group: !!engine.scene.getObjectByName('WorldPlay')?.getObjectByName('HostedGame'), critters: s.game.enemies.enemies.length,
      onGround: s.game.enemies.enemies.every(e => Math.abs(e.position.y - L.terrain.heightAt(e.position.x, e.position.z)) < 0.05) }; })())`));
  check('the ground the game stands on is the world engine\'s own', level.pts.every(([a, b]) => Math.abs(a - b) < 0.1) && level.village === 0,
    level.pts.map(([a, b]) => `${a.toFixed(2)}/${b.toFixed(2)}`).join(' '));
  const startAt = { x: level.spawn.x + level.origin.x, z: level.spawn.z + level.origin.z };
  check('the player starts at the spawn marker, on the town', Math.hypot(startAt.x - settings.site.x, startAt.z - settings.site.z) < 3,
    `(${startAt.x.toFixed(1)}, ${startAt.z.toFixed(1)}) for (${settings.site.x.toFixed(1)}, ${settings.site.z.toFixed(1)})`);
  check('the mission\'s critters are in the world engine\'s scene, on its ground', level.group && level.critters > 0 && level.onGround, `${level.critters} critters`);
  await w.js(`document.querySelector('#world-play .wp-go').click()`);
  await w.until(`${P}.session.playing && document.querySelector('#world-play .wp-card').hidden`, 10000, 'the game to start');
  // Frames on a software rasteriser come seconds apart, so the game is stepped by its own fixed step, as a replay is.
  const moved = JSON.parse(await w.js(`(() => { const g = ${P}.session.game, a = g.player.position.clone();
    for (let i = 0; i < 120; i++) g.step({ move: { x: 0, y: 1 } });
    return JSON.stringify({ d: Math.hypot(g.player.position.x - a.x, g.player.position.z - a.z), dy: Math.abs(g.player.position.y - g.level.terrain.heightAt(g.player.position.x, g.player.position.z)) }); })()`));
  check('played: the body walks on the world\'s ground', moved.d > 1 && moved.dy < 0.05, `${moved.d.toFixed(1)} m, ${moved.dy.toFixed(3)} m off the ground`);
  await sleep(5000);
  const eye = JSON.parse(await w.js(`JSON.stringify((() => { const s = ${P}.session, v = new engine.camera.position.constructor(); v.copy(s.camera.position).add(engine.scene.getObjectByName('WorldPlay').position); return { d: v.distanceTo(engine.camera.position) }; })())`));
  check('the world engine draws from the game\'s eye', eye.d < 0.05, `${eye.d.toFixed(3)} m apart`);
  const ps = await w.shot('play-on-the-world');
  check('and draws the game on the world', ps.colours > 40, `${ps.colours} colours; ${ps.file}`);
  // ── 5. pause, and back to editing ────────────────────────────────────────────
  await w.key({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await w.until(`/waits/.test(document.querySelector('#world-play .wp-title').textContent)`, 20000, 'the paused card');
  check('Esc pauses the mission, and says so', (await w.js(`${P}.session.game.state.current`)) === 'PAUSED');
  await w.js(`document.querySelector('#world-play .wp-back').click()`);
  await w.until(`!${P}.playing() && document.querySelector('#world-play').hidden`, 10000, 'the editing view');
  const after = JSON.parse(await w.js(`JSON.stringify({ mode: engine.mode, view: studio.game.view(), game: !!engine.scene.getObjectByName('WorldPlay'), props: engine.props.items.size, chrome: getComputedStyle(document.querySelector('#readout')).visibility })`));
  check('"Back to editing" takes the game out of the world and the editor is as it was', after.mode === 'orbit' && after.view === 'world' && !after.game
    && after.props === props0 && after.chrome === 'visible', JSON.stringify(after));
  // ── 5b. a first-person shooter on the world: the hands and weapon drawn over the world's frame ──────────
  await w.js(`(() => { const s = document.querySelector('#game-rows select'); s.value = 'shooter'; s.dispatchEvent(new Event('change')); })()`);
  playT0 = Date.now();
  await w.click('#play-here');
  await w.until(readyCard, 300000, 'the shooter on the world');
  const againReady = Date.now() - playT0;
  check('Play again is quicker (what loading cost is kept)', againReady < firstReady, `${againReady} ms against ${firstReady} ms`);
  await w.js(`document.querySelector('#world-play .wp-go').click()`);
  await sleep(4000);
  const fp = JSON.parse(await w.js(`JSON.stringify({ overlay: typeof engine.overlayPass === 'function', view: ${P}.session.rules.view(${P}.session), weapon: document.querySelector('#world-play .wp-wname').textContent, cross: !document.querySelector('#world-play .wp-cross').hidden })`));
  check('first person: the weapon is drawn over the world, the HUD names it', fp.overlay && fp.view === 'first' && fp.weapon.length > 0 && fp.cross, JSON.stringify(fp));
  const fs1 = await w.shot('shooter-on-the-world');
  console.log(`       shooter: ${fs1.file} (${fs1.colours} colours)`);
  check('in live play the editor\'s chrome is gone, the top bar too', await w.js(`getComputedStyle(document.querySelector('#readout')).visibility === 'hidden'`));
  await w.key({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await w.until(`/waits/.test(document.querySelector('#world-play .wp-title').textContent)`, 20000, 'the paused card');
  check('paused, the top bar is back: the views are one click away', await w.js(`getComputedStyle(document.querySelector('#readout')).visibility === 'visible'`));
  await w.click('#modes [data-view="world"]');
  await w.until(`!${P}.playing()`, 10000, 'the editing view');
  await w.js(`(() => { const s = document.querySelector('#game-rows select'); s.value = 'arena'; s.dispatchEvent(new Event('change')); })()`);
  check('the World button in the top bar leaves play too', (await w.js('engine.mode')) === 'orbit' && (await w.js('studio.game.settings().genre')) === 'arena');
  // ── 6. Mission: the graph, in the editor, on the editor's mission ──────────────
  const V = (name) => `document.querySelector("#view-${name} iframe").contentWindow`;
  const shown = (name) => `!!document.querySelector('#view-${name}') && !document.querySelector('#view-${name}').hidden`;
  await w.click('#modes [data-view="remix"]');
  const WS = V('remix');
  await w.until(`${shown('remix')} && ${WS}.document.body.dataset.mode === 'remix' && !!${WS}.__studio`, 120000, 'the Mission view');
  const ws1 = JSON.parse(await w.js(`JSON.stringify({ genre: ${WS}.__studio.project.genre, seed: ${WS}.__studio.project.seed, site: ${WS}.__studio.project.worldSite, on: document.querySelector('#modes .on')?.dataset.view, paused: engine.paused, bar: getComputedStyle(document.querySelector('#readout')).visibility })`));
  check('Mission opens the mission graph in the page, under the editor\'s top bar, on the editor\'s mission',
    ws1.genre === 'arena' && ws1.seed === built.seed && ws1.on === 'remix' && ws1.paused && ws1.bar === 'visible', JSON.stringify(ws1));
  await w.js(`${WS}.__studio.change({ name: 'Harbour defence' })`);
  await w.until(`studio.game.mission()?.name === 'Harbour defence'`, 10000, 'the edit to reach the editor');
  check('an edit in the graph is the editor\'s mission', true);
  await w.js(`${WS}.document.querySelector('#compile-top').click()`);
  // Play from a workspace plays the level as it was built, in the game runtime over the viewport.
  const G = 'document.querySelector("#game-layer iframe").contentWindow';
  await w.until(`!!document.querySelector('#game-layer iframe') && !!${G}.__studio?.completedBuild`, 300000, 'the edited mission');
  check('Generate & play in the graph plays the edited mission in the editor', (await w.js(`${G}.__studio.project.name`)) === 'Harbour defence');
  const expected = await w.js(`(async () => {
    const { worldParamsFor } = await import('/src/world/kernelGround.js');
    const { terrainParameterHash, hex } = await import('/src/kernel/terrain/fingerprint.js');
    return hex(terrainParameterHash(worldParamsFor(engine.params.seed, { terrain: engine.params.terrain, water: engine.params.water })));
  })()`);
  const ground = JSON.parse(await w.js(`JSON.stringify(${G}.__studio?.session?.level?.ground ?? null)`) || 'null');
  check('that level stands on the world the editor holds, at the spawn marker', ground?.kind === 'world' && ground.world.parameterHash === expected
    && Math.abs(ground.site.x - settings.site.x) < 0.2 && Math.abs(ground.site.z - settings.site.z) < 0.2,
    ground ? `${ground.kind}: ${ground.world?.parameterHash} vs ${expected}; site (${ground.site?.x}, ${ground.site?.z})` : 'no level');
  // The game's art comes from the asset origin, as everywhere on the site, not from beside the page: a downloaded ZIP
  // keeps its art next to it, the editor's game does not. (This server would answer /assets/ with stand-ins, so the
  // address is checked, not the load.)
  const artAt = JSON.parse(await w.js(`(async () => { const d = await ${G}.eval("import('/src/config/assetDelivery.js')"); return JSON.stringify({ url: d.assetURL('assets/studio/visigames-mark.svg'), origin: d.ASSET_ORIGIN, packaged: d.isPackagedGame() }); })()`));
  check('the game loads its art from the art server, not from the site', artAt.url.startsWith(artAt.origin + '/') && !artAt.packaged, artAt.url);
  check('and nothing the game does is stored', await w.js(`${G}.localStorage !== localStorage && localStorage.length === 0`));
  const exit = await w.js(`${G}.document.querySelector('#overlay-exit').textContent`);
  check('the game\'s way out says where it goes', exit === 'Back to the world', exit);
  await w.js(`${G}.document.querySelector('#overlay-exit').click()`);
  await w.until(`${shown('remix')} && !document.querySelector('#game-layer')`, 60000, 'the graph again');
  check('leaving that game returns to the graph, as it was (the view kept)', (await w.js(`${WS}.__studio.project.name`)) === 'Harbour defence');
  // ── 7. Level: the level editor, in the editor ─────────────────────────────────
  await w.click('#modes [data-view="build"]');
  const LV = V('build');
  await w.until(`${shown('build')} && ${LV}.document.body.dataset.mode === 'build' && !!${LV}.__studio?.build?.store`, 180000, 'the Level view');
  const lvl = JSON.parse(await w.js(`JSON.stringify({ name: ${LV}.__studio.build.store.game.name, levels: ${LV}.__studio.build.store.game.levels.length, seed: ${LV}.__studio.build.store.game.levels[0].seed })`));
  check('Level opens the level editor in the page on the same mission', lvl.name === 'Harbour defence' && lvl.seed === built.seed, JSON.stringify(lvl));
  await sleep(3000);
  const ls = await w.shot('level-in-the-editor');
  console.log(`       level: ${ls.file} (${ls.colours} colours)`);
  // ── 8. 2D: games on a grid, this world among them ─────────────────────────────
  await w.click('#modes [data-view="2d"]');
  const D2 = V('2d');
  await w.until(`${shown('2d')} && !!${D2}.document.querySelector('[data-g="world"]')`, 60000, 'the 2D view');
  check('2D opens its start screen with this world offered', (await w.js(`${D2}.document.querySelector('.g-world .meta')?.textContent ?? ''`)).includes(built.seed));
  check('and the editor\'s Play steps aside there (2D plays its own games)', await w.js(`getComputedStyle(document.querySelector('#play-here')).display === 'none'`));
  await w.js(`${D2}.document.querySelector('[data-g="world"]').click()`);
  await w.until(`${D2}.document.getElementById('app').dataset.view === 'editor'`, 30000, 'the world in 2D');
  const two = JSON.parse(await w.js(`JSON.stringify({ genre: ${D2}.__builder.store.project.genre, title: ${D2}.__builder.store.project.title, w: ${D2}.__builder.store.level.width, h: ${D2}.__builder.store.level.height, ready: !${D2}.__builder.analysis()?.issues?.some?.(i => i.severity === 'error') })`));
  check('"Your world, in 2D" opens this world as a 2D adventure', two.genre === 'adventure' && two.title.includes(built.seed) && two.w === 48 && two.h === 32, JSON.stringify(two));
  await sleep(1500);
  const ts = await w.shot('2d-in-the-editor');
  check('and draws it', ts.colours > 30, `${ts.colours} colours; ${ts.file}`);
  // ── 9. My-3D-Engine: a figure from a photograph, into the mission ───────────
  await w.click('#modes [data-view="my3d"]');
  const ME = V('my3d');
  await w.until(`${shown('my3d')} && !!${ME}.document.querySelector('#fileFront')`, 60000, 'the My-3D-Engine view');
  check('My-3D-Engine opens in the page, the other views kept and paused', await w.js(`document.querySelector('#view-2d').hidden && document.querySelector('#view-build').hidden && document.querySelector('#view-remix').hidden`));
  await w.js(`(async () => {
    const blob = await (await fetch('data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'tools/test/fixtures/photo-front.png')).toString('base64')}')).blob();
    const win = ${ME}, input = win.document.querySelector('#fileFront');
    const dt = new win.DataTransfer(); dt.items.add(new win.File([blob], 'photo-front.png', { type: 'image/png' }));
    input.files = dt.files; input.dispatchEvent(new win.Event('change'));
  })()`);
  await w.until(`!${ME}.document.querySelector('#runBtn').disabled`, 60000, 'the photograph to be taken');
  const t0 = Date.now();
  await w.js(`${ME}.document.querySelector('#runBtn').click()`);
  await w.until(`!${ME}.document.querySelector('#exportCard').hidden`, 600000, 'the reconstruction');
  check('a photograph becomes a figure in My-3D-Engine', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(3000);
  const ms = await w.shot('my-3d-engine-in-the-editor');
  check('and My-3D-Engine draws it with the engine\'s renderer', ms.colours > 30, `${ms.colours} colours; ${ms.file}`);
  await w.js(`${ME}.document.querySelector('#missionBtn').click()`);
  await w.until(`${shown('remix')} && /Your figure from My-3D-Engine/.test(${WS}.document.querySelector('dialog.prop-dialog .prop-metrics')?.textContent ?? '')`, 300000, 'the figure in the Mission view');
  check('"Use in the mission" opens Mission with its prop importer on the figure', true);
  await w.js(`${WS}.document.querySelector('dialog.prop-dialog')?.close()`);
  // ── 10. back, to views kept as they were ─────────────────────────────────────
  const t1 = Date.now();
  await w.click('#modes [data-view="2d"]');
  await w.until(`${shown('2d')} && ${D2}.document.getElementById('app').dataset.view === 'editor'`, 5000, '2D again');
  check('2D comes back as it was, at once', (await w.js(`${D2}.__builder.store.project.title`)) === two.title, `${Date.now() - t1} ms`);
  await w.click('#modes [data-view="world"]');
  await w.until(`!document.querySelector('.view-layer:not([hidden])') && !engine.paused`, 10000, 'the world');
  check('World steps every view aside and the world runs again, the mission kept', (await w.js(`studio.game.mission()?.name`)) === 'Harbour defence');
} catch (err) {
  check('the run finished', false, err.message);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  browser.close(); server.close();
}
console.log(failures ? `World → Play: ${failures} failed` : 'World → Play: OK');
process.exit(failures ? 1 : 0);
