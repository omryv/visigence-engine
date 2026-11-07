/* One ground under everything — engine/terrain/ground.js, and the two
 * smaller promises it rests on.
 *
 * groundBundle is the call a sibling repository makes when it wants to stand
 * on THIS engine's ground rather than on its own port of it: the four arrays
 * canonical.js bakes, and a manifest that says which ground they are. So what
 * is checked here is what such a consumer would have to take on trust
 * otherwise:
 *
 *   · the bounds are bounds — bakeHeightField's min/max contain every stored
 *     height, which before this change they did not (measured below), and
 *     the heights themselves did not move to make it so
 *   · the bundle is deterministic — two independent bakes are case C
 *   · the manifest says what the fingerprint says, hash for hash, so either
 *     can be compared against either
 *   · timings are optional, injected, touch no hash, and a bad clock cannot
 *     make them lie in a way the schema would refuse
 *   · placementsHash is canonical (order, key order and float noise do not
 *     move it), refuses what it cannot write faithfully, and its arrival
 *     changed no existing fingerprint
 *
 * That the manifest is the shape schema/ground.schema.json says it is lives
 * in tests/ground-schema.test.js, split out because reading the schema needs
 * node:fs: this file imports nothing but the engine, so it runs under
 * JavaScriptCore as well as Node.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import {
  groundBundle, GROUND_KIND, GROUND_MANIFEST_VERSION, CORE_MODULES,
} from "../../../src/kernel/core/index.js";
import { createHeightSampler, bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { bakeCanonicalGround, CANONICAL_RES } from "../../../src/kernel/terrain/canonical.js";
import {
  GENERATOR_VERSION, canonicalTerrainFingerprint, classify, formatFingerprint,
  hashFloat32, hashMask, hashString, placementsHash, canonicalPlacements, PLACEMENT_QUANTUM,
} from "../../../src/kernel/terrain/fingerprint.js";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { SEED_WORLD } from "./seed-world.js";
import { paramsFromWorldFile } from "../../../src/genesis/world/worldfile.js";

const clock = typeof performance !== "undefined" && performance.now
  ? () => performance.now()
  : () => Date.now();

const extremes = (data) => {
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
};

// ── the bounds are bounds ───────────────────────────────────────────────────

/* heightHash of bakeHeightField(makeParams({ seed }), 129), measured with the
   bakeHeightField that shipped BEFORE min/max were read back from the stored
   array. The fix may change the two numbers reported about the field and
   nothing else; these are what "nothing else" means. */
const PRE_FIX_HEIGHT_HASH = {
  "K7QN-3F2A-9XBD": 0x17fb06f4,
  "BRAVO-7": 0xccfb56cf,
  "CHARLIE": 0xc04a1574,
  "ECHO": 0xf139f0f3,
  "GOLF": 0x3c587675,
};
const SMALL = 129;

test("bakeHeightField's min/max contain every stored height, on several seeds", () => {
  for (const seed of Object.keys(PRE_FIX_HEIGHT_HASH)) {
    const f = bakeHeightField(makeParams({ seed }), SMALL);
    for (let i = 0; i < f.data.length; i++) {
      const v = f.data[i];
      ok(f.min <= v && v <= f.max, `${seed}: cell ${i} holds ${v}, outside the reported [${f.min}, ${f.max}]`);
    }
    // Not merely bounds: the tightest ones, i.e. the stored extremes exactly.
    const [lo, hi] = extremes(f.data);
    eq(f.min, lo, `${seed} min`);
    eq(f.max, hi, `${seed} max`);
  }
});

test("…and the heights themselves did not move to make it so", () => {
  for (const [seed, h] of Object.entries(PRE_FIX_HEIGHT_HASH)) {
    eq(hashFloat32(bakeHeightField(makeParams({ seed }), SMALL).data), h, `${seed} heightHash`);
  }
  // The canonical grid too, before erosion: measured pre-fix as 0x0ce55339.
  eq(hashFloat32(bakeHeightField(makeParams(), CANONICAL_RES).data), 0x0ce55339, "default params at 513² heightHash");
});

