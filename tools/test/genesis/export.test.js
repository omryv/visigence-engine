// The export: everything this tool makes has been trapped in this tool, and
// these are the contracts that let it out. Three store-only encoders — GLB,
// PNG, ZIP — and the bundle that assembles the ground, the heightmap and the
// masks into one deterministic file.
//
// Each format is verified by an INDEPENDENT reading of it, not by the writer's
// own bookkeeping: the GLB goes through js/glb-compat.js, whose inspector
// predates this writer and was built to check assets from anywhere; the PNG's
// zlib stream is re-inflated by a store-block walker written against the spec
// in this file; the zip's directory is parsed back out record by record. A
// writer tested against itself proves it agrees with itself.
import { test, eq, close, ok, report } from "../kernel/harness.js";
import { encodeGlb } from "../../../src/genesis/world/export/glb.js";
import { encodeGrayPng, zlibStore, crc32 } from "../../../src/genesis/world/export/png.js";
import { encodeZip } from "../../../src/genesis/world/export/zip.js";
import { buildTerrainMesh, buildExportBundle, exportZipName, EXPORT_MESH_RES } from "../../../src/genesis/world/export-world.js";
import { encodeR16, UNITY_IMPORTER_CS, UNITY_README } from "../../../src/genesis/world/export/unity.js";
import { buildPlacementsFile, buildSiteFile } from "../../../src/genesis/world/export-site.js";
import { inspectGlb } from "../../../src/genesis/world/glb-compat.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField, createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { hashBytes } from "../../../src/kernel/terrain/fingerprint.js";

// ── independent decoders, written against the specs ─────────────────────────

/* Inflate a store-only zlib stream: skip the 2-byte header, walk BTYPE-00
   blocks, concatenate their payloads. Anything with compressed blocks — which
   the encoder must never write — throws. */
function inflateStore(z) {
  const out = [];
  let o = 2, final = 0;
  while (!final) {
    final = z[o] & 1;
    const btype = (z[o] >> 1) & 3;
    if (btype !== 0) throw new Error(`not a store block (BTYPE ${btype})`);
    const len = z[o + 1] | (z[o + 2] << 8);
    const nlen = z[o + 3] | (z[o + 4] << 8);
    eq((len ^ 0xffff) & 0xffff, nlen, "NLEN is LEN's complement");
    out.push(z.subarray(o + 5, o + 5 + len));
    o += 5 + len;
  }
  const total = out.reduce((s, p) => s + p.length, 0);
  const raw = new Uint8Array(total);
  let w = 0;
  for (const p of out) { raw.set(p, w); w += p.length; }
  return raw;
}

function pngChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let o = 8;
  while (o < bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    chunks.push({ type, data: bytes.subarray(o + 8, o + 8 + len), crc: dv.getUint32(o + 8 + len) });
    o += 12 + len;
  }
  return chunks;
}

function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let o = 0;
  while (dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const crc = dv.getUint32(o + 14, true);
    const size = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const data = bytes.subarray(o + 30 + nameLen + extraLen, o + 30 + nameLen + extraLen + size);
    entries.push({ name, method, crc, data });
    o += 30 + nameLen + extraLen + size;
  }
  return entries;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

test("crc32 is the real CRC-32", () => {
  // "IEND" alone is the best-known constant in the format.
  eq(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44])), 0xae426082);
});

test("a store-only zlib stream inflates back to its input", () => {
  // Over a block boundary: 150,000 bytes is three blocks.
  const raw = new Uint8Array(150000);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >> 7)) & 0xff;
  const back = inflateStore(zlibStore(raw));
  eq(back.length, raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (back[i] !== raw[i]) throw new Error(`byte ${i} differs`);
  }
});

