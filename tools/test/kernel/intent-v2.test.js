/* Intent v2 — asks that are about a line: shoreline, ray, corridor, pad.
 *
 * src/kernel/terrain/condition.js promises four things about them, and this file
 * is where each is measured:
 *
 *   WHAT IS ASKED IS DELIVERED. Equalities to a centimetre, inequalities to a
 *   millimetre, read back off the analytic sampler the world actually draws —
 *   not off the solver's own bookkeeping.
 *
 *   AN ASK THAT CANNOT BE MET SAYS SO. A contradiction comes back as ground,
 *   finite, with a positive `miss`; nothing throws.
 *
 *   NOTHING ELSE MOVES. A file with only version-1 records solves to the bit
 *   as it did before v2 existed: the numbers pinned below were produced by the
 *   code at the commit before this one (git archive HEAD, run under Node), and
 *   the parameter hash of such a world is the hash it always had.
 *
 *   THE ROWS ARE THE ROWS. The system the solve used travels with the sampler,
 *   so a reader (terrain/sigma.js) reasons over exactly those rows.
 */
import { test, eq, ok, close, report } from "./harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import {
  normalizeIntent, intentErrors, polylineSamples, rowsFor, INTENT_TYPES, INTENT_VERSION, MAX_INTENT, MAX_ROWS,
  SHORE_STEP, SHORE_SAMPLES, SHORE_MARGIN, CORRIDOR_STEP, CORRIDOR_SAMPLES, RAY_SAMPLES, GRADIENT_STEP, FLAT_RING,
} from "../../../src/kernel/terrain/condition.js";
import { terrainParameterHash } from "../../../src/kernel/terrain/fingerprint.js";

const SEEDS = ["K7QN-3F2A-9XBD", "TMNR-2J2A-PG43", "Q375-ND9S-NSQV", "6QKX-J4XR-Z5D3"];
const CM = 0.01, MM = 0.001;
const world = (seed, intent, water) => {
  const p = makeParams({ seed });
  p.terrain.intent = intent;
  if (water !== undefined) p.water.level = water;
  return p;
};
const sampler = (seed, intent, water) => createHeightSampler(world(seed, intent, water));
const dist = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
// The largest difference between two samplers on a 200 m grid over the middle 4 km.
const moved = (a, b) => {
  let w = 0;
  for (let x = -2000; x <= 2000; x += 200) for (let z = -2000; z <= 2000; z += 200) w = Math.max(w, Math.abs(a(x, z) - b(x, z)));
  return w;
};

/* ══ nothing else moves ════════════════════════════════════════════════ */

/* Produced by the pre-v2 code (commit eedf79f) for this exact list. JSON
   carries a double exactly, so `eq` here is equality to the bit. */
const V1 = [
  { type: "level", h: 30 },
  { type: "summit", x: -400, z: -900, h: 180 },
  { type: "flat", x: 900, z: 900, r: 80, h: 40 },
  { type: "point", x: 300, z: -200, h: 250 },
  { type: "point", x: -900, z: 700, h: -20, op: "<=" },
  { type: "point", x: 1800, z: 100, h: 12, op: ">=" },
];
const V1_PROBES = [[0, 0], [-400, -900], [900, 900], [1234.5, -321.25], [-1700, 1600]];
const V1_GOLDEN = {
  "K7QN-3F2A-9XBD": { nats: 159.30187137009148, miss: 0.03126280325789668, h: [126.47147648073744, 179.99845487243755, 40.00016353908384, 121.0460098933524, -89.5618608464907] },
  "TMNR-2J2A-PG43": { nats: 125.46295872289811, miss: 0.002932172988820529, h: [236.0151602505511, 179.9992939202421, 40.00094866576204, 96.43963510175936, -101.79304795948875] },
  "Q375-ND9S-NSQV": { nats: 103.72529412188635, miss: 0.007890061654339947, h: [200.8522018390209, 179.99981988864013, 40.00115547073964, 51.60572852575233, -37.441332898422964] },
};

test("a v1-only list solves to the bit as it did before v2", () => {
  for (const [seed, g] of Object.entries(V1_GOLDEN)) {
    const s = sampler(seed, V1);
    eq(s.conditioning.nats, g.nats, `${seed} nats:`);
    eq(s.conditioning.miss, g.miss, `${seed} miss:`);
    V1_PROBES.forEach(([x, z], i) => eq(s(x, z), g.h[i], `${seed} height at ${x},${z}:`));
    eq(s.conditioning.dropped, 0, "and MAX_ROWS turns nothing away");
  }
});

