/* condition.js — WHAT A WORLD IS FOR, made true of the seed it grew from.
 *
 * ── the problem ──
 * A seed is a hash, and a hash is built to say nothing: two seeds one letter
 * apart grow unrelated worlds, and neither knows what it is for. So everything
 * a world is FOR has always been applied afterwards. Screening throws seeds
 * away until one clears a bar — measured on the default terrain, four seeds in
 * five fail it, because the continent mask makes almost every world either an
 * unbroken massif or open sea. The landform then stamps sculpt strokes onto
 * whatever the survivor happened to grow. Generate, test, patch.
 *
 * ── what this does instead ──
 * The broad relief of the classic recipe — the base fractal and the continent
 * mask — is a weighted sum of lattice values the seed hashes to. A statement
 * about the ground ("the height here is 150 m", "this is a summit", "the
 * interior averages 40 m above the sea") is a LINEAR function of those values.
 * So rather than reject a seed that does not say what the world needs, find
 * the smallest change to its lattice values that makes every statement true:
 *
 *     Δ = Wᵀ (W Wᵀ)⁻¹ (c − W a)
 *
 * a: the lattice values; W: how each statement reads them; c: what the
 * statements demand. The lattice values are independent and identically
 * distributed, so the minimum-norm Δ is also the least improbable one — read
 * as Gaussian, it is exactly the conditional-simulation correction (kriging;
 * Hoffman & Ribak 1991): the conditioned world is a draw from the worlds in
 * which the statements hold, not a world with a patch on it.
 *
 * Three consequences, and they are why this module exists:
 *
 *   EVERY SEED WORKS. A seed that misses a bar is carried onto it rather than
 *   thrown away (src/kernel/core/survey.js, conditionSeed).
 *
 *   THE EDIT IS MADE OF THE WORLD. The correction at x is Σ λᵢ·Cov(shape(x),
 *   statementᵢ): the field's own covariance, so it has the terrain's own
 *   octaves. A sculpt stroke is a smoothstep disc; this is more of the same
 *   ground.
 *
 *   IT COSTS A NUMBER. ½·ΔᵀΣ⁻¹Δ is the surprise the edit injected, in nats —
 *   how far the world had to be bent. A default world has 4–5 thousand linear
 *   lattice values, so two typical worlds differ by about √(d/2) ≈ 48 nats; an
 *   edit well under that is an edit nobody could pick out of the seed's own
 *   variation. It is reported on every sampler that carries intent.
 *
 * ── what it is added to, exactly ──
 * The correction is an ADDITIVE field in shape space (before the plate),
 * spanned by the classic recipe's own linear lattice streams — the base
 * fractal's octaves and the continent's — sampled at the recipe's own warped
 * coordinates. On a recipe world with no terracing that IS shifting the seed's
 * own lattice values. It is not quite that in three places, all deliberate:
 *
 *   plateau > 0   the recipe terraces after the blend; the correction is added
 *                 after the terrace, so the corrected ground is not re-stepped.
 *   ridged > 0.75 the fractal's weight in the basis is floored at CREST_FLOOR:
 *                 a crest-dominated recipe has almost no linear fractal, and a
 *                 basis of continent alone cannot say anything local.
 *   a stack       the basis is still the recipe's streams. It is a statement
 *                 about what terrain-shaped change looks like, and a stack has
 *                 no single linear part to borrow one from.
 *
 * And the targets are EXACT through the plate: a point asked to stand at
 * −20 m stands at −20 m, on the sea floor's compressed scale and inside the
 * rim's falloff, because heightfield.js hands over the plate's own inverse.
 *
 * ── what a lone point does ──
 * The recipe's variance is dominated by the continent mask, whose lattice is
 * wider than the world, so the least improbable way to raise ONE point is to
 * raise the whole country a little. That is honest least-surprise and it is
 * rarely what anybody means. Pair it with a `level` record and the regional
 * mean is held, which forces the change into the finer octaves — the joint
 * solve is the whole trick, and it is what survey.js does.
 *
 * ── determinism ──
 * A pure function of (params, intent). No clock, no Math.random, no Math.exp,
 * no Math.cos: floor, sqrt and the four operations, in a fixed order (Map
 * iteration is insertion order), so Node and JavaScriptCore agree to the bit.
 * (A flat's ring used to be placed with Math.cos and Math.sin, which the
 * standard lets two engines round differently; it now reads a table of the
 * six doubles V8 produced, so every world already on disk keeps its ring and
 * every runtime builds the same one — tools/test/kernel/intent-v2.test.js.) And a world
 * with no intent never reaches this file — createHeightSampler returns the
 * very shape function it returned before, which is what keeps every world
 * already on disk bit-identical (tools/test/kernel/noise-stack.test.js, GOLDEN).
 *
 * ── version 2: asks that are about a LINE, not a point ──
 * Four more statements. Each is a set of the same rows the first four were
 * made of — a height at a point, at least or at most a height, the
 * difference between two points — and the same minimum-norm solve answers
 * them:
 *
 *   shoreline  the waterline runs HERE: every sample along a polyline stands
 *              at a waterline, and with `side` the ground a little way to
 *              one side is land and to the other is sea.
 *   ray        a sightline: the ground stays under the straight line from an
 *              eye to a far point, so the far point can be SEEN — and with
 *              `contact` and a height the line grazes it, a silhouette.
 *   corridor   a road's worth of ground: between neighbouring samples along a
 *              polyline the ground climbs no steeper than `maxGrade`.
 *   pad        a flat with a height it must have. Sugar over `flat` with an
 *              `h`: the same nine rows, solved by the same loop, so the two
 *              give the same ground to the bit (tools/test/kernel/intent-v2.test.js).
 *
 * The rows are the same; the ACTIVE SET that holds the inequalities is not,
 * for a list carrying a shoreline, a ray or a corridor. Those are dozens of
 * nearly parallel rows on one strip, and the v1 loop below — hold every
 * broken bound for good, solve once per round — was measured missing
 * shorelines by 0.3–1.8 m and paying hundreds of nats for bounds it never
 * needed. So such a list goes through activeSetV2: the same factorisation,
 * refined against its own residual, and held bounds released once they push
 * the wrong way. That is a different answer for EVERY record in the list,
 * v1 ones included: adding a ray that holds nothing to a list of points
 * re-solves the points too. The refined answer is the exact minimum-norm one
 * and the v1 loop's single regularised solve is not; they agree at the
 * statements to within the v1 solve's own miss (3 cm on K7QN for the list in
 * tools/test/kernel/intent-v2.test.js) and, measured on a 200 m grid, differ elsewhere by
 * up to 0.77 m on K7QN, 0.18 m on Q375 and 5 mm on TMNR, with a ray 5 km up
 * that holds no row. A list with only v1 records and pads takes the v1 loop
 * unchanged.
 *
 * A line is many rows, so a list of 48 records is no longer a bound on the
 * size of the solve. MAX_ROWS is, and a record whose rows would carry the
 * system past it is dropped whole (a coastline stated halfway is a different
 * coastline) and counted in `dropped`.
 *
 * A file holding only version-1 records solves exactly as it did: their rows
 * are built by the same code in the same order, and nothing a v2 record adds
 * is reached by a list without one (tools/test/kernel/intent-v2.test.js checks it to the
 * bit; tests/condition.test.js is unchanged).
 *
 * Pure JS: no three.js, no DOM. Part of the procedural core.
 */

import { warp2 } from "./noise.js";

