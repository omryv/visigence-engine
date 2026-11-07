/**
 * A minimal glTF 2.0 binary writer: one box mesh, one PBR material, one node, one scene.
 *
 * Exists for the browser smoke harness (tools/test/e2e-genres.mjs), which runs the real
 * session against STAND-IN geometry where the R2 art is unreachable: every model the
 * missions load becomes a box of roughly the right size, so the loader, the animators,
 * the batching and the collision proxies all run their real code over real GLB bytes,
 * and only the pixels are wrong. It is not an art tool.
 */

const PAD4 = n => (n + 3) & ~3;

/**
 * @param {object} o
 * @param {number} [o.width]  x extent, metres
 * @param {number} [o.height] y extent; the box stands on y = 0
 * @param {number} [o.depth]  z extent
 * @param {string} [o.name]   node and mesh name
 * @param {number[]} [o.color] RGBA base colour
 * @returns {Buffer} the .glb bytes
 */
/**
 * A box, or with `parts` (ids, or {id, sockets}) a parts LIBRARY: one node per part, every node the same box, the id on the node's name
 * (with '.' and ':' made '_', as GLTFLoader would) and verbatim in its extras, which the assemblers read as
 * userData.name (render/HouseAssembler.js and its siblings index a library by it). `material` names the one material,
 * so a library's colour slots read as the art's would (HSE_Wall, TRE_Leaf, CRT_Body).
 */
export function boxGlb({ width = 1, height = 1, depth = 1, name = 'stand-in', color = [0.6, 0.62, 0.66, 1], parts = null, material = null } = {}) {
  const hx = width / 2, hz = depth / 2, y0 = 0, y1 = height;
  // 6 faces x 4 vertices; normals per face; simple uvs.
  const faces = [
    { n: [0, 0, 1], v: [[-hx, y0, hz], [hx, y0, hz], [hx, y1, hz], [-hx, y1, hz]] },
    { n: [0, 0, -1], v: [[hx, y0, -hz], [-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz]] },
    { n: [1, 0, 0], v: [[hx, y0, hz], [hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz]] },
    { n: [-1, 0, 0], v: [[-hx, y0, -hz], [-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz]] },
    { n: [0, 1, 0], v: [[-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz], [-hx, y1, -hz]] },
    { n: [0, -1, 0], v: [[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]] },
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  faces.forEach((f, i) => {
    const base = i * 4;
    for (const [k, p] of f.v.entries()) { positions.push(...p); normals.push(...f.n); uvs.push(k & 1, k >> 1); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const pos = new Float32Array(positions), nor = new Float32Array(normals), uv = new Float32Array(uvs), idx = new Uint16Array(indices);
  // A library's nodes: each part (the box) followed by its sockets, empty children the assemblers read by
  // `extras.socket`, half a box up so a part hung from one is visible.
  const library = { nodes: [], roots: [] };
  for (const part of parts ?? []) {
    const { id, sockets = [] } = typeof part === 'string' ? { id: part } : part;
    const at = library.nodes.length;
    library.roots.push(at);
    library.nodes.push({ mesh: 0, name: id.replace(/[.:]/g, '_'), extras: { name: id }, ...(sockets.length ? { children: sockets.map((_, k) => at + 1 + k) } : {}) });
    for (const socket of sockets) library.nodes.push({ name: `${id}_${socket}`.replace(/[.:]/g, '_'), extras: { socket }, translation: [0, height / 2, 0] });
  }
  const arrays = [pos, nor, uv, idx];
  const views = []; let offset = 0;
  const bin = Buffer.alloc(arrays.reduce((n, a) => n + PAD4(a.byteLength), 0));
  for (const a of arrays) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(bin, offset);
    views.push({ buffer: 0, byteOffset: offset, byteLength: a.byteLength, ...(a === idx ? { target: 34963 } : { target: 34962 }) });
    offset += PAD4(a.byteLength);
  }
  const json = {
    asset: { version: '2.0', generator: 'visigames stand-in' },
    scene: 0,
    scenes: [{ nodes: parts ? library.roots : [0] }],
    nodes: parts ? library.nodes : [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: material ?? `${name}-material`, pbrMetallicRoughness: { baseColorFactor: color, metalness: 0.1, roughnessFactor: 0.8 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-hx, y0, -hz], max: [hx, y1, hz] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  delete json.materials[0].pbrMetallicRoughness.metalness; json.materials[0].pbrMetallicRoughness.metallicFactor = 0.1;
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(4 - jsonBytes.length % 4, 0x20)]);
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

/** A 4x4 opaque PNG of one colour. */
export function tinyPng([r, g, b] = [120, 124, 130]) {
  const zlib = globalThis.process ? require_('node:zlib') : null;
  const w = 4, h = 4, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A tenth of a second of silence as a 16-bit mono WAV; decodes whatever the file's name says. */
export function tinyWav() {
  const rate = 8000, samples = 800, data = Buffer.alloc(samples * 2);
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}

export const tinySvg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#4a6b7a"/></svg>');

let table = null;
function crc32(buf) {
  if (!table) { table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