test("the old way of measuring really did report a range its data left", () => {
  /* The test above has to be able to fail. Recompute the extremes the way
     the old code did — from the sampler's double, before the float32 store —
     and count the seeds where that range does NOT contain the stored data.
     Measured: 4 of these 5. If this ever reads 0, the first test has stopped
     proving anything and needs seeds that exercise the rounding again. */
  let violated = 0, worst = 0;
  for (const seed of Object.keys(PRE_FIX_HEIGHT_HASH)) {
    const p = makeParams({ seed });
    const h = createHeightSampler(p), size = p.terrain.size;
    let dlo = Infinity, dhi = -Infinity;
    for (let j = 0; j < SMALL; j++) {
      const z = (j / (SMALL - 1) - 0.5) * size;
      for (let i = 0; i < SMALL; i++) {
        const v = h((i / (SMALL - 1) - 0.5) * size, z);
        if (v < dlo) dlo = v; if (v > dhi) dhi = v;
      }
    }
    const [lo, hi] = extremes(bakeHeightField(p, SMALL).data);
    if (lo < dlo || hi > dhi) violated++;
    worst = Math.max(worst, dlo - lo, hi - dhi);
  }
  print(`    pre-store extremes excluded stored data on ${violated} of ${Object.keys(PRE_FIX_HEIGHT_HASH).length} seeds, by up to ${worst.toExponential(2)} m`);
  ok(violated >= 1, "no seed exercises the float32 rounding of an extreme");
});

// ── the bundle ──────────────────────────────────────────────────────────────

const WORLD = paramsFromWorldFile(SEED_WORLD);

/* The default world, baked once WITH a clock (the timing test reads it) and
   once without, independently. Module-level so the heavier tests below share
   two bakes rather than each paying for its own. */
const t0 = clock();
const TIMED = groundBundle(WORLD, { now: clock });
const TIMED_MS = clock() - t0;
const PLAIN = groundBundle(paramsFromWorldFile(SEED_WORLD));

const fingerprintOf = (b, params) =>
  canonicalTerrainFingerprint({ params, field: b.field, wet: b.wet, flow: b.flow });

const throws = (fn) => { try { fn(); } catch { return true; } return false; };

test("two independent bakes of a world are the same ground — classify() says C", () => {
  const v = classify(fingerprintOf(TIMED, WORLD), fingerprintOf(PLAIN, WORLD));
  eq(v.verdict, "C", `${v.note} differs: ${v.differs.join(", ")} —`);
  ok(v.equal, "the two fingerprints differ somewhere");
  for (const k of ["parameterHash", "heightHash", "landMaskHash", "flowMaskHash", "deltaHash", "min", "max"]) {
    eq(TIMED.manifest[k], PLAIN.manifest[k], `manifest ${k}`);
  }
  ok(PLAIN.manifest.deltaHash !== null, "the default world erodes, so it has a delta to hash");
});

test("the bundle IS bakeCanonicalGround — no second pipeline", () => {
  const g = bakeCanonicalGround(WORLD);
  eq(hashFloat32(g.field.data), PLAIN.manifest.heightHash, "field");
  eq(hashMask(g.wet), PLAIN.manifest.landMaskHash, "wet");
  eq(hashMask(g.flow), PLAIN.manifest.flowMaskHash, "flow");
  eq(hashFloat32(g.delta), PLAIN.manifest.deltaHash, "delta");
  eq(g.field.min, PLAIN.field.min); eq(g.field.max, PLAIN.field.max);
});

test("the manifest says what canonicalTerrainFingerprint says about the same field", () => {
  const m = PLAIN.manifest, fp = fingerprintOf(PLAIN, WORLD);
  eq(m.kind, GROUND_KIND); eq(m.version, GROUND_MANIFEST_VERSION);
  eq(m.generatorVersion, fp.generatorVersion, "generatorVersion");
  eq(m.res, fp.resolution, "res");
  eq(m.size, fp.dimensions[0], "size");
  eq(m.cellSize, fp.cellSize, "cellSize");
  eq(m.min, fp.heightMin, "min");
  eq(m.max, fp.heightMax, "max");
  eq(m.waterLevel, fp.waterLevel, "waterLevel");
  for (const k of ["parameterHash", "heightHash", "landMaskHash", "flowMaskHash"]) eq(m[k], fp[k], k);
  // Constraints the schema cannot state.
  ok(m.min <= m.max, "min > max");
  eq(m.cellSize, m.size / (m.res - 1), "cellSize is not size / (res - 1)");
  eq(m.res, CANONICAL_RES, "the default bundle is not on the canonical grid");
  eq(GENERATOR_VERSION, 2, "GENERATOR_VERSION moved — M1 changes no pipeline");
});

