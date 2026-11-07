import fs from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { withMeshopt } from './_meshopt.mjs';

export function readGLB(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`Not a GLB: ${file}`);
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length));
  return { bytes, json, bin: Buffer.from(bytes.subarray(28 + length)) };
}

// CPU inspection needs the geometry, skin and clips, without a browser image decoder.
export async function loadGeometry({ json, bin }) {
  globalThis.ProgressEvent ??= class {};
  const j = structuredClone(json);
  j.buffers[0].uri = 'data:application/octet-stream;base64,' + bin.toString('base64');
  delete j.images; delete j.textures;
  for (const m of j.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    delete m.extensions;
    delete m.pbrMetallicRoughness?.baseColorTexture;
    delete m.pbrMetallicRoughness?.metallicRoughnessTexture;
  }
  return withMeshopt(new GLTFLoader()).parseAsync(JSON.stringify(j), '');
}

export function writeGLB(file, { json, bin }) {
  const str = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(str.length / 4) * 4, 32); str.copy(padded);
  const header = Buffer.alloc(20);
  [0x46546c67, 2, 28 + padded.length + bin.length, padded.length, 0x4e4f534a]
    .forEach((n, i) => header.writeUInt32LE(n, i * 4));
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([header, padded, bh, bin]));
}

export function accessor(glb, index) {
  const a = glb.json.accessors[index], view = glb.json.bufferViews[a.bufferView];
  if (a.componentType !== 5126 || a.sparse) throw new Error('Expected dense float accessor');
  const size = { VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? size * 4;
  return { a, size, offset: i => start + i * stride,
    get: i => Array.from({ length: size }, (_, c) => glb.bin.readFloatLE(start + i * stride + c * 4)),
    set: (i, v) => v.forEach((n, c) => glb.bin.writeFloatLE(n, start + i * stride + c * 4)) };
}
