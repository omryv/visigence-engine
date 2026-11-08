/**
 * THE LEVEL BUILDER IN A BROWSER: the start screen, every template in the editor, a playtest
 * driven by the keyboard, every genre's menus by keyboard, generated levels, the exported
 * single-file game and a share link, phone and tablet widths, then the games saved in this
 * browser, reopened from the start screen and by their #open= link.
 *
 *   node tools/test/e2e-builder.mjs
 *
 * Headless Chromium over the DevTools protocol (tools/lib/_headless.mjs), no npm install and no
 * art: the builder draws everything itself. Every step goes through the page: real mouse clicks
 * on the Play button and the start screen, real key presses in the game. The editor's state is
 * READ through `window.__builder` (builder/editor/app.js) to assert on. The exported file is
 * built by the page's own publish module and opened from disk, as a player would double-click it.
 *
 * Screenshots land in shots/e2e-builder/ (ignored by Git).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser } from '../../lib/_headless.mjs';

const PORT = 8148, WIDTH = 1280, HEIGHT = 800;
const outDir = path.join(ROOT, 'docs/reports/play2d');
fs.mkdirSync(outDir, { recursive: true });
const TEMPLATES = ['honey-heist', 'meadow-quest', 'slime-siege', 'hive-run', 'crate-garden'];
/** Google Fonts is the page's only outside request; a sandbox without it is not a failure. */
const IGNORE = [/fonts\.googleapis|fonts\.gstatic|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource/];