test("a v1 world's parameter hash is the hash it had; a shoreline's carries the waterline", () => {
  // Both values from the pre-v2 code, as above.
  const p = world("K7QN-3F2A-9XBD", [{ type: "level", h: 30 }, { type: "summit", x: -400, z: -900, h: 180 }]);
  eq(terrainParameterHash(p), 4089282656, "v1 intent:");
  eq(terrainParameterHash(world("K7QN-3F2A-9XBD", [])), 1756194718, "no intent:");
  eq(terrainParameterHash(world("K7QN-3F2A-9XBD", V1, 7)), terrainParameterHash(world("K7QN-3F2A-9XBD", V1, 0)),
    "without a shoreline the water level is still not terrain");
  const coast = [{ type: "shoreline", points: [[-600, 0], [600, 0]] }];
  ok(terrainParameterHash(world("K7QN-3F2A-9XBD", coast, 7)) !== terrainParameterHash(world("K7QN-3F2A-9XBD", coast, 0)),
    "with one, a different waterline is a different ground, and the hash says so");
  const own = [{ type: "shoreline", points: [[-600, 0], [600, 0]], level: 3 }];
  eq(terrainParameterHash(world("K7QN-3F2A-9XBD", own, 7)), terrainParameterHash(world("K7QN-3F2A-9XBD", own, 0)),
    "a shoreline that carries its own level makes the water level not terrain again");
});

test("freezing a shoreline's waterline into it moves neither the ground nor the hash", () => {
  /* What Engine.setFloodLevel does before it floods: a shoreline with no
     level of its own gets the level its ground was solved at. The world must
     not change under that, or flooding would move land and a save would
     reopen as different ground. */
  const coast = [{ type: "level", h: 20 }, { type: "shoreline", points: [[-600, 0], [600, 0]], side: "left" }];
  for (const seed of SEEDS.slice(0, 3)) {
    const live = world(seed, coast, 7);
    const frozen = world(seed, coast.map((r) => (r.type === "shoreline" ? { ...r, level: 7 } : r)), 0);
    eq(terrainParameterHash(live), terrainParameterHash(frozen), `${seed}: the same hash`);
    const a = createHeightSampler(live), b = createHeightSampler(frozen);
    eq(moved(a, b), 0, `${seed}: the same ground, to the bit`);
    eq(a.conditioning.nats, b.conditioning.nats);
    // And once frozen, flooding the world is a different sea over the same land.
    eq(moved(b, createHeightSampler(world(seed, frozen.terrain.intent, 30))), 0, `${seed}: the flood moves no land`);
  }
});

test("a shoreline's own level is the waterline it stands at", () => {
  for (const seed of SEEDS.slice(1)) {
    const s = sampler(seed, [{ type: "shoreline", points: [[-500, 200], [500, 300]], level: -15 }], 4);
    ok(s.conditioning.miss <= CM, `${seed}: miss ${s.conditioning.miss.toFixed(4)}`);
    for (const p of polylineSamples([[-500, 200], [500, 300]], SHORE_STEP)) close(s(p.x, p.z), -15, CM, `${seed}: at −15 m, not at the sea's 4 m`);
  }
});

test("the version and the vocabulary", () => {
  eq(INTENT_VERSION, 2);
  for (const t of ["point", "summit", "flat", "level", "shoreline", "ray", "corridor", "pad"]) ok(INTENT_TYPES.includes(t), t);
  eq(MAX_INTENT, 48, "the record cap is where it was");
  ok(MAX_ROWS >= 48 * 9, "and no v1 list can reach the row cap");
});

/* ══ shoreline ═════════════════════════════════════════════════════════ */

/* A coast across the middle of the map with a bend in it. Three of the four
   suite seeds; K7QN is left to the fold test below, because this line runs
   through ground where its domain warp nearly folds (Jacobian determinant
   0.08) and the solve misses there by 0.25 m — measured, and reported. */
const COAST = [[-800, -300], [-300, -100], [200, -250], [700, 100]];
const COAST_SEEDS = SEEDS.slice(1);

test("a shoreline stands every sample at the waterline, land to one side and sea to the other", () => {
  const samples = polylineSamples(COAST, SHORE_STEP, SHORE_SAMPLES);
  for (const seed of COAST_SEEDS) {
    for (const side of ["left", "right"]) {
      const s = sampler(seed, [{ type: "shoreline", points: COAST, side }]);
      const c = s.conditioning;
      ok(c.converged, `${seed} ${side}: converged`);
      ok(c.miss <= CM, `${seed} ${side}: miss ${c.miss.toFixed(4)} m`);
      ok(c.nats > 0 && Number.isFinite(c.nats), `${seed}: nats reported (${c.nats.toFixed(0)})`);
      const k = side === "left" ? 40 : -40;
      for (const p of samples) {
        close(s(p.x, p.z), 0, CM, `${seed} ${side} waterline at ${p.x.toFixed(0)},${p.z.toFixed(0)}:`);
        ok(s(p.x + k * p.nx, p.z + k * p.nz) >= SHORE_MARGIN - MM, `${seed} ${side}: land side is land`);
        ok(s(p.x - k * p.nx, p.z - k * p.nz) <= -SHORE_MARGIN + MM, `${seed} ${side}: sea side is sea`);
      }
      for (const [x, z] of COAST) close(s(x, z), 0, CM, `${seed} ${side}: every vertex is a sample`);
    }
  }
});

