/* fingerprint.js — WHAT A WORLD'S GROUND ACTUALLY IS, as numbers.
 *
 * The library shelf and the editor render the same worlds through two very
 * different renderers, and "they look the same" is not a claim either of them
 * can make about itself. A slab three units wide and a four-kilometre plate
 * seen from a walking camera share no pixels, no mesh, no material and no
 * light — so the only way to know whether the visitor is looking at the SAME
 * WORLD after clicking is to compare the thing underneath all of that: the
 * height field, the masks derived from it, and the parameters both were
 * derived from.
 *
 * This module is that comparison, and it is deliberately the whole of it. One
 * expression of "the fingerprint of this ground", imported by:
 *
 *   hero/library.js          prints [PICKER] for the world in the centre
 *   js/studio.js           prints [EDITOR] for the world it opened
 *   tests/handoff.test.js  asserts the two are equal, field and all
 *
 * It lives in engine/ rather than in js/ because the engine itself reports one
 * (Engine.terrainFingerprint) and the layering is one-directional — see
 * tools/check-imports.mjs.
 *
 * Pure JS, and deliberately import-free: no three.js, no DOM, not even the
 * rest of the terrain layer. It runs in the browser, in a worker, in the Node
 * suite and under JavaScriptCore, which is the only way the number a console
 * prints can be the same number a test asserts.
 *
 * ── on hashing floats ──
 * The hash is over the FLOAT BITS, not over rounded decimals. A tolerance
 * baked into a fingerprint is a fingerprint that cannot answer the question
 * it exists to answer: "is this the same field, or a field that resembles
 * it". Resemblance is what the bug looked like. Bit equality is what the fix
 * has to mean. (The per-coordinate sampling check in the suite is where a
 * tolerance legitimately lives — see sampleHeights below.)
 */

/* Bumped when the terrain PIPELINE changes shape — the order of the stages, the
   grid the erosion runs on, what the sampler is a function of. Not when a
   parameter's default moves: that is what parameterHash is for. A picker and
   an editor reporting different generator versions are two different programs
   agreeing on a seed, which is the failure this whole module exists to name. */
export const GENERATOR_VERSION = 2;

