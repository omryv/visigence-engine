/* export-world.js — the world as files another tool can open.
 *
 * A `.world.json` is the world as INSTRUCTIONS, and only this engine can
 * follow them. This module is the other direction: the world as RESULTS — a
 * GLB of the ground, a 16-bit heightmap, and the masks the terrain bake
 * already derives (slope, curvature, AO, flow, and when erosion ran, deposit
 * and wetness). engine/terrain/masks.js has said since it was written that
 * those masks exist "so a buyer can RE-AUTHOR the look instead of accepting
 * ours"; until now they were packed into a GPU texture and shipped to nobody.
 *
 * ── what the export is a picture OF ──
 * The session's actual ground: the baked field the caller hands over is
 * post-erosion and post-sculpt (studio bakes it through engine.sampleHeight),
 * and the vertex colours reproduce the editor's own colour pass — the same
 * elevation ramp, the same slope-and-concavity shade (shading.js, which the
 * masks also use "because the renderer and the export must not drift"), and
 * the same climate blend when the world has one.
 *
 * ── determinism ──
 * Same world, same bytes, the property every serialiser in this repo holds.
 * The GLB, the PNGs and the zip are all store-only deterministic encoders
 * (js/export/*); the manifest carries the canonical terrain fingerprint —
 * derived, never typed — and no clock is read anywhere on this path.
 *
 * ── and where it lands ──
 * A bundle a buyer cannot open is a demo. The bundle now ships its own
 * landing pads: unity/ carries the raw heightmap Unity reads natively and an
 * Editor importer that opens the whole thing as a scene (js/export/unity.js);
 * placements.json carries every authored transform for the studio, and
 * site.json the architect's room schedule — the interior pipeline's own
 * verdicts, exported rather than restated (js/export-site.js).
 *
 * Pure JS, no DOM: the Blob and the anchor are studio.js's thirty lines,
 * like Save. The suite builds a full bundle headless and walks it back out.
 */

import { createBakedSampler, elevNorm } from "../../kernel/terrain/heightfield.js";
import { epsFor, terrainShadeAt } from "../../kernel/terrain/shading.js";
import { canonicalStep } from "../../kernel/terrain/canonical.js";
import { bakeTerrainMasks } from "../../kernel/terrain/masks.js";
import { canonicalTerrainFingerprint } from "../../kernel/terrain/fingerprint.js";
import { createBiomeField } from "../../kernel/terrain/climate.js";
import { PALETTES, paletteLut, shadeInto, shadeIntoBlend } from "../style/palettes.js";
import { normalizeSeed, hashSeed } from "../../kernel/seed.js";
import { encodeGlb } from "./export/glb.js";
import { encodeGrayPng } from "./export/png.js";
import { encodeZip } from "./export/zip.js";
import { buildUnityFiles } from "./export/unity.js";
import { buildPlacementsFile, buildSiteFile } from "./export-site.js";

/* The mesh grid. The FIELD stays canonical 513² — that rule is about
   erosion, not presentation — but 513² is 263k vertices and a 16 MB file,
   and a mesh is presentation: 257² is 66k vertices, a ~4 MB GLB, and at 16 m
   spacing it holds every landform the 8 m field has that a viewer can see.
   The heightmap ships at full field resolution regardless, so nothing is
   lost — a buyer who wants denser geometry displaces it themselves, which is
   what the heightmap is FOR. */
export const EXPORT_MESH_RES = 257;

/**
 * The ground as one indexed mesh: positions in world metres (XZ centred on
 * the origin, Y up), per-vertex normals from central differences, colours
 * from the editor's own ramp and shade.
 */
export function buildTerrainMesh({ field, params, meshRes = EXPORT_MESH_RES }) {
  const sampler = createBakedSampler(field);
  const size = field.size, height = params.terrain.height;
  const res = meshRes, n = res * res;
  const step = size / (res - 1);
  const eps = epsFor(step);
  // The shade at the canonical step, not the export mesh's spacing — see
  // QuadtreeTerrain._buildTile: one step, one answer, so this bake and the
  // viewport agree about the same ground. Normals stay at the mesh's own eps,
  // because they light the tessellation this file actually ships.
  const shadeStep = canonicalStep(size);

  const biomes = createBiomeField(params, (name) => PALETTES[name]?.climate);
  const biomeLuts = biomes ? biomes.names.map((b) => paletteLut(PALETTES[b])) : null;
  const lut = paletteLut(PALETTES[params.biome] || PALETTES.verdant);

  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);

  let p = 0;
  for (let j = 0; j < res; j++) {
    const z = -size / 2 + j * step;
    for (let i = 0; i < res; i++, p++) {
      const x = -size / 2 + i * step;
      const y = sampler(x, z);
      positions[p * 3] = x; positions[p * 3 + 1] = y; positions[p * 3 + 2] = z;

      const hE = sampler(x + eps, z), hW = sampler(x - eps, z);
      const hS = sampler(x, z + eps), hN = sampler(x, z - eps);
      const dx = hE - hW, dz = hS - hN;
      const inv = 1 / Math.hypot(dx, 2 * eps, dz);
      normals[p * 3] = -dx * inv; normals[p * 3 + 1] = 2 * eps * inv; normals[p * 3 + 2] = -dz * inv;

      // The editor's own shade — the ONE implementation, at the ONE step.
      const shade = terrainShadeAt(sampler, x, z, shadeStep);
      if (biomes) {
        const cb = biomes.blendAt(x, z);
        shadeIntoBlend(colors, p, biomeLuts[cb.a], biomeLuts[cb.b], cb.mix, elevNorm(y, height), shade);
      } else {
        shadeInto(colors, p, lut, elevNorm(y, height), shade);
      }
    }
  }

  const indices = new Uint32Array((res - 1) * (res - 1) * 6);
  let q = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i, b = a + 1, d = a + res, e = d + 1;
      indices[q++] = a; indices[q++] = d; indices[q++] = b;
      indices[q++] = b; indices[q++] = d; indices[q++] = e;
    }
  }
  return { positions, normals, colors, indices };
}