test("a shoreline follows the world's own waterline, and a bare one only pins the line", () => {
  for (const seed of COAST_SEEDS) {
    const s = sampler(seed, [{ type: "shoreline", points: COAST, side: "left", offset: 60 }], 6);
    ok(s.conditioning.miss <= CM, `${seed}: miss ${s.conditioning.miss.toFixed(4)}`);
    for (const p of polylineSamples(COAST, SHORE_STEP, SHORE_SAMPLES)) {
      close(s(p.x, p.z), 6, CM, `${seed}: at the raised waterline`);
      ok(s(p.x + 60 * p.nx, p.z + 60 * p.nz) >= 6 + SHORE_MARGIN - MM, `${seed}: land 60 m off`);
      ok(s(p.x - 60 * p.nx, p.z - 60 * p.nz) <= 6 - SHORE_MARGIN + MM, `${seed}: sea 60 m off`);
    }
    const bare = sampler(seed, [{ type: "shoreline", points: COAST }]);
    eq(bare.conditioning.rows, polylineSamples(COAST, SHORE_STEP, SHORE_SAMPLES).length, "one row a sample without a side");
    ok(bare.conditioning.miss <= CM, `${seed}: bare miss ${bare.conditioning.miss.toFixed(4)}`);
  }
});

test("where the domain warp folds, a coast's two sides read one lattice — and the miss says so", () => {
  /* 23ZQ-JEG9-KR96: along COAST its warp's Jacobian determinant goes to
     −0.07 (measured at 51 points a segment), so ground on either side of the
     fold is read from the same lattice values and no correction drawn from
     them can raise one side and sink the other. The solve still returns
     ground, and the shortfall — 4.0 m, measured — is the number reported. */
  for (const seed of ["23ZQ-JEG9-KR96", "K7QN-3F2A-9XBD"]) {
    const s = sampler(seed, [{ type: "shoreline", points: COAST, side: "left" }]);
    ok(Number.isFinite(s(0, 0)) && Number.isFinite(s(-300, -100)), `${seed}: the ground is still ground`);
    ok(s.conditioning.miss > CM, `${seed}: the shortfall is reported (${s.conditioning.miss.toFixed(3)} m)`);
  }
});

/* ══ ray ═══════════════════════════════════════════════════════════════ */

test("a ray with no h ends on the conditioned ground, and is never pierced at its samples", () => {
  /* With no h the far end is wherever the ground ends up, so each sample's
     row reads both ends and states nothing about the far end itself: there
     are `samples` rows, not samples + 1, and contact adds none (the line is
     on the ground at `at` by definition). Checked against the ground the
     sampler draws at `at`, not the seed's raw ground there.
     Between samples the ground is free: measured at 480 points along these
     rays (24 samples, 1.6 km), the worst crossing was 0.28–1.69 m on the
     four seeds. A sightline that must hold everywhere asks for more samples.
     (Two of these eyes stand a little under the sea — TMNR −0.11 m, Q375
     −5.5 m — which is the case the eye's datum in the row is there for.) */
  for (const seed of SEEDS) {
    const raw = sampler(seed, []);
    const eye = [-600, raw(-600, 400) + 1.7, 400], at = [900, -200];
    const samples = 24;
    const plain = sampler(seed, [{ type: "ray", eye, at, samples }]);
    const touch = sampler(seed, [{ type: "ray", eye, at, samples, contact: true }]);
    eq(plain.conditioning.rows, samples, "one row a sample, none for the far end");
    eq(moved(plain, touch), 0, `${seed}: contact without h is the same statement`);
    const c = plain.conditioning;
    ok(c.converged && c.miss <= CM, `${seed}: miss ${c.miss.toExponential(2)}`);
    ok(Number.isFinite(c.nats), "nats reported");
    const end = plain(at[0], at[1]);
    for (let k = 0; k < samples; k++) {
      const t = k / samples, x = eye[0] + (at[0] - eye[0]) * t, z = eye[2] + (at[1] - eye[2]) * t;
      ok(plain(x, z) <= eye[1] + (end - eye[1]) * t + MM, `${seed}: sample ${k} under the ray`);
    }
  }
});