test("…on a world with a sea above zero, and on an un-eroded off-canonical bake", () => {
  /* The default world's water level is 0, so the test above would pass for
     a manifest that wrote 0 whatever the world said. These two would not. */
  const wet = mergeParams(makeParams({ seed: "HIGHSEA" }), {
    water: { level: 3.5 }, terrain: { erosion: { drops: 400 } },
  });
  for (const [what, params, opts] of [
    ["water at 3.5 m, eroded, 65²", wet, { res: 65 }],
    ["erode: false, 97²", makeParams({ seed: "FIRSTSWEEP" }), { res: 97, erode: false }],
  ]) {
    const b = groundBundle(params, opts);
    const m = b.manifest, fp = fingerprintOf(b, params);
    eq(m.waterLevel, fp.waterLevel, `${what}: waterLevel`);
    eq(m.waterLevel, params.water?.level || 0, `${what}: waterLevel is not the world's`);
    eq(m.res, fp.resolution, `${what}: res`); eq(m.res, opts.res, `${what}: res is not the one asked for`);
    eq(m.size, fp.dimensions[0], `${what}: size`);
    eq(m.cellSize, fp.cellSize, `${what}: cellSize`);
    eq(m.min, fp.heightMin, `${what}: min`); eq(m.max, fp.heightMax, `${what}: max`);
    for (const k of ["parameterHash", "heightHash", "landMaskHash", "flowMaskHash"]) eq(m[k], fp[k], `${what}: ${k}`);
  }
  // And the level really reached the mask: a higher sea floods more cells.
  const dry = groundBundle(mergeParams(wet, { water: { level: 0 } }), { res: 65 });
  const count = (mask) => mask.reduce((n, x) => n + (x ? 1 : 0), 0);
  ok(count(groundBundle(wet, { res: 65 }).wet) > count(dry.wet), "a 3.5 m sea flooded no more than a 0 m one");
});

test("the eroded field's bounds are bounds too", () => {
  const { data } = PLAIN.field;
  const [lo, hi] = extremes(data);
  eq(PLAIN.manifest.min, lo); eq(PLAIN.manifest.max, hi);
});

test("stages: listed always, timed only with an injected clock, never hashed", () => {
  eq(JSON.stringify(PLAIN.manifest.stages.map((s) => s.name)), JSON.stringify(["bake", "erode", "masks", "hash"]));
  ok(PLAIN.manifest.stages.every((s) => !("ms" in s)), "a manifest baked without a clock carries timings");
  ok(TIMED.manifest.stages.every((s) => typeof s.ms === "number" && s.ms >= 0), "an injected clock produced no timings");
  // Everything but the stages is identical, clock or no clock.
  const strip = ({ stages, ...rest }) => JSON.stringify(rest);
  eq(strip(TIMED.manifest), strip(PLAIN.manifest), "an injected clock changed the manifest");

  // A fake clock: ticks are deterministic, so the timings are too.
  let t = 0;
  const tick = () => (t += 5);
  const small = mergeParams(makeParams({ seed: "STAGES" }), { terrain: { erosion: { drops: 500 } } });
  const a = groundBundle(small, { res: 65, now: tick });
  eq(JSON.stringify(a.manifest.stages), JSON.stringify([
    { name: "bake", ms: 5 }, { name: "erode", ms: 5 }, { name: "masks", ms: 5 }, { name: "hash", ms: 5 },
  ]));
});

