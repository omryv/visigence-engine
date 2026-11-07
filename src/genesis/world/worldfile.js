// worldfile.js — the world as a file, and the only thing this tool makes that
// outlives the tab.
//
// The README's first rule is that `params` is the whole world: a small JSON
// object plus a seed, kilobytes rather than megabytes, holding INSTRUCTIONS
// rather than assets. This module takes that claim at its word. A `.world`
// file is the params, the placements and the derived spawn, wrapped in a
// versioned envelope. Everything downstream — the terrain, the water, the
// grass, the erosion, the four thousand trees — is re-derived from it, which
// is why a whole world weighs what a photograph of it would not.
//
// NOTHING HERE TOUCHES STORAGE. No localStorage, no sessionStorage, no
// cookie, no IndexedDB, no network. Nothing on this origin touches storage at
// both ends and tests/vault.test.js still passes unchanged. The distinction
// the README now has to make is a real one and worth stating plainly: the
// TOOL writes nothing to this machine; a file exists because somebody chose
// to save it through their own browser's save dialog. That is a different
// claim from the old one, and it is the only constraint any of this bends.
//
// The browser half — the Blob, the anchor, the file input — is thirty lines in
// studio.js. Everything in this module is pure JS with no DOM and no three.js,
// so the suite runs it headless like the rest of the pure modules.
//
// ── what a file deliberately does NOT carry ──
// Imported GLB bytes. A file that embedded them would stop being kilobytes,
// would stop being JSON, and would carry geometry this origin is not allowed
// to fetch back (`default-src 'none'`, and `tests/worlds.test.js` asserts
// every block a generated world reaches is procedural and carries no url).
// So imports are NAMED AND DROPPED rather than silently lost: `omitted` lists
// what was left behind, and the importer says so out loud. A generated world
// has none of these and round-trips exactly.
//
// ── the ground block, and why the file version did not move ──
// A file may also carry `ground`: the receipt groundBundle wrote when it baked
// this world (engine/terrain/ground.js), cut down to the eight lines a reader
// needs to say "this is the ground I stand on" without baking it —
// generatorVersion, res, size, parameterHash, heightHash, landMaskHash,
// flowMaskHash and waterLevel. It is written ONLY when the caller hands a
// manifest in, so every file that has been saved without one is the same
// bytes it was (tests/worldfile.test.js pins a v1 file's serialisation from
// before the block existed, and the default world's, against that).
//
// WORLD_FILE_VERSION stays 1, deliberately. The block is additive and
// optional: a file without it is a v1 file in every sense, and a file with it
// is ALSO one, because every reader of this envelope — this one, and every
// build before it — ignores a key it does not know rather than refusing the
// file. A bump would have bought nothing but a migration path for a shape that
// did not change, and it would have made every older build refuse files that
// it can, in fact, load. What the block is held to when it IS present is
// validateGround below: eight well-formed numbers, and agreement with the
// params on the three that the params decide (parameterHash, size, waterLevel).
// Whether the HASHES are true is not a validation question — answering it
// costs a bake — and is what js/certificate.js verifyCertificate's tier 2 is.

import { buildFusionRecord, validateFusionRecord, FUSION_VERSION } from "./fusion.js";
import { normalizeSeed, hashSeed } from "../../kernel/seed.js";
import { GENERATOR_VERSION, terrainParameterHash } from "../../kernel/terrain/fingerprint.js";
import { intentErrors } from "../../kernel/terrain/condition.js";

export const WORLD_FILE_KIND = "worldgence.world";
export const WORLD_FILE_VERSION = 1;
export const WORLD_FILE_EXT = ".world.json";

/* The ground block's lines, in the order a file writes them. A subset of the
   manifest (schema/ground.schema.json): the bounds, the delta and the stage
   list stay with the bake — min/max are recomputed by anybody who bakes, and
   a timing is not a fact about the world. */
export const GROUND_BLOCK_FIELDS = Object.freeze([
  "generatorVersion", "res", "size", "parameterHash",
  "heightHash", "landMaskHash", "flowMaskHash", "waterLevel",
]);

/** The ground block a file carries for a manifest: GROUND_BLOCK_FIELDS, in
    that order, copied. Throws on a manifest that lacks one — a block with a
    hole in it is a claim with a hole in it. */
