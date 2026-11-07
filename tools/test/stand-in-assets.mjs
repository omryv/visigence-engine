/**
 * Stand-in art for the browser smoke harness, where the R2 origin is unreachable.
 *
 *   node tools/test/stand-in-assets.mjs            # writes tools/test/.stand-ins/assets/...
 *
 * Every model, image and sound the runtime manifest names becomes a box, a 4x4 image or
 * a tenth of a second of silence, sized from what the pack says about it (a character
 * is 1.8 m tall, a weapon is its `metres`, a prop its `metres`), so the loader, the
 * animators, the batching and the collision proxies run their real code over real bytes.
 * The set lives OUTSIDE assets/ so the asset-backed test suites, which check the real
 * files' checksums, never mistake it for the art; tools/lib/_headless.mjs serves it as a
 * fallback for /assets/ requests when the real file is absent.
 *
 * The performance variants (.gltf + .bin + .ktx2) are not generated: the harness runs the
 * session with `?performanceAssets=off`, which loads the source models instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxGlb, tinyPng, tinyWav, tinySvg } from '../lib/_glb-writer.mjs';
import { HOUSE_PARTS } from '../../src/world/houseParts.js';
import { TREE_PARTS } from '../../src/world/treeParts.js';
import { NATURE_PARTS } from '../../src/world/natureParts.js';
import { LANDMARK_PARTS } from '../../src/world/landmarkParts.js';
import { CREATURE_PARTS } from '../../src/world/creatureParts.js';
import { DESERT_HOUSE_PARTS, DESERT_TREE_PARTS, DESERT_NATURE_PARTS, DESERT_LANDMARK_PARTS } from '../../src/world/desertParts.js';
import { SNOW_HOUSE_PARTS, SNOW_TREE_PARTS, SNOW_NATURE_PARTS, SNOW_LANDMARK_PARTS } from '../../src/world/snowParts.js';

/**
 * THE PARTS LIBRARIES. The grammars (houses, trees, flora, landmarks, creatures) build from named parts in one GLB
 * each, and an assembler refuses a plan whose part the library lacks, so a library's stand-in carries a box for every
 * part id any biome's table names, under the material prefix its colour slots are read with.
 */
const LIBRARY_KINDS = {
  houses: { material: 'HSE_Wall', parts: [HOUSE_PARTS, DESERT_HOUSE_PARTS, SNOW_HOUSE_PARTS] },
  trees: { material: 'TRE_Leaf', parts: [TREE_PARTS, DESERT_TREE_PARTS, SNOW_TREE_PARTS] },
  nature: { material: 'ARC_Nature', parts: [NATURE_PARTS, DESERT_NATURE_PARTS, SNOW_NATURE_PARTS] },
  landmarks: { material: 'LMK_Wood', parts: [LANDMARK_PARTS, DESERT_LANDMARK_PARTS, SNOW_LANDMARK_PARTS] },
  creatures: { material: 'CRT_Body', parts: [CREATURE_PARTS] },
};
function libraries(pack) {
  const out = new Map();
  for (const p of [pack, ...Object.values(pack.biomes ?? {})]) {
    if (p.houses?.library) out.set(p.houses.library, 'houses');
    if (p.trees?.library) out.set(p.trees.library, 'trees');
    if (p.world?.library) out.set(p.world.library, 'nature');
    if (p.world?.landmarks?.library) out.set(p.world.landmarks.library, 'landmarks');
    if (p.creatures?.library) out.set(p.creatures.library, 'creatures');
  }
  return out;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const STAND_IN_ROOT = path.join(ROOT, 'tools/test/.stand-ins');

/** Rough extents per path, from the packs, so a stand-in stands where the art would. */
function sizeFor(rel, sizes) {
  const known = sizes.get(rel);
  if (known) return known;
  if (/ground/.test(rel)) return { width: 10, height: 0.2, depth: 10 };
  if (/hero|player/.test(rel)) return { width: 0.6, height: 1.8, depth: 0.4 };
  return { width: 1, height: 1, depth: 1 };
}

export function generateStandIns({ force = false } = {}) {
  const manifests = ['tools/assets/runtime-manifest.json', 'tools/assets/studio-manifest.json']
    .map(f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).files ?? []);
  const sizes = new Map(), libs = new Map();
  for (const theme of fs.readdirSync(path.join(ROOT, 'packs'))) {
    if (!fs.existsSync(path.join(ROOT, 'packs', theme, 'pack.json'))) continue;
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', theme, 'pack.json'), 'utf8'));
    for (const c of Object.values(pack.characters ?? {})) if (c.model) sizes.set(c.model, { width: 0.6, height: 1.8, depth: 0.4 });
    for (const w of Object.values(pack.weapons ?? {})) if (w.model) sizes.set(w.model, { width: 0.08, height: 0.14, depth: w.metres ?? 0.6 });
    for (const p of pack.props ?? []) if (p.model) sizes.set(p.model, { width: p.metres ?? 1, height: p.metres ?? 1, depth: p.metres ?? 1 });
    for (const [file, kind] of libraries(pack)) libs.set(file, kind);
  }
  let written = 0, skipped = 0;
  for (const { path: rel } of manifests.flat()) {
    const real = path.join(ROOT, rel), out = path.join(STAND_IN_ROOT, rel);
    if (fs.existsSync(real) || (!force && fs.existsSync(out))) { skipped++; continue; }
    const ext = path.extname(rel).slice(1);
    let bytes;
    const lib = libs.get(rel) && LIBRARY_KINDS[libs.get(rel)];
    if (ext === 'glb' && lib) {
      const parts = new Map();
      for (const table of lib.parts) for (const [id, v] of Object.entries(table)) parts.set(id, [...new Set([...(parts.get(id) ?? []), ...(v.sockets ?? [])])]);
      bytes = boxGlb({ width: 0.5, height: 0.5, depth: 0.5, name: path.basename(rel, '.glb'), material: lib.material,
        parts: [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, sockets]) => ({ id, sockets })) });
    }
    else if (ext === 'glb') bytes = boxGlb({ ...sizeFor(rel, sizes), name: path.basename(rel, '.glb') });
    else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') bytes = tinyPng();
    else if (ext === 'mp3' || ext === 'ogg' || ext === 'wav') bytes = tinyWav();
    else if (ext === 'svg') bytes = tinySvg();
    else { skipped++; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
    written++;
  }
  return { written, skipped, root: STAND_IN_ROOT };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = generateStandIns({ force: process.argv.includes('--force') });
  console.log(`${r.written} stand-ins written, ${r.skipped} skipped (real file present, already generated, or a performance variant), under ${path.relative(ROOT, r.root)}`);
}