test("a clock that steps backwards or returns nonsense cannot produce a bad timing", () => {
  /* Date.now is not monotonic, and a caller's clock is whatever the caller
     passed. A negative difference is written as 0; a non-finite one leaves
     the stage untimed. Either way every stage is still listed, in order. */
  const p = makeParams({ seed: "CLOCK" });
  let t = 1000;
  const back = groundBundle(p, { res: 33, erode: false, now: () => (t -= 7) }).manifest.stages;
  eq(JSON.stringify(back), JSON.stringify([{ name: "bake", ms: 0 }, { name: "masks", ms: 0 }, { name: "hash", ms: 0 }]));
  const nan = groundBundle(p, { res: 33, erode: false, now: () => NaN }).manifest.stages;
  eq(JSON.stringify(nan), JSON.stringify([{ name: "bake" }, { name: "masks" }, { name: "hash" }]));
  // A clock that fails once and recovers: only the stages it could not time
  // lose their ms, and the next difference is measured from the last good tick.
  const ticks = [0, 10, NaN, 25, 30];
  let n = 0;
  const flaky = groundBundle(p, { res: 33, erode: false, now: () => ticks[n++] }).manifest.stages;
  eq(JSON.stringify(flaky), JSON.stringify([{ name: "bake", ms: 10 }, { name: "masks" }, { name: "hash", ms: 15 }]));
});

test("a bundle with no erosion says so: no erode stage, deltaHash null", () => {
  const p = makeParams({ seed: "DRY" });
  const first = groundBundle(p, { res: SMALL, erode: false });
  eq(first.manifest.deltaHash, null); eq(first.delta, null);
  eq(JSON.stringify(first.manifest.stages.map((s) => s.name)), JSON.stringify(["bake", "masks", "hash"]));
  const off = groundBundle(mergeParams(p, { terrain: { erosion: { enabled: false } } }), { res: SMALL });
  eq(off.manifest.deltaHash, null);
  // The same un-eroded surface either way; only the parameter hash tells
  // "erosion off in the world" from "erosion skipped by the caller".
  eq(first.manifest.heightHash, off.manifest.heightHash);
  ok(first.manifest.parameterHash !== off.manifest.parameterHash, "erosion.enabled is not in the parameter hash");
  eq(first.manifest.res, SMALL); eq(first.manifest.cellSize, p.terrain.size / (SMALL - 1));
});

test("groundBundle refuses what it cannot honestly describe", () => {
  const p = makeParams({ seed: "BAD" });
  for (const [what, call] of [
    ["no params", () => groundBundle(null)],
    ["res 1", () => groundBundle(p, { res: 1 })],
    ["res 64.5", () => groundBundle(p, { res: 64.5 })],
    ["a clock that is not a function", () => groundBundle(p, { res: 9, now: 3 })],
    // "false" is truthy; reading it as true would run the erosion it asked to skip.
    ["erode as a string", () => groundBundle(p, { res: 9, erode: "false" })],
    ["erode as a number", () => groundBundle(p, { res: 9, erode: 0 })],
    ["a NaN water level", () => groundBundle(mergeParams(p, { water: { level: NaN } }), { res: 9 })],
    ["a water level as a string", () => groundBundle(mergeParams(p, { water: { level: "3" } }), { res: 9 })],
    // These bake a field of NaN without complaint; the manifest would carry
    // size/min/max as null and fail its own schema.
    ["a NaN terrain size", () => groundBundle(mergeParams(p, { terrain: { size: NaN } }), { res: 9 })],
    ["a NaN terrain height", () => groundBundle(mergeParams(p, { terrain: { height: NaN } }), { res: 9 })],
  ]) {
    ok(throws(call), `groundBundle accepted ${what}`);
  }
  // …and what it may accept, it does: no water section at all means sea level 0.
  const { water, ...noWater } = p;
  eq(groundBundle(noWater, { res: 9, erode: false }).manifest.waterLevel, 0);
});

test("ground.js is part of the core, so the boundary test holds it", () => {
  for (const m of ["src/kernel/terrain/ground.js", "src/kernel/terrain/canonical.js", "src/kernel/terrain/fingerprint.js", "src/kernel/terrain/erosion.js"]) {
    ok(CORE_MODULES.includes(m), `${m} is not in CORE_MODULES`);
  }
});