test("an 8-bit grayscale PNG round-trips pixel for pixel", () => {
  const w = 37, h = 23;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  const png = encodeGrayPng({ width: w, height: h, depth: 8, data });
  const chunks = pngChunks(png);
  eq(chunks[0].type, "IHDR");
  eq(chunks[chunks.length - 1].type, "IEND");
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
  eq(ihdr.getUint32(0), w); eq(ihdr.getUint32(4), h);
  eq(chunks[0].data[8], 8, "bit depth");
  eq(chunks[0].data[9], 0, "colour type: grayscale");
  const raw = inflateStore(chunks.find((c) => c.type === "IDAT").data);
  eq(raw.length, (w + 1) * h, "one filter byte per scanline");
  for (let y = 0; y < h; y++) {
    eq(raw[y * (w + 1)], 0, `row ${y} filter is none`);
    for (let x = 0; x < w; x++) eq(raw[y * (w + 1) + 1 + x], data[y * w + x], `pixel ${x},${y}`);
  }
});

test("a 16-bit heightmap PNG keeps all sixteen bits, big-endian", () => {
  const w = 5, h = 3;
  const data = new Uint16Array([0, 1, 255, 256, 65535, 32768, 12345, 54321, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  const png = encodeGrayPng({ width: w, height: h, depth: 16, data });
  const chunks = pngChunks(png);
  eq(chunks[0].data[8], 16, "bit depth 16");
  const raw = inflateStore(chunks.find((c) => c.type === "IDAT").data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 2 + 1) + 1 + x * 2;
      eq((raw[o] << 8) | raw[o + 1], data[y * w + x], `sample ${x},${y}`);
    }
  }
});

test("every chunk's CRC verifies", () => {
  const png = encodeGrayPng({ width: 8, height: 8, depth: 8, data: new Uint8Array(64) });
  for (const c of pngChunks(png)) {
    const body = new Uint8Array(4 + c.data.length);
    for (let i = 0; i < 4; i++) body[i] = c.type.charCodeAt(i);
    body.set(c.data, 4);
    eq(crc32(body), c.crc, `${c.type} CRC`);
  }
});

// ── GLB ─────────────────────────────────────────────────────────────────────

function quadMesh() {
  return {
    name: "quad",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 1, 1, 3, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
  };
}

test("the inspector this repo already trusts accepts the writer's GLB", () => {
  const info = inspectGlb(encodeGlb(quadMesh()));
  ok(info.ok, `rejected: ${info.reason}`);
  eq(info.version, 2);
  eq(info.meshes, 1);
  eq(info.images, 0);
});

test("the JSON chunk describes exactly the arrays that were written", () => {
  const glb = encodeGlb(quadMesh());
  const dv = new DataView(glb);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
  eq(json.asset.version, "2.0");
  const prim = json.meshes[0].primitives[0];
  eq(prim.mode, 4, "triangles");
  const posAcc = json.accessors[prim.attributes.POSITION];
  eq(posAcc.count, 4);
  eq(posAcc.type, "VEC3");
  // min/max are required on POSITION and loaders build bounds from them.
  eq(posAcc.min[0], 0); eq(posAcc.max[1], 3); eq(posAcc.max[2], 1);
  eq(json.accessors[prim.indices].count, 6);
  eq(json.buffers.length, 1);
  // Total binary length = the four arrays end to end.
  const m = quadMesh();
  eq(json.buffers[0].byteLength,
    m.positions.byteLength + m.normals.byteLength + m.colors.byteLength + m.indices.byteLength);
});

test("the binary chunk carries the vertex data verbatim", () => {
  const m = quadMesh();
  const glb = encodeGlb(m);
  const dv = new DataView(glb);
  const jsonPadded = dv.getUint32(12, true);
  const binStart = 20 + jsonPadded + 8;
  const pos = new Float32Array(glb, binStart, m.positions.length);
  for (let i = 0; i < m.positions.length; i++) eq(pos[i], m.positions[i], `position float ${i}`);
});

test("a GLB without optional attributes is still a valid GLB", () => {
  const m = quadMesh();
  const info = inspectGlb(encodeGlb({ name: "bare", positions: m.positions, indices: m.indices }));
  ok(info.ok, `rejected: ${info.reason}`);
});