test("a ray with no h states nothing about its far end, next to statements that do", () => {
  /* The blocking case from review. A missing h once meant "the ground the
     SEED grew at `at`", which is a statement — the far end stays at or
     under its raw height — and beside a v1 list it held a row and moved
     ground by up to 296 m (TMNR), 207 m (Q375), 64 m (K7QN). Now a ray 5 km
     up beside the same list holds no row at all. What still moves is the
     loop: a list with a ray goes through the refined active set (see the
     header), measured here at up to 0.77 m (K7QN), 0.18 m (Q375) and 5 mm
     (TMNR) on a 200 m grid. */
  const list = [{ type: "level", h: 30 }, { type: "summit", x: -400, z: -900, h: 180 },
                { type: "flat", x: 900, z: 900, r: 80, h: 40 }, { type: "point", x: 300, z: -200, h: 250 }];
  for (const seed of SEEDS.slice(0, 3)) {
    const a = sampler(seed, list), b = sampler(seed, [...list, { type: "ray", eye: [0, 5000, 0], at: [100, 0] }]);
    eq(b.conditioning.system.used.filter((c) => c.record === 4).length, 0, `${seed}: the ray holds nothing`);
    ok(moved(a, b) < 1, `${seed}: the ground moves by the loop alone (${moved(a, b).toFixed(3)} m)`);
    ok(b.conditioning.nats < a.conditioning.nats + 2, `${seed}: and costs nothing (${a.conditioning.nats.toFixed(1)} → ${b.conditioning.nats.toFixed(1)} nats)`);

    /* A ray to a point another statement places: the line ends where THAT
       statement puts the ground, above the seed's ground or below it. Under
       water (the second, on TMNR) the datum form is stricter than asked, so
       the ground stays further under the line, never over it. */
    const raw = sampler(seed, []);
    const eye = [-600, raw(-600, 400) + 1.7, 400], at = [900, -200];
    for (const lift of [80, -60]) {
      const H = raw(at[0], at[1]) + lift;
      const s = sampler(seed, [{ type: "point", x: at[0], z: at[1], h: H }, { type: "ray", eye, at, samples: 24 }]);
      ok(s.conditioning.converged && s.conditioning.miss <= CM, `${seed} ${lift}: miss ${s.conditioning.miss.toExponential(2)}`);
      close(s(at[0], at[1]), H, CM, `${seed} ${lift}: the point stands where it was asked`);
      for (let k = 0; k < 24; k++) {
        const t = k / 24, x = eye[0] + (at[0] - eye[0]) * t, z = eye[2] + (at[1] - eye[2]) * t;
        ok(s(x, z) <= eye[1] + (H - eye[1]) * t + MM, `${seed} ${lift}: sample ${k} under the line to the point`);
      }
    }
  }
});

test("a ray to a stated height, and the default sample count", () => {
  for (const seed of SEEDS.slice(0, 3)) {
    const eye = [0, 260, 0], at = [1400, 300], h = 140;
    const s = sampler(seed, [{ type: "ray", eye, at, h, contact: true }]);
    eq(s.conditioning.rows, RAY_SAMPLES + 1, "samples + the far end");
    close(s(at[0], at[1]), h, CM, `${seed}: the far end stands at h`);
    for (let k = 0; k < RAY_SAMPLES; k++) {
      const t = k / RAY_SAMPLES;
      ok(s(eye[0] + (at[0] - eye[0]) * t, eye[2] + (at[1] - eye[2]) * t) <= eye[1] + (h - eye[1]) * t + MM, `${seed}: under the ray`);
    }
  }
});

/* ══ corridor ══════════════════════════════════════════════════════════ */

test("a corridor holds its grade between every pair of samples", () => {
  /* At the samples, to the millimetre. Between them the ground keeps its own
     detail: measured every 4 m along this road at maxGrade 0.06, the steepest
     4 m step was 0.05–0.26 on the four seeds. The bound is on the 32 m step,
     which is a road's grade; a cart track's bumps are a finer statement. */
  const road = [[-1000, 600], [-200, 300], [500, 700], [1200, 200]];
  const pts = polylineSamples(road, CORRIDOR_STEP, CORRIDOR_SAMPLES);
  for (const seed of SEEDS) {
    for (const maxGrade of [0.06, 0.12]) {
      const raw = sampler(seed, []);
      const s = sampler(seed, [{ type: "corridor", points: road, maxGrade }]);
      ok(s.conditioning.converged, `${seed} ${maxGrade}: converged`);
      eq(s.conditioning.rows, 2 * (pts.length - 1), "two rows a pair");
      let rawWorst = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = dist(pts[i - 1], pts[i]);
        ok(Math.abs(s(pts[i].x, pts[i].z) - s(pts[i - 1].x, pts[i - 1].z)) <= maxGrade * d + MM, `${seed} ${maxGrade}: pair ${i}`);
        rawWorst = Math.max(rawWorst, Math.abs(raw(pts[i].x, pts[i].z) - raw(pts[i - 1].x, pts[i - 1].z)) / d);
      }
      if (rawWorst > maxGrade) ok(s.conditioning.nats > 0 && s.conditioning.active > 0, `${seed}: a steep road cost something`);
    }
  }
});