/* 2 since shoreline, ray, corridor and pad. NOT forward-compatible: a
   version-1 build's intentErrors names any type it does not know, and
   js/worldfile.js refuses a file with errors, so an old build REFUSES a file
   carrying a v2 record rather than quietly solving part of it. (Its sampler
   alone, handed such params directly, drops the records it cannot read —
   normalizeIntent always did — which is the other half of why refusing is
   right: half a coast is a different coast.) Any build still shipping the v1
   module, a bundled copy included, has to be rebuilt to open v2 worlds. */
export const INTENT_VERSION = 2;

/* A ceiling on records, for the same reason noise-stack.js has MAX_LAYERS:
   intent arrives in files, and every record is rows in a dense solve. */
export const MAX_INTENT = 48;

/* ── the vocabulary ──
     point   { x, z, h, op? }  the ground at (x, z) stands at h metres — or at
                               least (">=") or at most ("<=") h.
     summit  { x, z, h }       a point at h with no slope at it: a crest, a knoll
     flat    { x, z, r, h? }   a level pad of radius r, optionally at height h
     level   { h, op?, inset? } the mean DATUM height over a centred square
                               `inset` of the world wide: the height the ground
                               would have if the sea floor were not compressed
                               (heightfield.js SEA_FLOOR). Regional, not local.
   All heights are world metres, measured the way the sampler reports them. */
/* ── the vocabulary, version 2 ──
     shoreline { points, side?, offset?, level? }
                 points: [[x, z], …], 2 to 64 of them. The ground at every
                 sample along the line (SHORE_STEP below) stands at the
                 waterline: `level` metres when the record carries one, and
                 otherwise params.water.level (0 when the world has none).
                 A tool writing a shoreline should write its `level`: then
                 the record says everything the ground depends on, and
                 flooding the world afterwards moves the sea, not the land
                 (Engine.setFloodLevel freezes the level into a record that
                 lacks one before it moves the water, for the same reason).
                 side: "left" | "right", seen from above walking the line
                 from its first point: with +x east and +z south (three.js,
                 where −z is north), left of a heading (dx, dz) is (dz, −dx).
                 With a side, ground `offset` metres (default 40) that way
                 stands at least 2 m above the waterline, and the same
                 distance the other way at least 2 m below it.
     ray       { eye: [x, y, z], at: [x, z], h?, contact?, samples? }
                 along the horizontal segment from the eye's foot to `at`,
                 the ground stays at or under the straight line from the eye
                 to (at, h). With `h`, contact: true makes the far end an
                 equality — the ground there stands at h and the line
                 touches it, which is a silhouette — and without contact the
                 far end is held at or under h too. Without `h` the line
                 ends on the CONDITIONED ground at `at`, whatever the other
                 statements make that: each sample's row reads both ends,
                 ground(sample) − t·ground(at) ≤ (1 − t)·eye y, which is
                 still linear, and the far end needs no row of its own (it
                 is on the line by definition, so `contact` adds nothing).
                 That row is on the DATUM (heightfield.js), built so it is
                 enough above and below the plate's zero alike (the height
                 where the sea floor's compression starts): exact where
                 the eye and the far end are at or above it, and stricter
                 than asked, never looser, where either is below it
                 (constraintsFor says why one row does it).
                 samples (default 12, 2–64) points along the segment, the
                 eye's own foot first: an eye inside a hill is not an eye.
                 (An earlier draft read a missing h as the ground the SEED
                 grew there, before any correction. That is a statement
                 nobody made — "the ground at `at` stays at or under its raw
                 height" — and next to any other statement it was measured
                 moving ground by up to 296 m. It had to be settled before
                 any file carried a ray, because changing it after would
                 move every saved world that has one.)
     corridor  { points, maxGrade? }
                 between neighbouring samples along the polyline (CORRIDOR_STEP
                 below) the ground rises or falls by at most maxGrade × their
                 distance (default 0.12: rise over run, about 7°).
     pad       { x, z, r, h }  a flat whose height is required.
   Every coordinate a v2 record states must lie on the plate, |x| and |z| at
   most size/2 (a pad's whole ring, a ray's eye and far end, every vertex):
   the continent lattice is wider than the world, so a statement off the
   plate is answered by bending ground ON it (a pad at x = 3000 m on a 4096 m
   world was measured moving the plate by 483 m). intentErrors names it when told the
   size, and a line's or a ray's rows off the plate are not stated at all.
   v1 records are left as they always were — a v1 file that loads today
   keeps loading. */
export const INTENT_TYPES = ["point", "summit", "flat", "level", "shoreline", "ray", "corridor", "pad"];
export const INTENT_OPS = ["=", ">=", "<="];
const REQUIRED = {
  point: ["x", "z", "h"], summit: ["x", "z", "h"], flat: ["x", "z", "r"], level: ["h"],
  shoreline: [], ray: [], corridor: [], pad: ["x", "z", "r", "h"],
};

/* A ceiling on ROWS. 48 records was a ceiling on the solve when a record was
   at most nine rows; a coastline is hundreds. 640 is what the largest single
   line below can state (a shoreline with a side: 128 samples × 3 rows = 384)
   with room left for the v1 statements a grammar pairs it with, and v1 alone
   cannot reach it (48 pads × 9 = 432), so no v1 file is ever cut by it.
   What it costs, measured in Node on the four suite seeds: a 3.8 km coast with
   sides and a 2.1 km road (411 rows, ~100 of them held) solve in 0.3–0.7 s;
   two coasts that zigzag at the lattice's own scale, near the cap (558 rows,
   ~270 held), take 0.7–2.1 s and miss by up to 4 m, because that is not a
   coast the basis can draw. The active set only ever holds what it has to. */
export const MAX_ROWS = 640;

/* Polyline sampling. Every vertex is a sample, and a segment longer than the
   step is cut into equal pieces no longer than it. The steps sit under one
   cell of the finest lattice octave on the default world (about 72 m: 4096 m
   over 1.7 cycles over 2.02⁵), so a sampled line says something about every
   cell it crosses; the shoreline's is the coarser because each of its samples
   is three rows. A line long enough to need more than the cap is sampled more
   coarsely, evenly, rather than truncated. */
export const SHORE_STEP = 48;
export const SHORE_SAMPLES = 128;
export const CORRIDOR_STEP = 32;
export const CORRIDOR_SAMPLES = 160;
export const MAX_POLYLINE = 64;
// How far past the waterline a shoreline's sides must stand, metres.
export const SHORE_MARGIN = 2;
export const SHORE_OFFSET = 40;
/* Nearer than this the side rows read almost the same lattice weights as the
   waterline row between them, and a ±2 m step in a few metres is a cliff. */
const MIN_SHORE_OFFSET = 12;
export const RAY_SAMPLES = 12;
const MAX_RAY_SAMPLES = 64;
export const CORRIDOR_GRADE = 0.12;

/* The level record's sampling: the same inset the seed screen measures inside
   (survey.js), on a grid fine enough to be a mean and coarse enough to be one
   row of a small system. */
export const LEVEL_INSET = 0.76;
export const LEVEL_GRID = 12;

/* "No slope here" is a pair of central differences this far either side of
   the point. Well under one cell of the finest lattice on any shipped world
   (~70 m), so it reads the slope AT the point rather than across a hill. */
export const GRADIENT_STEP = 24;

/* A flat pad's ring sits at least this far out; nearer than that the ring
   rows are the gradient rows again, and the system goes singular. */