// ── ZIP ─────────────────────────────────────────────────────────────────────

test("a zip walks back out entry by entry, bytes intact", () => {
  const files = [
    { name: "a.txt", bytes: new TextEncoder().encode("alpha") },
    { name: "dir/b.bin", bytes: new Uint8Array([0, 255, 1, 254, 2]) },
    { name: "empty", bytes: new Uint8Array(0) },
  ];
  const zip = encodeZip(files);
  const entries = zipEntries(zip);
  eq(entries.length, 3);
  for (let i = 0; i < files.length; i++) {
    eq(entries[i].name, files[i].name);
    eq(entries[i].method, 0, "store");
    eq(entries[i].crc, crc32(files[i].bytes), `${files[i].name} crc`);
    eq(entries[i].data.length, files[i].bytes.length);
    for (let k = 0; k < files[i].bytes.length; k++) eq(entries[i].data[k], files[i].bytes[k]);
  }
  // End record: entry count and directory reachable.
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  eq(dv.getUint32(eocd, true), 0x06054b50, "EOCD signature");
  eq(dv.getUint16(eocd + 10, true), 3, "entry count");
});

// ── the bundle ──────────────────────────────────────────────────────────────

function smallField(seed = "K7QN-3F2A-9XBD") {
  const p = makeParams({ seed });
  return { params: p, field: bakeHeightField(p, 65, createHeightSampler(p)) };
}

test("the terrain mesh is the field, coloured and closed", () => {
  const { params, field } = smallField();
  const mesh = buildTerrainMesh({ field, params, meshRes: 33 });
  eq(mesh.positions.length, 33 * 33 * 3);
  eq(mesh.indices.length, 32 * 32 * 6);
  for (const i of mesh.indices) ok(i < 33 * 33, "index in range");
  for (let v = 0; v < 33 * 33; v++) {
    const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    close(Math.hypot(nx, ny, nz), 1, 1e-4, `normal ${v} unit length`);
    ok(ny > 0, "ground normals point up");
    for (let k = 0; k < 3; k++) {
      const c = mesh.colors[v * 3 + k];
      ok(c >= 0 && c <= 1.0001, `colour channel in range: ${c}`);
    }
  }
});

test("the bundle holds the ground, the heightmap, the masks and its own account", () => {
  const { params, field } = smallField();
  const bundle = buildExportBundle({ params, field, meshRes: 33 });
  const names = bundle.files.map((f) => f.name);
  for (const want of ["terrain.glb", "heightmap.png", "masks/slope.png", "masks/curvature.png",
                      "masks/ao.png", "masks/flow.png", "manifest.json"]) {
    ok(names.includes(want), `bundle carries ${want}`);
  }
  ok(!names.includes("masks/deposit.png"), "no deposition mask without a delta");

  const manifest = JSON.parse(new TextDecoder().decode(bundle.files.find((f) => f.name === "manifest.json").bytes));
  eq(manifest.kind, "worldgence.export");
  close(manifest.heightmap.minMeters, field.min, 1e-9);
  close(manifest.heightmap.maxMeters, field.max, 1e-9);
  eq(manifest.terrain.seed, params.seed, "fingerprint carries the seed");
  eq(manifest.terrain.resolution, field.res, "fingerprint measured the field, not the mesh");

  const glb = bundle.files.find((f) => f.name === "terrain.glb").bytes;
  ok(inspectGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)).ok, "the GLB in the bundle inspects clean");
});

test("a delta adds the two erosion masks", () => {
  const { params, field } = smallField();
  const delta = new Float32Array(field.res * field.res);
  for (let i = 0; i < delta.length; i++) delta[i] = Math.sin(i * 0.01) * 0.8;
  const names = buildExportBundle({ params, field, delta, meshRes: 33 }).files.map((f) => f.name);
  ok(names.includes("masks/deposit.png"), "deposit mask present");
  ok(names.includes("masks/wetness.png"), "wetness mask present");
});