/* ══ pad ═══════════════════════════════════════════════════════════════ */

test("a pad is a flat with a height it must have", () => {
  const e = GRADIENT_STEP;
  for (const seed of SEEDS) {
    const s = sampler(seed, [{ type: "pad", x: 300, z: 300, r: 60, h: 75 }]);
    eq(s.conditioning.rows, 9, "the nine rows of a flat with h");
    ok(s.conditioning.miss <= CM, `${seed}: miss ${s.conditioning.miss.toExponential(2)}`);
    close(s(300, 300), 75, CM, `${seed} centre:`);
    close(s(300 + e, 300), s(300 - e, 300), CM, `${seed} level east-west:`);
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      close(s(300 + 60 * Math.cos(a), 300 + 60 * Math.sin(a)), 75, CM, `${seed} ring ${k}:`);
    }
  }
  eq(normalizeIntent([{ type: "pad", x: 0, z: 0, r: 50 }]), null, "a pad without a height is not a pad");
});

test("a pad is sugar: the same ground as a flat with h, to the bit, alone or in a list", () => {
  /* A pad takes the flat's solve (the v1 loop) rather than the v2 one, so
     the two are one statement written two ways. In a list with a line or a
     ray they are both solved by the v2 loop, and equal again. */
  for (const seed of SEEDS.slice(0, 3)) {
    for (const rest of [[], [{ type: "point", x: -500, z: 200, h: 120 }], [{ type: "corridor", points: [[-900, -600], [-200, -700]] }]]) {
      const pad = sampler(seed, [{ type: "pad", x: 300, z: 300, r: 60, h: 75 }, ...rest]);
      const flat = sampler(seed, [{ type: "flat", x: 300, z: 300, r: 60, h: 75 }, ...rest]);
      eq(moved(pad, flat), 0, `${seed} with ${rest.length ? rest[0].type : "nothing"}:`);
      eq(pad.conditioning.nats, flat.conditioning.nats);
    }
  }
});

test("a flat's ring is a table of the doubles V8 gave, so no engine can round it differently", () => {
  eq(FLAT_RING.length, 6);
  FLAT_RING.forEach(([c, s], k) => {
    eq(c, Math.cos((k * Math.PI) / 3), `cos ${k}:`);
    eq(s, Math.sin((k * Math.PI) / 3), `sin ${k}:`);
  });
});

/* ══ asks that cannot all be true ══════════════════════════════════════ */

test("contradictory asks come back as ground with a positive miss, never a throw", () => {
  const cases = [
    ["a coast through a high pad", [{ type: "pad", x: 0, z: 0, r: 60, h: 90 }, { type: "shoreline", points: [[-300, 0], [300, 0]], side: "left" }]],
    ["a flat road between two pads 100 m apart in height", [
      { type: "pad", x: -150, z: 0, r: 50, h: 20 }, { type: "pad", x: 150, z: 0, r: 50, h: 120 },
      { type: "corridor", points: [[-150, 0], [150, 0]], maxGrade: 0.01 }]],
    ["a sightline through a summit above it", [
      { type: "summit", x: 0, z: 0, h: 250 }, { type: "ray", eye: [-800, 100, 0], at: [800, 0], h: 100, contact: true }]],
  ];
  for (const seed of SEEDS.slice(0, 3)) {
    for (const [name, intent] of cases) {
      let s;
      try { s = sampler(seed, intent); } catch (err) { ok(false, `${seed} ${name}: threw ${err.message}`); }
      ok(Number.isFinite(s(0, 0)) && Number.isFinite(s(150, 0)), `${seed} ${name}: finite ground`);
      ok(s.conditioning.miss > 0.5, `${seed} ${name}: miss ${s.conditioning.miss.toFixed(2)} m`);
      ok(Number.isFinite(s.conditioning.nats), `${seed} ${name}: nats ${s.conditioning.nats.toFixed(0)}`);
    }
  }
});

/* ══ the rows travel with the sampler ══════════════════════════════════ */

test("the solved system is on the sampler, out of the way of its summary", () => {
  const s = sampler(SEEDS[1], [{ type: "pad", x: 0, z: 0, r: 60, h: 50 }, { type: "point", x: 500, z: 0, h: 300, op: "<=" }]);
  const sys = s.conditioning.system;
  ok(sys && sys.basis && Array.isArray(sys.used) && Array.isArray(sys.all), "system, basis, rows");
  eq(sys.all.length, s.conditioning.rows, "every row stated");
  eq(sys.used.length, sys.all.filter((c) => !c.ineq).length + s.conditioning.active, "the equalities and the held bounds");
  ok(!Object.keys(s.conditioning).includes("system") && !JSON.stringify(s.conditioning).includes("basis"),
    "the summary stays a small plain object");
  eq(sys.records.length, 2, "and the records it was read from");
});

