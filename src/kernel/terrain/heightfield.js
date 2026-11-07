// The height sampler: params → h(x, z) in world metres.
// Three flavours share one contract:
//   analytic  — pure function of the noise fields, the built-in recipe (default)
//   stack     — the same, with the SHAPE composed from params.terrain.stack
//   baked     — bilinear over a Float32Array grid (post-erosion / export)
// Either of the first two may carry INTENT (params.terrain.intent): statements
// about the ground that terrain/condition.js makes true by the least improbable
// change to the seed's own lattice. A world with no intent never meets it.
// Pure JS, no three.js — runs in the erosion worker and in JSC tests.
//
// ── TWO HALVES, AND ONLY THE FIRST IS AUTHORABLE ──
// A sampler is a SHAPE run through a PLATE. The shape is the recipe — warped
// fbm against a ridged crest on a continent mask, or whatever a layer stack
// says instead. The plate is sea level, the square edge falloff that sinks the
// world's rim into open water, the gentler sea floor and the vertical scale,
// and it runs after ANY shape.
//
// That split is why a stack cannot take the plate with it. The plate is what
// turns a finite square of noise into an island with a coastline rather than a
// cliff into the void, and `tools/walk-world.mjs` audits worlds on the
// assumption that it runs.
//
// It is a strong falloff rather than a clamp, and the distinction is worth
// stating because the code does not enforce it: the edge subtracts up to 1.15
// from a shape whose own range is about ±1.3, so a shape PINNED AT ITS
// MAXIMUM across the whole world outruns it and leaves the rim standing a few
// metres above the water. That is true of the built-in recipe too and always
// has been — measured over 400 seeds the highest any rim reaches is −40 m, so
// ordinary noise has about a third of the falloff in hand. What can reach it
// is a constant, or a layer driven to saturation everywhere, which a stack
// makes easy to write for the first time. Hence the note here rather than a
// clamp that would move every world already on disk.

import { seedChannel } from "../seed.js";
import { fbm, ridged, warp2 } from "./noise.js";
import { normalizeStack, evaluateStack } from "./noise-stack.js";
import { conditionShape } from "./condition.js";

// Where the coastal falloff begins, as a fraction of the half-extent.
export const EDGE_START = 0.84;
// How far (in shape units) the falloff sinks the very rim.
export const EDGE_DEPTH = 1.15;
// Below sea level the shape is compressed by this, so the shelf reads.
export const SEA_FLOOR = 0.45;

export function createHeightSampler(params) {
  const t = params.terrain;
  const seed = seedChannel(params.seed, "terrain");
  const size = t.size;
  const inv = t.frequency / size; // world → noise space

  /* ── the shape: the built-in recipe ──
     Left exactly as it was written, arithmetic and order untouched, because
     the claim that a world without a stack is bit-identical to the world it
     was before stacks existed is only worth as much as this function not
     having been "tidied" on the way past. tools/test/kernel/noise-stack.test.js pins it
     against heights sampled before the split. */
  function classicShape(x, z) {
    let nx = x * inv, nz = z * inv;
    [nx, nz] = warp2(nx, nz, seed, t.warp);

    const base = fbm(nx, nz, seed, t.octaves, t.lacunarity, t.gain);
    const crest = ridged(nx * 0.6, nz * 0.6, seed ^ 0x2545f491, Math.max(3, t.octaves - 1), t.lacunarity, t.gain);
    // Continent mask: very low frequency, decides land vs sea basins.
    const continent = fbm(nx * 0.22 + 7.3, nz * 0.22 - 3.1, seed ^ 0x68e31da4, 3);

    let h = base * (1 - t.ridged) + crest * t.ridged;
    h = h * 0.72 + continent * 0.55;

    if (t.island > 0) { // radial falloff → archipelago / island worlds
      const d = Math.sqrt(x * x + z * z) / (size * 0.5);
      h -= t.island * (d * d * 1.6 - 0.35);
    }
    if (t.plateau > 0) { // soft terracing
      const steps = 6;
      const q = Math.round(h * steps) / steps;
      h = h + (q - h) * t.plateau;
    }
    return h;
  }

  /* A stack REPLACES the recipe rather than adding to it — a stack that wants
     the recipe underneath says so with a `legacy` layer, which is handed
     classicShape to call. Anything unevaluable (no stack, an empty list, only
     types this build does not know) normalises to null and takes the recipe,
     which is what every world saved before this existed says by saying
     nothing at all. */
  const stack = normalizeStack(t.stack);
  const baseShape = stack
    ? (x, z) => evaluateStack(stack, x * inv, z * inv, seed, { worldX: x, worldZ: z, legacy: classicShape })
    : classicShape;

  /* The rim's falloff, in shape units — one function, read by the plate and
     by the plate's inverse, so the two cannot drift. Zero inside EDGE_START. */
  function edgeDrop(x, z) {
    const e = Math.max(Math.abs(x), Math.abs(z)) / (size * 0.5);
    if (!(e > EDGE_START)) return 0;
    const k = Math.min((e - EDGE_START) / (1 - EDGE_START), 1);
    return k * k * (3 - 2 * k) * EDGE_DEPTH;
  }

  /* ── the plate, inverted ──
     The shape value whose DATUM height at (x, z) is D metres — the height
     before the sea floor is compressed. Affine in D. This is how intent asks
     for a height in metres and gets exactly that height back, on the shelf
     and inside the rim's falloff as much as in the middle of the land. A
     height H below zero is a datum of H / SEA_FLOOR. */
  const seaOffset = (t.seaLevel * 2 - 1) * 0.5;
  const toShape = (D, x, z) => D / t.height + seaOffset + edgeDrop(x, z);

  /* ── intent ──
     When the world carries none, conditionShape returns null and `shape` is
     the very function above — the same reference, so a world without intent
     is bit-identical to the world it was before intent existed. */
  /* The waterline travels in too, because a shoreline statement stands the
     ground AT it (condition.js). Nothing else reads it, and a world whose
     intent has no shoreline solves the same rows whatever it is. */
  const waterLevel = Number.isFinite(params.water?.level) ? params.water.level : 0;
  const conditioning = conditionShape({
    terrain: t, seed, inv, shape: baseShape, plate: { toShape, floor: SEA_FLOOR, scale: t.height }, intent: t.intent,
    waterLevel,
  });
  const correction = conditioning?.correction || null;
  const shape = correction ? (x, z) => baseShape(x, z) + correction(x, z) : baseShape;

  function height(x, z) {
    let h = shape(x, z);

    // Normalize around sea level: params.terrain.seaLevel ∈ [0,1] of the range.
    const sea = (t.seaLevel * 2 - 1) * 0.5;
    h -= sea;

    // World edge: sink the outer margin below sea level so the finite plate
    // ends as a coastline in open water rather than a cliff into the void.
    // Square falloff (not radial) because the world IS a square.
    const drop = edgeDrop(x, z);
    if (drop) h -= drop; // smoothstep, deep enough to submerge

    // Gentler sea floor so the shelf reads well underwater.
    if (h < 0) h *= SEA_FLOOR;
    return h * t.height;
  }

  height.params = params;
  height.kind = stack ? "stack" : "analytic";
  // The shape before the plate, and the datum height (metres, sea floor not
  // compressed) — what the seed screen reasons in (src/kernel/core/survey.js).
  height.shape = shape;
  height.datum = (x, z) => (shape(x, z) - toShape(0, x, z)) * t.height;
  /* What the intent cost, or null for a world that carries none. `nats` is the
     surprise the correction injected, `miss` the metres by which the most
     unmet statement fell short — see terrain/condition.js. */
  height.conditioning = conditioning
    ? { nats: conditioning.nats, miss: conditioning.miss, rows: conditioning.rows, active: conditioning.active,
        converged: conditioning.converged, coefficients: conditioning.coefficients,
        records: conditioning.records.length, dropped: conditioning.dropped }
    : null;
  /* The solved system itself, for a reader that has to reason over the very
     rows the solve used (terrain/sigma.js: how much freedom the statements
     left the ground). Non-enumerable, so the summary above stays the small
     plain object it always was — to JSON, to a log, to a diff. */
  if (height.conditioning) {
    Object.defineProperty(height.conditioning, "system", {
      value: { basis: conditioning.basis, records: conditioning.records, ...conditioning.system },
      enumerable: false,
    });
  }
  return height;
}