/* The heightmap: full field resolution, 16 bits — 8 bits over a 420 m range
   is 1.6 m steps, which is visible terracing on any slope; 16 is 6 mm. The
   min/max it was normalised against ride in the manifest, because a
   heightmap without its scale is a picture, not a measurement. */
function heightmapPng(field) {
  const { res, data, min, max } = field;
  const range = max - min || 1;
  const out = new Uint16Array(res * res);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(((data[i] - min) / range) * 65535);
  }
  return encodeGrayPng({ width: res, height: res, depth: 16, data: out });
}

/**
 * The whole bundle: `{ name, files: [{ name, bytes }, …] }`, ready for
 * encodeZip. `delta` is the erosion delta as a Float32Array on the FIELD'S
 * OWN grid, or null. Engine.erosionDelta() answers `{ res, data }`; the
 * caller passes `.data` only when `.res` matches `field.res`, because a delta
 * on another grid would be silently misregistered sediment — masks.js guards
 * the length, and the res check is the honest version of the same guard.
 */
export function buildExportBundle({
  params, field, delta = null, origin = null, meshRes = EXPORT_MESH_RES,
  /* The other half of the world: what stands on the ground. `records` is
     engine.props.records(); `interiors` is the build's interior reports (one
     per building); `spawn` the authored spawn; `boundsFor(uid)` the editor's
     coarse extent for a placement. All optional — a terrain-only export is
     still an export, and the suite builds bundles with no engine at all. */
  records = null, interiors = null, spawn = null, boundsFor = () => null,
}) {
  const sampler = createBakedSampler(field);
  const cell = field.size / (field.res - 1);
  const masks = bakeTerrainMasks({
    sampler,
    res: field.res,
    spacingMeters: cell,
    sampleAt: (ix, iz) => [(ix / (field.res - 1) - 0.5) * field.size, (iz / (field.res - 1) - 0.5) * field.size],
    deposition: delta,
  });

  const mesh = buildTerrainMesh({ field, params, meshRes });
  const gray = (data) => encodeGrayPng({ width: field.res, height: field.res, depth: 8, data });

  const files = [
    { name: "terrain.glb", bytes: new Uint8Array(encodeGlb({ name: "terrain", ...mesh })) },
    { name: "heightmap.png", bytes: heightmapPng(field) },
    { name: "masks/slope.png", bytes: gray(masks.slope) },
    { name: "masks/curvature.png", bytes: gray(masks.curvature) },
    { name: "masks/ao.png", bytes: gray(masks.ao) },
    { name: "masks/flow.png", bytes: gray(masks.flow) },
  ];
  if (delta) {
    files.push({ name: "masks/deposit.png", bytes: gray(masks.deposit) });
    files.push({ name: "masks/wetness.png", bytes: gray(masks.wetness) });
  }

  /* The bridge: the raw heightmap Unity reads natively, the importer that
     opens the whole bundle as a scene, and the two JSON files that carry
     what stands on the ground — the studio's transforms and the architect's
     room schedule. Sold output has to LAND somewhere; this is where. */
  const enc = new TextEncoder();
  const json = (obj) => enc.encode(JSON.stringify(obj, null, 2) + "\n");
  files.push(...buildUnityFiles(field));
  if (records) {
    files.push({ name: "placements.json", bytes: json(buildPlacementsFile({ records, boundsFor })) });
  }
  if (interiors && interiors.length) {
    files.push({ name: "site.json", bytes: json(buildSiteFile({ params, interiors, records: records || [], spawn, origin })) });
  }

  const manifest = {
    kind: "worldgence.export",
    version: 2,
    origin: origin ? String(origin) : null,
    /* Derived, never typed — the same fingerprint the fingerprint module
       logs, so an export can be matched to the session that made it. */
    terrain: canonicalTerrainFingerprint({ params, field }),
    heightmap: {
      file: "heightmap.png", depth: 16, res: field.res,
      minMeters: field.min, maxMeters: field.max, sizeMeters: field.size,
      note: "height_m = min + (sample/65535) * (max - min); row 0 is z = -size/2",
    },
    mesh: { file: "terrain.glb", res: meshRes, vertexColors: "editor ramp × shade, linear floats" },
    masks: files.filter((f) => f.name.startsWith("masks/")).map((f) => f.name),
    placements: records ? "placements.json" : null,
    site: interiors && interiors.length ? "site.json" : null,
    unity: {
      importer: "unity/WorldgenceImporter.cs",
      heightmapRaw: "unity/heightmap.r16",
      note: "raw little-endian uint16, row 0 at z = -size/2; the importer performs the Z mirror Unity needs",
    },
    waterLevelMeters: params.water?.level || 0,
  };
  files.push({ name: "manifest.json", bytes: json(manifest) });

  return { name: exportZipName(params, origin), files };
}

/* Same derivation as worldFileName: from the world, never from the clock,
   so exporting twice offers the same name and the second overwrites the
   first. */
export function exportZipName(params, origin = null) {
  const slug = String(origin || params?.biome || "world")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "world";
  const seed = normalizeSeed(params?.seed) || "unseeded";
  const tag = (hashSeed(seed) >>> 0).toString(36).slice(0, 6);
  return `${slug}-${tag}.export.zip`;
}