test("v2 intent is a pure function of the params", () => {
  const intent = [{ type: "shoreline", points: COAST, side: "right" }, { type: "corridor", points: [[0, 600], [900, 900]] },
                  { type: "ray", eye: [-500, 200, 800], at: [600, 900] }, { type: "pad", x: -700, z: 700, r: 70, h: 45 }];
  const a = sampler(SEEDS[2], intent), b = sampler(SEEDS[2], JSON.parse(JSON.stringify(intent)));
  eq(a.conditioning.nats, b.conditioning.nats, "the same cost");
  for (const [x, z] of [[0, 0], [-300, -100], [450, 750], [-700, 700], [1500, -1500]]) eq(a(x, z), b(x, z), `at ${x},${z}:`);
});

/* ══ a file's v2 intent is read, never trusted ═════════════════════════ */

test("v2 records are normalised: clean copies, clamps, defaults", () => {
  const out = normalizeIntent([
    { type: "shoreline", points: [[0, 0], [100, 0], ["x", 1], [200, 50]], side: "up", offset: 3, colour: 1 },
    { type: "shoreline", points: [[0, 0], [10, 0]], side: "left", offset: 3 },
    { type: "shoreline", points: [[0, 0]] },
    { type: "ray", eye: [0, 10], at: [5, 5] },
    { type: "ray", eye: [0, 10, 0], at: [500, 5], samples: 999, contact: "yes" },
    { type: "corridor", points: Array.from({ length: 80 }, (_, i) => [i * 10, 0]), maxGrade: -1 },
    { type: "pad", x: 0, z: 0, r: 1, h: 5 },
  ]);
  eq(out.length, 5, "the one-point line and the two-number eye are gone");
  eq(out[0].points.length, 3, "an unreadable vertex is dropped");
  eq(out[0].side, undefined, "an unknown side is no side");
  eq(out[0].colour, undefined, "unknown fields are not carried");
  ok(out[1].offset >= 12, "a side offset too near the line is widened");
  eq(out[2].samples, 64, "samples are capped");
  eq(out[2].contact, false, "contact is true or it is not");
  eq(out[3].points.length, 64, "a polyline is capped at 64 vertices");
  eq(out[3].maxGrade, 0, "a negative grade is a level road");
  ok(out[4].r >= 2 * GRADIENT_STEP, "a pad too small to be a pad is widened");
  eq(normalizeIntent([{ type: "corridor", points: [[0, 0], [100, 0]] }])[0].maxGrade, 0.12, "the default grade");
  eq(normalizeIntent([{ type: "ray", eye: [0, 1, 0], at: [1, 1] }])[0].samples, RAY_SAMPLES, "the default samples");
});

test("a file carrying bad v2 intent is told which record and which field", () => {
  eq(intentErrors([{ type: "shoreline", points: [[0, 0], [100, 0]], side: "left" }, { type: "pad", x: 0, z: 0, r: 60, h: 3 }]).length, 0);
  ok(intentErrors([{ type: "shoreline", points: "north" }]).some((e) => /intent\[0\]\.points/.test(e)));
  ok(intentErrors([{ type: "shoreline", points: [[0, 0], [1, "a"]] }]).some((e) => /intent\[0\]\.points\[1\]/.test(e)));
  ok(intentErrors([{ type: "corridor", points: [[0, 0]] }]).some((e) => /at least 2/.test(e)));
  ok(intentErrors([{ type: "shoreline", points: [[0, 0], [1, 1]], side: "up" }]).some((e) => /intent\[0\]\.side/.test(e)));
  ok(intentErrors([{ type: "ray", eye: [0, 0], at: [1, 1] }]).some((e) => /intent\[0\]\.eye/.test(e)));
  ok(intentErrors([{ type: "ray", eye: [0, 0, 0], at: [1, 1], contact: 1 }]).some((e) => /intent\[0\]\.contact/.test(e)));
  ok(intentErrors([{ type: "corridor", points: [[0, 0], [1, 1]], maxGrade: -2 }]).some((e) => /maxGrade/.test(e)));
  ok(intentErrors([{ type: "pad", x: 0, z: 0, r: 60 }]).some((e) => /intent\[0\]\.h/.test(e)));
  const long = Array.from({ length: 64 }, (_, i) => [i * 300 - 9600, 0]);
  const many = Array.from({ length: 3 }, () => ({ type: "shoreline", points: long, side: "left" }));
  ok(intentErrors(many).some((e) => /rows/.test(e)), "a list past the row budget is named");
  ok(intentErrors([{ type: "shoreline", points: [[0, 0], [1, 1]], level: "sea" }]).some((e) => /intent\[0\]\.level/.test(e)));
});