export function groundBlock(manifest) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("groundBlock: a ground manifest is required");
  const out = {};
  for (const k of GROUND_BLOCK_FIELDS) {
    if (manifest[k] === undefined) throw new TypeError(`groundBlock: the manifest has no ${k}`);
    out[k] = manifest[k];
  }
  return out;
}

/* A placement has geometry of its own when it carries a spec, or an index into
   the file's geometry table. */
const hasGeometry = (p) => !!p.proc || p.procRef != null;

/* A placement carries bytes we cannot serialise when it names a URL or an
   import key and has no geometry of its own. Generated worlds never do. */
function isImportedAsset(p) {
  return !hasGeometry(p) && (!!p.url || !!p.bytesKey);
}

/* ── the shape of a placement on disk ──
   `buildFusionRecord` enumerates every field it carries, nulls included, and
   that is right for a handoff: a field not named there does not exist on the
   far side. It is wrong for a file. A furnished city is thousands of
   placements and most of them are a catalogue block sitting on the ground
   with no tint, no stretch, no style, no affordance and no import key — nine
   fields of `null` each, written out in full, several hundred bytes of
   nothing per piece.

   So a placement is written without the fields that hold their default, and
   read back with them restored. The record the engine is handed is identical
   either way, which `tests/worldfile.test.js` asserts against the engine's
   own field list rather than against this table. */
const PLACEMENT_DEFAULTS = {
  ref: null, url: null, bytesKey: null, placeholder: false,
  rotationY: 0, scale: 1, seat: null, tint: null, stretch: null,
  style: null, use: null, proc: null,
};

function compactPlacement(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k in PLACEMENT_DEFAULTS && sameAsDefault(v, PLACEMENT_DEFAULTS[k])) continue;
    out[k] = v;
  }
  return out;
}

function expandPlacement(p) {
  const out = { ...PLACEMENT_DEFAULTS, ...p };
  // `proc` is restored from the table by the reader, never from this default.
  if (p.procRef != null) delete out.proc;
  return out;
}

function sameAsDefault(v, d) {
  if (v === d) return true;
  // Absent is the same as defaulted; `undefined` never reaches JSON anyway.
  return v === undefined || (d === null && v === null);
}

/* ── build ──
   `bakedAt` is threaded rather than read from the clock so that saving the
   same world twice produces the same bytes, and so the round-trip test can
   assert byte-identity instead of asserting everything-except-one-field. */
export function buildWorldFile({ params, propRecords, field, world = null, tactics = null, bakedAt = 0, spawn = null, ground = null }) {
  /* `spawn` IS THE AUTHORED LANDING, and it has to be threaded rather than
     re-derived. deriveSpawn falls back to `settlements[0]` — the top-scoring
     habitable cell — whenever no override reaches it, and this function used
     not to take one at all. So the spawn tool set a landing, the ring drew
     where the author clicked, and Save then wrote the cell the scorer liked
     instead: on a coastal seed, a beach a kilometre away. Every authored
     spawn was lost at every save, and `deriveSpawn`'s own `authored: true`
     branch (js/fusion.js) was unreachable in the product.
     Null means "nobody authored one", which is the generated case and still
     derives exactly as before. */
  const record = buildFusionRecord({ params, propRecords, field, tactics, spawnOverride: spawn });
  record.bakedAt = bakedAt;

  const omitted = record.props.filter(isImportedAsset).map((p) => ({ uid: p.uid, label: p.label || "imported model" }));
  record.props = record.props.filter((p) => !isImportedAsset(p));
  // `assets` is the bytesKey → ArrayBuffer map the IndexedDB handoff used to
  // clone. JSON cannot hold an ArrayBuffer and this file is JSON, so the map
  // goes with the placements that referenced it.
  delete record.assets;

  const doc = {
    kind: WORLD_FILE_KIND,
    fileVersion: WORLD_FILE_VERSION,
    // The terrain pipeline that scored everything below — see generatorNote.
    // Written here rather than computed on read: by the time anybody asks,
    // the generator that produced this file is gone.
    generatorVersion: GENERATOR_VERSION,
    // The world grammar this came out of ("farshore"…), when it came out of
    // one at all. Advisory: the file is complete without it, and a world
    // sculpted from scratch has no grammar to name.
    origin: world ? String(world) : null,
    omitted,
    // The geometry table — see dedupeProcs. Written before `world` so a person
    // opening the file meets the small thing first.
    procs: dedupeProcs(record.props),
    world: { ...record, props: record.props.map(compactPlacement) },
  };
  /* The ground receipt, only when there is one — see the header. Written last
     so a file without it is, key for key, the file it always was. A manifest
     baked from other params is refused here rather than saved: the file would
     fail its own validation the moment it was opened. */
  if (ground) {
    doc.ground = groundBlock(ground);
    const bad = validateGround(doc.ground, params);
    if (bad.length) throw new TypeError(`buildWorldFile: ${bad.join("; ")}`);
  }
  return doc;
}