const MIN_FLAT_R = 2 * GRADIENT_STEP;

/* Tikhonov term, relative to the mean diagonal. Two statements closer together
   than one lattice cell are nearly the same row, and an unregularised solve
   answers that with enormous opposing corrections. This keeps the answer
   bounded, at a cost of millimetres on anything the ground can express (a
   summit, a pad and a level at random: 4 mm median, measured). An ask it
   CANNOT express — a 180 m summit fifty metres from a 40 m pad — is met as
   nearly as the lattice allows, and the result's `miss` says by how much. */
const RIDGE = 1e-6;
// An inequality is met when within this (shape units: ≈ 1 mm on a 420 m world).
const SLACK = 2e-6;
const ACTIVE_ROUNDS = 16;

/* See the header: a crest-dominated recipe still gets fine octaves to bend. */
const CREST_FLOOR = 0.25;
// Octaves past this are sub-metre on any world this engine draws.
const BASIS_OCTAVES = 8;
// The lattice values are U[0,1): variance 1/12. Surprise is reported against it.
const NOISE_VARIANCE = 1 / 12;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/* ── reading intent off a file ──
   Never throws. Records of an unknown type, or missing a number, are dropped;
   what survives is a fresh copy holding only the fields this version reads.
   An absent, empty or wholly unusable list is null: no intent at all, which is
   what every world saved before this existed says by saying nothing. */
export function normalizeIntent(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const r of raw) {
    if (out.length >= MAX_INTENT) break;
    if (!r || typeof r !== "object" || !REQUIRED[r.type]) continue;
    if (!REQUIRED[r.type].every((k) => finite(r[k]))) continue;
    const rec = { type: r.type };
    for (const k of REQUIRED[r.type]) rec[k] = r[k];
    if (r.type === "point" || r.type === "level") rec.op = INTENT_OPS.includes(r.op) ? r.op : "=";
    if (r.type === "flat") {
      rec.r = Math.max(rec.r, MIN_FLAT_R);
      if (finite(r.h)) rec.h = r.h;
    }
    if (r.type === "level") rec.inset = finite(r.inset) ? Math.min(Math.max(r.inset, 0.05), 1) : LEVEL_INSET;
    if (r.type === "pad") rec.r = Math.max(rec.r, MIN_FLAT_R);
    if (r.type === "shoreline" || r.type === "corridor") {
      const points = readPolyline(r.points);
      if (!points) continue;
      rec.points = points;
      if (r.type === "shoreline") {
        if (r.side === "left" || r.side === "right") {
          rec.side = r.side;
          rec.offset = finite(r.offset) ? Math.max(r.offset, MIN_SHORE_OFFSET) : SHORE_OFFSET;
        }
        if (finite(r.level)) rec.level = r.level;
      } else rec.maxGrade = finite(r.maxGrade) ? Math.max(r.maxGrade, 0) : CORRIDOR_GRADE;
    }
    if (r.type === "ray") {
      if (!vec(r.eye, 3) || !vec(r.at, 2)) continue;
      rec.eye = [r.eye[0], r.eye[1], r.eye[2]];
      rec.at = [r.at[0], r.at[1]];
      if (finite(r.h)) rec.h = r.h;
      rec.contact = r.contact === true;
      rec.samples = finite(r.samples) ? Math.min(Math.max(Math.round(r.samples), 2), MAX_RAY_SAMPLES) : RAY_SAMPLES;
    }
    out.push(rec);
  }
  return out.length ? out : null;
}

const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(finite);
/* A polyline off a file: the first MAX_POLYLINE readable [x, z] pairs, or
   null when fewer than two survive. */
function readPolyline(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const p of raw) {
    if (out.length >= MAX_POLYLINE) break;
    if (vec(p, 2)) out.push([p[0], p[1]]);
  }
  return out.length >= 2 ? out : null;
}

/** What is wrong with a list a file carries, as sentences — the standard
    js/worldfile.js holds every other terrain field to. Empty when it is fine.

    `size`, when given, is the world's edge in metres, and every coordinate a
    v2 record states is checked against the plate (see the vocabulary). The
    v2 records are also held to two things normalizeIntent would otherwise
    clamp or let through without a word, because no file carries them yet and
    a silent repair is a world nobody asked for:
      - a shoreline with a side needs a line that goes somewhere and never
        turns straight back on itself: at a point of no length, or at a
        reversal, "land to the left" and "sea to the right" are the same
        ground, and the solve can only report the miss;
      - an `offset` is a side's distance, so it needs a side, and at least
        MIN_SHORE_OFFSET; a ray's `samples` is a whole number in 2–64; a
        pad's radius is at least MIN_FLAT_R. */