test("v2 asks that cannot be met by construction, or would be clamped, are named", () => {
  const has = (list, re) => intentErrors(list).some((e) => re.test(e));
  ok(has([{ type: "shoreline", points: [[0, 0], [0, 0]], side: "left" }], /no length/), "a coast of no length with a side");
  ok(has([{ type: "shoreline", points: [[0, 0], [500, 0], [0, 0]], side: "left" }], /turns straight back at vertex 1/), "a coast that folds back");
  eq(intentErrors([{ type: "shoreline", points: [[0, 0], [500, 0], [0, 0]] }]).length, 0, "without a side a fold is only a line twice");
  ok(has([{ type: "shoreline", points: [[0, 0], [500, 0]], offset: 60 }], /has no side/), "an offset with no side");
  ok(has([{ type: "shoreline", points: [[0, 0], [500, 0]], side: "left", offset: 3 }], /under 12 m/), "an offset that would be widened");
  for (const n of [1, 65, 2.5]) ok(has([{ type: "ray", eye: [0, 9, 0], at: [500, 0], samples: n }], /samples/), `ray samples ${n}`);
  ok(has([{ type: "pad", x: 0, z: 0, r: 10, h: 5 }], /intent\[0\]\.r 10 is under 48/), "a pad that would be widened");
});

test("a v2 statement off the plate is named when the size is known, and states no rows", () => {
  /* Measured on TMNR before this rule (review): a pad at x = 3000 moved
     ground inside a 4096 m plate by 483 m, a shoreline from x = 5000 to
     6000 by 151 m. intentErrors now names each, and the rows a line or a
     ray would state off the plate are not stated. */
  const size = 4096;
  const off = (rec) => intentErrors([rec], { size }).some((e) => /off the plate/.test(e));
  ok(off({ type: "shoreline", points: [[5000, 0], [6000, 0]], side: "left" }), "a coast off the edge");
  ok(off({ type: "corridor", points: [[0, 0], [0, 2100]] }), "a road that runs off it");
  ok(off({ type: "ray", eye: [-2100, 50, 0], at: [0, 0] }), "an eye off it");
  ok(off({ type: "ray", eye: [0, 50, 0], at: [0, 2500] }), "a far end off it");
  ok(intentErrors([{ type: "pad", x: 3000, z: 0, r: 60, h: 10 }], { size }).some((e) => /reaches off the plate/.test(e)), "a pad off it");
  ok(intentErrors([{ type: "pad", x: 2000, z: 0, r: 60, h: 10 }], { size }).some((e) => /reaches off the plate/.test(e)), "a pad whose ring is");
  eq(intentErrors([{ type: "shoreline", points: [[5000, 0], [6000, 0]] }]).length, 0, "without a size nothing is assumed");
  eq(intentErrors([{ type: "point", x: 5000, z: 0, h: 10 }], { size }).length, 0, "and v1 records are left as they were");
  eq(intentErrors([{ type: "pad", x: 1900, z: -1900, r: 100, h: 10 }, { type: "corridor", points: [[-2048, 0], [2048, 0]] }], { size }).length, 0,
    "the plate's own edge is on the plate");

  const seed = SEEDS[1], raw = sampler(seed, []);
  eq(sampler(seed, [{ type: "shoreline", points: [[5000, 0], [6000, 0]], side: "left" }]).conditioning, null, "a coast wholly off the plate is no intent");
  // Half on: only the samples on the plate (and their sides) are rows.
  const half = sampler(seed, [{ type: "shoreline", points: [[1500, 0], [2600, 0]], side: "left" }]);
  const on = polylineSamples([[1500, 0], [2600, 0]], SHORE_STEP, SHORE_SAMPLES).filter((p) => p.x <= 2048).length;
  eq(half.conditioning.rows, 3 * on, `the ${on} samples on the plate, three rows each`);
  ok(half.conditioning.miss <= CM, `and those are met (${half.conditioning.miss.toFixed(4)} m)`);
  ok(Number.isFinite(moved(raw, half)));
});