/* ── the geometry table ──
   A composed town is over a thousand placements and it is built out of a few
   dozen SHAPES: every chair in it carries the same part list, and so does
   every wall segment, every roof panel and every pale in a fence. Carrying
   `proc` on each placement writes that catalogue out once per piece, which is
   how Crownway's file first measured 5.6 MB — nearly all of it the same few
   hundred bytes copied twelve hundred times.

   So the distinct specs go in a table and each placement keeps an index into
   it. The saving is the duplication rate and nothing else: no spec is
   approximated, nothing is rounded, and `propsFromWorldFile` hands back
   exactly the object that went in. Mutates `props` in place — it is called on
   a record this function just built and owns. */
function dedupeProcs(props) {
  const procs = [];
  const seen = new Map(); // canonical JSON → index
  for (const p of props) {
    if (!p.proc) continue;
    const key = JSON.stringify(p.proc);
    let i = seen.get(key);
    if (i === undefined) { i = procs.length; seen.set(key, i); procs.push(p.proc); }
    p.procRef = i;
    delete p.proc;
  }
  return procs;
}

/* ── the terrain numbers that are load-bearing rather than merely wrong ──
   Most of `params` degrades gracefully: a silly `gain` makes an ugly world,
   not a broken one, and refusing files over taste would be its own kind of
   data loss. These three do not degrade. They decide whether the load can
   complete at all, and each was reachable from a file the envelope check
   waved through:

     octaves   fbm and ridged accumulate `norm` once per octave and return
               `sum / norm` (engine/terrain/noise.js:33). At zero octaves the
               loop never runs, every sample is 0/0, and the sampler returns
               NaN for the whole plate — a world that loads "successfully",
               draws nothing, floods nowhere, scores no settlement and drops
               the spawn in a corner, reporting only three.js's own "Computed
               radius is NaN" to the console.
     sculpt    SculptLayer.replay spreads it (Engine.sculptRestore). Anything
               that is not an array throws "strokes is not iterable" — and it
               throws PART WAY THROUGH the load, which is what the rescue in
               studio.js's openWorldFile now exists to survive.
     size      divides the fog law and every world-space→texture mapping.

   Named here rather than guarded downstream because this is the boundary the
   file crosses: refused at the door, the world already on screen is never
   touched at all, which is a better outcome than any recovery. */
function validateTerrain(params) {
  const errors = [];
  const t = params?.terrain;
  if (!t || typeof t !== "object") return ["params.terrain missing"];
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  if (!finite(t.size) || t.size <= 0) errors.push(`terrain.size ${JSON.stringify(t.size ?? null)} is not a positive number`);
  if (t.octaves !== undefined && (!finite(t.octaves) || t.octaves < 1)) {
    errors.push(`terrain.octaves ${JSON.stringify(t.octaves)} is not a number ≥ 1 — the noise would average over nothing`);
  }
  if (t.sculpt !== undefined && !Array.isArray(t.sculpt)) errors.push("terrain.sculpt is not a list of strokes");
  /* Rivers: authored records over slices of the sculpt list. The strokes
     themselves replay through the sculpt path untouched; what is validated
     here is the DESCRIPTION — a record with a stringly width or a path that
     is not a list was written by something that is not this module. */
  if (t.rivers !== undefined) {
    if (!Array.isArray(t.rivers)) {
      errors.push("terrain.rivers is not a list");
    } else {
      t.rivers.forEach((rv, i) => {
        if (!rv || typeof rv !== "object") return void errors.push(`terrain.rivers[${i}] is not an object`);
        for (const k of ["x", "z", "width", "depth"]) {
          if (!finite(rv[k])) errors.push(`terrain.rivers[${i}].${k} ${JSON.stringify(rv[k] ?? null)} is not a number`);
        }
        if (rv.path !== undefined && !Array.isArray(rv.path)) errors.push(`terrain.rivers[${i}].path is not a list`);
      });
    }
  }
  /* Intent: statements the solver makes true (engine/terrain/condition.js).
     The sampler drops a record it cannot read rather than failing, but a file
     CARRYING one was written by something that is not this engine — the
     same standard the river records above are held to. The size goes in so
     a v2 record's coordinates are checked against the plate. */
  errors.push(...intentErrors(t.intent, { size: t.size }));
  /* The erosion numbers, when present, must be numbers. erode() falls back
     to its shipped defaults for anything non-finite now, so a bad value no
     longer NaNs the field — but a file CARRYING "drops": "many" was written
     by something that is not this module, and that is the standard the
     placement checks below already apply. */
  if (t.erosion !== undefined) {
    if (typeof t.erosion !== "object" || t.erosion === null) {
      errors.push("terrain.erosion is not an object");
    } else {
      for (const k of ["drops", "inertia", "capacity", "deposit", "erode", "evaporate"]) {
        if (t.erosion[k] !== undefined && !finite(t.erosion[k])) {
          errors.push(`terrain.erosion.${k} ${JSON.stringify(t.erosion[k])} is not a number`);
        }
      }
      const th = t.erosion.thermal;
      if (th !== undefined && (typeof th !== "object" || th === null)) {
        errors.push("terrain.erosion.thermal is not an object");
      } else if (th) {
        for (const k of ["iterations", "talus", "rate"]) {
          if (th[k] !== undefined && !finite(th[k])) {
            errors.push(`terrain.erosion.thermal.${k} ${JSON.stringify(th[k])} is not a number`);
          }
        }
      }
    }
  }
  return errors;
}