test("exporting the same world twice is the same bytes twice", () => {
  const a = buildExportBundle({ ...smallField(), meshRes: 33 });
  const b = buildExportBundle({ ...smallField(), meshRes: 33 });
  eq(a.name, b.name);
  const za = encodeZip(a.files), zb = encodeZip(b.files);
  eq(za.length, zb.length);
  eq(hashBytes(za), hashBytes(zb), "zip bytes identical");
});

test("the export's name comes from the world, never from the clock", () => {
  const p = makeParams({ seed: "K7QN-3F2A-9XBD" });
  const name = exportZipName(p, "farshore");
  ok(name.startsWith("farshore-"), name);
  ok(name.endsWith(".export.zip"), name);
  eq(exportZipName(p, "farshore"), name, "stable");
  ok(exportZipName(p, null).startsWith(p.biome + "-"), "origin-less worlds fall back to the biome");
});

test("a climate world exports with its blended colours, not a crash", () => {
  const { params, field } = smallField();
  params.climate = { biomes: ["verdant", "tundra", "badlands"], scale: 1 };
  const mesh = buildTerrainMesh({ field, params, meshRes: 33 });
  let finite = true;
  for (const c of mesh.colors) if (!Number.isFinite(c)) finite = false;
  ok(finite, "every colour channel is a number");
});

/* ══ the bridge — where a sold world lands ══════════════════════════════════
   What is sold is the output, and an output nobody can open is a demo. These
   hold the three landing pads: the raw heightmap Unity reads natively, the
   importer that ships inside the bundle it imports, and the two JSON files
   that carry the scene and the room schedule. */

const FAKE_RECORDS = [
  { uid: "p1-0", label: "Pink House", ref: "house", position: [10.123, 4.567, -20.891],
    rotationY: 1.5707, scale: 1, use: { kind: "door", verb: "open" } },
  { uid: "p2-1", label: "Oak", ref: "oak", position: [-3, 0, 8], rotationY: 0, scale: 1.2 },
  { uid: "p3-2", label: "Imported Rock", url: "blob:whatever", position: [0, 0, 0], rotationY: 0, scale: 1 },
];

const FAKE_INTERIOR = {
  uid: "p1-0", label: "Pink House", archetype: "cottage", at: "ground",
  people: { occupants: 4, children: 2, trade: "fisher" },
  zones: [
    { index: 0, purpose: "kitchen", w: 3.2, d: 2.8, door: true },
    { index: 1, purpose: "parlour", w: 4.1, d: 3.6 },
  ],
  doors: [{}],
  rooms: [{ check: { ok: true, violations: [] }, attempt: 0 }],
  check: { ok: true, violations: [], stats: { reachedZones: 2, zones: 2, walkFrac: 0.62 } },
};

test("the raw heightmap is the field, little-endian, recoverable to metres", () => {
  const { field } = smallField();
  const raw = encodeR16(field);
  eq(raw.length, field.res * field.res * 2, "res*res*2 bytes");
  const view = new DataView(raw.buffer);
  const range = field.max - field.min;
  for (const i of [0, 1, field.res * 3 + 7, field.res * field.res - 1]) {
    const back = field.min + (view.getUint16(i * 2, true) / 65535) * range;
    close(back, field.data[i], range / 65535 + 1e-6, `sample ${i} recovers to metres`);
  }
});

test("the importer ships whole: no template holes, no interpolation accidents", () => {
  ok(UNITY_IMPORTER_CS.includes("class WorldgenceImporter"), "the class is there");
  ok(UNITY_IMPORTER_CS.includes("[MenuItem("), "the menu item is there");
  ok(UNITY_IMPORTER_CS.includes("res - 1 - z"), "the Z mirror is in the reader");
  // The one hazard of C# inside a JS template literal, asserted rather than
  // hoped: nothing in the source reads as an unexpanded JS interpolation.
  ok(!UNITY_IMPORTER_CS.includes("${"), "no JS interpolation leaked into the C#");
  ok(!UNITY_IMPORTER_CS.includes("`"), "no backtick survives inside the template");
  ok(UNITY_README.includes("Assets/Editor"), "the README says where the importer goes");
});