export function intentErrors(raw, { size } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return ["terrain.intent is not a list"];
  const errors = [];
  const half = finite(size) && size > 0 ? size / 2 : null;
  const offPlate = (x, z) => half !== null && finite(x) && finite(z) && (Math.abs(x) > half || Math.abs(z) > half);
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") return void errors.push(`terrain.intent[${i}] is not an object`);
    if (!REQUIRED[r.type]) return void errors.push(`terrain.intent[${i}].type ${JSON.stringify(r.type ?? null)} is not one of ${INTENT_TYPES.join(", ")}`);
    for (const k of REQUIRED[r.type]) {
      if (!finite(r[k])) errors.push(`terrain.intent[${i}].${k} ${JSON.stringify(r[k] ?? null)} is not a number`);
    }
    if (r.op !== undefined && !INTENT_OPS.includes(r.op)) errors.push(`terrain.intent[${i}].op ${JSON.stringify(r.op)} is not one of ${INTENT_OPS.join(" ")}`);
    const at = `terrain.intent[${i}]`;
    const plate = (what, x, z) => {
      if (offPlate(x, z)) errors.push(`${at}${what} (${x}, ${z}) is off the plate; a ${size} m world spans ±${half} m`);
    };
    if (r.type === "shoreline" || r.type === "corridor") {
      if (!Array.isArray(r.points)) errors.push(`${at}.points is not a list of [x, z] pairs`);
      else {
        r.points.forEach((p, j) => {
          if (!vec(p, 2)) errors.push(`${at}.points[${j}] ${JSON.stringify(p ?? null)} is not an [x, z] pair of numbers`);
          else plate(`.points[${j}]`, p[0], p[1]);
        });
        if (r.points.length < 2) errors.push(`${at}.points holds ${r.points.length}; a line needs at least 2`);
        if (r.points.length > MAX_POLYLINE) errors.push(`${at}.points holds ${r.points.length}; the most a line reads is ${MAX_POLYLINE}`);
      }
    }
    if (r.type === "shoreline") {
      if (r.side !== undefined && r.side !== "left" && r.side !== "right") errors.push(`${at}.side ${JSON.stringify(r.side)} is not "left" or "right"`);
      if (r.offset !== undefined) {
        if (!finite(r.offset)) errors.push(`${at}.offset ${JSON.stringify(r.offset)} is not a number`);
        else if (r.side === undefined) errors.push(`${at}.offset is a side's distance, and the line has no side`);
        else if (r.offset < MIN_SHORE_OFFSET) errors.push(`${at}.offset ${r.offset} is under ${MIN_SHORE_OFFSET} m: a ±${SHORE_MARGIN} m step that near the line is a cliff`);
      }
      if (r.level !== undefined && !finite(r.level)) errors.push(`${at}.level ${JSON.stringify(r.level)} is not a number`);
      if ((r.side === "left" || r.side === "right") && Array.isArray(r.points)) {
        const pts = readPolyline(r.points);
        if (pts) {
          const segs = [];
          for (let j = 1; j < pts.length; j++) {
            const dx = pts[j][0] - pts[j - 1][0], dz = pts[j][1] - pts[j - 1][1], len = Math.sqrt(dx * dx + dz * dz);
            if (len > 0) segs.push([dx / len, dz / len, j]);
          }
          if (!segs.length) errors.push(`${at}.points has no length, so its ${r.side} side is the line itself`);
          for (let j = 1; j < segs.length; j++) {
            if (segs[j - 1][0] * segs[j][0] + segs[j - 1][1] * segs[j][1] < -0.9999) {
              errors.push(`${at}.points turns straight back at vertex ${segs[j][2] - 1}, where its land side and its sea side are the same ground`);
            }
          }
        }
      }
    }
    if (r.type === "corridor" && r.maxGrade !== undefined && !(finite(r.maxGrade) && r.maxGrade >= 0)) {
      errors.push(`${at}.maxGrade ${JSON.stringify(r.maxGrade)} is not a number at least 0`);
    }
    if (r.type === "ray") {
      if (!vec(r.eye, 3)) errors.push(`${at}.eye ${JSON.stringify(r.eye ?? null)} is not an [x, y, z] triple of numbers`);
      else plate(".eye", r.eye[0], r.eye[2]);
      if (!vec(r.at, 2)) errors.push(`${at}.at ${JSON.stringify(r.at ?? null)} is not an [x, z] pair of numbers`);
      else plate(".at", r.at[0], r.at[1]);
      if (r.h !== undefined && !finite(r.h)) errors.push(`${at}.h ${JSON.stringify(r.h)} is not a number`);
      if (r.samples !== undefined && !(Number.isInteger(r.samples) && r.samples >= 2 && r.samples <= MAX_RAY_SAMPLES)) {
        errors.push(`${at}.samples ${JSON.stringify(r.samples)} is not a whole number from 2 to ${MAX_RAY_SAMPLES}`);
      }
      if (r.contact !== undefined && typeof r.contact !== "boolean") errors.push(`${at}.contact ${JSON.stringify(r.contact)} is not true or false`);
    }
    if (r.type === "pad" && finite(r.x) && finite(r.z) && finite(r.r)) {
      if (r.r < MIN_FLAT_R) errors.push(`${at}.r ${r.r} is under ${MIN_FLAT_R} m, where a pad's ring would be its own slope rows`);
      const rr = Math.max(r.r, MIN_FLAT_R);
      if (offPlate(Math.abs(r.x) + rr, 0) || offPlate(0, Math.abs(r.z) + rr)) {
        errors.push(`${at} reaches off the plate: centre (${r.x}, ${r.z}) and radius ${rr} on a ${size} m world that spans ±${half} m`);
      }
    }
  });
  if (raw.length > MAX_INTENT) errors.push(`terrain.intent holds ${raw.length} records; the most a world reads is ${MAX_INTENT}`);
  /* The row budget is a property of the list, not of any one record, and it
     is geometry alone, so it can be told before any world is built. */
  const records = normalizeIntent(raw);
  if (records) {
    let rows = 0;
    for (const rec of records) rows += rowsFor(rec);
    if (rows > MAX_ROWS) errors.push(`terrain.intent states ${rows} rows; the most a world solves is ${MAX_ROWS}, and records past that are dropped`);
  }
  return errors;
}

/** How many rows a normalised record states — before any is discarded for a
    non-finite target or for lying off the plate, which only a world can say.
    So it is an upper bound, and it is what MAX_ROWS is checked against in
    intentErrors; intentSystem checks the rows actually stated. */
export function rowsFor(rec) {
  switch (rec.type) {
    case "point": case "level": return 1;
    case "summit": return 3;
    case "flat": return finite(rec.h) ? 9 : 8;
    case "pad": return 9;
    case "shoreline": return polylineSamples(rec.points, SHORE_STEP, SHORE_SAMPLES).length * (rec.side ? 3 : 1);
    case "corridor": return 2 * (polylineSamples(rec.points, CORRIDOR_STEP, CORRIDOR_SAMPLES).length - 1);
    // Without h the far end is on the line by definition, and has no row.
    case "ray": return finite(rec.h) ? rec.samples + 1 : rec.samples;
    default: return 0;
  }
}

/** The samples a polyline is read at: every vertex, and equal pieces no
    longer than `step` between them — or, when that would be more than `max`
    samples, equal pieces of whatever length keeps it to `max`. Each sample
    carries the unit normal to its LEFT, (dz, −dx) of the heading (see the
    vocabulary): a segment's own inside it, the mean of the two headings at a
    vertex, the incoming one at a vertex where the line turns straight back.
    Zero-length segments are skipped. Square roots and the four operations
    only, so every runtime cuts the same line at the same places. */
export function polylineSamples(points, step, max = Infinity) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1], [x1, z1] = points[i];
    const dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0) { segs.push({ x0, z0, x1, z1, dx, dz, len, ux: dx / len, uz: dz / len }); total += len; }
  }
  if (!segs.length) return [{ x: points[0][0], z: points[0][1], nx: 0, nz: 0 }];
  const room = max - (segs.length + 1);
  const eff = room > 0 ? Math.max(step, total / room) : Infinity;
  const out = [];
  const push = (x, z, ux, uz) => out.push({ x, z, nx: uz, nz: -ux });
  segs.forEach((s, j) => {
    if (j === 0) push(s.x0, s.z0, s.ux, s.uz);
    else {
      const p = segs[j - 1];
      let ux = p.ux + s.ux, uz = p.uz + s.uz;
      const l = Math.sqrt(ux * ux + uz * uz);
      if (l > 1e-9) { ux /= l; uz /= l; } else { ux = p.ux; uz = p.uz; }
      push(s.x0, s.z0, ux, uz);
    }
    const pieces = Math.max(1, Math.ceil(s.len / eff));
    for (let k = 1; k < pieces; k++) push(s.x0 + (s.dx * k) / pieces, s.z0 + (s.dz * k) / pieces, s.ux, s.uz);
  });
  const last = segs[segs.length - 1];
  push(last.x1, last.z1, last.ux, last.uz);
  return out;
}

/** The points a level record averages over, in world metres. Exported so the
    seed screen measures a level exactly the way the solver states one. */
export function levelPoints(size, inset = LEVEL_INSET, grid = LEVEL_GRID) {
  const span = size * inset, pts = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) pts.push([(i / (grid - 1) - 0.5) * span, (j / (grid - 1) - 0.5) * span]);
  }
  return pts;
}

/* ══ the basis ═════════════════════════════════════════════════════════════
   The recipe's linear streams, as a table: stream s reads its lattice at
   ((n·mul + o)·freq) for the warped noise coordinate n, and contributes
   w × valueNoise there. valueNoise is (bilinear-quintic blend of four
   lattice values)·2 − 1, so ∂shape/∂(one lattice value) is 2·w·(its blend
   weight) — and that is all a row is. */

const LIM = 1 << 20;   // |lattice index| bound, so a key fits a double exactly
const M = 1 << 21;
const keyOf = (s, ix, iz) => (s * M + (ix + LIM)) * M + (iz + LIM);

