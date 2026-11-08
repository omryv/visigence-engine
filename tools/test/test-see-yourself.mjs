/**
 * SEE YOURSELF: a photograph becomes a figure (src/atlas/web/figure.js photoToFigure) and the figure becomes a prop
 * through the studio's own importer (editor/assetImport.js). The browser half (decoding, the subject crop, the atlas on
 * a canvas, the worker) is drawn by tools/test/shoot-studio.mjs `arcade-world-figure`; this is the rest:
 *
 *   1. the reconstruction is part of the engine (src/atlas/), reached only by the import dialog, on demand: the
 *      game's runtime never imports it (a game carries the GLB, not the reconstruction);
 *   2. the worker answers the two requests figure.js makes, with the fields figure.js reads;
 *   3. the GLB photoToFigure writes, built here the same way from the test photograph (reconstruct, then SmartMesh
 *      to 24k triangles, no rig), passes the importer's checks (no skin, within the triangle and texture budgets)
 *      and its project rules at a person's height.
 *
 * Run:  node tools/test/test-see-yourself.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ATLAS, jsFiles, moduleSpecifiers, resolveRelative, inAtlas } from '../lib/modules.mjs';
import { inspectGLB } from '../../editor/assetImport.js';
import { normalizeImportedProps } from '../../src/world/importedProps.js';
import { tinyPng } from '../lib/_glb-writer.mjs';
import { reconstruct, PRESETS } from '../../src/atlas/atlas-core.js';
import { smartMesh } from '../../src/atlas/smartmesh.js';
import { glbBytes } from '../../src/atlas/exporters.js';
import { decodePNG, downscaleRGBA } from '../lib/png.mjs';

const ok = msg => console.log(`  ok   ${msg}`);

// ── 1. where the reconstruction sits ────────────────────────────────────────
{
  for (const f of ['web/figure.js', 'web/worker.js', 'atlas-core.js', 'exporters.js', 'smartmesh.js'])
    assert(fs.existsSync(path.join(ATLAS, f)), `src/atlas/${f} is in the engine`);
  // Who reaches into src/atlas/ from outside it: the import dialog and the editor's My-3D-Engine view (the
  // reconstruction's own page), and nothing the game runs (neither ships in a downloaded game: tools/build/game-manifest.mjs).
  const reachers = [];
  for (const file of [...jsFiles(path.join(ROOT, 'src')), ...jsFiles(path.join(ROOT, 'editor'))]) {
    if (inAtlas(file)) continue;
    for (const spec of moduleSpecifiers(fs.readFileSync(file, 'utf8')))
      if (spec.startsWith('.') && inAtlas(resolveRelative(file, spec))) reachers.push(path.relative(ROOT, file));
  }
  assert.deepEqual([...new Set(reachers)].sort(), ['editor/assetImport.js', 'editor/my-3d-engine/app.js', 'editor/my-3d-engine/viewer.js'], 'only the import dialog and My-3D-Engine reach the reconstruction');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'editor/runtime-files.json'), 'utf8'));
  assert(!manifest.some((f) => f.startsWith('editor/my-3d-engine/') || f.startsWith('src/atlas/')), 'a downloaded game carries neither');
  const importer = fs.readFileSync(path.join(ROOT, 'editor/assetImport.js'), 'utf8');
  assert(importer.includes("import('../src/atlas/web/figure.js')"), 'the import dialog loads figure.js on demand');
  assert(!/^\s*import\b[^(]*src\/atlas/m.test(importer), 'and never statically: a studio that never imports a photo never loads it');
  ok('the reconstruction is in the engine at src/atlas/; only the import dialog (on demand) and My-3D-Engine reach it');
}

// ── 2. the worker's protocol ────────────────────────────────────────────────
{
  const worker = fs.readFileSync(path.join(ATLAS, 'web/worker.js'), 'utf8'), figure = fs.readFileSync(path.join(ATLAS, 'web/figure.js'), 'utf8');
  for (const [asks, answers] of [['reconstruct', 'done'], ['exportGeometry', 'geometry']]) {
    assert(figure.includes(`type: '${asks}'`) && figure.includes(`'${answers}'`), `figure.js asks ${asks} and waits for ${answers}`);
    assert(worker.includes(`msg.type === '${asks}'`) && worker.includes(`type: '${answers}'`), `the worker answers ${asks} with ${answers}`);
  }
  for (const field of ['padded', 'paddedBack', 'stats', 'notes', 'summary']) assert(new RegExp(`\\b${field}\\b`).test(worker), `the worker hands back ${field}`);
  ok('the worker answers reconstruct and exportGeometry with what figure.js reads');
}

// ── 3. the figure, through the importer ─────────────────────────────────────
{
  const img = decodePNG(fs.readFileSync(path.join(ROOT, 'tools/test/fixtures/photo-front.png'))), preset = PRESETS.balanced;
  const k = Math.min(1, preset.w / Math.max(img.w, img.h)), w = Math.round(img.w * k), h = Math.round(img.h * k);
  const t0 = performance.now();
  const r = reconstruct(downscaleRGBA(img.px, img.w, img.h, w, h), w, h, 'balanced', () => {}, { px: img.px, w: img.w, h: img.h }, null, null);
  const s = smartMesh(r, { kappa: 1, target: 24000, measure: false });
  const geo = { positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices, colors: s.baseColor, sigma: s.sigma, sigmaMeta: r.sigStats };
  // The atlas is a canvas in the browser; any PNG is a texture to the importer's checks, and the real one is at most
  // 2048 px wide (figure.js fitAtlas), which the browser shot holds.
  const bytes = glbBytes(geo, tinyPng(), 'test', null, null), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const report = inspectGLB(buffer);
  assert(!report.json.skins && report.triangles <= 24000 && report.triangles > 1000, `a static mesh within the budget (${report.triangles} triangles)`);
  assert.equal(report.triangles, s.indices.length / 3);
  const P = s.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) { const a = i % 3; lo[a] = Math.min(lo[a], P[i]); hi[a] = Math.max(hi[a], P[i]); }
  const size = hi.map((v, a) => v - lo[a]);
  assert(size[1] > size[2], 'standing up: y is its height');
  const [prop] = normalizeImportedProps([{ id: 'a'.repeat(64), name: 'You', size, scale: 1.75 / size[1], collision: 'box', triangles: report.triangles, bytes: buffer.byteLength,
    creator: 'Me', source: 'A photograph, reconstructed on this device', license: 'My own photograph', rightsConfirmed: true }]);
  assert(Math.abs(prop.size[1] * prop.scale - 1.75) < 1e-9 && prop.model === `imports/${'a'.repeat(64)}.glb`, 'a 1.75 m figure is a prop the project accepts');
  ok(`the test photograph: ${report.triangles.toLocaleString()} triangles, no skin, through the importer at a person's height, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
console.log('See yourself: OK');