test("the default world's ground bakes in a measured time", () => {
  const s = TIMED.manifest.stages.map((x) => `${x.name} ${x.ms.toFixed(0)}`).join(", ");
  print(`    default world groundBundle: ${TIMED_MS.toFixed(0)} ms at ${CANONICAL_RES}² (${s} ms)`);
  // Generous on purpose: this is a regression tripwire, not a benchmark.
  ok(TIMED_MS < 5000, `the default world took ${TIMED_MS.toFixed(0)} ms to bake`);
});

// ── placements ──────────────────────────────────────────────────────────────

const RECORDS = [
  { uid: "p3f2a-1", ref: "tree.oak", position: [12.345678, 4.5, -300.25], rotationY: 1.2345678, scale: 1 },
  { uid: "p3f2a-0", ref: "rock.flat", proc: { seed: "A", size: 2 }, position: [-7, 0.125, 40], scale: [1, 2, 1] },
  { uid: "p3f2a-a", ref: "lamp", position: [0, 0, 0], rotationY: 0, scale: 0.5, label: undefined },
];

test("placementsHash ignores record order, key order and sub-quantum noise", () => {
  const h = placementsHash(RECORDS);
  ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, "not a uint32");
  eq(placementsHash([...RECORDS].reverse()), h, "record order moved the hash");
  const reKeyed = RECORDS.map((r) => Object.fromEntries(Object.entries(r).reverse()));
  eq(placementsHash(reKeyed), h, "key order moved the hash");
  // 1e-6 is a hundredth of the quantum; these values sit nowhere near a
  // rounding boundary (12.345678 is 123456.78 quanta).
  const noisy = RECORDS.map((r) => ({ ...r, position: r.position.map((x) => x + 1e-6) }));
  eq(placementsHash(noisy), h, "float noise below the quantum moved the hash");
  eq(PLACEMENT_QUANTUM, 1e-4);
});

test("placementsHash moves for every real difference", () => {
  const h = placementsHash(RECORDS);
  const moved = RECORDS.map((r, i) => (i === 0 ? { ...r, position: [r.position[0] + 2e-4, r.position[1], r.position[2]] } : r));
  ok(placementsHash(moved) !== h, "a 0.2 mm move was not seen");
  ok(placementsHash(RECORDS.slice(1)) !== h, "a deleted placement was not seen");
  ok(placementsHash(RECORDS.map((r, i) => (i === 1 ? { ...r, ref: "rock.tall" } : r))) !== h, "a swapped model was not seen");
  ok(placementsHash(RECORDS.map((r, i) => (i === 2 ? { ...r, uid: "p3f2a-b" } : r))) !== h, "a re-minted uid was not seen");
  // "No placements given" and "there are none" are different answers.
  eq(placementsHash(null), null); eq(placementsHash(undefined), null);
  eq(placementsHash([]), hashString("[]"));
});

test("the canonical text is the documented form, character for character", () => {
  /* Pinned as text so a port in another language can be checked against the
     string before the hash: sorted by uid, keys sorted, numbers as integer
     counts of 1e-4, −0 as 0, a non-finite number as null, undefined dropped. */
  eq(canonicalPlacements([
    { uid: "b", x: 1.5, y: -0.00001, z: NaN, w: undefined, list: [0.25, null, "s"] },
    { uid: "a", k: { z: 1, a: -2.00004 }, flag: true },
  ]), '[{"flag":true,"k":{"a":-20000,"z":10000},"uid":"a"},{"list":[2500,null,"s"],"uid":"b","x":15000,"y":0,"z":null}]');
  // Two records sharing a uid still sort to one order, whatever came first.
  const twins = [{ uid: "same", n: 2 }, { uid: "same", n: 1 }];
  eq(canonicalPlacements(twins), canonicalPlacements([...twins].reverse()));
  ok(throws(() => canonicalPlacements({ uid: "not a list" })), "a non-array was accepted as a placement list");
});

