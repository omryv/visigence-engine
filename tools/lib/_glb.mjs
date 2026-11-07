/**
 * A GLB reader for the offline tools: geometry only, in the file's own scene space.
 *
 * The measurement tools each carry their own three-line GLB parse because each needs one
 * attribute out of one primitive. The offline RENDERER needs more than that - normals, the
 * index buffer, and every node's full TRS chain - so it is written once, here, and returns a
 * flat list of primitives with each one's world matrix already accumulated.
 *
 * glTF only, no Draco, no sparse accessors, no morph targets: which is exactly what the four
 * view-model GLBs in assets/ contain.
 */

import fs from 'node:fs';
import { MeshoptDecoder } from '../../vendor/three/examples/jsm/libs/meshopt_decoder.module.js';

// The shipped models are EXT_meshopt_compression-packed (the same decoder the game vendors
// beside GLTFLoader). Its WebAssembly is ready before the first parse; decoding is then
// synchronous, so the readers below stay synchronous too.
await MeshoptDecoder.ready;

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMP_GET = {
  5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16',
  5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32',
};
const NUM_COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Split a .glb container into its JSON chunk and its binary chunk. */
export function parseGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const total = dv.getUint32(8, true);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + len)));
    else if (type === 0x004e4942) bin = buf.subarray(start, start + len);
    off = start + len;
  }
  if (!json) throw new Error('GLB: no JSON chunk');
  // Decode every meshopt-compressed bufferView in place: `_decoded` carries the plain bytes
  // and readAccessor reads from it, at offset 0, with the view's own stride.
  for (const bv of json.bufferViews || []) {
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (!ext) continue;
    const source = bin.subarray(ext.byteOffset || 0, (ext.byteOffset || 0) + ext.byteLength);
    const target = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(target, ext.count, ext.byteStride, source, ext.mode, ext.filter);
    bv._decoded = target; bv.byteStride = ext.byteStride;
  }
  return { json, bin };
}

/** One accessor as a Float64Array of `count * components` values. */
export function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const nc = NUM_COMP[acc.type];
  const cs = COMP_SIZE[acc.componentType];
  const bv = json.bufferViews[acc.bufferView];
  const src = bv._decoded || bin;
  const base = (bv._decoded ? 0 : (bv.byteOffset || 0)) + (acc.byteOffset || 0);
  const stride = bv.byteStride || nc * cs;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const get = COMP_GET[acc.componentType];
  const out = new Float64Array(acc.count * nc);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < nc; c++) out[i * nc + c] = dv[get](base + i * stride + c * cs, true);
  }
  return { data: out, count: acc.count, components: nc };
}

/** Column-major 4x4 from a node's TRS, in the same layout three uses. */
function trsMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/**
 * Every mesh primitive in the file, with its accumulated node matrix.
 *
 * @returns {{positions: Float64Array, normals: Float64Array|null, index: Uint32Array,
 *            matrix: number[], name: string}[]}
 */
export function loadGLBPrimitives(file) {
  const { json, bin } = parseGLB(fs.readFileSync(file));
  const out = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  const walk = (nodeIdx, parent) => {
    const node = json.nodes[nodeIdx];
    const world = mul(parent, trsMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes.POSITION === undefined) continue;
        const pos = readAccessor(json, bin, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined
          ? readAccessor(json, bin, prim.attributes.NORMAL).data : null;
        let index;
        if (prim.indices !== undefined) {
          index = Uint32Array.from(readAccessor(json, bin, prim.indices).data);
        } else {
          index = new Uint32Array(pos.count);
          for (let i = 0; i < pos.count; i++) index[i] = i;
        }
        out.push({
          positions: pos.data, normals: nrm, index, matrix: world,
          name: node.name || json.meshes[node.mesh].name || `mesh${node.mesh}`,
        });
      }
    }
    for (const c of node.children || []) walk(c, world);
  };

  const scene = json.scenes[json.scene ?? 0];
  for (const n of scene.nodes) walk(n, identity);
  return out;
}