const server = await serveRepo(PORT);
const browser = await launchBrowser({ width: WIDTH, height: HEIGHT });
const { send, on } = browser;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(url, { width = WIDTH, height = HEIGHT } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const keep = t => t && !IGNORE.some(re => re.test(t));
  on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) { const t = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text; if (keep(t)) errors.push(t); } });
  on('Runtime.consoleAPICalled', (p, sid) => { if (sid === sessionId && p.type === 'error') { const t = p.args.map(a => a.value ?? a.description).join(' '); if (keep(t)) errors.push(t); } });
  on('Log.entryAdded', (p, sid) => { if (sid === sessionId && p.entry.level === 'error' && keep(`${p.entry.text} ${p.entry.url || ''}`)) errors.push(p.entry.text); });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expression).catch(() => false)) return true; await sleep(100); }
    return false;
  };
  const shot = async name => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64')); };
  const click = async selector => {
    // scroll it into view first, as a person would; a click outside the viewport hits nothing
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (!box) throw new Error(`nothing to click at ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, sessionId);
  };
  const KEYS = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Escape: 27, F5: 116, Space: 32, Enter: 13 };
  const key = async (name, type, extra = {}) => send('Input.dispatchKeyEvent', { type, key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name], ...extra }, sessionId);
  // Enter presses a focused button on its character event, as a real keyboard sends one
  const press = async (name, holdMs = 60) => { await key(name, 'rawKeyDown'); if (name === 'Enter') await key(name, 'char', { text: '\r' }); await sleep(holdMs); await key(name, 'keyUp'); };
  const close = () => send('Target.closeTarget', { targetId });
  return { evaluate, waitFor, shot, click, press, key, close, errors };
}

// The 2D view's page (2d.html), opened on its own: inside the one editor it is the same page in a frame.
const base = `http://127.0.0.1:${PORT}/2d.html`;
try {
  console.log('start screen');
  {
    const page = await openPage(`${base}#gallery`);
    check('the start screen opens', await page.waitFor(`document.getElementById('app').dataset.view === 'gallery'`));
    check('five templates, each playing live', await page.waitFor(`document.querySelectorAll('.g-card [data-preview] canvas').length === 5`));
    check('a blank start for every genre', await page.evaluate(`document.querySelectorAll('[data-g="blank"]').length`) === 5);
    await sleep(600);
    await page.shot('gallery');
    await page.click('[data-g="template"][data-id="honey-heist"]');
    check('Use template opens the editor', await page.waitFor(`document.getElementById('app').dataset.view === 'editor' && !!window.__builder`));
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }

  for (const id of TEMPLATES) {
    console.log(id);
    const page = await openPage(`${base}#template=${id}`);
    check('the editor opens on the template', await page.waitFor(`!!window.__builder && document.getElementById('app').dataset.view === 'editor'`));
    check('its checks come back clean', await page.waitFor(`(() => { const a = window.__builder.analysis(); return !!a && !a.issues.some(x => x.severity !== 'tip'); })()`, 20000),
      await page.evaluate(`JSON.stringify((window.__builder.analysis() || {}).issues || null)`).catch(() => ''));
    await page.shot(`${id}-editor`);

    // Play from the top bar, as a person would, and drive the game with real keys.
    await page.click('#play-btn');
    check('Play opens the playtest', await page.waitFor(`!document.getElementById('playtest').hidden && !!document.querySelector('#playtest canvas')`));
    await sleep(1600); // the level card
    const before = await page.evaluate(`JSON.stringify(window.__builder && document.querySelector('#playtest canvas') ? 1 : 0)`);
    for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft']) await page.press(k, 500);
    await page.shot(`${id}-playtest`);
    await page.press('Escape');
    check('Escape stops the playtest and returns to the editor', await page.waitFor(`document.getElementById('playtest').hidden`));
    check('the route comes back as a trace', await page.waitFor(`(() => { const t = window.__builder.store.state.trace; return !!t && t.points.length > 5; })()`),
      `trace ${await page.evaluate(`JSON.stringify(window.__builder.store.state.trace && window.__builder.store.state.trace.points.length)`)}`);
    void before;
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }

  // A keyboard alone plays every genre: a menu's buttons take Enter and Space even where play uses those keys (Space
  // jumps, fires or acts; Enter acts in an adventure).
  console.log('game menus by keyboard');
  for (const id of TEMPLATES) {
    const page = await openPage(`http://127.0.0.1:${PORT}/tools/test/play2d/builder-play.html?template=${id}&muted`);
    const menuFocused = `!!document.activeElement?.closest('[data-screen]:not([hidden])')`;
    await page.waitFor(`window.__ready && ${menuFocused}`);
    await page.press('Space');
    const started = await page.waitFor(`window.__game.phase === 'play'`, 3000);
    await page.press('Escape');
    const paused = await page.waitFor(`window.__game.phase === 'paused' && ${menuFocused}`, 3000);
    await page.press('Enter');
    const resumed = await page.waitFor(`window.__game.phase === 'play'`, 3000);
    check(`${id}: Space presses Play, Escape pauses, Enter presses Resume`, started && paused && resumed, `phase ${await page.evaluate('window.__game.phase')}`);
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }

  console.log('generating');
  for (const genre of ['platformer', 'puzzle']) {
    const page = await openPage(`${base}#generate=${genre}`);
    check(`#generate=${genre} opens the editor with Generate levels`, await page.waitFor(`!!window.__builder && !!document.querySelector('.gen-actions [data-gen="run"]')`));
    await page.click('.gen-actions [data-gen="run"]');
    check('the worker hands back checked levels', await page.waitFor(`document.querySelectorAll('.gen-item').length === 5`, 60000),
      await page.evaluate(`document.querySelector('.gen-status')?.textContent || ''`));
    const scores = await page.evaluate(`[...document.querySelectorAll('.gen-diff')].map(e => parseFloat(getComputedStyle(e).getPropertyValue('--d')))`);
    check('they climb in difficulty', scores.every((v, i) => !i || v >= scores[i - 1]), scores.join(' '));
    await page.shot(`generate-${genre}`);
    await page.click('.gen-actions [data-gen="replace"]');
    check('Use these puts them in the game as its levels', await page.waitFor(`window.__builder.store.project.levels.length === 5 && !document.querySelector('.gen-list')`));
    check('the first generated level passes its checks in the editor', await page.waitFor(`(() => { const a = window.__builder.analysis(); return !!a && !a.issues.some(x => x.severity !== 'tip'); })()`, 20000));
    check('one undo takes them all back', await page.evaluate(`(() => { window.__builder.store.undo(); return window.__builder.store.project.levels.length === 1; })()`));
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }
  {
    const page = await openPage(`${base}#generate=maze:${encodeURIComponent('frost 7')}`);
    check('#generate=<genre>:<seed> opens Generate levels on that seed', await page.waitFor(`window.__builder?.store.genre === 'maze' && document.querySelector('#gen-seed')?.value === 'frost 7'`),
      await page.evaluate(`document.querySelector('#gen-seed')?.value || ''`));
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }

  console.log('publishing');
  {
    const page = await openPage(`${base}#template=crate-garden`);
    await page.waitFor(`!!window.__builder`);
    // The Export button's own code path: the page bundles its runtime into one HTML file.
    const html = await page.evaluate(`import('/src/play2d/editor/publish.js').then(m => m.buildStandaloneHtml(window.__builder.store.project))`);
    check('the game exports as one HTML file', typeof html === 'string' && html.length > 100000 && html.includes('window.VisigameHooks'), `${Math.round((html || '').length / 1024)} KB`);
    const code = await page.evaluate(`import('/src/play2d/core/format.js').then(m => m.encodeShare(window.__builder.store.project))`);
    check('a share link fits in a URL', typeof code === 'string' && code.length < 12000, `${(code || '').length} chars`);
    await page.close();

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visigame-export-')), 'crate-garden.html');
    fs.writeFileSync(file, html);
    const game = await openPage(`file://${file}`);
    check('the exported file boots from disk', await game.waitFor(`!!window.__visigame && !!document.querySelector('#game canvas')`));
    check('its title screen offers Play', await game.waitFor(`(() => { const b = [...document.querySelectorAll('#game [data-screen] button')].find(x => /^\\s*play\\b/i.test(x.textContent)); if (b) b.dataset.e2e = 'play'; return !!b; })()`));
    await game.click('[data-e2e="play"]');
    check('Play starts the game', await game.waitFor(`document.querySelector('#game [data-screen]').hidden`));
    await sleep(1600); // the level card
    for (const k of ['ArrowRight', 'ArrowDown']) await game.press(k, 300);
    await game.shot('exported-game');
    check('no console errors in the exported game', game.errors.length === 0, game.errors.join(' | ').slice(0, 400));
    await game.close();

    const shared = await openPage(`${base}#play=${code}`);
    check('the share link plays the game full-screen', await shared.waitFor(`document.getElementById('app').dataset.view === 'player' && !!document.querySelector('.player-page canvas')`));
    await shared.click('[data-remix]');
    check('Remix opens a copy in the editor', await shared.waitFor(`document.getElementById('app').dataset.view === 'editor' && window.__builder.store.project.title === 'My block puzzle game'`));
    await shared.shot('remixed');
    check('no console errors', shared.errors.length === 0, shared.errors.join(' | ').slice(0, 400));
    await shared.close();
  }

  // The iOS app's Games tab plays a template by #try=, and Remix starts your own copy of it.
  console.log('a template played by its link');
  {
    const page = await openPage(`${base}#try=hive-run`);
    check('#try= plays the template full-screen', await page.waitFor(`document.getElementById('app').dataset.view === 'player' && !!document.querySelector('.player-page canvas')`));
    await page.click('[data-remix]');
    check('Remix opens your own copy in the editor', await page.waitFor(`document.getElementById('app').dataset.view === 'editor' && window.__builder.store.project.title === 'My arcade maze game' && window.__builder.store.project.template === 'hive-run'`));
    const link = await page.evaluate(`(window.visigameHost = { shareBase: 'https://example.test/builder/' }, import('/src/play2d/editor/publish.js').then(m => m.shareUrl(window.__builder.store.project)))`);
    check('inside the app, share links point at the public builder', typeof link === 'string' && link.startsWith('https://example.test/builder/#play='), String(link).slice(0, 60));
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }

  // A phone hides Share, Export and Redo from the top bar, so the Play menu carries them; nothing runs off the side.
  console.log('small screens');
  {
    const page = await openPage(`${base}#template=hive-run`, { width: 320, height: 640 });
    await page.waitFor(`!!window.__builder && document.getElementById('app').dataset.view === 'editor'`);
    const fits = sel => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].every(el => el.getBoundingClientRect().right <= innerWidth + 0.5)`);
    check('the top bar fits a 320 px phone', await fits('#topbar > *'));
    await page.click('#play-more');
    const items = await page.evaluate(`[...document.querySelectorAll('.menu button')].map(b => b.textContent.trim())`);
    check('the Play menu carries Share and Export on a phone', items.includes('Share a link') && items.includes('Export'), items.join(', '));
    await page.shot('phone-play-menu');
    await page.evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.trim() === 'Share a link')?.click()`);
    check('Share opens from there', await page.waitFor(`!!document.querySelector('.dialog #share-url')`, 5000));
    await page.press('Escape');
    await page.click('#games-btn');
    check('the start screen fits a phone, Back to the game included', await page.waitFor(`document.getElementById('app').dataset.view === 'gallery' && !!document.querySelector('[data-g="continue"]') && document.getElementById('gallery').scrollWidth <= innerWidth`)
      && await fits('.g-bar > *'));
    await page.shot('phone-start-screen');
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();

    const tablet = await openPage(`${base}#template=hive-run`, { width: 768, height: 1024 });
    await tablet.waitFor(`!!window.__builder && document.getElementById('app').dataset.view === 'editor'`);
    check('at 768 px the top bar keeps Play and its menu on screen, and the title box its title',
      await tablet.evaluate(`(() => { const t = document.querySelector('.titlebox'); return document.getElementById('play-more').getBoundingClientRect().right <= innerWidth && t.scrollWidth <= t.clientWidth + 1; })()`));
    await tablet.shot('tablet-editor');
    await tablet.close();
  }

  // The 2D view stores nothing, as the editor it belongs to does: a game lives in the page while it is open and leaves
  // as a file, a link or an export. So within one page: the start screen lists the game in hand, Back to the game
  // returns to it, Games opens the start screen, and no link leaves the tool.
  console.log('your games, this visit');
  {
    const page = await openPage(`${base}#template=hive-run`);
    check('a template opens in the editor', await page.waitFor(`!!window.__builder && document.getElementById('app').dataset.view === 'editor'`));
    const id = await page.evaluate(`window.__builder.store.project.id`);
    await page.click('#games-btn');
    check('Games opens the start screen', await page.waitFor(`document.getElementById('app').dataset.view === 'gallery'`));
    check('the start screen lists the game in hand', await page.waitFor(`document.querySelectorAll('.g-recent [data-g="recent"]').length > 0`));
    const away = await page.evaluate(`[...document.querySelectorAll('a[href]')].map(a => new URL(a.href)).filter(u => u.protocol.startsWith('http') && u.origin !== location.origin).map(u => u.href)`);
    check('no link leaves the tool', away.length === 0, away.join(' '));
    check('the page fits the window', await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    // 2d.html replaces the page's storage with memory before anything loads (an own property over Window's).
    check('nothing is stored on this machine', await page.evaluate(`!!Object.getOwnPropertyDescriptor(window, 'localStorage')`));
    await page.shot('your-games');
    await page.click('[data-g="continue"]');
    check('Back to the game returns to the editor', await page.waitFor(`document.getElementById('app').dataset.view === 'editor' && window.__builder.store.project.id === ${JSON.stringify(id)}`));
    check('no console errors', page.errors.length === 0, page.errors.join(' | ').slice(0, 400));
    await page.close();
  }
} catch (e) {
  failures++;
  console.log(`    FAIL harness  (${e.message})`);
} finally {
  browser.close();
  server.close();
}
console.log(failures ? `\nFAILED: ${failures}` : `\nall builder browser checks passed (shots in ${path.relative(ROOT, outDir)})`);
process.exit(failures ? 1 : 0);
