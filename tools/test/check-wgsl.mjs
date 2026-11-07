/**
 * EVERY PROGRAM THE WORLD ENGINE DRAWS COMPILES TO VALID WGSL.
 *
 *   node tools/test/check-wgsl.mjs                      the default seed's own world, rain, at night
 *   node tools/test/check-wgsl.mjs --town               built on: woods planted and a town placed on its land
 *   node tools/test/check-wgsl.mjs --weather snow --tier high
 *
 * Why this exists. The world engine's shaders were GLSL, run by WebGLRenderer, and are now TSL node graphs that
 * three compiles to WGSL on WebGPU and to GLSL on the WebGL2 fallback. WGSL is the stricter of the two (its
 * uniformity rule refuses an implicitly-derived texture read under a branch that varies per pixel, which GLSL
 * accepts), so a graph that renders on WebGL2 can still fail to compile on the backend the engine is for. Headless
 * Chromium's WebGPU adapter here (SwiftShader) loses the device as soon as anything presents to a canvas, so the
 * WebGPU frame cannot be watched; but it compiles shaders correctly, uniformity included. So this:
 *
 *   1. opens the editor (index.html) on the renderer's WebGL2 backend (which runs here) and lets the world build, optionally built
 *      on through the editor's own commands (woods planted, a town placed), with a fire lit, weather falling and the
 *      clock at night, so that every kind of object the engine draws is in the scene;
 *   2. asks a second renderer, on the WebGPU backend, for the WGSL three generates for every distinct material in
 *      that live scene (Renderer.debug.getShaderAsync), the shadow-casting and instanced ones included;
 *   3. compiles each vertex and fragment program on a raw WebGPU device and fails on any compiler error.
 *
 * What it does not do: show a WebGPU frame (tools/test/e2e-world.mjs checks pixels, on WebGL2). A real GPU runs the
 * same programs this proves valid.
 */
import { serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { landPoint } from '../lib/worldProbe.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TOWN = process.argv.includes('--town'), WEATHER = arg('--weather', 'rain'), TIER = arg('--tier', 'high'), HOUR = +arg('--hour', 23);
const PORT = 8197;
const server = await serveRepo(PORT);
const browser = await launchBrowser({ width: 1280, height: 800, webgpu: true });
const { send, on } = browser;
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const pageErrors = [];
on('Runtime.exceptionThrown', (p, s) => { if (s === sessionId) pageErrors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 400)); });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?renderer=webgl&gfx=${TIER}` }, sessionId);
  const t0 = Date.now();
  while (!(await js('!!(window.engine && window.engine.terrain && window.engine.terrain.tiles.size > 0)').catch(() => false))) {
    if (Date.now() - t0 > 180000) throw new Error('the world did not build');
    await sleep(1000);
  }
  await sleep(10000);
  if (TOWN) {
    console.log('built', await js(`(async () => {
      studio.plantWoods();
      const at = ${landPoint.toString()}(engine);
      await studio.placeSite(at.x, at.z, 'town');
      await new Promise(r => setTimeout(r, 5000));
      return JSON.stringify({ at, props: engine.props.items.size, scatter: engine.scatterCount() });
    })()`));
  }
  await js(`(() => { engine.addFireAt(0, 0, { r: 2 }); engine.setWeather(${JSON.stringify(WEATHER)}); engine.setTimeOfDay(${HOUR}); })()`);
  await sleep(8000);
  // Everything is in the scene: stop drawing it, so the software GPU spends itself on the compiles, not on the rain.
  await js('engine.setPaused(true)');
  const results = JSON.parse(await js(`(async () => {
    const THREE = await import('three/webgpu');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const r2 = new THREE.WebGPURenderer({ canvas: document.createElement('canvas') });
    await r2.init();
    const objects = [];
    engine.scene.traverse((o) => { if ((o.isMesh || o.isSprite || o.isPoints || o.isLine) && o.material && !Array.isArray(o.material)) objects.push(o); });
    const seen = new Set(), out = [];
    for (const o of objects) {
      if (seen.has(o.material.uuid)) continue;
      seen.add(o.material.uuid);
      const what = (o.material.type || '?') + (o.isInstancedMesh ? ' (instanced)' : o.isSprite ? ' (sprite)' : '') + ' ' + (o.name || o.parent?.name || o.parent?.parent?.name || '');
      try {
        const { vertexShader, fragmentShader } = await r2.debug.getShaderAsync(engine.scene, engine.camera, o);
        const errors = [];
        for (const [stage, code] of [['vertex', vertexShader], ['fragment', fragmentShader]]) {
          const module = device.createShaderModule({ code });
          for (const m of (await module.getCompilationInfo()).messages)
            if (m.type === 'error') errors.push(stage + ' line ' + m.lineNum + ': ' + m.message.slice(0, 240));
        }
        out.push({ what, errors });
      } catch (e) { out.push({ what, errors: ['could not generate: ' + String(e.message || e).slice(0, 300)] }); }
    }
    return JSON.stringify(out);
  })()`));
  const kinds = new Map();
  for (const r of results) {
    const kind = r.what.replace(/ (tile|detail|scatter|prop|fx):?\S*$/, ' $1').trim();
    if (!kinds.has(kind)) kinds.set(kind, { n: 0, bad: 0 });
    kinds.get(kind).n++;
    if (r.errors.length) { kinds.get(kind).bad++; failures++; console.log(`  FAIL ${r.what}\n         ${r.errors.slice(0, 3).join('\n         ')}`); }
  }
  for (const [kind, k] of kinds) console.log(`  ${k.bad ? 'FAIL' : 'ok  '} ${kind}${k.n > 1 ? ` (${k.n} materials)` : ''}`);
  console.log(`${results.length} distinct materials, ${results.length * 2} programs compiled as WGSL`);
} catch (err) {
  failures++;
  console.log('  FAIL the check did not finish: ' + err.message);
} finally {
  if (pageErrors.length) { failures++; console.log('  FAIL page errors:\n         ' + pageErrors.slice(0, 3).join('\n         ')); }
  await send('Target.closeTarget', { targetId }).catch(() => {});
  browser.close(); server.close();
}
console.log(failures ? `WGSL: ${failures} failed` : 'WGSL: every program compiles');
process.exit(failures ? 1 : 0);