test("degenerate lines, odd rays and a NaN waterline never throw", () => {
  const cases = [
    [{ type: "shoreline", points: [[0, 0], [0, 0]], side: "left" }],
    [{ type: "shoreline", points: [[0, 0], [500, 0], [0, 0]], side: "left" }],
    [{ type: "shoreline", points: [[1e300, 0], [-1e300, 0]], side: "left" }],
    [{ type: "corridor", points: [[0, 0], [0, 0]] }],
    [{ type: "corridor", points: [[-500, 0], [500, 0]], maxGrade: 0 }],
    [{ type: "ray", eye: [0, 10, 0], at: [0, 0], contact: true }],
    [{ type: "ray", eye: [0, -500, 0], at: [500, 0] }],
    [{ type: "pad", x: 0, z: 0, r: 1e5, h: 10 }],
  ];
  for (const water of [0, NaN, -30]) {
    for (const intent of cases) {
      let s;
      try { s = sampler(SEEDS[1], intent, water); } catch (err) { ok(false, `${JSON.stringify(intent)} at ${water}: threw ${err.message}`); continue; }
      ok(Number.isFinite(s(0, 0)) && Number.isFinite(s(100, 0)), `${JSON.stringify(intent).slice(0, 60)} at ${water}: finite ground`);
      if (s.conditioning) ok(Number.isFinite(s.conditioning.miss) && Number.isFinite(s.conditioning.nats), "finite numbers");
    }
  }
  // A NaN waterline is no waterline: the shoreline stands at 0.
  const nan = sampler(SEEDS[1], [{ type: "shoreline", points: [[-300, 0], [300, 0]] }], NaN);
  for (const p of polylineSamples([[-300, 0], [300, 0]], SHORE_STEP)) close(nan(p.x, p.z), 0, CM, "a NaN level reads as 0");
});

test("a list at the row cap still returns ground, and says whether it converged", () => {
  /* Lines that zigzag at the lattice's own scale, near MAX_ROWS: a 64-vertex
     coast with a side and a 64-vertex road at grade 0, 633 rows. Measured:
     ~220 bounds held, out of rounds after 2.4–2.8 s, missing by 2.8 m
     (TMNR) and 3.5 m (K7QN). intentErrors has nothing to say about it — it
     is a legal list — so `converged` and `miss` are how a caller finds out. */
  const zig = (z0, amp) => Array.from({ length: 64 }, (_, i) => [i * 60 - 1900, z0 + (i % 2) * amp]);
  const intent = [{ type: "shoreline", points: zig(0, 40), side: "left" }, { type: "corridor", points: zig(900, 300), maxGrade: 0 }];
  eq(intentErrors(intent, { size: 4096 }).length, 0, "a legal list");
  const s = sampler(SEEDS[1], intent);
  const c = s.conditioning;
  ok(c.rows <= MAX_ROWS && c.rows > MAX_ROWS - 20, `${c.rows} rows`);
  eq(c.dropped, 0);
  eq(typeof c.converged, "boolean");
  ok(Number.isFinite(c.miss) && Number.isFinite(c.nats), `miss ${c.miss.toFixed(2)} m, ${c.nats.toFixed(0)} nats`);
  if (!c.converged) ok(c.miss > CM, "an unconverged answer reports its shortfall");
  ok(Number.isFinite(s(0, 0)) && Number.isFinite(s(-1000, 900)), "and the ground is ground");
});

test("a list past MAX_ROWS drops whole records and says how many", () => {
  const long = Array.from({ length: 64 }, (_, i) => [i * 60 - 1900, (i % 2) * 40]);
  const coast = { type: "shoreline", points: long, side: "left" };
  const one = rowsFor(normalizeIntent([coast])[0]);
  ok(one > MAX_ROWS / 2 && one <= SHORE_SAMPLES * 3, `one long coast states ${one} rows`);
  const s = sampler(SEEDS[1], [coast, coast, { type: "pad", x: 0, z: 900, r: 60, h: 30 }]);
  eq(s.conditioning.dropped, 1, "the second coast did not fit");
  eq(s.conditioning.rows, one + 9, "the pad after it still did");
  ok(s.conditioning.rows <= MAX_ROWS);
});

/* ══ the sampling a line is read at ════════════════════════════════════ */

test("polyline samples: every vertex, no step longer than asked, capped, normal to the left", () => {
  const line = [[0, 0], [100, 0], [100, 250], [100, 250], [-50, 400]];
  const pts = polylineSamples(line, 48);
  for (const [x, z] of line) ok(pts.some((p) => p.x === x && p.z === z), `vertex ${x},${z} is a sample`);
  for (let i = 1; i < pts.length; i++) ok(dist(pts[i - 1], pts[i]) <= 48 + 1e-9, `step ${i}`);
  // Heading +x (east): left, seen from above with −z north, is −z.
  eq(pts[1].nx, 0); eq(pts[1].nz, -1);
  const capped = polylineSamples([[0, 0], [10000, 0]], 48, 100);
  ok(capped.length <= 100 && capped.length >= 98, `a long line is cut evenly into the cap (${capped.length})`);
  const all = polylineSamples(Array.from({ length: 64 }, (_, i) => [i * 1000, 0]), SHORE_STEP, SHORE_SAMPLES);
  ok(all.length <= SHORE_SAMPLES, `the cap holds with every vertex kept (${all.length})`);
  eq(polylineSamples([[5, 5], [5, 5]], 48).length, 1, "a line of no length is its point");
});

report("intent-v2");
