/**
 * WHAT IS ACTUALLY IN A PACK'S ART, measured rather than assumed.
 *
 *   node tools/build/inspect-pack.mjs               # every GLB under assets/
 *   node tools/build/inspect-pack.mjs arcade        # one pack's manifest
 *   node tools/build/inspect-pack.mjs --json        # machine-readable
 *
 * A pack manifest says how big a crate is, whether a character can be animated and what
 * a level costs to load. Every one of those is a property of the FILE, and writing them
 * down by hand is how a manifest goes stale the first time an asset is re-exported. So
 * this measures them, and `tools/test/test-pack.mjs` asserts the manifest still agrees.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT LOOKS FOR, AND WHY EACH ONE DECIDES SOMETHING
 * ---------------------------------------------------------------------------
 *   BOUNDS     with node transforms applied. Accessor min/max alone is mesh-local, and
 *              on a file with 88 nodes that is not the size of the object. The pack
 *              needs the true extent to convert a unit-normalised export into metres.
 *   UNIT BOX   generated art arrives normalised so its longest axis is exactly 1.0. A
 *              crate, a door, a rifle and a soldier are then all the same size, and
 *              nothing downstream can tell. Flagging it is what forces the manifest to
 *              carry a metre scale per asset.
 *   RIG        skins, joints and animation clips. Zero of all three means the mesh is
 *              static and moves as one solid body (src/anim/RigidBody.js), not through an
 *              AnimationMixer.
 *   SEGMENTS   how many separate meshes. One mesh is a prop. Eighty-eight meshes is a
 *              character taken apart at the joints, which is riggable WITHOUT skin
 *              weights: each segment is a rigid part that can hang off a bone.
 *   TEXTURE    decoded RGBA cost, which is the budget that actually kills a page. An
 *              8192 map is 268 MB decoded whatever the file compresses to. See
 *              src/core/AssetLoader.js, which caps at 2048 for exactly this reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGLB } from '../lib/_glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const packId = argv.find((a) => !a.startsWith('--')) || null;

/* ── matrix helpers: glTF node transforms, column-major like three ───────── */

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** TRS -> matrix, the glTF composition order: T * R * S. */
function trs(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function apply(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/* ── the measurement ─────────────────────────────────────────────────────── */

export function inspectGlb(absPath) {
  const buf = fs.readFileSync(absPath);
  const { json: j, bin } = parseGLB(buf);

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let meshCount = 0, triangles = 0;

  /**
   * Walk the scene graph so node transforms reach the bounds. The eight corners of each
   * primitive's accessor box are transformed rather than the box itself: a rotated box's
   * axis-aligned extent is not its min/max rotated.
   */
  const visit = (nodeIndex, parent) => {
    const node = j.nodes[nodeIndex];
    const world = mul(parent, trs(node));
    if (node.mesh != null) {
      const mesh = j.meshes[node.mesh];
      for (const prim of mesh.primitives || []) {
        meshCount++;
        const acc = j.accessors[prim.attributes.POSITION];
        const count = prim.indices != null ? j.accessors[prim.indices].count : acc.count;
        triangles += count / 3;
        if (!acc.min || !acc.max) continue;
        for (let c = 0; c < 8; c++) {
          const corner = [
            (c & 1) ? acc.max[0] : acc.min[0],
            (c & 2) ? acc.max[1] : acc.min[1],
            (c & 4) ? acc.max[2] : acc.min[2],
          ];
          const w = apply(world, corner);
          for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hi[k]) hi[k] = w[k]; }
        }
      }
    }
    for (const child of node.children || []) visit(child, world);
  };
  const scene = j.scenes?.[j.scene ?? 0];
  for (const rootNode of scene?.nodes ?? j.nodes.map((_, i) => i)) visit(rootNode, IDENT);

  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => (Number.isFinite(v) ? v : 0));
  const longest = Math.max(...size);

  // Texture cost: decoded RGBA, which is what the GPU and the tab actually pay.
  const images = [];
  let decodedBytes = 0;
  for (const img of j.images || []) {
    const dim = imageDim(j, bin, img);
    images.push(dim);
    if (dim) decodedBytes += dim.w * dim.h * 4;
  }

  const joints = (j.skins || []).reduce((a, s) => a + (s.joints?.length || 0), 0);

  return {
    file: path.relative(ROOT, absPath),
    bytes: buf.length,
    nodes: (j.nodes || []).length,
    meshes: meshCount,
    triangles: Math.round(triangles),
    materials: (j.materials || []).length,
    images: images.filter(Boolean).map((d) => `${d.w}x${d.h}`),
    decodedMB: +(decodedBytes / 1048576).toFixed(1),
    skins: (j.skins || []).length,
    joints,
    clips: (j.animations || []).length,
    min: lo.map((v) => +v.toFixed(4)),
    size: size.map((v) => +v.toFixed(4)),
    longest: +longest.toFixed(4),
    /** Generated art arrives normalised so the longest axis is exactly 1. */
    unitNormalised: Math.abs(longest - 1) < 1e-3,
    /** Static: nothing to play. Moves as one rigid body (src/anim/RigidBody.js). */
    static: joints === 0 && (j.animations || []).length === 0,
    /** Many meshes = taken apart at the joints = riggable without skin weights. */
    segmented: meshCount > 8,
  };
}