/* ── the ground block, checked ──
   The cheap half only: shape, and agreement with the params on what the
   params decide. Recomputing parameterHash is a JSON.stringify and a hash
   over it — microseconds — so a block that names some other world's params
   is refused at the door like any other self-contradiction. The four ground
   hashes are not checked here: that is a bake, and it is a verifier's job. */
const isHash32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
function validateGround(g, params) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["ground is not an object"];
  const errors = [];
  const show = (v) => JSON.stringify(v ?? null);
  for (const k of Object.keys(g)) {
    if (!GROUND_BLOCK_FIELDS.includes(k)) errors.push(`ground.${k} is not a ground line this file format carries`);
  }
  if (!Number.isInteger(g.generatorVersion) || g.generatorVersion < 1) errors.push(`ground.generatorVersion ${show(g.generatorVersion)} is not a version number`);
  if (!Number.isInteger(g.res) || g.res < 2) errors.push(`ground.res ${show(g.res)} is not a grid of at least 2 samples`);
  if (!(typeof g.size === "number" && Number.isFinite(g.size) && g.size > 0)) errors.push(`ground.size ${show(g.size)} is not a positive number`);
  if (!(typeof g.waterLevel === "number" && Number.isFinite(g.waterLevel))) errors.push(`ground.waterLevel ${show(g.waterLevel)} is not a number`);
  for (const k of ["parameterHash", "heightHash", "landMaskHash", "flowMaskHash"]) {
    if (!isHash32(g[k])) errors.push(`ground.${k} ${show(g[k])} is not an unsigned 32-bit hash`);
  }
  if (errors.length || !params?.terrain) return errors;
  const ph = terrainParameterHash(params);
  if (g.parameterHash !== ph) errors.push(`ground.parameterHash ${g.parameterHash} is not this file's params (${ph}) — the ground is some other world's`);
  if (g.size !== params.terrain.size) errors.push(`ground.size ${g.size} is not terrain.size ${params.terrain.size}`);
  const level = params.water?.level || 0;
  if (g.waterLevel !== level) errors.push(`ground.waterLevel ${g.waterLevel} is not water.level ${level}`);
  return errors;
}

/* ── validate ──
   Returns a list of named failures, empty when the document is loadable. The
   caller shows them; nothing here throws, because a bad file a user picked is
   an ordinary event and not an exception.

   That promise is kept twice. The checks below are written for shapes a file
   can have (a `props` that is not a list, a placement that is null), and the
   whole of it runs inside a catch that turns anything they did not foresee
   into one more named failure — because the M4 review found that `props: 5`
   reached a TypeError, and a promise that rests on having thought of every
   shape is one the next shape breaks. */
export function validateWorldFile(doc) {
  try {
    return validateWorldFileChecks(doc);
  } catch (e) {
    return [`not a readable world file (${e?.message ?? e})`];
  }
}