function streamsFor(t) {
  const streams = [];
  // The base fractal, octave for octave as fbm() runs it: the loop condition
  // is `i < octaves`, so 6.5 octaves is seven, and `norm` is the whole loop's.
  const n = Math.max(0, Math.min(Math.ceil(finite(t.octaves) ? t.octaves : 0), 64));
  const octs = [];
  let amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < n; i++) { octs.push([amp, freq]); norm += amp; amp *= t.gain; freq *= t.lacunarity; }
  const crest = Math.max(1 - (finite(t.ridged) ? t.ridged : 0), CREST_FLOOR);
  for (const [a, f] of octs.slice(0, BASIS_OCTAVES)) {
    const w = 0.72 * crest * a / norm;
    if (finite(w) && finite(f) && w !== 0) streams.push({ mul: 1, ox: 0, oz: 0, freq: f, w });
  }
  // The continent mask: fbm(nx·0.22 + 7.3, nz·0.22 − 3.1, …, 3) — gain 0.5,
  // lacunarity 2, whatever the sliders say, because the recipe hard-codes it.
  for (const [a, f] of [[0.5, 1], [0.25, 2], [0.125, 4]]) {
    streams.push({ mul: 0.22, ox: 7.3, oz: -3.1, freq: f, w: 0.55 * a / 0.875 });
  }
  return streams;
}

/** The basis a world's corrections are drawn from. `seed` is the terrain
    channel and `inv` the world→noise scale, both exactly as heightfield.js
    computes them. */
export function createBasis({ terrain, seed, inv }) {
  const t = terrain;
  const warp = finite(t.warp) ? t.warp : 0;
  const streams = streamsFor(t);

  /* Add coef × ∂shape(x, z)/∂lattice into `out` (Map key → weight). */
  function addPoint(out, coef, x, z) {
    const [nx, nz] = warp2(x * inv, z * inv, seed, warp);
    for (let s = 0; s < streams.length; s++) {
      const st = streams[s];
      const X = (nx * st.mul + st.ox) * st.freq, Z = (nz * st.mul + st.oz) * st.freq;
      const ix = Math.floor(X), iz = Math.floor(Z);
      if (!(Math.abs(ix) < LIM - 2 && Math.abs(iz) < LIM - 2)) continue;
      const u = quintic(X - ix), v = quintic(Z - iz), k = 2 * st.w * coef;
      bump(out, keyOf(s, ix, iz), k * (1 - u) * (1 - v));
      bump(out, keyOf(s, ix + 1, iz), k * u * (1 - v));
      bump(out, keyOf(s, ix, iz + 1), k * (1 - u) * v);
      bump(out, keyOf(s, ix + 1, iz + 1), k * u * v);
    }
  }

  /* A correction as a field: the same weights a row is built from, read
     against Δ held as one dense box per stream. */
  function field(delta) {
    const boxes = streams.map(() => null);
    const bounds = streams.map(() => [Infinity, -Infinity, Infinity, -Infinity]);
    const cells = [];
    for (const [key, d] of delta) {
      const izo = key % M, rest = (key - izo) / M, ixo = rest % M, s = (rest - ixo) / M;
      const ix = ixo - LIM, iz = izo - LIM, b = bounds[s];
      if (ix < b[0]) b[0] = ix; if (ix > b[1]) b[1] = ix;
      if (iz < b[2]) b[2] = iz; if (iz > b[3]) b[3] = iz;
      cells.push([s, ix, iz, d]);
    }
    bounds.forEach((b, s) => {
      if (b[0] > b[1]) return;
      const w = b[1] - b[0] + 1, h = b[3] - b[2] + 1;
      boxes[s] = { x0: b[0], z0: b[2], w, h, data: new Float64Array(w * h) };
    });
    for (const [s, ix, iz, d] of cells) {
      const bx = boxes[s];
      bx.data[(iz - bx.z0) * bx.w + (ix - bx.x0)] += d;
    }
    const at = (bx, ix, iz) => {
      const i = ix - bx.x0, j = iz - bx.z0;
      return i < 0 || j < 0 || i >= bx.w || j >= bx.h ? 0 : bx.data[j * bx.w + i];
    };
    return function correction(x, z) {
      const [nx, nz] = warp2(x * inv, z * inv, seed, warp);
      let sum = 0;
      for (let s = 0; s < streams.length; s++) {
        const bx = boxes[s];
        if (!bx) continue;
        const st = streams[s];
        const X = (nx * st.mul + st.ox) * st.freq, Z = (nz * st.mul + st.oz) * st.freq;
        const ix = Math.floor(X), iz = Math.floor(Z);
        // Outside the box on every corner: nothing to read, skip the blend.
        if (ix + 1 < bx.x0 || iz + 1 < bx.z0 || ix > bx.x0 + bx.w - 1 || iz > bx.z0 + bx.h - 1) continue;
        const u = quintic(X - ix), v = quintic(Z - iz);
        sum += 2 * st.w * ((1 - u) * (1 - v) * at(bx, ix, iz) + u * (1 - v) * at(bx, ix + 1, iz)
          + (1 - u) * v * at(bx, ix, iz + 1) + u * v * at(bx, ix + 1, iz + 1));
      }
      return sum;
    };
  }

  return { streams: streams.length, addPoint, field };
}

function bump(map, key, w) {
  const prev = map.get(key);
  map.set(key, prev === undefined ? w : prev + w);
}

/* ══ statements → rows ═════════════════════════════════════════════════════
   Each record becomes one or more linear constraints on the SHAPE:
       Σ coef·shape(x, z)  (= | ≥)  target
   with the target carried through the plate's own inverse, so a height asked
   for in metres is a height delivered in metres.

   `plate.toShape(D, x, z)` is the shape value whose DATUM height at (x, z) is
   D metres — affine in D, with the rim's falloff folded in. `plate.floor` is
   the sea floor's compression: a height H below zero is a datum of H/floor. */

/* A flat's ring: six points at k·60°. These are the doubles Math.cos and
   Math.sin returned for (k·π)/3 in V8 when every flat on disk was solved, so
   rings built from the table are those rings to the bit — and, unlike the
   two functions, the table cannot round differently in another engine
   (tools/test/kernel/intent-v2.test.js checks the table against V8's own answer). */
export const FLAT_RING = [
  [1, 0],
  [0.5000000000000001, 0.8660254037844386],
  [-0.4999999999999998, 0.8660254037844387],
  [-1, 1.2246467991473532e-16],
  [-0.5000000000000004, -0.8660254037844385],
  [0.5000000000000001, -0.8660254037844386],
];

/* `ctx` carries what only the v2 statements read: the world's waterline in
   metres, for a shoreline that does not carry its own. */