/** PNG and JPEG dimensions straight out of the buffer view. No decoder needed. */
function imageDim(j, bin, img) {
  if (img.bufferView == null) return null;
  const bv = j.bufferViews[img.bufferView];
  const off = bv.byteOffset || 0;
  const b = bin.subarray(off, off + bv.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  let files = [];
  if (packId) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', packId, 'pack.json'), 'utf8'));
    for (const a of manifestAssets(manifest)) files.push(path.join(ROOT, a));
  } else {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.glb')) files.push(p);
      }
    };
    walk(path.join(ROOT, 'assets'));
    files.sort();
  }

  const reports = files.map(inspectGlb);
  if (asJson) { console.log(JSON.stringify(reports, null, 2)); process.exit(0); }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('file', 40), pad('MB', 5), pad('size (units)', 22), pad('tris', 8),
    pad('meshes', 7), pad('rig', 14), pad('tex', 10), 'decoded');
  let totalBytes = 0, totalDecoded = 0, unitCount = 0, staticCount = 0;
  for (const r of reports) {
    totalBytes += r.bytes; totalDecoded += r.decodedMB;
    if (r.unitNormalised) unitCount++;
    if (r.static) staticCount++;
    console.log(
      pad(r.file.replace('assets/', ''), 40),
      pad((r.bytes / 1048576).toFixed(1), 5),
      pad(r.size.map((v) => v.toFixed(2)).join(' x ') + (r.unitNormalised ? ' *' : ''), 22),
      pad(r.triangles.toLocaleString(), 8),
      pad(r.meshes, 7),
      pad(r.static ? 'STATIC' : `${r.joints}j ${r.clips}clip`, 14),
      pad([...new Set(r.images)].join(',') || '-', 10),
      `${r.decodedMB} MB`);
  }

  console.log(`\n${reports.length} files, ${(totalBytes / 1048576).toFixed(0)} MB on disk, `
    + `${totalDecoded.toFixed(0)} MB of texture once decoded`);
  if (unitCount) {
    console.log(`\n* ${unitCount}/${reports.length} are UNIT-NORMALISED (longest axis exactly 1.0).`);
    console.log('  Nothing in them says how big the object is, so the pack manifest has to.');
  }
  if (staticCount) {
    console.log(`\n${staticCount}/${reports.length} are STATIC — no skin, no joints, no clips.`);
    console.log('  Anything that has to move animates as one rigid body (src/anim/RigidBody.js).');
  }
  const CAP = 2048;
  const over = reports.filter((r) => r.images.some((d) => +d.split('x')[0] > CAP));
  if (over.length) {
    console.log(`\n${over.length} file(s) carry textures above the ${CAP} px cap in`
      + ' src/core/AssetLoader.js:');
    for (const r of over) console.log(`  ${r.file}  ${[...new Set(r.images)].join(',')}  ${r.decodedMB} MB decoded`);
    console.log('  An 8192 map is 268 MB of RGBA whatever it compresses to on disk.');
  }
}

/** Every asset path a manifest references, in declaration order. */
export function manifestAssets(manifest) {
  const out = [];
  const take = (v) => { if (typeof v === 'string' && v.endsWith('.glb')) out.push(v); };
  const walk = (v) => {
    if (!v || typeof v !== 'object') return take(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk(manifest);
  return [...new Set(out)];
}
