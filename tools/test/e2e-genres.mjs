/**
 * THE BROWSER SMOKE TEST: the real launcher, one mission per genre, driven end to end.
 *
 *   node tools/test/stand-in-assets.mjs        # once: stand-in art where the R2 origin is unreachable
 *   node tools/test/e2e-genres.mjs             # both genres
 *   node tools/test/e2e-genres.mjs --only exploration
 *   node tools/test/e2e-genres.mjs --real      # no stand-ins: the local art cache must exist
 *
 * Headless Chromium over the DevTools protocol (tools/lib/_headless.mjs), the studio page at
 * index.html with `?debug=1`, which exposes `window.__studio` (editor/studio.js). Every step
 * goes through the page's own surface: the launcher's genre picker and world tiles, the
 * play overlay's button, the session's key set and pointer, real mouse events on the canvas
 * for clicks. The session's game state is READ through the handle to assert on;
 * it is written only where the check needs a player teleport between distant checks.
 *
 * SwiftShader stands in for the GPU and boxes stand in for the art, so this proves the code
 * paths, the input plumbing, the HUD and the absence of errors; it does not prove the pixels.
 * Screenshots land in assets/review/shots/e2e/.
 *
 * TIME IS SIMULATION TICKS, NOT SECONDS. Under SwiftShader a frame of the full post stack
 * takes a second or more, and the game advances at most 0.05 s of simulation per frame, so
 * every wait here is on `game.tick`. The shooter runs the launcher's own quality (the full
 * post stack, temporal AA included, which is where the Safari failure lived); the
 * exploration mission, which walks the level, runs with `?fx=off`, the engine's own switch that removes the
 * post effects and set dressing, so a thirty-metre walk takes a minute rather than ten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { STAND_IN_ROOT, generateStandIns } from './stand-in-assets.mjs';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const real = argv.includes('--real');
const PORT = 8147, WIDTH = 800, HEIGHT = 450;
const outDir = path.join(ROOT, 'assets/review/shots/e2e');
fs.mkdirSync(outDir, { recursive: true });
if (!real) generateStandIns();

const server = await serveRepo(PORT, { fallbackRoot: real ? null : STAND_IN_ROOT });
const browser = await launchBrowser({ width: WIDTH, height: HEIGHT });
const { send, on } = browser;
const IGNORE = [/WebGPU is not available/, /Failed to load resource/, /THREE\.WebGPURenderer: WebGPU/];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
};

/** One page per genre; console errors collected for the page's lifetime. */
async function openStudio(query) {
  // The size comes from the metrics override below: newer Chromium refuses a size for a tab in an existing window.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const keep = t => t && !IGNORE.some(re => re.test(t));
  on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) { const t = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text; if (keep(t)) errors.push(t); } });
  on('Runtime.consoleAPICalled', (p, sid) => { if (sid === sessionId && p.type === 'error') { const t = p.args.map(a => a.value ?? a.description).join(' '); if (keep(t)) errors.push(t); } });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?mode=play&${query}` }, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64')); };
  const mouse = async (type, x, y, button = 'left', clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : (button === 'right' ? 2 : 1) }, sessionId);
  const close = () => send('Target.closeTarget', { targetId });
  return { evaluate, shot, mouse, close, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll a page expression until truthy, or fail with the last value. */
async function until(page, expression, { timeoutMs = 240000, every = 500, label = expression } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(expression);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
}

/** Helpers installed into the page: walking to a point through the session's own input. */
const HELPERS = `
window.__h = {
  s() { return window.__studio.session; },
  g() { return window.__studio.session.game; },
  hud() { return JSON.parse(JSON.stringify(this.g().hudState)); },
  pos() { const p = this.g().player.position; return { x: p.x, y: p.y, z: p.z }; },
  wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); },
  /** Turn to face a point by handing the session look deltas. */
  face(x, z) { const p = this.g().player; const yaw = Math.atan2(-(x - p.position.x), -(z - p.position.z)); this.s().look.x = this.wrap(yaw - p.yaw); },
  /** Resolve after n simulation ticks (or when the game stops playing). */
  ticks(n, wallMs = 120000) {
    const g = this.g(); const t0 = g.tick, w0 = performance.now();
    return new Promise((resolve) => { const step = () => { if (g.tick - t0 >= n || !g.state.isPlaying || performance.now() - w0 > wallMs) resolve(g.tick - t0); else requestAnimationFrame(step); }; step(); });
  },
  /** Walk to a point along the navigation grid through KeyW. */
  walkTo(x, z, maxTicks = 3600, arrive = 1.2) {
    const s = this.s(), g = this.g();
    return new Promise((resolve) => {
      const t0 = g.tick, w0 = performance.now();
      const step = () => {
        const p = g.player.position, d = Math.hypot(x - p.x, z - p.z);
        if (d <= arrive || g.tick - t0 > maxTicks || performance.now() - w0 > 600000 || !g.state.isPlaying) { s.keys.delete('KeyW'); s.touchMove = { x: 0, y: 0 }; resolve(d <= arrive); return; }
        const path = g.collision.findPath(p.x, p.z, x, z, 0.36 / g.collision.cell, { bestEffort: true }) ?? [];
        const wp = path.find(w => Math.hypot(w.x - p.x, w.z - p.z) > 0.6) ?? { x, z };
        const yaw = Math.atan2(-(wp.x - p.x), -(wp.z - p.z)); s.look.x = this.wrap(yaw - g.player.yaw); s.keys.add('KeyW');
        requestAnimationFrame(step);
      };
      step();
    });
  },
  /** Hold a key until a predicate holds, for at most maxTicks of simulation. */
  hold(code, predicate, maxTicks = 600) {
    const s = this.s(), g = this.g();
    return new Promise((resolve) => {
      const t0 = g.tick, w0 = performance.now();
      const step = () => { let ok = false; try { ok = predicate(); } catch {} if (ok || g.tick - t0 > maxTicks || performance.now() - w0 > 300000 || !g.state.isPlaying) { s.keys.delete(code); resolve(ok); return; } s.keys.add(code); requestAnimationFrame(step); };
      step();
    });
  },
  canvasCentre() { const r = this.s().canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
};
true`;

/** Open the launcher, pick a genre and a world, build, and start the mission. */
async function launch(page, genre, theme) {
  await until(page, `!!window.__studio && !!document.querySelector('#mission-genre') && !!document.querySelector('[data-play-world]')`, { label: 'launcher' });
  await page.evaluate(HELPERS);
  await page.evaluate(`document.querySelector('[data-genre=${JSON.stringify(genre)}]').click(); true`);
  await until(page, `document.querySelector('[data-genre=${JSON.stringify(genre)}]').getAttribute('aria-checked') === 'true'`, { timeoutMs: 5000, label: `${genre} genre` });
  check('the launcher shows the genre', (await page.evaluate(`document.querySelector('#launcher-genre-line').textContent`)).length > 0, await page.evaluate(`document.querySelector('#launcher-genre-line').textContent`));
  // The deck selects the world; the featured card then plays it.
  await page.evaluate(`document.querySelector('[data-select-world=${JSON.stringify(theme)}]')?.click(); true`);
  await until(page, `document.querySelector('[data-play-world]')?.dataset.playWorld === ${JSON.stringify(theme)}`, { timeoutMs: 10000, label: `${theme} selected` });
  await page.evaluate(`document.querySelector('[data-play-world]').click(); true`);
  await until(page, `(() => { const st = document.querySelector('#load-status')?.textContent ?? ''; if (/Could not build|OVER BUDGET|MISSING/.test(document.querySelector('#preview-loading strong')?.textContent + st)) return 'FAILED:' + st; return !!window.__studio.session?.game && document.body.classList.contains('mission-playing'); })()`, { label: `${genre} build` }).then(v => { if (String(v).startsWith('FAILED')) throw new Error(v); });
  await page.evaluate(`document.querySelector('#start-mission').click(); true`);
  await until(page, `window.__h.s().playing && window.__h.g().state.isPlaying`, { timeoutMs: 20000, label: 'playing' });
  await page.evaluate(`window.__h.ticks(6)`);
}

async function commonChecks(page, genre) {
  const view = await page.evaluate(`window.__h.s().rules.view(window.__h.s())`);
  check('project genre reached the session', (await page.evaluate(`window.__h.s().genre.id`)) === genre);
  check('HUD mission label is set', (await page.evaluate(`document.querySelector('#mission-label').textContent`)).length > 0);
  check('HUD is visible', (await page.evaluate(`!document.querySelector('#game-hud').hidden`)));
  return view;
}

async function restartCheck(page) {
  await page.evaluate(`window.__h.g().player.damage(100000); true`);
  await until(page, `window.__h.g().state.current === 'PLAYER_DEAD' && !document.querySelector('#play-overlay').hidden`, { timeoutMs: 8000, label: 'death overlay' });
  check('death shows the overlay', (await page.evaluate(`document.querySelector('#play-eyebrow').textContent`)) === 'MISSION FAILED');
  await page.evaluate(`document.querySelector('#start-mission').click(); true`);
  await until(page, `window.__h.g().state.isPlaying && window.__h.g().tick < 30`, { timeoutMs: 20000, label: 'restart' });
  check('restart returns to play at tick zero with full health', (await page.evaluate(`window.__h.g().player.health`)) > 90);
}

const GENRES = {
  shooter: { theme: 'arcade', query: '', run: async (page) => {
    const view = await commonChecks(page, 'shooter');
    check('first-person view', view === 'first');
    const eye = await page.evaluate(`(() => { const s = window.__h.s(), p = s.game.player; return s.camera.position.y - p.position.y; })()`);
    check('camera at eye height', eye > 1.4 && eye < 2.0, eye.toFixed(2));
    check('weapon HUD shows ammo', /\d+\s*\/\s*\d+/.test(await page.evaluate(`document.querySelector('#ammo-value').textContent`)));
    const before = await page.evaluate(`window.__h.hud().weapon.mag`);
    const c = await page.evaluate(`window.__h.canvasCentre()`);
    await page.mouse('mousePressed', c.x, c.y); await page.evaluate(`window.__h.ticks(12)`); await page.mouse('mouseReleased', c.x, c.y);
    check('left click fires the weapon', (await page.evaluate(`window.__h.hud().weapon.mag`)) < before, `${before} -> ${await page.evaluate(`window.__h.hud().weapon.mag`)}`);
    await page.evaluate(`window.__h.s().actions.reload = true; window.__h.ticks(3)`);
    check('R reloads', (await page.evaluate(`window.__h.hud().weapon.state`)) === 'RELOADING', await page.evaluate(`window.__h.hud().weapon.state`));
    const yaw0 = await page.evaluate(`window.__h.g().player.yaw`);
    await page.evaluate(`window.__h.s().look = { x: 0.4, y: 0 }; window.__h.ticks(3)`);
    check('look input turns the player', Math.abs((await page.evaluate(`window.__h.g().player.yaw`)) - yaw0) > 0.2);
    const p0 = await page.evaluate(`window.__h.pos()`);
    await page.evaluate(`window.__h.hold('KeyW', () => false, 45)`);
    const p1 = await page.evaluate(`window.__h.pos()`);
    check('W moves the player', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1, Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2));
    await page.shot('shooter');
    await restartCheck(page);
  } },
  exploration: { theme: 'arcade', query: '&fx=off', run: async (page) => {
    const view = await commonChecks(page, 'exploration');
    check('first-person view', view === 'first');
    check('no weapon stack', await page.evaluate(`window.__h.g().weapons === null && window.__h.s().viewmodel === null`));
    check('HUD shows hands free', (await page.evaluate(`document.querySelector('#weapon-name').textContent`)) === 'HANDS FREE');
    const station = await page.evaluate(`(() => { const p = window.__h.g().level.placements.find(p => p.interaction === 'activate'); return { x: p.x, z: p.z, h: p.height }; })()`);
    check('walked to the station', await page.evaluate(`window.__h.walkTo(${station.x}, ${station.z}, 3600, 1.6)`));
    await page.evaluate(`window.__h.face(${station.x}, ${station.z}); window.__h.s().look.y = 0.3; window.__h.ticks(3)`);
    const activated = await page.evaluate(`window.__h.hold('KeyE', () => window.__h.hud().objectives.completed >= 1, 400)`);
    check('E held at the station activates it', activated, await page.evaluate(`document.querySelector('#interaction-prompt').textContent`));
    const checkpoint = await page.evaluate(`(() => { const p = window.__h.g().level.placements.find(p => p.stepId === 'checkpoint'); return { x: p.x, z: p.z }; })()`);
    check('walked to the checkpoint', await page.evaluate(`window.__h.walkTo(${checkpoint.x}, ${checkpoint.z}, 3600, 1.5)`));
    await page.evaluate(`window.__h.ticks(10)`);
    check('checkpoint step completed', (await page.evaluate(`window.__h.hud().objectives.completed`)) >= 2);
    const spawn = await page.evaluate(`(() => { const s = window.__h.g().level.spawn.position; return { x: s.x, z: s.z }; })()`);
    check('walked back to extraction', await page.evaluate(`window.__h.walkTo(${spawn.x}, ${spawn.z}, 4800, 1.5)`));
    await page.evaluate(`window.__h.ticks(150)`);
    check('victory by hands alone', (await page.evaluate(`window.__h.g().state.current`)) === 'VICTORY');
    await until(page, `!document.querySelector('#play-overlay').hidden`, { timeoutMs: 5000, label: 'overlay' }).catch(() => {});
    check('overlay says mission complete', (await page.evaluate(`document.querySelector('#play-eyebrow').textContent`)) === 'MISSION COMPLETE');
    await page.shot('exploration');
    await page.evaluate(`document.querySelector('#start-mission').click(); true`);
    await until(page, `window.__h.g().state.isPlaying && window.__h.g().tick < 30`, { timeoutMs: 20000, label: 'play again' });
    check('play again restarts the mission', (await page.evaluate(`window.__h.hud().objectives.completed`)) === 0);
  } },
};

/** After the shooter run: switch genre on the same page and play again. */
async function switchGenre(page) {
  console.log('genre switch (shooter -> exploration, same page)');
  await page.evaluate(`document.querySelector('#result-home')?.click?.(); window.__studio.closePlay(); true`);
  await sleep(300);
  await page.evaluate(`document.querySelector('[data-genre="exploration"]').click(); true`);
  await until(page, `document.querySelector('[data-genre="exploration"]').getAttribute('aria-checked') === 'true'`, { timeoutMs: 5000, label: 'exploration genre' });
  await page.evaluate(`document.querySelector('[data-select-world="arcade"]')?.click(); true`);
  await until(page, `document.querySelector('[data-play-world]')?.dataset.playWorld === 'arcade'`, { timeoutMs: 10000, label: 'arcade selected' });
  await page.evaluate(`document.querySelector('[data-play-world]').click(); true`);
  await until(page, `window.__studio.session?.game && window.__studio.session.genre.id === 'exploration' && document.body.classList.contains('mission-playing')`, { label: 'switched build' });
  await page.evaluate(`document.querySelector('#start-mission').click(); true`);
  await until(page, `window.__h.g().state.isPlaying`, { timeoutMs: 20000, label: 'switched playing' });
  check('the switched session has no weapons and plays first person', await page.evaluate(`window.__h.g().weapons === null && window.__h.s().rules.view(window.__h.s()) === 'first'`));
  check('the previous session was disposed', await page.evaluate(`window.__h.g().extraSystems.length === 0`));
}

const report = [];
for (const [genre, def] of Object.entries(GENRES)) {
  if (only && genre !== only) continue;
  console.log(genre);
  const page = await openStudio('debug=1&assets=local&performanceAssets=off' + def.query);
  const t0 = Date.now();
  try {
    await launch(page, genre, def.theme);
    await def.run(page);
    if (genre === 'shooter' && !only) await switchGenre(page);
  } catch (e) {
    check(`${genre} run completed`, false, String(e.message).slice(0, 300));
    try { await page.shot(`${genre}-failed`); } catch {}
  }
  check('no console errors', page.errors.length === 0, page.errors.slice(0, 3).map(e => e.split('\n')[0].slice(0, 160)).join(' | '));
  report.push({ genre, seconds: +((Date.now() - t0) / 1000).toFixed(1), errors: page.errors });
  await page.close();
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
browser.close(); server.close();
console.log(failures ? `\nFAILED: ${failures}` : '\nEvery genre plays from the launcher without errors.');
process.exit(failures ? 1 : 0);