/* ── FNV-1a, 32-bit, over bytes ──
   Same construction as src/kernel/seed.js's hashSeed, extended to buffers. Small,
   dependency-free, identical in every runtime this repository runs in, and
   more than strong enough for "did this 1 MB of ground change". */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashBytes(bytes, h = FNV_OFFSET) {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

export function hashString(str, h = FNV_OFFSET) {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 255;
    h = Math.imul(h, FNV_PRIME);
    h ^= (str.charCodeAt(i) >> 8) & 255;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Hash a Float32Array by its bytes. `null` hashes to null rather than to the
    empty hash, so "no field" is distinguishable from "an empty field". */
export function hashFloat32(data) {
  if (!data) return null;
  const view = data instanceof Float32Array ? data : new Float32Array(data);
  return hashBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

/** Hash a mask (Uint8Array). Same null rule. */
export function hashMask(mask) {
  if (!mask) return null;
  return hashBytes(mask instanceof Uint8Array ? mask : new Uint8Array(mask));
}

/** A hash as the eight hex digits a console line wants. */
export const hex = (h) => (h == null ? "—" : (h >>> 0).toString(16).padStart(8, "0"));

/* ── the parameter hash ──
   Every field that can move the ground, in a fixed order, and NOTHING else. A
   world's hour, its fog and its grass wind are real differences between two
   documents and are not differences in terrain — folding them in would make
   the hash change for reasons the height field does not, which is the fastest
   way to teach everybody to ignore it.

   The sculpt list IS in, because a stroke is terrain. It goes in as its own
   canonical JSON rather than as a count: two strokes of equal length in
   different places are two different worlds. The noise stack and the thermal
   pass are in for the same reason — both are live knobs that reshape the
   field, and a hash that skips them would happily file a ground under params
   it was not derived from. The water level is NOT in: it moves no vertex, and
   canonicalTerrainFingerprint already carries it as its own line — with the
   one exception hashedIntent below spells out. */
/* The one exception to "the water level moves no vertex": a shoreline that
   carries no `level` of its own stands the ground at the world's waterline
   (condition.js), so for it the level is terrain. Rather than append the
   level as a field of its own, each such record is hashed as the record it
   is in effect — the same record with `level` set — so freezing the level
   into it (Engine.setFloodLevel does, before it floods) leaves the hash, like
   the ground, exactly where it was. Every list without a level-less
   shoreline is hashed as the very array it is, so its hash is the one it
   always had. */
function hashedIntent(intent, waterLevel) {
  if (!intent.some((r) => r && r.type === "shoreline" && !Number.isFinite(r.level))) return intent;
  const level = Number.isFinite(waterLevel) ? waterLevel : 0;
  return intent.map((r) => (r && r.type === "shoreline" && !Number.isFinite(r.level) ? { ...r, level } : r));
}

export function terrainParameterHash(params) {
  const t = params?.terrain || {};
  const e = t.erosion || {};
  const canon = JSON.stringify([
    params?.version ?? null,
    params?.seed ?? null,
    t.size ?? null, t.height ?? null, t.frequency ?? null, t.octaves ?? null,
    t.lacunarity ?? null, t.gain ?? null, t.warp ?? null, t.ridged ?? null,
    t.plateau ?? null, t.island ?? null, t.seaLevel ?? null,
    [e.enabled ?? false, e.drops ?? null, e.inertia ?? null, e.capacity ?? null,
     e.deposit ?? null, e.erode ?? null, e.evaporate ?? null],
    [e.thermal?.iterations ?? 0, e.thermal?.talus ?? null, e.thermal?.rate ?? null],
    t.stack ?? null,
    t.sculpt ?? [],
    t.rivers ?? [],
    /* Intent reshapes the field (terrain/condition.js), so it is terrain. It
       is APPENDED, and only when there is some: every world without intent
       keeps the parameter hash it has always had, which is the same promise
       the sampler makes about its heights. */
    ...(Array.isArray(t.intent) && t.intent.length ? [hashedIntent(t.intent, params?.water?.level)] : []),
  ]);
  return hashString(canon);
}

/* ── the placements hash ──
   What stands ON the ground, as one number, so a fingerprint can say "the
   same world, furnished the same way" and not only "the same ground". It is a
   SEPARATE hash and it never enters parameterHash or heightHash: a placement
   moves no vertex, and a terrain hash that changed when somebody nudged a
   lamp post would be a terrain hash everybody learns to ignore.

   The canonical form, every rule of which is there because the obvious
   alternative was not stable. It is meant to be recomputed outside
   JavaScript — tools/kernel/py/genesis_placements.py is the Python port, and
   tools/test/kernel/vectors/seed-vectors.json carries pinned rows (non-ASCII, astral and
   control characters among them) that tools/kernel/py/check_vectors.py holds it to
   — so each rule says what a port has to write to get the same bytes:

     · Records are sorted by `uid`, compared by UTF-16 CODE UNIT, the default
       comparison of two JS strings (not localeCompare, which depends on the
       runtime's locale data). A port must sort the same way, and Python's
       sorted() over str does NOT: it compares code points, which puts an
       astral character (a surrogate pair, 0xD800…) BEFORE U+E000–U+FFFF where
       JavaScript puts it after. Sorting by s.encode("utf-16-be") is the
       code-unit order. The list order a scene hands over is the order things
       happened to be inserted, and two editors that loaded the same file in
       a different order are holding the same placements. Two records that
       share a uid (or have none — they sort as "") fall back to their own
       canonical text, compared the same way, so the order is total and the
       hash cannot depend on the input order. A uid, when present, must be a
       string: a numeric uid would be both sorted as text and written as a
       quantized number, so uids 0 and 0.00001 would be one placement.
     · Object keys are sorted, at every depth, by the same code-unit order.
       JSON.stringify writes keys in insertion order, which is how a record
       built by spreading a default and a record parsed from a file disagree
       about a world they agree on.
     · Every number is rounded to PLACEMENT_QUANTUM (1e-4: a tenth of a
       millimetre in metres, a ten-thousandth of a radian) and written as the
       INTEGER count of quanta, in plain decimal digits. A float that went
       through a drag, an undo and a save is not bit-identical to the one that
       did not, and those are not two placements. Integers rather than rounded
       decimals because a decimal is printed differently by different
       languages (JS writes 100000 where Python writes 100000.0). The rounding
       is Math.round over x = v * 10000 (a double multiply) — nearest, ties
       toward +infinity — which a port writes as
       `f = floor(x); q = f + (1 if x - f >= 0.5 else 0)` (not Python's
       round(), which ties to even). −0 is written as 0 and a non-finite
       number as null, as JSON.stringify writes it. A count past 2^53 − 1
       (a value past about 9.007e11) is refused: beyond it the count is no
       longer an exact integer, and from 1e21 JavaScript prints it in exponent
       form where Python prints every digit.
     · Strings, keys included, are written as JSON.stringify writes them,
       which is NOT Python's json.dumps default: non-ASCII is written as
       itself, unescaped, so the port is json.dumps(s, ensure_ascii=False).
       The escapes then agree (\" \\ \b \f \n \r \t, the rest of U+0000–U+001F
       as lowercase \u00xx, nothing else). A string holding a lone surrogate
       is refused: JavaScript would escape it and Python would write it raw,
       and it is not text either way.
     · The text is hashed by hashString: FNV-1a over each UTF-16 code unit's
       low byte then high byte, i.e. over the UTF-16-LE encoding — not UTF-8.
     · `undefined` and functions drop out exactly as JSON.stringify drops
       them — from an object, the key goes; in an array, they become null —
       so a record carrying `{ label: undefined }` is the record without the
       label. An object with a toJSON method is replaced by what it returns,
       as JSON does (a Date becomes its ISO string).
     · A typed array of numbers (a Float32Array position, as a renderer keeps
       it) is written as the plain array of its values, so it hashes like the
       Array a file would parse back.
     · Anything JSON has no form for is refused with a TypeError rather than
       written as something it is not: a BigInt (JSON.stringify throws on
       one too), a symbol, a Map or a Set (JSON would write {} and their
       contents would never reach the hash), an ArrayBuffer, a DataView, a
       BigInt64Array. */
export const PLACEMENT_QUANTUM = 1e-4;
const QUANTA_PER_UNIT = 10000; // 1 / PLACEMENT_QUANTUM, spelled exactly: v / 1e-4 and v * 10000 differ in the last bit

function wellFormed(s, where) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
      throw new TypeError(`placementsHash: ${where} holds a lone surrogate`);
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError(`placementsHash: ${where} holds a lone surrogate`);
  }
  return s;
}

const codeUnitOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalValue(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    const q = Math.round(v * QUANTA_PER_UNIT);
    if (!Number.isSafeInteger(q)) throw new RangeError(`placementsHash: ${v} is past the exact range of the quantized form (|v| < ~9.007e11)`);
    return String(q === 0 ? 0 : q);
  }
  if (typeof v === "string") return JSON.stringify(wellFormed(v, "a string"));
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "bigint" || typeof v === "symbol") throw new TypeError(`placementsHash: a ${typeof v} has no JSON form`);
  if (Array.isArray(v)) {
    // An index loop, not map(): map skips the holes of a sparse array and
    // join would then write them as nothing, where JSON writes null.
    const parts = [];
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      parts.push(x === undefined || typeof x === "function" ? "null" : canonicalValue(x));
    }
    return "[" + parts.join(",") + "]";
  }
  if (typeof v === "object") {
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView || v instanceof BigInt64Array || v instanceof BigUint64Array) {
        throw new TypeError(`placementsHash: a ${v.constructor.name} has no JSON form`);
      }
      return canonicalValue(Array.from(v));
    }
    if (v instanceof Map || v instanceof Set || v instanceof ArrayBuffer) {
      throw new TypeError(`placementsHash: a ${v.constructor.name} has no JSON form (JSON would write {} and drop its contents)`);
    }
    if (typeof v.toJSON === "function") return canonicalValue(v.toJSON());
    const parts = [];
    for (const k of Object.keys(v).sort(codeUnitOrder)) {
      const x = v[k];
      if (x === undefined || typeof x === "function") continue;
      parts.push(JSON.stringify(wellFormed(k, "a key")) + ":" + canonicalValue(x));
    }
    return "{" + parts.join(",") + "}";
  }
  return "null"; // undefined or a function at the top of a value
}

