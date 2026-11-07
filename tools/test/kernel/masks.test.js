/* The terrain control map, asserted against terrain whose answer is known.
 *
 * src/kernel/terrain/masks.js has computed slope, curvature, ambient occlusion and
 * D8 flow accumulation since it was written, and until now had NO functional
 * test — it was covered only by boundary.test.js checking that it stays pure.
 * That was survivable while its one consumer was an exporter nobody could run
 * from here. It is not survivable now: the terrain shader reads all four
 * channels every frame, so a sign error in curvature or a transposed channel
 * in the packing is a visual bug with no test between it and the screen.
 *
 * Every case below builds an analytic surface — a cone, a bowl, a valley —
 * where the correct answer is known before the code runs, rather than
 * asserting that today's output equals today's output.
 */
import { test, ok, eq, close, report } from "./harness.js";
import {
  bakeTerrainMasks, bakeFlow, bakeErosionMasks, packTerrainMasks, packErosionMasks,
  CURVATURE_NEUTRAL, DEPOSITION_NEUTRAL, DEPOSITION_RANGE, SLOPE_REFERENCE_GRADE,
} from "../../../src/kernel/terrain/masks.js";

const RES = 33;
const SPACING = 4;
const HALF = ((RES - 1) * SPACING) / 2;
const sampleAt = (ix, iz) => [-HALF + ix * SPACING, -HALF + iz * SPACING];
const bake = (sampler, deposition = null) =>
  bakeTerrainMasks({ sampler, res: RES, spacingMeters: SPACING, sampleAt, deposition });
const at = (grid, ix, iz) => grid[iz * RES + ix];
const MID = (RES - 1) / 2;

test("a flat plain is flat in every channel", () => {
  const { slope, curvature } = bake(() => 12);
  eq(at(slope, MID, MID), 0, "flat ground reports slope");
  // Curvature is stored with 0.5 as flat because eight bits cannot hold a
  // sign. A consumer reading this raw gets "half concave" everywhere.
  eq(at(curvature, MID, MID), CURVATURE_NEUTRAL, "flat ground is not the neutral curvature");
});

test("slope saturates at the reference grade and not before", () => {
  // A constant 45° ramp: dy/dx = 1.0, which IS the reference grade.
  const { slope } = bake((x) => x * SLOPE_REFERENCE_GRADE);
  eq(at(slope, MID, MID), 255, "a 45° ramp should saturate the slope channel");
  // Half that grade must land near the middle rather than also saturating —
  // a mask that is 255 everywhere carries no information at all.
  const gentle = bake((x) => x * 0.5 * SLOPE_REFERENCE_GRADE).slope;
  const v = at(gentle, MID, MID);
  ok(v > 100 && v < 160, `a half-grade slope quantised to ${v}, expected mid-range`);
});

test("curvature separates a bowl from a ridge, with the documented sign", () => {
  const r2 = (x, z) => x * x + z * z;
  // 0.006 rather than a gentler figure on purpose: at ±0.002 the quantised
  // answer is 133 vs 122, which is the correct SIGN inside the noise floor of
  // an 8-bit channel. A test that can only just tell the two apart cannot
  // tell you the sign flipped either.
  const bowl = bake((x, z) => r2(x, z) * 0.006);     // concave up
  const dome = bake((x, z) => -r2(x, z) * 0.006);    // convex up
  const b = at(bowl.curvature, MID, MID), d = at(dome.curvature, MID, MID);
  ok(b > CURVATURE_NEUTRAL, `a bowl read ${b}, expected above ${CURVATURE_NEUTRAL} (concave)`);
  ok(d < CURVATURE_NEUTRAL, `a dome read ${d}, expected below ${CURVATURE_NEUTRAL} (convex)`);
  /* The shader brightens ridges and darkens hollows off this one sign. Get it
     backwards and the terrain reads inside-out — valleys glowing, ridges in
     shadow — which is subtle enough to ship. */
  ok(b - CURVATURE_NEUTRAL > 8 && CURVATURE_NEUTRAL - d > 8, "the two are barely distinguishable");
});

test("ambient occlusion darkens a hollow and leaves open ground alone", () => {
  const flat = bake(() => 5);
  const bowl = bake((x, z) => (x * x + z * z) * 0.004);
  const open = at(flat.ao, MID, MID), sunk = at(bowl.ao, MID, MID);
  eq(open, 255, "flat open ground must be fully unoccluded — the shader relies on 1.0 being the identity");
  ok(sunk < open, `a bowl floor (${sunk}) is not darker than open ground (${open})`);
});

