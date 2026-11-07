// Exporters — GLB (binary glTF) and OBJ+MTL+PNG in a zip, written by hand so
// the app carries no exporter dependency. Both take plain typed arrays.
import { BAKED_ROUGHNESS } from './render-state.js';

const enc = new TextEncoder();
const pad4 = (n) => (n + 3) & ~3;

let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_T[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

export function makeZip(files) {
  const chunks = [], central = [];
  let off = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = [].concat([0x50,0x4b,0x03,0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
                         u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
    chunks.push(new Uint8Array(lh), name, data);
    const ch = [].concat([0x50,0x4b,0x01,0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
                         u32(crc), u32(data.length), u32(data.length), u16(name.length),
                         u16(0), u16(0), u16(0), u16(0), u32(0), u32(off));
    central.push({ head: new Uint8Array(ch), name });
    off += lh.length + name.length + data.length;
  }
  const cOff = off;
  let cSize = 0;
  for (const c of central) { chunks.push(c.head, c.name); cSize += c.head.length + c.name.length; }
  const eocd = [].concat([0x50,0x4b,0x05,0x06], u16(0), u16(0), u16(files.length), u16(files.length),
                         u32(cSize), u32(cOff), u16(0));
  chunks.push(new Uint8Array(eocd));
  let total = 0; chunks.forEach(c => total += c.length);
  const out = new Uint8Array(total);
  let p = 0; chunks.forEach(c => { out.set(c, p); p += c.length; });
  return new Blob([out], { type: 'application/zip' });
}

/**
 * Wavefront OBJ. Triangles from `indices` — unless the geometry carries the
 * quad pairing `smartMesh` produces (`quads`, 4 indices per face, and `tris`,
 * the leftovers), in which case the faces are written as quads where they were
 * paired. OBJ is the one format here that can say "quad"; the GLB cannot, and
 * carries the same surface as triangles.
 */
export function makeOBJ(geo, id) {
  const { positions, normals, uvs, indices, quads, tris } = geo;
  const nV = positions.length / 3;
  let o = `# ATLAS/ONE artifact ${id}\nmtllib atlas-${id}.mtl\no atlas_specimen\nusemtl specimen\n`;
  const v = [], vt = [], vn = [], f = [];
  for (let i = 0; i < nV; i++) {
    v.push(`v ${positions[i*3].toFixed(5)} ${positions[i*3+1].toFixed(5)} ${positions[i*3+2].toFixed(5)}`);
    vt.push(`vt ${uvs[i*2].toFixed(5)} ${uvs[i*2+1].toFixed(5)}`);
    vn.push(`vn ${normals[i*3].toFixed(4)} ${normals[i*3+1].toFixed(4)} ${normals[i*3+2].toFixed(4)}`);
  }
  const corner = (i) => `${i+1}/${i+1}/${i+1}`;
  if (quads && quads.length) {
    for (let q = 0; q < quads.length; q += 4)
      f.push(`f ${corner(quads[q])} ${corner(quads[q+1])} ${corner(quads[q+2])} ${corner(quads[q+3])}`);
    const rest = tris || new Uint32Array(0);
    for (let t = 0; t < rest.length; t += 3)
      f.push(`f ${corner(rest[t])} ${corner(rest[t+1])} ${corner(rest[t+2])}`);
  } else {
    for (let t = 0; t < indices.length; t += 3)
      f.push(`f ${corner(indices[t])} ${corner(indices[t+1])} ${corner(indices[t+2])}`);
  }
  o += v.join('\n') + '\n' + vt.join('\n') + '\n' + vn.join('\n') + '\n' + f.join('\n') + '\n';
  const mtl = `newmtl specimen\nKa 0 0 0\nKd 1 1 1\nKs 0.05 0.05 0.05\nNs 12\nmap_Kd atlas-${id}.png\n`;
  return [{ name: `atlas-${id}.obj`, data: enc.encode(o) },
          { name: `atlas-${id}.mtl`, data: enc.encode(mtl) }];
}

/**
 * GLB bytes. `makeGLB` wraps this in a Blob for the browser; tests want the
 * bytes, and a Blob is a poor place to keep something you have to parse back.
 *
 * @param {object} geo   {positions, normals, uvs, indices, colors}
 * @param {Uint8Array} pngBuf  the atlas
 * @param {string} id
 * @param {object|null} rig  {joints, bones, skinJoints, skinWeights} — when
 *   absent the output is byte-identical to the unrigged export, which is what
 *   keeps "static export remains available and unchanged" a testable claim
 *   rather than an intention.
 */
export function glbBytes(geo, pngBuf, id, rig = null, pbr = null) {
  const { positions, normals, uvs, indices, colors, sigma } = geo;
  const idxU32 = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  const nV = positions.length / 3;

  // THE UV ORIGIN, RECONCILED HERE AND NOWHERE ELSE.
  //
  // glTF 2.0 puts the TEXCOORD_0 origin at the UPPER-LEFT of the image. This
  // project builds UVs bottom-origin — `v = 1 - y/h` in atlas-core — which is
  // what a canvas-backed texture whose flipY defaults to true expects. Both are
  // internally consistent; writing the bottom-origin array into a glTF file is
  // what was not.
  //
  // It shipped for a long time because nothing rendered the EXPORTED BYTES under
  // the SPEC's convention: the certificate re-renders geometry only, the skin
  // checks positions, the relight suite scores fields. The one renderer that
  // looked at it agreed with the file, and it agreed because it was reading the
  // file's convention rather than glTF's. Measured, before this line existed:
  // correlation against the input photograph 0.9821 read bottom-origin, 0.0945
  // read top-origin.
  //
  // The flip belongs HERE, in the GLB writer, and must not move up into
  // atlas-core: `makeOBJ` reads the same array, and Wavefront `vt` IS
  // bottom-origin. Fixing it at the source would correct this file and break
  // that one.
  const uvGl = new Float32Array(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    uvGl[i] = uvs[i];
    uvGl[i + 1] = 1 - uvs[i + 1];
  }

  const skinned = !!(rig && rig.joints && rig.joints.length && rig.skinJoints && rig.skinWeights);
  const J = skinned ? rig.joints.length : 0;
  // Per-vertex σ rides as a custom attribute. glTF reserves unprefixed names, so
  // an application attribute has to start with an underscore; a reader that does
  // not know it ignores it and gets the same mesh. It goes last, after even the
  // normal map, so that adding it cannot shift any index the skinned or PBR
  // paths already depend on — the same reason the normal map goes where it does.
  const hasSigma = !!(sigma instanceof Float32Array && sigma.length === nV);
  let sigMin = 0, sigMax = 0;
  if (hasSigma) {
    sigMin = Infinity; sigMax = -Infinity;
    for (const v of sigma) { if (v < sigMin) sigMin = v; if (v > sigMax) sigMax = v; }
  }
  // σ is a LENGTH, and a length in the wrong units is worse than no length. The
  // attribute carries working-grid pixels — the units the uncertainty was
  // derived in — while the vertices are in model space, so the conversion has to
  // travel with the file or a reader will silently mix them. `calibrated` rides
  // along for the same reason: an exported σ whose coverage was never
  // established must not be read as one whose was.
  const sm = geo.sigmaMeta || {};
  const sigmaExtras = {
    units: 'working-grid pixels',
    pxToModel: sm.pxToModel === undefined ? null : sm.pxToModel,
    calibrated: sm.calibrated === undefined ? null : !!sm.calibrated,
    along: 'vertex normal',
    // The family and its shape parameter, and the multipliers they imply. A
    // reader that takes this attribute for a standard deviation and draws ±1 of
    // it would be quoting 68% for an interval that is not one: under a t with
    // ν ≈ 3 the 68% interval is 1.19 scales and the 95% is 3.18, where a
    // Gaussian's are 0.99 and 1.96. So the multipliers travel with the file
    // rather than being left for the reader to assume.
    family: sm.family || null,
    nu: sm.nu === undefined ? null : sm.nu,
    intervals: sm.intervals || null,
    note: sm.calibrated
      ? 'Scale of a Student-t predictive of the surface position along each vertex'
        + ' normal. Multiply by the factor in `intervals` for a named coverage level.'
      : 'UNCALIBRATED: monotone in uncertainty, and the interval multipliers in'
        + ' `intervals` are the fitted family\'s — but no coverage property has been'
        + ' established for them, so they name a shape and not a probability.',
  };

  // Inverse bind matrices. The bind pose has no rotation and no scale — a joint
  // sits where the medial axis put it — so the inverse of the global bind
  // transform is a pure negative translation. Column-major, as glTF requires.
  const ibm = new Float32Array(J * 16);
  for (let j = 0; j < J; j++) {
    const o = j * 16, p = rig.joints[j];
    ibm[o] = 1; ibm[o+5] = 1; ibm[o+10] = 1; ibm[o+15] = 1;
    ibm[o+12] = -p.x; ibm[o+13] = -p.y; ibm[o+14] = -p.z;
  }

  const parts = [
    new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
    new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength),
    new Uint8Array(uvGl.buffer, uvGl.byteOffset, uvGl.byteLength),
    new Uint8Array(colors.buffer, colors.byteOffset, colors.byteLength),
    new Uint8Array(idxU32.buffer, idxU32.byteOffset, idxU32.byteLength),
    pngBuf,
  ];
  if (skinned) parts.push(
    new Uint8Array(rig.skinJoints.buffer, rig.skinJoints.byteOffset, rig.skinJoints.byteLength),
    new Uint8Array(rig.skinWeights.buffer, rig.skinWeights.byteOffset, rig.skinWeights.byteLength),
    new Uint8Array(ibm.buffer, ibm.byteOffset, ibm.byteLength),
  );
  // The normal map goes last so the bufferView indices of everything before it
  // do not shift with whether the asset is skinned.
  const nmView = pbr && pbr.normalPng ? parts.length : -1;
  if (pbr && pbr.normalPng) parts.push(pbr.normalPng);
  const sigView = hasSigma ? parts.length : -1;
  if (hasSigma) parts.push(new Uint8Array(sigma.buffer, sigma.byteOffset, sigma.byteLength));
  const views = [];
  const bin = [];
  let boff = 0;
  for (const p of parts) {
    const start = boff;
    bin.push(p); boff += p.length;
    const padn = pad4(boff) - boff;
    if (padn) { bin.push(new Uint8Array(padn)); boff += padn; }
    views.push({ start, len: p.length });
  }
  const binBuf = new Uint8Array(boff);
  { let o = 0; for (const b of bin) { binBuf.set(b, o); o += b.length; } }

  const mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[i+k]); mx[k] = Math.max(mx[k], positions[i+k]); }

  // Joint nodes carry LOCAL translations, so the chain composes to the world
  // position the medial axis found; the IBMs above undo exactly that.
  const jointNodes = [];
  if (skinned) {
    const kids = rig.joints.map(() => []);
    rig.joints.forEach((p, j) => { if (p.parent >= 0) kids[p.parent].push(1 + j); });
    rig.joints.forEach((p, j) => {
      const par = p.parent >= 0 ? rig.joints[p.parent] : null;
      const node = { name: p.parent < 0 ? 'root' : `joint_${j}`,
                     translation: [p.x - (par ? par.x : 0), p.y - (par ? par.y : 0), p.z - (par ? par.z : 0)] };
      if (kids[j].length) node.children = kids[j];
      jointNodes.push(node);
    });
  }
  const rootJoint = skinned ? rig.joints.findIndex((p) => p.parent < 0) : -1;

  const json = {
    asset: { version: '2.0', generator: 'ATLAS/ONE' },
    scene: 0,
    scenes: [{ nodes: skinned ? [0, 1 + rootJoint] : [0] }],
    nodes: [skinned ? { mesh: 0, skin: 0, name: 'atlas_specimen' } : { mesh: 0, name: 'atlas_specimen' },
            ...jointNodes],
    meshes: [{ name: 'atlas_specimen', primitives: [{
      attributes: {
        ...(skinned
          ? { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3, JOINTS_0: 5, WEIGHTS_0: 6 }
          : { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3 }),
        ...(hasSigma ? { _SIGMA: skinned ? 8 : 5 } : {}),
      },
      indices: 4, material: 0, mode: 4,
      ...(hasSigma ? { extras: { ATLAS_sigma: sigmaExtras } } : {}) }] }],
    // the surface is closed and consistently wound, so single-sided is correct
    // and lets a viewer cull half the triangles
    materials: [{ name: pbr ? 'specimen_albedo' : 'specimen',
      // The baked default is BAKED_ROUGHNESS rather than a literal, because
      // anything presenting the baked material has to declare the same number
      // and two copies of it would be two places to forget.
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0,
                              roughnessFactor: pbr ? pbr.roughness : BAKED_ROUGHNESS },
      ...(pbr && pbr.normalPng ? { normalTexture: { index: 1 } } : {}),
      doubleSided: false }],
    textures: pbr && pbr.normalPng
      ? [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }]
      : [{ source: 0, sampler: 0 }],
    images: pbr && pbr.normalPng
      ? [{ bufferView: 5, mimeType: 'image/png' },
         { bufferView: nmView, mimeType: 'image/png' }]
      : [{ bufferView: 5, mimeType: 'image/png' }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nV, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: nV, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: nV, type: 'VEC2' },
      { bufferView: 3, componentType: 5126, count: nV, type: 'VEC3' },
      { bufferView: 4, componentType: 5125, count: idxU32.length, type: 'SCALAR' },
      // 5, 6, 7 exist only when skinned; a trailing undefined would serialise as
      // null and fail validation, so they are appended rather than reserved.
      ...(skinned ? [
        { bufferView: 6, componentType: 5123, count: nV, type: 'VEC4' },   // JOINTS_0
        { bufferView: 7, componentType: 5126, count: nV, type: 'VEC4' },   // WEIGHTS_0
        { bufferView: 8, componentType: 5126, count: J,  type: 'MAT4' },   // inverse bind
      ] : []),
      // _SIGMA, accessor 5 unskinned and 8 skinned — appended for the same
      // reason 5/6/7 are, so an absent one never serialises as a null.
      // `sigView` is an index into `parts`, and it is also the index into
      // `bufferViews` — the two arrays are built in the same order and the
      // optional entries appear in both or in neither, so they cannot drift.
      ...(hasSigma ? [{ bufferView: sigView, componentType: 5126, count: nV, type: 'SCALAR',
                        min: [sigMin], max: [sigMax] }] : []),
    ],
    bufferViews: [
      { buffer: 0, byteOffset: views[0].start, byteLength: views[0].len, target: 34962 },
      { buffer: 0, byteOffset: views[1].start, byteLength: views[1].len, target: 34962 },
      { buffer: 0, byteOffset: views[2].start, byteLength: views[2].len, target: 34962 },
      { buffer: 0, byteOffset: views[3].start, byteLength: views[3].len, target: 34962 },
      { buffer: 0, byteOffset: views[4].start, byteLength: views[4].len, target: 34963 },
      { buffer: 0, byteOffset: views[5].start, byteLength: views[5].len },
      ...(skinned ? [
        { buffer: 0, byteOffset: views[6].start, byteLength: views[6].len, target: 34962 },
        { buffer: 0, byteOffset: views[7].start, byteLength: views[7].len, target: 34962 },
        // The inverse bind matrices are not vertex data, so no target: a
        // bufferView bound to ARRAY_BUFFER that never reaches an attribute is a
        // validation error, not a harmless extra.
        { buffer: 0, byteOffset: views[8].start, byteLength: views[8].len },
      ] : []),
      ...(nmView >= 0 ? [{ buffer: 0, byteOffset: views[nmView].start, byteLength: views[nmView].len }] : []),
      ...(hasSigma ? [{ buffer: 0, byteOffset: views[sigView].start, byteLength: views[sigView].len,
                        target: 34962 }] : []),
    ],
    ...(skinned ? { skins: [{ joints: rig.joints.map((_, j) => 1 + j),
                              inverseBindMatrices: 7,
                              skeleton: 1 + rootJoint }] } : {}),
    buffers: [{ byteLength: boff }],
  };

  let jsonBuf = enc.encode(JSON.stringify(json));
  const jpad = pad4(jsonBuf.length) - jsonBuf.length;
  if (jpad) {
    const jj = new Uint8Array(jsonBuf.length + jpad);
    jj.set(jsonBuf);
    for (let i = 0; i < jpad; i++) jj[jsonBuf.length + i] = 0x20;   // pad JSON with spaces
    jsonBuf = jj;
  }
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, 0x46546C67, true); p += 4;   // 'glTF'
  dv.setUint32(p, 2, true); p += 4;
  dv.setUint32(p, total, true); p += 4;
  dv.setUint32(p, jsonBuf.length, true); p += 4;
  dv.setUint32(p, 0x4E4F534A, true); p += 4;   // 'JSON'
  out.set(jsonBuf, p); p += jsonBuf.length;
  dv.setUint32(p, binBuf.length, true); p += 4;
  dv.setUint32(p, 0x004E4942, true); p += 4;   // 'BIN'
  out.set(binBuf, p);
  return out;
}

export function makeGLB(geo, pngBuf, id, rig = null, pbr = null) {
  return new Blob([glbBytes(geo, pngBuf, id, rig, pbr)], { type: 'model/gltf-binary' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