/** The canonical text placementsHash hashes — exported so a mismatch can be
    diffed as text, and so a port can be checked against the string before
    anybody argues about the number. */
export function canonicalPlacements(records) {
  if (!Array.isArray(records)) throw new TypeError("canonicalPlacements: records must be an array");
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const uid = r != null && typeof r === "object" ? r.uid : undefined;
    if (uid != null && typeof uid !== "string") {
      throw new TypeError(`canonicalPlacements: record ${i} has a ${typeof uid} uid — a uid is a string`);
    }
    rows.push({ uid: uid == null ? "" : wellFormed(uid, "a uid"), text: canonicalValue(r) });
  }
  rows.sort((a, b) => codeUnitOrder(a.uid, b.uid) || codeUnitOrder(a.text, b.text));
  return "[" + rows.map((r) => r.text).join(",") + "]";
}

/** FNV-1a over canonicalPlacements(records). `null`/`undefined` hash to null
    ("no placements were given"), which is not the hash of `[]` ("there are
    none") — the same distinction hashFloat32 keeps for a missing field. */
export function placementsHash(records) {
  if (records == null) return null;
  return hashString(canonicalPlacements(records));
}

/* The erosion parameters as one short line — what a console readout wants,
   and what tells a reader WHY two heightHashes differ when they do. */