test("flow accumulates downhill, and a channel carries more than its banks", () => {
  /* A V-shaped valley running along Z, tilted so water also moves +Z. Every
     cell drains toward the axis, so the axis must collect far more than the
     slopes beside it — that is the whole claim the shader's drainage term
     rests on. */
  // MINUS z: height falls as z rises, so the outlet is the high-index end.
  // With the sign the other way the valley still concentrates flow, just at
  // the opposite edge — which is how this test caught its own first draft.
  const { flow } = bake((x, z) => Math.abs(x) * 0.35 - z * 0.05);
  const axis = at(flow, MID, RES - 2);
  const bank = at(flow, MID + 6, RES - 2);
  ok(axis > bank, `the valley axis (${axis}) carries no more than its bank (${bank})`);
  ok(axis > 200, `the axis only reached ${axis}; the main channel should be near the top of the range`);
});

test("flow is conservative: nothing is created and the outlet holds the most", () => {
  // A single uniform slope — every cell drains one way, so the lowest row
  // must hold the largest accumulation.
  const res = 16;
  const heights = new Float64Array(res * res);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) heights[iz * res + ix] = -iz;
  const flow = bakeFlow(heights, res);
  const top = flow[0 * res + 8], bottom = flow[(res - 1) * res + 8];
  ok(bottom > top, `the outlet (${bottom}) should carry more than the ridge (${top})`);
  eq(Math.max(...flow), 255, "the log-normalised maximum should reach the top of the range");
});

test("a pit keeps its own water rather than inventing an outlet", () => {
  // No depression filling, deliberately — see masks.js. A single sink in
  // otherwise flat ground must not blow up or route water uphill.
  const res = 8;
  const heights = new Float64Array(res * res).fill(10);
  heights[3 * res + 3] = 0;
  const flow = bakeFlow(heights, res);
  ok(flow.every((v) => Number.isFinite(v) && v >= 0 && v <= 255), "flow left the byte range");
  eq(flow[3 * res + 3], 255, "the sink should be where everything ends up");
});

test("the packing puts each mask in the channel the shader reads", () => {
  /* The channel order IS the contract with QuadtreeTerrain's injection, and
     nothing at runtime would notice a swap — curvature in the AO slot just
     looks like a different, plausible terrain. */
  const n = 3;
  const rgba = packTerrainMasks({
    slope: Uint8Array.from([1, 2, 3]),
    curvature: Uint8Array.from([11, 12, 13]),
    ao: Uint8Array.from([21, 22, 23]),
    flow: Uint8Array.from([31, 32, 33]),
  });
  eq(rgba.length, n * 4, "packed buffer is the wrong length");
  for (let i = 0; i < n; i++) {
    eq(rgba[i * 4 + 0], 1 + i, `R (slope) wrong at ${i}`);
    eq(rgba[i * 4 + 1], 11 + i, `G (curvature) wrong at ${i}`);
    eq(rgba[i * 4 + 2], 21 + i, `B (ao) wrong at ${i}`);
    eq(rgba[i * 4 + 3], 31 + i, `A (flow) wrong at ${i}`);
  }
});

test("the same world bakes the same masks", () => {
  // Seeded determinism is the rule the whole engine runs on, and a mask that
  // moved between two runs would move the ground's material with it.
  const surface = (x, z) => Math.sin(x * 0.03) * 9 + Math.cos(z * 0.021) * 7;
  const a = bake(surface), b = bake(surface);
  for (const k of ["slope", "curvature", "ao", "flow"]) {
    ok(a[k].every((v, i) => v === b[k][i]), `${k} differed between two identical bakes`);
  }
});

test("every channel is a byte, and the grid is square", () => {
  const { slope, curvature, ao, flow, deposit, wetness } = bake((x, z) => Math.sin(x * 0.05) * 20 + z * 0.1);
  for (const [name, g] of [["slope", slope], ["curvature", curvature], ["ao", ao], ["flow", flow],
                           ["deposit", deposit], ["wetness", wetness]]) {
    eq(g.length, RES * RES, `${name} is not res²`);
    ok(g instanceof Uint8Array, `${name} is not a Uint8Array`);
  }
  close(slope.length / RES, RES, 1e-9);
});

/* ── the two masks that come out of the erosion ──
   These are the ones a shader weights its materials by, and they are the ones
   with no visual tell when they go wrong: a deposition mask with its sign
   flipped puts bedrock in the channels and silt on the ridges, which reads as
   a strange but plausible world rather than as a bug. */