test("placementsHash writes a typed array as the array it holds", () => {
  // A renderer keeps a position as a Float32Array; a file parses back an Array.
  const f32 = new Float32Array([12.5, -3.25, 0.125]); // exact in float32, so the values are equal
  eq(placementsHash([{ uid: "a", position: f32 }]), placementsHash([{ uid: "a", position: [12.5, -3.25, 0.125] }]));
  eq(canonicalPlacements([{ uid: "a", p: new Int16Array([1, -2]) }]), '[{"p":[10000,-20000],"uid":"a"}]');
  // toJSON is honoured as JSON honours it.
  eq(canonicalPlacements([{ uid: "d", at: { toJSON: () => "2026-01-01" } }]), '[{"at":"2026-01-01","uid":"d"}]');
});

test("placementsHash refuses what it cannot write faithfully", () => {
  for (const [what, records] of [
    ["a numeric uid", [{ uid: 10 }]],
    ["a boolean uid", [{ uid: true }]],
    ["a BigInt", [{ uid: "a", n: 10n }]],
    ["a Map", [{ uid: "a", m: new Map([[1, 2]]) }]],
    ["a Set", [{ uid: "a", s: new Set([1]) }]],
    ["an ArrayBuffer", [{ uid: "a", b: new ArrayBuffer(4) }]],
    ["a DataView", [{ uid: "a", b: new DataView(new ArrayBuffer(4)) }]],
    ["a BigInt64Array", [{ uid: "a", b: new BigInt64Array(1) }]],
    ["a symbol", [{ uid: "a", s: Symbol("x") }]],
    ["a lone high surrogate in a value", [{ uid: "a", label: "\ud800x" }]],
    ["a lone low surrogate in a key", [{ uid: "a", ["\udc00"]: 1 }]],
    ["a lone surrogate in a uid", [{ uid: "\ud83d" }]],
    ["a value past 2^53 quanta", [{ uid: "a", x: 1e12 }]],
    ["a value in exponent form", [{ uid: "a", x: -1e20 }]],
  ]) {
    ok(throws(() => placementsHash(records)), `placementsHash accepted ${what}`);
  }
  // The edges of what it accepts: a proper surrogate pair, and the largest
  // magnitude whose count is still an exact integer.
  eq(canonicalPlacements([{ uid: "\u{1F332}" }]), '[{"uid":"\u{1F332}"}]');
  eq(canonicalPlacements([{ uid: "a", x: 900719925474 }]), '[{"uid":"a","x":9007199254740000}]');
  // A uid is optional; records without one sort first, as "".
  eq(canonicalPlacements([{ uid: "a" }, { ref: "x" }, { uid: null, ref: "y" }]),
     '[{"ref":"x"},{"ref":"y","uid":null},{"uid":"a"}]');
});

test("a fingerprint without placements is the fingerprint it always was", () => {
  const p = makeParams({ seed: "PLACED" });
  const field = bakeHeightField(p, 33);
  const before = canonicalTerrainFingerprint({ params: p, field });
  /* The key list a fingerprint had before placementsHash existed. Absent,
     not null: the serialised fingerprint is the same text it always was. */
  eq(Object.keys(before).join(","), [
    "id", "view", "seed", "biome", "generatorVersion", "paramsVersion", "resolution", "dimensions",
    "cellSize", "heightMin", "heightMax", "verticalScale", "waterLevel", "seaLevel", "heightHash",
    "landMaskHash", "flowMaskHash", "parameterHash", "erosion", "sculptStrokes", "meshRes", "lodLevel",
  ].join(","));
  ok(!formatFingerprint("X", before).includes("placementsHash"), "the readout grew a line nobody asked for");

  const placed = canonicalTerrainFingerprint({ params: p, field, placements: RECORDS });
  eq(placed.placementsHash, placementsHash(RECORDS));
  ok(formatFingerprint("X", placed).includes("placementsHash"), "the readout does not show the placements");
  const { placementsHash: _, ...rest } = placed;
  eq(JSON.stringify(rest), JSON.stringify(before), "giving placements changed some OTHER line");
  // classify() is about the ground. Same ground, different furniture: C.
  eq(classify(before, placed).verdict, "C");
  const other = canonicalTerrainFingerprint({ params: p, field, placements: RECORDS.slice(1) });
  eq(classify(placed, other).verdict, "C");
  eq(canonicalTerrainFingerprint({ params: p, field, placements: [] }).placementsHash, hashString("[]"));
});

report("ground");
