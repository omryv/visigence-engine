/**
 * The exported game's bundle: the level builder's runtime, bundled the way the Export button
 * bundles it, must define the same exports as Node's own import of every module, run with no
 * DOM at module load, and survive being inlined in an HTML file.
 *   node tools/test/test-builder-export.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectModules, bundle, transformModule, resolvePath, scriptSafe, jsonSafe } from '../../../src/play2d/core/bundle.js';
import { normalizeProject, toDocument } from '../../../src/play2d/core/format.js';
import { TEMPLATES } from '../../../src/play2d/templates/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/* What the 2D game may reach outside src/play2d/: the kernel's seed streams, pure and bundled with it. The builder's
   editor (src/play2d/editor/) is the one editor's 2D view and may stand on the engine too (the world, in 2D). */
const GAME_MAY_REACH = new Set(['/src/kernel/seed.js']);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

await test('resolvePath walks relative specifiers and refuses bare ones', () => {
  assert.equal(resolvePath('/src/play2d/runtime/game.js', './sims/index.js'), '/src/play2d/runtime/sims/index.js');
  assert.equal(resolvePath('/src/play2d/runtime/sims/maze.js', '../../core/grid.js'), '/src/play2d/core/grid.js');
  assert.throws(() => resolvePath('/a/b.js', 'three'), /relative/);
});

await test('the dialect: one export per statement, lists, re-exports; default and star refused', () => {
  const body = transformModule('/m/a.js', "import { x as y } from './b.js';\nexport const A = 1;\nexport function f() { return y; }\nconst z = 2;\nexport { z as Z };\nexport { q } from './c.js';\n");
  const b = { x: 7 }, c = { q: 9 };
  const out = new Function('__m', body)({ '/m/b.js': b, '/m/c.js': c });
  assert.deepEqual({ ...out }, { q: 9, A: 1, f: out.f, Z: 2 });
  assert.equal(out.f(), 7);
  assert.throws(() => transformModule('/m/d.js', 'export default 1;'), /default and star/);
  assert.throws(() => transformModule('/m/d.js', "export * from './e.js';"), /default and star/);
});

await test('the 2D game is self-contained: every import is relative, resolves, and stays inside it (or the seed streams)', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } })(path.join(ROOT, 'src/play2d'));
  assert.ok(files.length > 30);
  const problems = [];
  for (const file of files) {
    const rel = '/' + path.relative(ROOT, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm)) {
      const spec = m[1];
      if (!spec.startsWith('.')) { problems.push(`${rel}: bare import "${spec}"`); continue; }
      const target = resolvePath(rel, spec);
      const editor = rel.startsWith('/src/play2d/editor/');
      if (!(target.startsWith('/src/play2d/') || GAME_MAY_REACH.has(target) || (editor && target.startsWith('/src/')))) problems.push(`${rel}: "${spec}" leaves src/play2d/`);
      else if (!fs.existsSync(path.join(ROOT, target))) problems.push(`${rel}: "${spec}" does not resolve`);
    }
    if (/\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) problems.push(`${rel}: dynamic import() cannot be bundled`);
  }
  assert.deepEqual(problems, []);
});

const ENTRY = '/src/play2d/runtime/game.js';
const sources = await collectModules(ENTRY, p => read(p));
const code = bundle(sources, ENTRY);

await test('the runtime bundle reaches the sims, art and format, and nothing outside builder/', () => {
  const paths = [...sources.keys()];
  for (const p of ['/src/play2d/runtime/sims/platformer.js', '/src/play2d/runtime/sims/puzzle.js', '/src/play2d/art/index.js', '/src/play2d/core/format.js', '/src/play2d/runtime/render.js'])
    assert.ok(paths.includes(p), `bundle is missing ${p}`);
  assert.ok(paths.every(p => p.startsWith('/src/play2d/core/') || p.startsWith('/src/play2d/art/') || p.startsWith('/src/play2d/runtime/') || GAME_MAY_REACH.has(p)), paths.join('\n'));
});

await test('every bundled module defines exactly the exports Node sees, with no DOM at load', async () => {
  const ctx = vm.createContext({ console, Math, Date, JSON, Object, Array, Map, Set, WeakMap, Promise, Symbol, Number, String, Boolean, Error, TypeError, RangeError, Uint8Array, Uint16Array, Int16Array, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8ClampedArray, ArrayBuffer, DataView, RegExp, parseInt, parseFloat, isFinite, isNaN, Infinity, NaN, encodeURIComponent, decodeURIComponent, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(code, ctx, { filename: 'visigame-runtime.js' });
  const mods = ctx.__visigameModules;
  for (const p of sources.keys()) {
    const real = await import(pathToFileURL(path.join(ROOT, p)).href);
    assert.deepEqual(Object.keys(mods[p]).sort(), Object.keys(real).sort(), `exports differ for ${p}`);
  }
  assert.equal(typeof ctx.__visigame.createGame, 'function');
  // the boot script in an exported file uses these two
  assert.equal(typeof mods['/src/play2d/core/format.js'].normalizeProject, 'function');
});

await test('the bundled sims play the same game as the modules', async () => {
  const ctx = vm.createContext({ console, Math, JSON, Object, Array, Map, Set, Promise, Symbol, Number, String, Boolean, Error, TypeError, RangeError, Uint8Array, Uint16Array, Int16Array, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8ClampedArray, ArrayBuffer, DataView, RegExp, parseInt, parseFloat, isFinite, isNaN, Infinity, NaN, encodeURIComponent, decodeURIComponent, TextEncoder, TextDecoder, btoa, atob, Date });
  vm.runInContext(code, ctx);
  const bundled = ctx.__visigameModules['/src/play2d/runtime/sims/index.js'];
  const { createSim, emptyInput } = await import('../../../src/play2d/runtime/sims/index.js');
  const project = TEMPLATES.find(t => t.genre === 'platformer').build({ id: 'export-test' });
  const a = createSim(project, 0, { seed: 5 }), b = bundled.createSim(project, 0, { seed: 5 });
  for (let i = 0; i < 600; i++) {
    const input = emptyInput(); input.right = i % 90 < 70; input.jump = i % 45 < 12; input.pressed.jump = i % 45 === 0;
    a.step(input); b.step(JSON.parse(JSON.stringify(input)));
  }
  assert.equal(b.player.x.toFixed(6), a.player.x.toFixed(6));
  assert.equal(b.player.y.toFixed(6), a.player.y.toFixed(6));
  assert.equal(b.score, a.score);
});

await test('inlined text cannot close its script element', () => {
  const nasty = { title: '</script><script>alert(1)</script>', note: 'a b<!--' };
  const json = jsonSafe(nasty);
  assert.ok(!json.includes('</script') && !json.includes('<!--') && !json.includes(' '));
  assert.deepEqual(JSON.parse(json), nasty);
  const js = scriptSafe('const s = "</script>"; // <!-- x');
  assert.ok(!/<\/script/i.test(js) && !js.includes('<!--'));
  assert.equal(new Function(`${js}\nreturn s;`)(), '</script>');
});

await test('an exported project document reloads to the same project', () => {
  for (const t of TEMPLATES) {
    const p = t.build({ id: 'x-' + t.id });
    const doc = JSON.parse(jsonSafe(toDocument(p)));
    assert.deepEqual(toDocument(normalizeProject(doc)), toDocument(p), t.id);
  }
});

console.log(`ok ${passed} builder export tests (${sources.size} modules, ${(code.length / 1024).toFixed(0)} KB bundle)`);