function constraintsFor(rec, plate, size, ctx) {
  const datum = (H) => (H < 0 ? H / plate.floor : H);
  const at = (H, x, z) => plate.toShape(datum(H), x, z);
  // Two points at the SAME height: their shapes differ only by the rim.
  const same = (x1, z1, x2, z2) => ({
    terms: [[1, x1, z1], [-1, x2, z2]], target: plate.toShape(0, x1, z1) - plate.toShape(0, x2, z2), ineq: false,
  });
  const bounded = (terms, target, op) => (op === ">="
    ? [{ terms, target, ineq: true }]
    : op === "<="
      ? [{ terms: terms.map(([c, x, z]) => [-c, x, z]), target: -target, ineq: true }]
      : [{ terms, target, ineq: false }]);
  const e = GRADIENT_STEP;
  const half = size / 2;
  const on = (x, z) => Math.abs(x) <= half && Math.abs(z) <= half;
  switch (rec.type) {
    case "point":
      return bounded([[1, rec.x, rec.z]], at(rec.h, rec.x, rec.z), rec.op);
    case "summit":
      return [
        { terms: [[1, rec.x, rec.z]], target: at(rec.h, rec.x, rec.z), ineq: false },
        same(rec.x + e, rec.z, rec.x - e, rec.z),
        same(rec.x, rec.z + e, rec.x, rec.z - e),
      ];
    case "flat":
    case "pad": {
      const out = [same(rec.x + e, rec.z, rec.x - e, rec.z), same(rec.x, rec.z + e, rec.x, rec.z - e)];
      for (const [c, s] of FLAT_RING) out.push(same(rec.x + rec.r * c, rec.z + rec.r * s, rec.x, rec.z));
      if (finite(rec.h)) out.push({ terms: [[1, rec.x, rec.z]], target: at(rec.h, rec.x, rec.z), ineq: false });
      return out;
    }
    case "level": {
      const pts = levelPoints(size, rec.inset);
      const c = 1 / pts.length;
      let target = 0;
      for (const [x, z] of pts) target += c * plate.toShape(rec.h, x, z);
      return bounded(pts.map(([x, z]) => [c, x, z]), target, rec.op);
    }
    /* Every v2 inequality goes through the plate the way a v1 one does. The
       plate is monotone in the shape, so "the height here is at most y" is
       "the shape here is at most toShape(datum(y))", exactly, on the sea floor
       and in the rim as much as on land.
       A line's or a ray's row that reads a point off the plate is not stated
       (see the vocabulary); intentErrors names the record. */
    case "shoreline": {
      const level = finite(rec.level) ? rec.level : ctx.waterLevel;
      const out = [];
      const samples = polylineSamples(rec.points, SHORE_STEP, SHORE_SAMPLES);
      for (const p of samples) {
        if (on(p.x, p.z)) out.push({ terms: [[1, p.x, p.z]], target: at(level, p.x, p.z), ineq: false });
      }
      if (rec.side) {
        const k = (rec.side === "left" ? 1 : -1) * rec.offset;
        for (const p of samples) {
          const lx = p.x + k * p.nx, lz = p.z + k * p.nz, sx = p.x - k * p.nx, sz = p.z - k * p.nz;
          if (on(lx, lz)) out.push(...bounded([[1, lx, lz]], at(level + SHORE_MARGIN, lx, lz), ">="));
          if (on(sx, sz)) out.push(...bounded([[1, sx, sz]], at(level - SHORE_MARGIN, sx, sz), "<="));
        }
      }
      return out;
    }
    case "ray": {
      const [ex, ey, ez] = rec.eye, [ax, az] = rec.at;
      const out = [];
      if (finite(rec.h)) {
        // A stated far end: every row is one point under a known height.
        for (let k = 0; k < rec.samples; k++) {
          const t = k / rec.samples;
          const x = ex + (ax - ex) * t, z = ez + (az - ez) * t;
          if (on(x, z)) out.push(...bounded([[1, x, z]], at(ey + (rec.h - ey) * t, x, z), "<="));
        }
        if (on(ax, az)) out.push(...bounded([[1, ax, az]], at(rec.h, ax, az), rec.contact ? "=" : "<="));
        return out;
      }
      /* The far end is the conditioned ground at `at`, so each sample reads
         both ends. What is wanted is H(x) ≤ (1 − t)·ey + t·H(at), and height
         is not linear in the shape: H(D) = max(D, floor·D) of the datum D,
         because the sea floor is compressed. But that max makes one row
         enough. With E the eye's own datum (ey, or ey/floor under water),
             D(x) − t·D(at) ≤ (1 − t)·E
         gives both D(x) and floor·D(x) at most (1 − t)·ey + t·H(at) — each
         side of the max is checked against the matching side of H(at) ≥
         D(at), H(at) ≥ floor·D(at) — so it is SUFFICIENT above zero, below
         it and across it; exact where the eye and the far end both stand
         at or above zero, which is what a sightline is for; and
         otherwise stricter than asked, never looser (a far end under water
         by t·(1 − floor) times its depth in datum). In shape units,
         with D = (shape − toShape(0))·scale and toShape affine in D:
             shape(x) − t·shape(at) ≤ toShape((1 − t)·E, x) − t·toShape(0, at)
         — a two-term row, the rim folded in the way `same` folds it. The
         eye's own foot (t = 0) reads only itself, and on the height scale,
         like the stated form. (A first version used ey for E under water
         too, and was measured letting the ground 1.5 m over a ray whose eye
         stood 0.1 m under the sea.) */
      if (!on(ax, az)) return out;
      const E = datum(ey);
      for (let k = 0; k < rec.samples; k++) {
        const t = k / rec.samples;
        const x = ex + (ax - ex) * t, z = ez + (az - ez) * t;
        if (!on(x, z)) continue;
        if (k === 0) { out.push(...bounded([[1, x, z]], at(ey, x, z), "<=")); continue; }
        out.push(...bounded([[1, x, z], [-t, ax, az]], plate.toShape((1 - t) * E, x, z) - t * plate.toShape(0, ax, az), "<="));
      }
      return out;
    }
    /* A grade bound on the DATUM difference: exact on land, where height is
       datum, and conservative on the sea floor, where a datum step of d is a
       height step of SEA_FLOOR·d — a road under water is held a little
       flatter than it was asked to be, never steeper. */
    case "corridor": {
      const scale = finite(plate.scale) ? plate.scale : 1;
      const pts = polylineSamples(rec.points, CORRIDOR_STEP, CORRIDOR_SAMPLES);
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (!on(a.x, a.z) || !on(b.x, b.z)) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const g = (rec.maxGrade * Math.sqrt(dx * dx + dz * dz)) / scale;
        const rim = plate.toShape(0, b.x, b.z) - plate.toShape(0, a.x, a.z);
        // up:   shape(b) − shape(a) ≤ rim + g   ⇔   shape(a) − shape(b) ≥ −(rim + g)
        out.push({ terms: [[1, a.x, a.z], [-1, b.x, b.z]], target: -(rim + g), ineq: true });
        // down: shape(b) − shape(a) ≥ rim − g
        out.push({ terms: [[1, b.x, b.z], [-1, a.x, a.z]], target: rim - g, ineq: true });
      }
      return out;
    }
    default:
      return [];
  }
}

/* ══ the solve ═════════════════════════════════════════════════════════════
   Equalities in one minimum-norm solve; inequalities by active set — solve,
   find every inequality the answer breaks, hold those at their bound, solve
   again from the untouched seed. In THIS loop (the v1 one, which every list
   without a shoreline, ray or corridor takes) nothing is ever released, so
   the answer is feasible and a little short of the exact minimum where a
   held bound would have let go; it converges in two or three rounds on
   anything a grammar writes, and says so when it does not. A list with a
   line or a ray in it goes through activeSetV2 below instead. */

/* Split in two so a refinement (below) can reuse one factorisation: `factor`
   builds the Gram matrix and its Cholesky factor, `apply` runs the two
   triangular solves for a right-hand side and lifts λ back to Δ. solve() is
   the two in a row — the same operations in the same order as when they were
   one function, so a v1 world's Δ is the Δ it always was. */
function solve(rows, rhs) {
  return apply(factor(rows), rhs);
}

const rowDot = (ra, rb) => {
  const [a, b] = ra.size <= rb.size ? [ra, rb] : [rb, ra];
  let s = 0;
  for (const [k, w] of a) { const v = b.get(k); if (v !== undefined) s += w * v; }
  return s;
};