function validateWorldFileChecks(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") return ["not a world file"];
  if (doc.kind !== WORLD_FILE_KIND) errors.push(`not a world file (kind ${JSON.stringify(doc.kind ?? null)})`);
  if (doc.fileVersion !== WORLD_FILE_VERSION) {
    errors.push(`file version ${doc.fileVersion ?? "?"} ≠ ${WORLD_FILE_VERSION}`);
  }
  /* A GENERATOR MISMATCH IS NOT A VALIDATION ERROR, and making it one would be
     the wrong fix. The file still parses, still holds a complete world, and
     still builds; what has moved is the ground under it. Refusing it would
     strand every world minted before a bump — including a customer's — for a
     difference the loader can state instead. See generatorNote.

     A stamp that is not a version number is a different matter: that file was
     written by something that is not this module, which is the same standard
     the placement checks below apply. */
  if (generatorProvenance(doc).status === "malformed") {
    errors.push(`generator version ${JSON.stringify(doc.generatorVersion)} is not a version number`);
  }
  if (!doc.world || typeof doc.world !== "object") {
    errors.push("no world in the file");
    return errors;
  }
  if (doc.world.version !== FUSION_VERSION) {
    // Named separately from the envelope version: the envelope can be right
    // and the world inside it still be from an older engine.
    errors.push(`world version ${doc.world.version ?? "?"} ≠ ${FUSION_VERSION}`);
  }
  for (const e of validateFusionRecord(doc.world)) errors.push(e);
  for (const e of validateTerrain(doc.world.params)) errors.push(e);
  if (doc.omitted != null && !Array.isArray(doc.omitted)) errors.push("omitted is not a list");
  if (!Array.isArray(doc.procs)) errors.push("no geometry table");
  // Absent is the file it always was. Present, it is held to validateGround.
  if (doc.ground !== undefined) for (const e of validateGround(doc.ground, doc.world.params)) errors.push(e);
  for (const p of Array.isArray(doc.world.props) ? doc.world.props : []) {
    if (!p || typeof p !== "object") continue; // named by validateFusionRecord
    // A file that still names bytes it cannot carry was written by something
    // that is not this module.
    if (isImportedAsset(p)) errors.push(`placement ${p.uid} names bytes the file cannot carry`);
    // An index into a table that does not hold it is a placement with no
    // shape — worth naming here rather than becoming `undefined` geometry
    // three frames into a rebuild.
    if (p.procRef != null && !(doc.procs || [])[p.procRef]) {
      errors.push(`placement ${p.uid} points at geometry ${p.procRef}, which the file does not carry`);
    }
  }
  return errors;
}

/* ── serialise ──
   No indentation. This was two-space pretty-printed on the argument that a
   world file is something a person may open and diff — and then Crownway was
   measured: 2,557 placements, and the indentation alone was most of a
   megabyte of leading spaces. A file nobody can afford to save is not a file
   anybody will diff. `node -e "console.log(JSON.stringify(JSON.parse(...),
   null, 2))"` is the answer for the rare read; the default is the size. */
export function serializeWorldFile(doc) {
  return JSON.stringify(doc) + "\n";
}

/** Parse text into `{ doc, errors }`. Never throws — bad JSON is one of the
    named failures, not a stack trace. */
export function parseWorldFile(text) {
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { doc: null, errors: [`not JSON: ${err.message}`] };
  }
  const errors = validateWorldFile(doc);
  return { doc: errors.length ? null : doc, errors };
}

/* ── the name on the save dialog ──
   Derived from the world, never from the clock: saving the same world on the
   same seed twice offers the same filename, so the second save overwrites the
   first instead of littering a Downloads folder with near-duplicates. */
export function worldFileName(doc) {
  const w = doc?.world || {};
  const slug = String(doc?.origin || w.params?.biome || "world")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "world";
  const seed = normalizeSeed(w.seed) || "unseeded";
  const tag = (hashSeed(seed) >>> 0).toString(36).slice(0, 6);
  return `${slug}-${tag}${WORLD_FILE_EXT}`;
}

/** The params to hand `engine.applyParams`. A deep clone: the caller is about
    to have the engine mutate it, and the document may be shown afterwards. */
export function paramsFromWorldFile(doc) {
  return JSON.parse(JSON.stringify(doc.world.params));
}

/** The ground block a file carries, as a fresh copy, or null for a file
    saved without one. */
export function groundFromWorldFile(doc) {
  return doc?.ground ? { ...doc.ground } : null;
}