test("placements.json carries every transform and names what it cannot carry", () => {
  const file = buildPlacementsFile({ records: FAKE_RECORDS, boundsFor: (uid) => uid === "p1-0" ? { size: 6.2, above: 5.1, below: 0.2 } : null });
  eq(file.kind, "worldgence.placements");
  eq(file.count, 3, "every record travels — an omitted GLB still keeps its transform");
  const house = file.placements.find((p) => p.uid === "p1-0");
  eq(house.position[0], 10.12, "positions round to centimetres");
  eq(house.verb, "open", "the affordance verb travels");
  eq(house.bounds.size, 6.2, "the measured extent travels");
  const oak = file.placements.find((p) => p.uid === "p2-1");
  eq(oak.bounds, null, "no extent is no extent, not a made-up one");
  eq(file.omitted.length, 1, "the GLB import is named");
  eq(file.omitted[0].uid, "p3-2");
});

test("site.json is the checker's own schedule, joined to the shell's transform", () => {
  const { params } = smallField();
  const site = buildSiteFile({ params, interiors: [FAKE_INTERIOR], records: FAKE_RECORDS, spawn: { x: 5.678, z: -9 }, origin: "farshore" });
  eq(site.kind, "worldgence.site");
  eq(site.units, "metres");
  eq(site.totals.buildings, 1);
  eq(site.totals.rooms, 2);
  eq(site.totals.occupants, 4);
  const b = site.buildings[0];
  eq(b.position[0], 10.12, "the schedule stands where the shell stands");
  eq(b.rooms[0].areaM2, 8.96, "area is width times depth, rounded");
  eq(b.rooms[0].opensOffEntry, true);
  eq(b.validated.ok, true);
  eq(b.validated.roomsReachable, 2);
  close(b.validated.walkableFraction, 0.62, 1e-9);
  eq(site.spawn.x, 5.68);
});

test("the full bundle carries the bridge, and the manifest names all of it", () => {
  const { params, field } = smallField();
  const bundle = buildExportBundle({
    params, field, meshRes: 33,
    records: FAKE_RECORDS, interiors: [FAKE_INTERIOR], spawn: { x: 0, z: 0 }, origin: "farshore",
  });
  const names = bundle.files.map((f) => f.name);
  for (const want of ["unity/heightmap.r16", "unity/WorldgenceImporter.cs", "unity/README.txt",
                      "placements.json", "site.json"]) {
    ok(names.includes(want), `bundle carries ${want}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(bundle.files.find((f) => f.name === "manifest.json").bytes));
  eq(manifest.version, 2);
  eq(manifest.heightmap.res, field.res, "the importer needs the res and the manifest carries it");
  eq(manifest.placements, "placements.json");
  eq(manifest.site, "site.json");
  eq(manifest.unity.importer, "unity/WorldgenceImporter.cs");
  // …and a terrain-only export is still an export, with nothing half-claimed.
  const bare = buildExportBundle({ params, field, meshRes: 33 });
  const bareManifest = JSON.parse(new TextDecoder().decode(bare.files.find((f) => f.name === "manifest.json").bytes));
  eq(bareManifest.placements, null);
  eq(bareManifest.site, null);
  ok(bare.files.some((f) => f.name === "unity/heightmap.r16"), "the terrain still lands in Unity");
});

test("the bridge does not cost determinism: same world, same bytes, still", () => {
  const make = () => buildExportBundle({
    ...smallField(), meshRes: 33,
    records: FAKE_RECORDS, interiors: [FAKE_INTERIOR], spawn: { x: 1, z: 2 }, origin: "farshore",
  });
  const za = encodeZip(make().files), zb = encodeZip(make().files);
  eq(za.length, zb.length);
  eq(hashBytes(za), hashBytes(zb), "zip bytes identical with the bridge aboard");
});

report("export");