test("a world that never eroded gets the neutral pair, not zero", () => {
  /* This is the whole compatibility claim. The shader's defaults for these
     two channels are (0.5, 0) — no sediment, no marsh — and a world with
     erosion switched off has to land exactly there, or turning erosion off
     would repaint the ground rather than leaving it alone.

     Deposition is asserted off the full bake; wetness is asserted through
     bakeErosionMasks with the drainage explicitly zero, because the flow
     channel is normalised to its OWN maximum — so on a perfectly level test
     plain every cell collects exactly 1 and every cell therefore reads 255,
     which says nothing about wetness and everything about a mask that only
     means something when there is a channel to compare against. */
  const { deposit } = bake(() => 12);            // flat, no delta
  ok(deposit.every((v) => v === DEPOSITION_NEUTRAL), "un-eroded ground is not neutral deposition");

  const { wetness } = bakeErosionMasks({
    slope: Uint8Array.from([0]), curvature: Uint8Array.from([CURVATURE_NEUTRAL]),
    flow: Uint8Array.from([0]), res: 1,
  });
  eq(wetness[0], 0, "ground with no drainage and no sediment reports standing water");
});

test("deposition is signed about the neutral, and clips at the stated range", () => {
  const n = RES * RES;
  const delta = new Float32Array(n);
  delta[10] = DEPOSITION_RANGE / 2;      // half a range of sediment laid down
  delta[11] = -DEPOSITION_RANGE / 2;     // and the same stripped away
  delta[12] = DEPOSITION_RANGE * 4;      // far past full scale
  delta[13] = -DEPOSITION_RANGE * 4;
  const { deposit } = bake(() => 12, delta);
  ok(deposit[10] > DEPOSITION_NEUTRAL, `burial read ${deposit[10]}, expected above neutral`);
  ok(deposit[11] < DEPOSITION_NEUTRAL, `scour read ${deposit[11]}, expected below neutral`);
  /* Symmetric about the neutral to within one code, and one code is the floor
     rather than slack: 255 codes cannot be centred exactly on 128, so the
     midpoint quantises at 127.5 and the two sides differ by half a code. An
     asymmetry LARGER than that would bias every world toward burial or
     scour, which is exactly what a sign convention exists to prevent — and
     the shader's own dead zone (smoothstep from 0.08) swallows the half
     code entirely. */
  close(deposit[10] - DEPOSITION_NEUTRAL, DEPOSITION_NEUTRAL - deposit[11], 1);
  eq(deposit[12], 255, "deposition past full scale should clip, not wrap");
  eq(deposit[13], 0, "scour past full scale should clip, not wrap");
});

test("wetness holds where water lingers, not merely where it runs", () => {
  /* The claim the shader rests on: a steep channel and a flat channel carry
     the same drainage and are not the same ground. Both cells are given the
     SAME flow and curvature, so flatness is the only thing separating them. */
  const n = 4;
  const slope = Uint8Array.from([0, 255, 0, 255]);         // flat, 45°, flat, 45°
  const curvature = Uint8Array.from([CURVATURE_NEUTRAL, CURVATURE_NEUTRAL, 255, 255]);
  const flow = Uint8Array.from([255, 255, 255, 255]);
  const { wetness } = bakeErosionMasks({ slope, curvature, flow, res: 2 });
  ok(wetness[0] > 0, "a flat drainage line should hold water");
  eq(wetness[1], 0, "a 45° drainage line should shed it entirely");
  ok(wetness[2] > wetness[0], "a hollow should hold more than level ground at the same drainage");
});

test("laid sediment holds water after the channel has moved off it", () => {
  const slope = Uint8Array.from([0, 0]);
  const curvature = Uint8Array.from([CURVATURE_NEUTRAL, CURVATURE_NEUTRAL]);
  const flow = Uint8Array.from([40, 40]);                  // the same faint drainage
  const dry = bakeErosionMasks({ slope, curvature, flow, res: 1, deposition: null });
  const silted = bakeErosionMasks({
    slope, curvature, flow, res: 1,
    deposition: Float32Array.from([DEPOSITION_RANGE]),
  });
  ok(silted.wetness[0] > dry.wetness[0],
    `sediment (${silted.wetness[0]}) should hold more than bare ground (${dry.wetness[0]})`);
});

test("a deposition array that does not match the grid is dropped, not misread", () => {
  // The erosion grid and the mask grid are the same 513² today. If they ever
  // are not, half a mask read against the wrong cells is far worse than none.
  const { deposit } = bake(() => 12, new Float32Array(7));
  ok(deposit.every((v) => v === DEPOSITION_NEUTRAL), "a mismatched delta was read anyway");
});

test("the erosion packing puts each mask in the channel the shader reads", () => {
  const rg = packErosionMasks({
    deposit: Uint8Array.from([1, 2, 3]),
    wetness: Uint8Array.from([11, 12, 13]),
  });
  eq(rg.length, 6, "packed buffer is the wrong length");
  for (let i = 0; i < 3; i++) {
    eq(rg[i * 2 + 0], 1 + i, `R (deposition) wrong at ${i}`);
    eq(rg[i * 2 + 1], 11 + i, `G (wetness) wrong at ${i}`);
  }
});

report("masks");