/** The placement records to hand `engine.props.restore`, in file order, with
    their geometry read back out of the table. Cloned for the same reason: the
    engine is about to seat these, and the document may be shown afterwards. */
export function propsFromWorldFile(doc) {
  const procs = doc.procs || [];
  return (doc.world.props || []).map((p) => {
    const out = expandPlacement(p);
    out.position = [...p.position];
    if (out.procRef != null) {
      // Deep-cloned per placement: two chairs share a table entry, and they
      // must not share an object — editing one would otherwise edit every
      // chair in the world.
      out.proc = JSON.parse(JSON.stringify(procs[out.procRef]));
      delete out.procRef;
    }
    return out;
  });
}

/* ── the generator stamp ──
   THIS FILE CARRIES INSTRUCTIONS, NOT GROUND. `world.field` is `{res, size}`
   and nothing else: the heightfield is re-derived from seed+params every time
   the file is opened. What the file DOES carry as data is everything scored
   AGAINST that field — settlements, spawn, tactics — measured once, at mint
   time, by whatever terrain pipeline was current that day.

   So the two halves of a world file age at different rates, and until now only
   one of them said so. `fileVersion` is the envelope's shape, `world.version`
   is the record's shape, `params.version` is the params' shape. Three version
   numbers, and all three answer the same question — "can this be parsed". None
   of them answers the question that decides whether the file still means what
   it meant: is the ground these settlements were scored on the ground this
   code now makes.

   GENERATOR_VERSION is the number that answers it, and it existed only in the
   runtime fingerprint — printed to a console and thrown away. A .world.json
   attached to a bug report therefore could not be replayed, because nothing in
   it named the generator that placed the settlements it carries. That is the
   failure the constant was declared to name (engine/terrain/fingerprint.js:
   "a picker and an editor reporting different generator versions are two
   different programs agreeing on a seed"), happening to the one artifact that
   outlives the session.

   Stamped in the ENVELOPE rather than inside `world`, because `world` is
   buildFusionRecord's shape and that record is also what the IndexedDB handoff
   stores; the envelope is already where "which code wrote this" lives. */

/** What generator minted a file, as data. `status` is one of:
      current    — this build's own generator
      older      — minted before a pipeline change; its ground has moved
      newer      — minted by a build ahead of this one
      unstamped  — minted before the stamp existed; provenance unknown
      malformed  — a stamp that is not a version number (a validation error) */
export function generatorProvenance(doc) {
  const current = GENERATOR_VERSION;
  const raw = doc?.generatorVersion;
  /* ABSENT IS NOT VERSION ZERO. A file minted before this stamp existed has
     UNKNOWN provenance, which is a different fact from a known mismatch —
     folding the two together reports every file already in the wild as stale
     and teaches everybody to ignore the reading, which is how a version number
     stops working. */
  if (raw == null) return { stamped: false, version: null, current, status: "unstamped" };
  const version = typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(version) || version < 1) {
    return { stamped: true, version: raw, current, status: "malformed" };
  }
  const status = version === current ? "current" : version < current ? "older" : "newer";
  return { stamped: true, version, current, status };
}

/** Which generator a loaded file was minted by, as a sentence or null.
    Null means "this build's own" — the case that needs no sentence. */
export function generatorNote(doc) {
  const p = generatorProvenance(doc);
  switch (p.status) {
    case "older":
      return `This world was minted by terrain generator ${p.version}; this build derives ` +
             `its ground with generator ${p.current}. The seed and the params are unchanged — ` +
             "the ground under its settlements and spawn is not.";
    case "newer":
      return `This world was minted by terrain generator ${p.version}, which is ahead of this ` +
             `build's generator ${p.current}. Its ground will be derived by the older pipeline.`;
    case "unstamped":
      return `This file names no generator. Its ground is derived by generator ${p.current}; ` +
             "if it was minted before that, the settlements and spawn it carries were scored " +
             "on a different surface.";
    // "current" needs no sentence, and "malformed" is a validation error
    // rather than a note — a file that fails validation is never loaded.
    default:
      return null;
  }
}

/** What a loaded file could not bring with it, as a sentence or null. */
export function omissionNote(doc) {
  const n = (doc?.omitted || []).length;
  if (!n) return null;
  return n === 1
    ? "One imported model was not in the file — a world file carries procedural blocks only."
    : `${n} imported models were not in the file — a world file carries procedural blocks only.`;
}