// Bake to a (res × res) grid covering [-size/2, size/2]². res should be 2ⁿ+1.
export function bakeHeightField(params, res, sampler) {
  const h = sampler || createHeightSampler(params);
  const size = params.terrain.size;
  const data = new Float32Array(res * res);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < res; j++) {
    const z = (j / (res - 1) - 0.5) * size;
    for (let i = 0; i < res; i++) {
      const at = j * res + i;
      data[at] = h((i / (res - 1) - 0.5) * size, z);
      /* The extremes are read BACK from the array, not taken from what the
         sampler returned. The sampler works in doubles and the field stores
         float32, so every store rounds, and it can round an extreme OUTWARDS:
         tracking the pre-store double reported a range that did not contain
         its own data. The 3dgen port found it first (src/world/terrain/
         heightfield.js there, where the stored minimum of one recipe sat
         1.8e-6 m below the reported one) and fixed it in the port; this is
         the same fix at the source. Measured here before the fix, at 129²
         over eight seeds of the default params: six of the eight reported a
         range that a stored value fell outside of, by up to 7.8e-6 m (seed
         ECHO's minimum).

         Microscopic, and still a bug, because downstream readers treat these
         two numbers as BOUNDS: an export normalises by them, a slab's
         thickness is cut from them, a manifest publishes them. A bound that a
         stored value can fall outside of is a bound nothing can rely on. The
         heights themselves do not move — only the two numbers reported about
         them — so every heightHash is what it was; tests/ground.test.js
         checks both halves of that sentence. */
      const v = data[at];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { res, size, data, min, max };
}

export function createBakedSampler(field) {
  const { res, size, data } = field;
  const scale = (res - 1) / size;
  function height(x, z) {
    let fx = (x + size / 2) * scale, fz = (z + size / 2) * scale;
    fx = Math.min(Math.max(fx, 0), res - 1.001);
    fz = Math.min(Math.max(fz, 0), res - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const a = data[iz * res + ix], b = data[iz * res + ix + 1];
    const c = data[(iz + 1) * res + ix], d = data[(iz + 1) * res + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }
  height.kind = "baked";
  height.field = field;
  return height;
}

// Normalized elevation for palette lookups. Analytic heights land roughly in
// [-0.45·height, +1.0·height]; every reader (terrain colours, minimap, splat
// export, VSight) maps through this one function so colours always agree.
export function elevNorm(h, height) {
  const t = (h / height + 0.45) / 1.45;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Slope in metres/metre via central differences (works on either sampler).
export function slopeAt(sampler, x, z, eps = 2) {
  const dx = sampler(x + eps, z) - sampler(x - eps, z);
  const dz = sampler(x, z + eps) - sampler(x, z - eps);
  return Math.sqrt(dx * dx + dz * dz) / (2 * eps);
}