export function erosionSummary(params) {
  const e = params?.terrain?.erosion;
  if (!e?.enabled) return "off";
  return `${e.drops} drops · inertia ${e.inertia} · capacity ${e.capacity} · ` +
         `deposit ${e.deposit} · erode ${e.erode} · evaporate ${e.evaporate}`;
}

/* ══ the fingerprint ═══════════════════════════════════════════════════════
   `field` is a baked heightfield { res, size, data } — the canonical one, at
   CANONICAL_RES (src/kernel/terrain/canonical.js), AFTER erosion. `wet` and `flow`
   are the masks derived from it by the same module. `meshRes` is the
   renderer's own tessellation and is reported but never compared: a slab at
   320 and a quadtree at whatever the camera asks for are two views of one
   field, which is the whole architecture.

   Everything here is derived. Nothing is passed in as a claim.

   `placements` is optional and is the one thing here that is not ground. When
   it is given, the fingerprint gains a `placementsHash` line; when it is not,
   the key is ABSENT — not null — so every fingerprint taken before it existed
   serialises to the same text it always did, and a fingerprint that never
   looked at placements cannot be mistaken for one that found none. classify()
   does not read it: its three verdicts are about the GROUND the two sides
   hold, and a world furnished differently on the same ground is still case
   C as far as terrain is concerned. Compare placementsHash directly when that
   is the question. */
export function canonicalTerrainFingerprint({
  id = null, params, field = null, wet = null, flow = null,
  meshRes = null, lodLevel = null, view = null, placements = undefined,
} = {}) {
  const t = params?.terrain || {};
  let min = null, max = null;
  if (field?.data) {
    min = Infinity; max = -Infinity;
    for (const v of field.data) { if (v < min) min = v; if (v > max) max = v; }
  }
  return {
    id,
    view,
    seed: params?.seed ?? null,
    biome: params?.biome ?? null,
    generatorVersion: GENERATOR_VERSION,
    paramsVersion: params?.version ?? null,
    // The FIELD's resolution and extent — the terrain's own, not the mesh's.
    resolution: field?.res ?? null,
    dimensions: field ? [field.size, field.size] : (t.size ? [t.size, t.size] : null),
    cellSize: field ? field.size / (field.res - 1) : null,
    heightMin: min, heightMax: max,
    // The vertical scale the field was generated at, and the one the renderer
    // draws it at. The first is terrain; the second is presentation, and the
    // pair is what tells CASE B from CASE C.
    verticalScale: t.height ?? null,
    waterLevel: params?.water?.level ?? 0,
    seaLevel: t.seaLevel ?? null,
    heightHash: hashFloat32(field?.data),
    landMaskHash: hashMask(wet),
    flowMaskHash: hashMask(flow),
    parameterHash: terrainParameterHash(params),
    erosion: erosionSummary(params),
    sculptStrokes: (t.sculpt || []).length,
    meshRes,
    lodLevel,
    ...(placements != null ? { placementsHash: placementsHash(placements) } : {}),
  };
}

/* ── the readout ──
   The exact block the bug report asked for, one line per fact, so a picker
   log and an editor log can be diffed by eye in a console before anybody
   opens a test file. */