/* `memo`, when given, caches Gram entries by row object across calls — the
   v2 active set refactors nearly the same system every round, and building
   G was measured at most of its time. The entries are the same rowDot of the
   same two rows, so a cached G is the G that would have been built. */
function factor(rows, memo) {
  const m = rows.length;
  const G = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      const s = memo ? memo(rows[i], rows[j]) : rowDot(rows[i], rows[j]);
      G[i * m + j] = s; G[j * m + i] = s;
    }
  }
  let trace = 0;
  for (let i = 0; i < m; i++) trace += G[i * m + i];
  const lift = RIDGE * (trace / m);
  for (let i = 0; i < m; i++) G[i * m + i] += lift;
  // Cholesky, then the two triangular solves.
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = G[i * m + j];
      for (let k = 0; k < j; k++) s -= L[i * m + k] * L[j * m + k];
      L[i * m + j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j * m + j];
    }
  }
  return { rows, m, L };
}

function apply({ rows, m, L }, rhs, lamSum) {
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) { let s = rhs[i]; for (let k = 0; k < i; k++) s -= L[i * m + k] * y[k]; y[i] = s / L[i * m + i]; }
  const lam = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < m; k++) s -= L[k * m + i] * lam[k]; lam[i] = s / L[i * m + i]; }
  if (lamSum) for (let i = 0; i < m; i++) lamSum[i] += lam[i];
  const delta = new Map();
  rows.forEach((r, i) => { for (const [k, w] of r) bump(delta, k, lam[i] * w); });
  return delta;
}

const dot = (row, delta) => {
  let s = 0;
  for (const [k, w] of row) { const d = delta.get(k); if (d !== undefined) s += w * d; }
  return s;
};

/* ── refinement: the ridge, paid back ──
   The Tikhonov term above costs millimetres when a few statements crowd one
   lattice cell. A line is DOZENS of statements in a strip one cell wide — a
   shoreline with sides is three rows every 48 m, inside 80 m — and there the
   single regularised solve was measured missing its own waterline by 0.3 to
   1.8 m on the four test seeds, a pad by up to 5 mm and a ray by up to
   1.5 cm. So a list that states a v2 record is solved again on its own
   residual, with the same factor, until every held row is met to REFINE_TOL
   or REFINE_ROUNDS have run: iterated Tikhonov, which walks the regularised
   answer to the exact minimum-norm one wherever the rows are consistent, and
   — where they contradict each other — stops after a bounded number of steps
   with the shortfall still standing, which is what `miss` then reports.
   Twelve, because more was measured to be worse, not better: at 32 or 64 the
   slow cases gain a centimetre or two, the folded ones (see the shoreline
   test) pay 2–4× the nats for it, and the solve takes 2–4× as long. After the
   v2 active set below, the same four seeds' pads and rays meet their rows to
   well under a millimetre (tools/test/kernel/intent-v2.test.js).

   Only a list with a shoreline, a ray or a corridor is refined. A list of
   v1 records — and pads, which are flats with an h and keep the flat's
   solve so the sugar is exact — takes the single solve it always took, to
   the bit: the rebuilt-from-seed worlds already on disk depend on it
   (tests/condition.test.js), and the millimetres it leaves are inside every
   tolerance a v1 statement was ever promised (a lone pad: under 1 cm on the
   four suite seeds, tools/test/kernel/intent-v2.test.js). */
const REFINE_ROUNDS = 12;
// ≈ 0.1 mm on a 420 m world, under the 1 mm the inequalities are held to.
const REFINE_TOL = 2.4e-7;
const V2_SOLVE = new Set(["shoreline", "ray", "corridor"]);

function solveRefined(sys, lam, memo) {
  const f = factor(sys.map((c) => c.row), memo);
  const delta = apply(f, sys.map((c) => c.need), lam);
  for (let p = 0; p < REFINE_ROUNDS; p++) {
    const resid = sys.map((c) => c.need - dot(c.row, delta));
    let worst = 0;
    for (const r of resid) if (Math.abs(r) > worst) worst = Math.abs(r);
    if (!(worst > REFINE_TOL)) break;
    for (const [k, d] of apply(f, resid, lam)) bump(delta, k, d);
  }
  return delta;
}

/* ── the active set, for a list with a v2 record ──
   The v1 loop (in solveIntent) holds every bound it finds broken and never
   lets one go.
   That is cheap and nearly optimal when there are a handful of inequalities.
   A shoreline with sides has two per sample, all on one strip, and the first
   solve (waterline alone) breaks most of them, so all of them were held as
   equalities: all 111 rows held on a 1.7 km coast, the system near-singular,
   and the answer measured at 160–1 700 nats with misses up to 4 m on twelve
   seeds.

   So this loop also RELEASES: once nothing is broken, a held bound whose
   multiplier is negative is pulling the ground the wrong way through its own
   bound, and it is let go. Stopping when nothing is broken and no multiplier
   is negative is the KKT condition for this convex problem, so a converged
   answer is the true minimum-norm correction, not an approximation of it. On
   the same twelve seeds it holds 4–19 bounds, costs 49–170 nats where the
   coast is expressible, and converges on all of them.

   Releasing every negative multiplier at once is fast and can cycle (a road,
   a coast and a ray together: 2 of 16 seeds never settled); releasing only
   the most negative one is slow (from round 4 on: 4 of 16 ran out of
   rounds). So the first RELEASE_ALL rounds release all of them and the rest
   release one — measured, all 16 and all 12 converge. That is the author's
   own inputs, not a promise: lines that zigzag at the lattice's own scale
   near MAX_ROWS (a 64-vertex zigzag coast with a side and a 64-vertex
   zigzag road at grade 0, 633 rows) were measured holding ~220 bounds,
   running out of rounds in 2.4–2.8 s and missing by 2.8–3.5 m. So
   `converged` is something a caller MUST read: when the loop runs out of
   rounds, the last answer that broke nothing is the one returned, and
   `converged` says false (tools/test/kernel/intent-v2.test.js runs a list at the cap).

   Some coasts no correction can draw. Where the domain warp FOLDS (its
   Jacobian determinant ≤ 0), ground on the two sides of the fold reads the
   same lattice values, and nothing drawn from them can raise one side and
   sink the other. Of those 12 seeds, 2 fold along the test coast and miss it
   by 0.17 and 4.0 m; 2 come near it (least determinant 0.08 and 0.21) and
   miss by 0.25 and 0.06 m; the 8 whose least determinant is 0.49 or more all
   meet it to 4 mm. That shortfall is the number `miss` reports. */
const V2_ROUNDS = 64;
const RELEASE_ALL = 16;
function activeSetV2(eqs, ineqs) {
  let held = [], delta = new Map(), used = [], best = null, rounds = 0, converged = false;
  const ids = new Map(), cache = new Map();
  for (const c of [...eqs, ...ineqs]) ids.set(c.row, ids.size);
  const n = ids.size;
  const memo = (ra, rb) => {
    const a = ids.get(ra), b = ids.get(rb), key = a < b ? a * n + b : b * n + a;
    let v = cache.get(key);
    if (v === undefined) { v = rowDot(ra, rb); cache.set(key, v); }
    return v;
  };
  for (; rounds < V2_ROUNDS; rounds++) {
    const sys = [...eqs, ...held];
    const lam = new Float64Array(sys.length);
    delta = sys.length ? solveRefined(sys, lam, memo) : new Map();
    used = sys;
    const broken = ineqs.filter((c) => !held.includes(c) && dot(c.row, delta) < c.need - SLACK);
    if (broken.length) { held = [...held, ...broken]; continue; }
    best = { delta, held, used };
    let worst = -1, low = 0;
    for (let i = 0; i < held.length; i++) { const l = lam[eqs.length + i]; if (l < low) { low = l; worst = i; } }
    if (worst < 0) { converged = true; break; }
    held = rounds < RELEASE_ALL ? held.filter((_, i) => !(lam[eqs.length + i] < 0)) : held.filter((_, i) => i !== worst);
  }
  if (!converged && best) ({ delta, held, used } = best);
  return { delta, held, used, converged, rounds };
}

