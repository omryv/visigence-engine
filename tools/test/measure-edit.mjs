/**
 * HOW LONG AN EDIT TAKES in the level editor, and whether edits leak. Headless Chromium, the WebGL2 backend, stand-in
 * art (tools/test/stand-in-assets.mjs), the Shooter template's first level:
 *
 *   node tools/test/measure-edit.mjs            # 10 edits: move a placed thing back and forth
 *   node tools/test/measure-edit.mjs --edits 30
 *
 * Each edit is timed inside the page, from the store change to the session's new game, the editor's "Updating the
 * level" gone (the editor's warm rebuild, editor/build/app.js and ShooterSession.build) and the rebuilt level drawn
 * once. Before each edit the editor is let go idle and the GPU drain (gl.finish): the software rasteriser runs the
 * editor's settle frames lazily, and a sync point inside an edit would otherwise wait for all of them, seconds a real
 * GPU never spends. The check that does not depend on the machine is the shader count: an edit must compile no shader
 * program (three's own program cache, before and after). And edits must not leak: the renderer's geometries and
 * textures, the scene's objects and the light rig's emitters stay what they were after the second edit (a warm rebuild
 * frees the level before it one rebuild late, so the first edit adds one level's worth). Not in tools/test/run.mjs:
 * it needs a browser.
 */
import { serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const EDITS = Math.max(3, arg('edits', 10)), PORT = 8193, W = 1280, H = 800;
const server = await serveRepo(PORT, { fallbackRoot: STAND_IN_ROOT });
const browser = await launchBrowser({ width: W, height: H, webgpu: false });
const { send, on } = browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300)); });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };
const READY = `(!!window.__studio?.build?.store && document.querySelector('#bld-pending')?.hidden && document.querySelector('#bld-empty')?.hidden && !!window.__studio.session?.game)`;

try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/game.html?mode=build&template=hive-patrol&debug=1&renderer=webgl&performanceAssets=off` }, sessionId);
  const t0 = Date.now();
  while (!(await js(READY).catch(() => false))) { if (Date.now() - t0 > 300000) throw new Error('the level editor did not open'); await sleep(250); }
  console.log(`level editor open, first level built: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(2000);
  const stats = () => js(`(()=>{const s=window.__studio.session,m=s.renderer.info.memory;let objects=0;s.scene.traverse(()=>objects++);return JSON.stringify({geometries:m.geometries,textures:m.textures,objects,emitters:s.rig?.emitters.length??0})})()`).then(JSON.parse);
  // One edit, timed in the page: the store change, then a 10 ms poll for the rebuilt level.
  const programs = () => js(`(()=>{const p=window.__studio.session.renderer._pipelines?.programs;return p?p.vertex.size+p.fragment.size:-1})()`);
  // Idle: the editor has stopped drawing (no frame for a second), then the GPU has finished what it was given.
  await js(`(()=>{const s=window.__studio.session,f=s.frame.bind(s);window.__frames=0;s.frame=(...a)=>{window.__frames++;return f(...a);};return 1})()`);
  const drain = async () => {
    let last = -1, still = 0;
    while (still < 4) { await sleep(250); const n = await js('window.__frames'); still = n === last ? still + 1 : 0; last = n; }
    await js(`(()=>{window.__studio.session.renderer.backend?.gl?.finish();return 1})()`);
  };
  const edit = (dx) => js(`new Promise(done=>{
    const s=window.__studio.build.store,e=s.edits.entities[0],game=window.__studio.session.game,t=performance.now();
    s.translate([e.id],${dx},0,'Move');
    // Done once the rebuilt level has also been drawn: a shader compiled again lands in that first frame.
    const poll=()=>{ if(window.__studio.session.game!==game&&${READY}){ window.__studio.session.frame(performance.now()); done(performance.now()-t); } else setTimeout(poll,10); };
    setTimeout(poll,10);
  })`);
  const times = [], compiled = [];
  let after1 = null;
  for (let i = 0; i < EDITS; i++) {
    await drain();
    const p0 = await programs();
    times.push(await edit(i % 2 ? -2 : 2));
    compiled.push((await programs()) - p0);
    // Steady state from the second edit: a warm rebuild keeps the level before it until the next one (_clearLevel).
    if (i === 1) after1 = await stats();
  }
  await drain();
  const last = await stats(), sorted = [...times].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  console.log(`each edit, ms: ${times.map(t => t.toFixed(0)).join(" ")}`);
  console.log(`edit to rebuilt level, ${EDITS} edits: median ${median.toFixed(0)} ms, slowest ${sorted.at(-1).toFixed(0)} ms`);
  check('an edit rebuilds the level warm (under 2 s even on the software rasteriser)', median < 2000, `${median.toFixed(0)} ms`);
  check('an edit compiles no shader program', compiled.every(n => n <= 0), `programs added per edit: ${compiled.join(' ')}`);
  for (const k of ['geometries', 'textures', 'objects', 'emitters'])
    check(`${k} do not grow edit by edit`, last[k] <= after1[k] + 2, `${after1[k]} after the second edit, ${last[k]} after ${EDITS}`);
  check('no page errors', !errors.length, errors[0] ?? '');
} catch (error) {
  failures++; console.error(error.message);
} finally {
  await browser.close(); server.close();
}
console.log(failures ? `FAILED: ${failures}` : 'Edits: OK');
process.exit(failures ? 1 : 0);
