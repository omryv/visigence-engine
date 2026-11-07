/* glb.js — a GLB writer the size of what it writes.
 *
 * Everything this tool makes is trapped in this tool: a `.world.json` is the
 * world as INSTRUCTIONS, and only this engine can follow them. The one format
 * every DCC tool, every engine and every viewer can open is glTF, and the
 * usual way to write it is three's GLTFExporter — 2,800 lines vendored to
 * serialise animations, skins, cameras, extensions and texture transforms
 * this exporter will never produce. What a terrain export actually is: ONE
 * indexed triangle mesh with positions, normals and vertex colours. That is a
 * fixed JSON skeleton and four typed arrays laid end to end, which is this
 * file.
 *
 * The repo already holds the other half of the contract: js/glb-compat.js
 * validates GLB payloads "before they enter a record or an export", and the
 * round-trip test drives this writer's output through that inspector — the
 * writer and the checker are two independent readings of the spec, which is
 * what makes the test worth having.
 *
 * DETERMINISTIC BYTES, like the world file: same mesh in, same bytes out. No
 * timestamps, no random IDs, and the JSON is built from object literals whose
 * key order is fixed by construction. tests/export.test.js asserts it.
 *
 * Pure JS — no DOM, no three.js. Runs headless like every other pure module.
 */

const GLB_MAGIC = 0x46546c67;      // "glTF"
const CHUNK_JSON = 0x4e4f534a;     // "JSON"
const CHUNK_BIN = 0x004e4942;      // "BIN\0"

const F32 = 5126, U32 = 5125;                  // componentType
const ARRAY = 34962, ELEMENT = 34963;          // bufferView.target

function minMax3(arr) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = arr[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * One mesh → one GLB. `positions` (Float32Array, xyz), `indices`
 * (Uint32Array); `normals` and `colors` (Float32Array, xyz) optional.
 * Returns an ArrayBuffer.
 */
export function encodeGlb({ name = "terrain", positions, normals = null, colors = null, indices }) {
  if (!positions || !indices) throw new Error("encodeGlb: positions and indices are required");
  const vertCount = positions.length / 3;

  // ── the binary chunk: arrays end to end, each already 4-aligned ──
  const parts = [positions, normals, colors, indices].filter(Boolean);
  const binLength = parts.reduce((s, a) => s + a.byteLength, 0);
  const bin = new Uint8Array(binLength);
  const views = [];
  let offset = 0;
  for (const a of parts) {
    bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset);
    views.push({ buffer: 0, byteOffset: offset, byteLength: a.byteLength, target: a === indices ? ELEMENT : ARRAY });
    offset += a.byteLength;
  }

  // ── accessors, in the same order the views were laid down ──
  const attributes = {};
  const accessors = [];
  let view = 0;
  const bounds = minMax3(positions);
  attributes.POSITION = accessors.length;
  accessors.push({ bufferView: view++, componentType: F32, count: vertCount, type: "VEC3", min: bounds.min, max: bounds.max });
  if (normals) {
    attributes.NORMAL = accessors.length;
    accessors.push({ bufferView: view++, componentType: F32, count: vertCount, type: "VEC3" });
  }
  if (colors) {
    attributes.COLOR_0 = accessors.length;
    accessors.push({ bufferView: view++, componentType: F32, count: vertCount, type: "VEC3" });
  }
  const indexAccessor = accessors.length;
  accessors.push({ bufferView: view++, componentType: U32, count: indices.length, type: "SCALAR" });

  const json = {
    asset: { version: "2.0", generator: "worldgence" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices: indexAccessor, mode: 4 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews: views,
    accessors,
  };

  // ── assembly: header + JSON chunk (space-padded) + BIN chunk (zero-padded) ──
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (binLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;

  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonBytes, 20);
  u8.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);       // spaces, per spec
  const binStart = 20 + jsonPadded;
  dv.setUint32(binStart, binPadded, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  u8.set(bin, binStart + 8);                                    // pad bytes stay 0
  return out;
}