/**
 * The rows a list of records states, before anything is solved: one entry per
 * linear constraint, `{ row, need, ineq, record }` — row the lattice weights
 * (Map key → ∂/∂lattice), need what the correction must add along it (shape
 * units), ineq whether it is a floor rather than an equality, and record the
 * index of the record it came from. Exported so a reader of the solved ground
 * (terrain/sigma.js) can reason over EXACTLY the rows the solve did.
 *
 * Records are taken in order; one whose rows would carry the system past
 * MAX_ROWS is skipped whole and counted in `dropped`.
 *
 *   waterLevel  the waterline in metres a shoreline stands at (default 0)
 */
export function intentSystem({ basis, shape, plate, size, records, waterLevel = 0 }) {
  const ctx = { waterLevel: finite(waterLevel) ? waterLevel : 0 };
  const cons = [];
  let dropped = 0;
  records.forEach((rec, r) => {
    const mine = [];
    for (const c of constraintsFor(rec, plate, size, ctx)) {
      if (!finite(c.target)) continue;
      const row = new Map();
      for (const [coef, x, z] of c.terms) basis.addPoint(row, coef, x, z);
      if (!row.size) continue;
      let value = 0;
      for (const [coef, x, z] of c.terms) value += coef * shape(x, z);
      if (!finite(value)) continue;
      mine.push({ row, need: c.target - value, ineq: c.ineq, record: r });
    }
    if (cons.length + mine.length > MAX_ROWS) { dropped++; return; }
    for (const c of mine) cons.push(c);
  });
  return { cons, dropped };
}

/**
 * The correction a list of intent records asks for, or null when there is
 * nothing to correct.
 *
 *   basis   createBasis(…) for this world
 *   shape   the UNCORRECTED shape, (x, z) → shape units
 *   plate   { toShape(D, x, z), floor, scale } — the plate's inverse and its
 *           vertical scale in metres (heightfield.js)
 *   size    the world's edge, metres
 *
 * Returns { correction(x, z), nats, miss, rows, active, converged, rounds,
 * coefficients, dropped, system: { all, used, misses } } — `rows` counts
 * every row stated, `dropped` the records MAX_ROWS turned away, and
 * `system.misses[r]` record r's own shortfall in metres (null when it stated
 * no row), of which `miss` is the largest.
 * `miss` is the largest amount, in metres of datum, by which any statement
 * went unmet — zero to the millimetre for anything the ground can express, and
 * the honest answer when two statements contradict each other. `converged`
 * false means the active set ran out of rounds (see activeSetV2): the ground
 * is the last answer that broke no bound, and `miss` is its shortfall. A
 * caller that needs the statements true reads both.
 *
 * What it costs: the whole solve, every time a sampler is built — nothing
 * here is cached, because a core module keeps no state between calls. In
 * Node, a handful of v1 records is milliseconds; a 3.8 km coast with sides
 * and a 2.1 km road (411 rows) 0.3–0.7 s; a list at MAX_ROWS up to ~2.8 s.
 * A caller that needs the same world twice (the engine, a picker, the
 * freedom map in terrain/sigma.js) builds one sampler and passes it along.
 */
export function solveIntent({ basis, shape, plate, size, records, waterLevel = 0 }) {
  const { cons, dropped } = intentSystem({ basis, shape, plate, size, records, waterLevel });
  if (!cons.length) return null;

  /* Which loop: see the header. A record MAX_ROWS dropped states no rows, so
     it does not choose the loop either. */
  const solved = new Set(cons.map((c) => c.record));
  const v2 = records.some((r, i) => solved.has(i) && V2_SOLVE.has(r.type));
  const eqs = cons.filter((c) => !c.ineq), ineqs = cons.filter((c) => c.ineq);
  const held = [];
  let delta = new Map(), converged = false, rounds = 0, used = [];
  if (v2) {
    const r = activeSetV2(eqs, ineqs);
    delta = r.delta; held.push(...r.held); used = r.used; converged = r.converged; rounds = r.rounds;
  } else {
    // The v1 loop, as it always ran: one regularised solve a round, no refinement.
    for (; rounds < ACTIVE_ROUNDS; rounds++) {
      const sys = [...eqs, ...held];
      used = sys;
      delta = !sys.length ? new Map() : solve(sys.map((c) => c.row), sys.map((c) => c.need));
      const broken = ineqs.filter((c) => !held.includes(c) && dot(c.row, delta) < c.need - SLACK);
      if (!broken.length) { converged = true; break; }
      held.push(...broken);
    }
  }

  let sq = 0;
  for (const d of delta.values()) sq += d * d;
  /* The same shortfall, kept per record as well: `misses[r]` is the largest
     amount by which any row record r stated went unmet, and null for a record
     that stated no row (MAX_ROWS dropped it, or every row read off the
     plate). The whole-list `miss` is the largest of them, by construction —
     one loop, the same comparison — so an author can be told WHICH statement
     the ground could not keep, not only that one could not be kept
     (js/author.js, explain). Read-only bookkeeping: nothing below it moves. */
  const misses = records.map(() => null);
  let miss = 0;
  for (const c of cons) {
    const got = dot(c.row, delta);
    const short = c.ineq && !held.includes(c) ? c.need - got : Math.abs(c.need - got);
    if (short > miss) miss = short;
    const was = misses[c.record], over = short > 0 ? short : 0;
    if (was === null || over > was) misses[c.record] = over;
  }
  const metres = finite(plate.scale) ? plate.scale : 1;
  return {
    correction: delta.size ? basis.field(delta) : null,
    nats: (0.5 * sq) / NOISE_VARIANCE,
    miss: miss * (finite(plate.scale) ? plate.scale : 1),
    rows: cons.length,
    active: held.length,
    converged,
    rounds: rounds + (converged ? 1 : 0),
    coefficients: delta.size,
    dropped,
    /* The system as solved: every row stated, and the rows the final solve
       actually held — the equalities and the inequalities it had to hold at
       their bound. An inequality the answer met without holding constrains
       nothing, so it is not in `used`. `misses` is per record, above. */
    system: { all: cons, used, misses: misses.map((m) => (m === null ? null : m * metres)) },
  };
}

/**
 * The one door heightfield.js uses: normalise the intent, build the basis,
 * solve. Null when the world carries no usable intent — in which case the
 * caller must use its shape untouched, which is what keeps intent-free worlds
 * bit-identical.
 */
export function conditionShape({ terrain, seed, inv, shape, plate, intent, waterLevel = 0 }) {
  const records = normalizeIntent(intent);
  if (!records) return null;
  const basis = createBasis({ terrain, seed, inv });
  const out = solveIntent({ basis, shape, plate, size: terrain.size, records, waterLevel });
  if (!out) return null;
  return { ...out, records, basis };
}