export function formatFingerprint(tag, fp) {
  const lines = [
    `[${tag}]`,
    `id:               ${fp.id ?? "—"}`,
    `seed:             ${fp.seed ?? "—"}`,
    `biome:            ${fp.biome ?? "—"}`,
    `generatorVersion: ${fp.generatorVersion}`,
    `resolution:       ${fp.resolution ?? "—"}`,
    `dimensions:       ${fp.dimensions ? `${fp.dimensions[0]} × ${fp.dimensions[1]} m` : "—"}`,
    `cellSize:         ${fp.cellSize == null ? "—" : fp.cellSize.toFixed(4) + " m"}`,
    `heightMin/max:    ${fp.heightMin == null ? "—" : `${fp.heightMin.toFixed(3)} … ${fp.heightMax.toFixed(3)} m`}`,
    `verticalScale:    ${fp.verticalScale ?? "—"}`,
    `waterLevel:       ${fp.waterLevel}`,
    `seaLevel:         ${fp.seaLevel ?? "—"}`,
    `heightHash:       ${hex(fp.heightHash)}`,
    `landMaskHash:     ${hex(fp.landMaskHash)}`,
    `flowMaskHash:     ${hex(fp.flowMaskHash)}`,
    `parameterHash:    ${hex(fp.parameterHash)}`,
    `erosion:          ${fp.erosion}`,
    `sculptStrokes:    ${fp.sculptStrokes}`,
    `meshRes / LOD:    ${fp.meshRes ?? "—"} / ${fp.lodLevel ?? "—"}`,
    // Only when the fingerprint carries one, so older readouts are unchanged.
    ...("placementsHash" in fp ? [`placementsHash:   ${hex(fp.placementsHash)}`] : []),
  ];
  return lines.join("\n  ");
}

/** Print a fingerprint. Separate from formatFingerprint so tests can build the
    text without a console and pages can log without building one. */
export function logFingerprint(tag, fp, sink = console) {
  sink.info(formatFingerprint(tag, fp));
  return fp;
}

/* ── the verdict ──
   The bug report's own three cases, decided from two fingerprints rather than
   from a screenshot. Returned as data so a page can print it and a test can
   assert on it. */
export function classify(picker, editor) {
  const differs = [];
  const same = (k) => {
    const a = picker[k], b = editor[k];
    const equal = Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    if (!equal) differs.push(k);
    return equal;
  };
  same("seed");
  same("generatorVersion");
  const heightSame = same("heightHash");
  same("landMaskHash");
  same("dimensions");
  same("resolution");
  same("waterLevel");
  same("verticalScale");
  const paramsSame = same("parameterHash");

  let verdict, note;
  if (!heightSame && !paramsSame) {
    verdict = "A";
    note = "the editor is deriving terrain from DIFFERENT PARAMETERS — it did not receive the selected world.";
  } else if (!heightSame) {
    verdict = "A";
    note = "same parameters, different field — the editor re-ran a generation stage the picker did not.";
  } else if (differs.length) {
    verdict = "B";
    note = "the field matches; a renderer-side transform differs — " + differs.join(", ") + ".";
  } else {
    verdict = "C";
    note = "field, masks and parameters all match — any remaining difference is presentation.";
  }
  return { verdict, differs, note, equal: differs.length === 0 };
}

/* ── the per-coordinate check ──
   The fingerprint answers "is it the same field". This answers the question
   the bug report actually phrased: for a normalized (u, v) in [-1, 1]², does
   pickerHeight(u, v) equal editorHeight(u, v). Deterministic coordinates, so
   two runs sample the same points and a failure names one.

   Returns metres, in world space, from whatever sampler is handed in — which
   is the point: the slab divides by MPU and the editor does not, so comparing
   the RENDERED y would compare two scales. The terrain function is what has
   to agree. */
export function sampleGrid(n = 9) {
  const pts = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Inset by half a step: the plate's outer margin is the falloff ramp,
      // and a sample exactly on the rim tests the clamp rather than the world.
      pts.push([((i + 0.5) / n) * 2 - 1, ((j + 0.5) / n) * 2 - 1]);
    }
  }
  return pts;
}

/** Sample one sampler over sampleGrid(n), in world metres. `halfExtent` is
    size / 2 — the same half-extent both views normalize against. */
export function sampleHeights(sampler, halfExtent, n = 9) {
  return sampleGrid(n).map(([u, v]) => sampler(u * halfExtent, v * halfExtent));
}
