/* Worlds from evidence — src/kernel/core/evidence.js, measured against a world
 * whose ground is known exactly because the engine grew it.
 *
 * Every test below has the same shape. World A (seed S1) is the truth: its
 * spot heights, its skyline, a coast drawn on it. The evidence is read off A
 * the way a surveyor, a camera or a chart would read it, turned into intent
 * records by evidence.js, and handed to a DIFFERENT seed, S2. The question is
 * whether S2, conditioned, says what the evidence says — read back off S2's
 * own analytic sampler, never off the solver's bookkeeping — and what that
 * cost in nats.
 *
 * The numbers the module's comments quote are printed here as the tests run
 * (`print`), so a change that moves them shows in the log, and the bounds
 * asserted are the promises: points to 5 cm, rows to a millimetre, and the
 * ground between a ray's samples within the tolerance documented below.
 */
import { test, eq, ok, close, report } from "./harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { mulberry32 } from "../../../src/kernel/seed.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { posteriorSigma, sigmaAt } from "../../../src/kernel/terrain/sigma.js";
import { intentErrors, polylineSamples, MAX_INTENT, MAX_ROWS, MAX_POLYLINE, SHORE_STEP, SHORE_SAMPLES } from "../../../src/kernel/terrain/condition.js";
import {
  fromSpotHeights, fromCoastline, fromSkyline, skylineFromPixels, refineRays, bandResidual, registrationGate,
  SKYLINE_SAMPLES, REFINE_TOLERANCE, REFINE_STEP, GATE_RATIO,
} from "../../../src/kernel/core/evidence.js";
import { CORE_MODULES } from "../../../src/kernel/core/index.js";

const S1 = "K7QN-3F2A-9XBD", S2 = "TMNR-2J2A-PG43";
const SIZE = 4096;
const clock = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();
const world = (seed, intent) => {
  const p = makeParams({ seed });
  if (intent) p.terrain.intent = intent;
  return p;
};
const A = createHeightSampler(world(S1));
const S2_RAW = createHeightSampler(world(S2));
const timed = (f) => { const t0 = clock(); const v = f(); return [v, clock() - t0]; };

test("the module is in the core, and the core says so", () => {
  ok(CORE_MODULES.includes("src/kernel/core/evidence.js"), "listed in CORE_MODULES");
});

/* ══ spot heights ═══════════════════════════════════════════════════════ */

// 24 surveyed heights off A, over the middle 3 km, from a seeded stream.
const rng = mulberry32(0x5eed);
const survey = [], heldOut = [];
for (let i = 0; i < 48; i++) {
  const x = (rng() - 0.5) * 3000, z = (rng() - 0.5) * 3000;
  (i < 24 ? survey : heldOut).push([x, z, A(x, z)]);
}

test("24 spot heights of world A, stated on seed S2, are met to 5 cm, and pin the ground there", () => {
  const ev = fromSpotHeights(survey, { size: SIZE });
  eq(ev.records.length, 24); eq(ev.dropped, 0); eq(ev.invalid, 0);
  eq(intentErrors(ev.records, { size: SIZE }).length, 0, "the records are a valid intent list");
  const p = world(S2, ev.records);
  const [s, ms] = timed(() => createHeightSampler(p));
  let worst = 0, before = 0;
  for (const [x, z, h] of survey) {
    worst = Math.max(worst, Math.abs(s(x, z) - h));
    before = Math.max(before, Math.abs(S2_RAW(x, z) - h));
  }
  ok(worst <= 0.05, `every point within 5 cm: worst ${worst.toFixed(4)} m`);
  ok(before > 100, `and S2 did not already say it: ${before.toFixed(1)} m off before`);
  const c = s.conditioning;
  ok(c.converged && c.dropped === 0, "converged, nothing dropped");
  const sg = sigmaAt(p, survey.map(([x, z]) => [x, z]), { sampler: s });
  const post = Math.max(...sg.map((v) => v.post)), prior = Math.min(...sg.map((v) => v.prior));
  ok(post < 0.05, `posterior sigma at every point under 5 cm: worst ${post.toFixed(4)} m`);
  ok(post < prior / 100, `against a prior of at least ${prior.toFixed(1)} m`);
  const map = posteriorSigma(p, { sampler: s }).stats;
  ok(map.atStatements < 0.05, `the freedom map agrees: largest post sigma at a pinned point ${map.atStatements.toFixed(4)} m`);
  ok(map.postMedian < map.priorMedian, `and 24 points lower the median sigma of the map (${map.priorMedian.toFixed(1)} → ${map.postMedian.toFixed(1)} m)`);
  print(`    spot heights: 24 points, worst ${worst.toFixed(4)} m (S2 raw ${before.toFixed(1)} m), nats ${c.nats.toFixed(2)}, miss ${c.miss.toFixed(4)} m, post sigma ≤ ${post.toFixed(4)} m (prior ≥ ${prior.toFixed(1)} m; map median ${map.priorMedian.toFixed(1)} → ${map.postMedian.toFixed(1)} m), solve ${ms.toFixed(0)} ms`);
});

test("a survey over the record budget is thinned by farthest-point selection, deterministically", () => {
  const r = mulberry32(7), many = [];
  for (let i = 0; i < 300; i++) { const x = (r() - 0.5) * 3800, z = (r() - 0.5) * 3800; many.push([x, z, A(x, z)]); }
  many.push([5000, 0, 10], [0, NaN, 3], "junk", [1, 2]);
  const ev = fromSpotHeights(many, { size: SIZE });
  eq(ev.records.length, MAX_INTENT, "the cap is MAX_INTENT");
  eq(ev.dropped, 300 - MAX_INTENT, "and the rest are counted as dropped");
  eq(ev.invalid, 4, "off the plate, non-finite, not a triple: counted as invalid");
  eq(JSON.stringify(fromSpotHeights(many, { size: SIZE })), JSON.stringify(ev), "the same input, the same selection");
  ev.kept.forEach((k, i) => eq(ev.records[i].x, many[k][0]));
  // Covering radius: the farthest any surveyed point is from a kept one.
  const cover = (idx) => Math.max(...many.slice(0, 300).map(([x, z]) => Math.min(...idx.map((k) => Math.hypot(many[k][0] - x, many[k][1] - z)))));
  const thinned = cover(ev.kept), prefix = cover([...Array(MAX_INTENT).keys()]);
  ok(thinned < prefix, `farthest-point leaves less uncovered than the first 48: ${thinned.toFixed(0)} m vs ${prefix.toFixed(0)} m`);
  eq(fromSpotHeights(many, { size: SIZE, maxRecords: 10 }).records.length, 10, "maxRecords is honoured");
  eq(ev.reason, null);
  ok(fromSpotHeights(many, { op: ">=" }).records.every((r) => r.op === ">="), "a known op is carried");
  const bad = fromSpotHeights(many, { op: "<" });
  ok(bad.records.length === 0 && /op/.test(bad.reason), `an unknown op is refused, not read as "=": ${bad.reason}`);
  eq(JSON.stringify(fromSpotHeights(many, { size: SIZE, maxRecords: 10 }).kept), JSON.stringify(ev.kept.slice(0, 10)),
    "and a smaller budget is a prefix of the larger one's selection");
  print(`    thinning: 300 → 48, covering radius ${thinned.toFixed(0)} m (first-48 prefix: ${prefix.toFixed(0)} m)`);
});

/* ══ the band and the gate ══════════════════════════════════════════════ */

test("bandResidual: zero inside the band, the signed excess outside it, null unmeasured", () => {
  eq(bandResidual(10, 10.4, 0.5), 0);
  close(bandResidual(10, 11, 0.5), 0.5, 1e-12);
  close(bandResidual(10, 8, 0.5), -1.5, 1e-12);
  eq(bandResidual(10, 12, 0), 2, "a zero band is the raw residual");
  eq(bandResidual(NaN, 1, 0.5), null);
  eq(bandResidual(1, undefined, 0.5), null);
  let threw = false;
  try { bandResidual(1, 2, -0.1); } catch (e) { threw = e instanceof RangeError; }
  ok(threw, "a negative band is a RangeError");
  for (let d = -3; d <= 3; d += 0.25) {
    const e = bandResidual(0, d, 1);
    ok(Math.abs(e) <= Math.abs(d) && (e === 0 || Math.sign(e) === Math.sign(d)), `|e| ≤ |d| and sign kept at d = ${d}`);
  }
});

test("the gate trusts a fine band against held-out spot heights, refuses a coarse one, and fails closed", () => {
  const s = createHeightSampler(world(S2, fromSpotHeights(survey, { size: SIZE }).records));
  const errors = heldOut.map(([x, z, h]) => s(x, z) - h);
  const fine = registrationGate({ errors, bands: 0.5 });
  ok(fine.pass, `a 0.5 m survey band passes against a median held-out error of ${fine.medianError.toFixed(1)} m (ratio ${fine.ratio.toFixed(4)})`);
  eq(fine.measured, 24); eq(fine.gateRatio, GATE_RATIO);
  const coarse = registrationGate({ errors, bands: errors.map(() => fine.medianError) });
  ok(!coarse.pass && coarse.ratio > GATE_RATIO, "a band as wide as the error it measures is refused");
  ok(!registrationGate({ errors: [], bands: [] }).pass, "nothing measured: no pass");
  ok(!registrationGate({ errors: [NaN, null], bands: 1 }).pass, "only unmeasured entries: no pass");
  ok(!registrationGate({ errors: [1, 2], bands: [1] }).pass, "mismatched lengths: no pass");
  ok(!registrationGate({ errors: [0, 0, 0], bands: 0 }).pass, "a zero median error leaves nothing to be small against");
  ok(!registrationGate({}).pass, "no input: no pass");
  // Exactly at the ratio passes (≤); a hair over does not.
  const at = registrationGate({ errors: [3, 3, 3], bands: 1 });
  ok(at.pass && at.ratio === GATE_RATIO, `median band exactly a third of the median error passes: ratio ${at.ratio}`);
  ok(!registrationGate({ errors: [3, 3, 3], bands: 1 + 1e-9 }).pass, "and a hair over a third is refused");
  for (const bands of [-0.1, [0.5, -1], [0.5, Infinity]]) {
    let threw = false;
    try { registrationGate({ errors: [1, 2], bands }); } catch (e) { threw = e instanceof RangeError; }
    ok(threw, `a broken band (${JSON.stringify(bands)}) is a RangeError, as in bandResidual`);
  }
  eq(registrationGate({ errors: [3, 3, 3], bands: [1, null, NaN] }).measured, 1, "an absent band marks its pair unmeasured");
  // The held-out points were not stated: conditioning on 24 tells you about them, not everything.
  const raw = heldOut.map(([x, z, h]) => Math.abs(S2_RAW(x, z) - h)).sort((a, b) => a - b)[12];
  print(`    held-out: median |error| ${fine.medianError.toFixed(1)} m after conditioning (S2 raw ${raw.toFixed(1)} m), band 0.5 m → ratio ${fine.ratio.toFixed(4)}`);
});

/* ══ a skyline ══════════════════════════════════════════════════════════ */

/* A camera on A: 25 m above A's ground at (−1200, −1200), looking west
   (yaw π/2), level, 96 × 64 pixels with a 60° horizontal field of view. The
   view was chosen by searching nine eyes and four headings over A for the
   one where S2's ground pierces the most of the sixteen rays before
   conditioning (14 of them). A's ground falls away from this eye, so the
   skyline is a silhouette a little under the horizon in most columns. */
const W = 96, H = 64, F = 83.1, REACH = 1500, STEP = 2;
const EYE = [-1200, A(-1200, -1200) + 25, -1200], YAW = Math.PI / 2;

/* The direction through image point (u, v), pitch 0: unit horizontal
   (hx, hz) and rise per metre — the same frame fromSkyline documents. */
function rayThrough(u, v) {
  const r = [Math.cos(YAW), -Math.sin(YAW)], f = [-Math.sin(YAW), -Math.cos(YAW)];
  const a = u - W / 2, b = H / 2 - v;
  const dx = a * r[0] + F * f[0], dz = a * r[1] + F * f[1], hl = Math.hypot(dx, dz);
  return [dx / hl, dz / hl, b / hl];
}
// Does the ray through (u, v) meet A's ground or its sea before it leaves the plate?
function pierced(u, v) {
  const [hx, hz, sl] = rayThrough(u, v);
  for (let t = STEP; ; t += STEP) {
    const x = EYE[0] + hx * t, z = EYE[2] + hz * t;
    if (Math.abs(x) > SIZE / 2 || Math.abs(z) > SIZE / 2) return false;
    if (Math.max(A(x, z), 0) > EYE[1] + sl * t) return true;
  }
}
/* Render A. For a level camera, lower in a column is lower at every
   distance, so the first ground row is a binary search; every pixel above it
   is sky and every pixel from it down is ground, each pixel judged by the ray
   through its centre. Sky brightens toward the horizon; ground is shaded by
   row; both carry ±6 levels of seeded noise. */
const truthRows = new Float32Array(W);
for (let c = 0; c < W; c++) {
  let lo = 0, hi = H;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pierced(c + 0.5, m + 0.5)) hi = m; else lo = m + 1; }
  truthRows[c] = lo;
}
const image = new Uint8ClampedArray(W * H * 4);
{
  const n = mulberry32(99);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 4, k = y / H, jit = () => (n() - 0.5) * 12;
    const rgb = y < truthRows[x] ? [70 + 80 * k, 130 + 55 * k, 210 + 20 * k] : [70 + 30 * k, 95 + 20 * k, 45 + 10 * k];
    image[j] = rgb[0] + jit(); image[j + 1] = rgb[1] + jit(); image[j + 2] = rgb[2] + jit(); image[j + 3] = 255;
  }
}

test("skylineFromPixels reads the synthetic photograph's skyline back exactly", () => {
  const prof = skylineFromPixels(image, W, H);
  eq(prof.length, W);
  let off = 0;
  for (let c = 0; c < W; c++) if (prof[c] !== truthRows[c]) off++;
  eq(off, 0, "every column's first ground row");
  ok([...truthRows].every((r) => r > 4 && r < H), "and ground meets the sky inside the frame in every column");
  // A column that starts in ground says nothing; one that is sky to the bottom says so.
  const edited = image.slice();
  for (let y = 0; y < H; y++) { const j = (y * W + 3) * 4; edited[j] = 60; edited[j + 1] = 90; edited[j + 2] = 40; }
  for (let y = 0; y < H; y++) { const j = (y * W + 7) * 4, k = y / H; edited[j] = 70 + 80 * k; edited[j + 1] = 130 + 55 * k; edited[j + 2] = 210 + 20 * k; }
  const e = skylineFromPixels(edited, W, H);
  ok(Number.isNaN(e[3]), "ground at the top of the frame: NaN");
  eq(e[7], H, "sky all the way down: the image height");
  ok([...skylineFromPixels(new Uint8Array(8), W, H)].every(Number.isNaN), "too few bytes: NaN everywhere");
});

/* A blurred or anti-aliased skyline: sky (150, 180, 230) to ground
   (60, 80, 40) over a ramp of `w` rows centred on the middle of a column of
   `h` rows, each pixel the mix at its centre. Where is the skyline? Inside
   the ramp; the half-way row is where an edge-finder would put it. A
   boundary found LOWER than that states a ray through ground; the rule must
   find it in the ramp's first half — at any resolution, which is what a
   running colour with a fixed rate per row failed (the same edge at 1 024
   rows over 24 rows of blur came back as sky to the bottom). */
test("skylineFromPixels finds soft edges in their first half, at any resolution", () => {
  const SKY = [150, 180, 230], GROUND = [60, 80, 40];
  const lines = [];
  for (const [h, widths] of [[64, [1, 4, 8]], [256, [8, 32]], [1024, [1, 16, 24, 64]], [4000, [1, 60, 200]]]) {
    for (const w of widths) {
      const start = Math.round(h / 2 - w / 2), img = new Uint8ClampedArray(h * 4);
      for (let y = 0; y < h; y++) {
        const t = Math.min(1, Math.max(0, (y + 0.5 - start) / w));
        for (let c = 0; c < 3; c++) img[y * 4 + c] = SKY[c] + (GROUND[c] - SKY[c]) * t;
        img[y * 4 + 3] = 255;
      }
      const p = skylineFromPixels(img, 1, h)[0];
      ok(p >= start && p <= start + w / 2, `${h} rows, a ${w}-row edge from row ${start}: found at ${p}`);
      lines.push(`${h}/${w}→${p - start}`);
    }
  }
  print(`    soft edges (rows/edge width → rows into the edge): ${lines.join(", ")}`);
});

test("fromSkyline refuses without a focal length rather than guessing one", () => {
  const prof = skylineFromPixels(image, W, H);
  for (const focalPx of [undefined, 0, -10, NaN]) {
    const r = fromSkyline({ eye: EYE, yaw: YAW, focalPx, width: W, height: H, profile: prof, maxDistance: REACH, size: SIZE });
    eq(r.records.length, 0); ok(/focal length/.test(r.reason), r.reason);
  }
});

/* How far above a ray a sampler's ground rises: at the rows the solver
   states (the eye's foot, the ray's even samples, the far end), and at every
   metre. `px` is the second as the angle it subtends at the eye — excess /
   distance × focal / cos(azimuth), the shift it makes in the image — taken
   from 50 m out, nearer than which a centimetre is a pixel. */
const FWD = [-Math.sin(YAW), -Math.cos(YAW)];
function excess(s, rec) {
  const [ex, ey, ez] = rec.eye, D = Math.hypot(rec.at[0] - ex, rec.at[1] - ez);
  const cos = ((rec.at[0] - ex) * FWD[0] + (rec.at[1] - ez) * FWD[1]) / D;
  const above = (t) => s(ex + (rec.at[0] - ex) * t, ez + (rec.at[1] - ez) * t) - (ey + (rec.h - ey) * t);
  let rows = -Infinity, dense = -Infinity, px = -Infinity;
  for (let k = 0; k <= rec.samples; k++) rows = Math.max(rows, above(k / rec.samples));
  for (let d = 0; d <= D; d += 1) {
    const e = above(d / D);
    dense = Math.max(dense, e);
    if (d >= 50) px = Math.max(px, (e / d) * (F / cos));
  }
  return { rows, dense, px };
}
const worstOf = (list, k) => Math.max(...list.map((e) => e[k]));

test("S2 conditioned on A's skyline keeps its ground under every sampled ray", () => {
  const profile = skylineFromPixels(image, W, H);
  const sky = fromSkyline({ eye: EYE, yaw: YAW, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE });
  eq(sky.records.length, 16); eq(sky.skipped.length, 0);
  eq(sky.rows, 16 * (SKYLINE_SAMPLES + 1)); ok(sky.rows <= MAX_ROWS);
  eq(intentErrors(sky.records, { size: SIZE }).length, 0, "a valid intent list, every far end on the plate");
  ok(sky.records.every((r) => r.contact === undefined), "an image alone states no contact");

  const truth = sky.records.map((r) => excess(A, r));
  ok(worstOf(truth, "dense") <= 0.05, `A itself, the truth, is under every ray: worst ${worstOf(truth, "dense").toFixed(3)} m`);
  const raw = sky.records.map((r) => excess(S2_RAW, r));
  const pierce = raw.filter((e) => e.dense > 0).length;
  ok(pierce >= 12, `S2 unconditioned pierces ${pierce} of 16 rays`);

  // The rays alone: met at their rows, free between them.
  const [plain, ms0] = timed(() => createHeightSampler(world(S2, sky.records)));
  ok(plain.conditioning.converged, "the sparse fan converges on its own");
  const gap = sky.records.map((r) => excess(plain, r));
  ok(worstOf(gap, "rows") <= 0.001, `at every stated sample the ground is under the ray: ${worstOf(gap, "rows").toFixed(5)} m`);

  // Refined: the same rays, held where the solved ground broke them.
  const [ref, ms] = timed(() => refineRays(world(S2, sky.records)));
  const c = ref.sampler.conditioning;
  ok(ref.converged && c.converged, "the refined solve converged");
  ok(ref.records.length <= MAX_INTENT, `${ref.records.length} records`);
  eq(intentErrors(ref.records, { size: SIZE }).length, 0, "the refined list is a valid intent list");
  ok(ref.records.slice(16).every((r) => r.type === "point" && r.op === "<="), "every cut is a point at most a height");
  ok(ref.worst <= REFINE_TOLERANCE, `refineRays reports ${ref.worst.toFixed(3)} m at its ${REFINE_STEP} m step`);
  const got = sky.records.map((r) => excess(ref.sampler, r));
  /* THE SAMPLING TOLERANCE, after refinement: the tolerance refineRays was
     given (0.5 m), checked at its 2 m step; read here at every metre. */
  ok(worstOf(got, "rows") <= 0.001, `rows still met: ${worstOf(got, "rows").toFixed(5)} m`);
  ok(worstOf(got, "dense") <= REFINE_TOLERANCE, `between samples within ${REFINE_TOLERANCE} m: worst ${worstOf(got, "dense").toFixed(3)} m`);
  ok(c.nats < 5, `and it cost ${c.nats.toFixed(2)} nats — well under the ~48 two worlds differ by`);

  /* Why the samples are few (SKYLINE_SAMPLES): the same fan stated densely,
     24 samples a ray. Printed, not asserted: how the v2 active set copes
     with a dense fan is the solver's property, and this file should not go
     red the day that improves. */
  const dense = fromSkyline({ eye: EYE, yaw: YAW, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE, samples: 24 });
  const [d, msd] = timed(() => createHeightSampler(world(S2, dense.records)).conditioning);

  print(`    skyline: 16 rays × ${SKYLINE_SAMPLES} samples, ${sky.rows} rows; S2 raw pierced ${pierce}/16 by up to ${worstOf(raw, "dense").toFixed(1)} m`);
  print(`      rays alone: between samples up to ${worstOf(gap, "dense").toFixed(2)} m (${worstOf(gap, "px").toFixed(2)} px), nats ${plain.conditioning.nats.toFixed(3)}, held ${plain.conditioning.active}, solve ${ms0.toFixed(0)} ms`);
  print(`      refined: ${ref.cuts} cuts in ${ref.rounds} solves, between samples ≤ ${worstOf(got, "dense").toFixed(3)} m (${worstOf(got, "px").toFixed(3)} px), nats ${c.nats.toFixed(3)}, miss ${c.miss.toFixed(5)} m, held ${c.active}, ${ms.toFixed(0)} ms`);
  print(`      dense fan (24 samples, ${dense.rows} rows): converged ${d.converged}, nats ${d.nats.toFixed(0)}, miss ${d.miss.toFixed(3)} m, ${msd.toFixed(0)} ms`);
});

test("with silhouette ranges, each ray ends ON the ground: contact", () => {
  const profile = skylineFromPixels(image, W, H);
  const base = fromSkyline({ eye: EYE, yaw: YAW, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE });
  // The silhouette distance on A: where A comes nearest the ray through the last sky pixel.
  const ranges = new Float32Array(W).fill(NaN);
  base.rays.forEach((ray, i) => {
    const rec = base.records[i], [ex, ey, ez] = rec.eye, [hx, hz] = [(rec.at[0] - ex) / ray.distance, (rec.at[1] - ez) / ray.distance];
    let best = -Infinity, at = 0;
    for (let d = 50; d <= ray.distance; d += 1) {
      const e = A(ex + hx * d, ez + hz * d) - (ey + ray.slope * d);
      if (e > best) { best = e; at = d; }
    }
    ranges[ray.column] = at;
  });
  const sky = fromSkyline({ eye: EYE, yaw: YAW, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE, ranges });
  ok(sky.records.every((r) => r.contact === true), "every record carries contact");
  eq(intentErrors(sky.records, { size: SIZE }).length, 0);
  const [s, ms] = timed(() => createHeightSampler(world(S2, sky.records)));
  const c = s.conditioning;
  ok(c.converged, "converged");
  let worst = 0;
  for (const r of sky.records) worst = Math.max(worst, Math.abs(s(r.at[0], r.at[1]) - r.h));
  /* Sixteen equalities on one wedge, each a silhouette the ground must
     touch while staying under its neighbours' rays: the solve meets them as
     nearly as its refinement allows, and says how nearly. Measured 0.23 m;
     the promise is that the reported miss is the truth about it. */
  ok(worst <= c.miss + 0.001, `the far ends stand on their rays within the reported miss: ${worst.toFixed(4)} m, miss ${c.miss.toFixed(4)} m`);
  ok(c.miss <= 0.5, "and the miss is under half a metre");
  print(`    skyline with ranges: contact at 16 far ends to ${worst.toFixed(4)} m, nats ${c.nats.toFixed(2)}, miss ${c.miss.toFixed(5)} m, held ${c.active}, solve ${ms.toFixed(0)} ms`);
});

/* A pitched camera. Every view above is level; this one tilts the same
   camera down 0.15 rad and then up 0.25 rad. With pitch a column of the
   image is no longer a vertical plane, so lower in a column is not simply
   lower at every distance and the binary search above does not apply: each
   sampled column is rendered by marching its rows from the top, the first
   pierced row being the boundary. The ray directions are built here from an
   independent frame (up = right × forward), so the test checks fromSkyline's
   frame, not a copy of it. */
const PITCHED = [-0.15, 0.25];
function pitchedView(pitch) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fwd = [-Math.sin(YAW) * Math.cos(pitch), Math.sin(pitch), -Math.cos(YAW) * Math.cos(pitch)];
  const right = [Math.cos(YAW), 0, -Math.sin(YAW)], up = cross(right, fwd);
  const dir = (u, v) => {
    const a = u - W / 2, b = H / 2 - v, d = [0, 1, 2].map((i) => a * right[i] + b * up[i] + F * fwd[i]), hl = Math.hypot(d[0], d[2]);
    return [d[0] / hl, d[2] / hl, d[1] / hl];
  };
  const hits = (u, v) => {
    const [hx, hz, sl] = dir(u, v);
    for (let t = STEP; t <= REACH; t += STEP) {
      const x = EYE[0] + hx * t, z = EYE[2] + hz * t;
      if (Math.abs(x) > SIZE / 2 || Math.abs(z) > SIZE / 2) return false;
      if (Math.max(A(x, z), 0) > EYE[1] + sl * t) return true;
    }
    return false;
  };
  const profile = new Float32Array(W).fill(NaN);
  for (let k = 0; k < 16; k++) {
    const c = Math.floor(((k + 0.5) * W) / 16);
    let r = 0;
    while (r < H && !hits(c + 0.5, r + 0.5)) r++;
    profile[c] = r;
  }
  return { dir, profile };
}

test("a pitched camera: the frame is right, and S2 conditioned on it stays under every ray", () => {
  for (const pitch of PITCHED) {
    const { dir, profile } = pitchedView(pitch);
    const sky = fromSkyline({ eye: EYE, yaw: YAW, pitch, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE });
    eq(sky.records.length, 16, `pitch ${pitch}: 16 rays`);
    ok(sky.rays.every((r) => r.row > 0 && r.row < H - 1), "the skyline is inside the frame");
    eq(intentErrors(sky.records, { size: SIZE }).length, 0);
    let frame = 0;
    sky.records.forEach((r, i) => {
      const ray = sky.rays[i], [hx, hz, sl] = dir(ray.column + 0.5, ray.row);
      frame = Math.max(frame, Math.abs((r.at[0] - EYE[0]) / ray.distance - hx), Math.abs((r.at[1] - EYE[2]) / ray.distance - hz), Math.abs(ray.slope - sl));
    });
    ok(frame < 1e-12, `pitch ${pitch}: every ray is the independent frame's ray through its pixel (${frame.toExponential(1)})`);
    const truth = worstOf(sky.records.map((r) => excess(A, r)), "dense");
    ok(truth <= 0.05, `A, the truth, is under every ray: ${truth.toFixed(3)} m`);
    const pierce = sky.records.filter((r) => excess(S2_RAW, r).dense > 0).length;
    ok(pierce >= 12, `S2 unconditioned pierces ${pierce} of 16`);
    const [ref, ms] = timed(() => refineRays(world(S2, sky.records)));
    ok(ref.converged && ref.dropped === 0, "refined, converged, nothing dropped");
    eq(intentErrors(ref.records, { size: SIZE }).length, 0);
    const got = sky.records.map((r) => excess(ref.sampler, r));
    ok(worstOf(got, "rows") <= 0.001 && worstOf(got, "dense") <= REFINE_TOLERANCE,
      `under every ray: rows ${worstOf(got, "rows").toFixed(5)} m, between samples ${worstOf(got, "dense").toFixed(3)} m`);
    print(`    pitch ${pitch}: skyline rows ${Math.min(...sky.rays.map((r) => r.row + 0.5))}–${Math.max(...sky.rays.map((r) => r.row + 0.5))}, S2 raw pierced ${pierce}/16; refined ${ref.cuts} cuts in ${ref.rounds} solves, ≤ ${worstOf(got, "dense").toFixed(4)} m above a ray, nats ${ref.sampler.conditioning.nats.toFixed(3)}, ${ms.toFixed(0)} ms`);
  }
});

/* refineRays and the row budget. Filler rays 3 km up (never near the
   ground, so never held) bring the list to 638 rows; the real fan took 11
   cuts above, and here there is room for 2 (measured: those two, the worst
   two, hold it to within the tolerance). Then one more filler puts
   the list over MAX_ROWS before any cut, and the solver drops a record. */
test("refineRays never cuts past MAX_ROWS, and reports what the solver dropped", () => {
  const profile = skylineFromPixels(image, W, H);
  const sky = fromSkyline({ eye: EYE, yaw: YAW, focalPx: F, width: W, height: H, profile, maxDistance: REACH, size: SIZE });
  const filler = (i, samples) => ({ type: "ray", eye: [-1800 + 400 * i, 3000, 1500], at: [-1800 + 400 * i, 1900], h: 3000, samples });
  const fill = [...Array(8).keys()].map((i) => filler(i, 64)).concat([filler(8, 37)]);
  const near = refineRays(world(S2, [...fill, ...sky.records]));
  eq(near.rows, MAX_ROWS, "the list ends at the cap exactly");
  eq(near.cuts, 2, "two cuts: the room there was");
  eq(intentErrors(near.records, { size: SIZE }).length, 0, "and it is still a valid intent list");
  eq(near.dropped, 0);
  ok(near.worst <= REFINE_TOLERANCE, `and the fan is still held: worst ${near.worst.toFixed(3)} m`);
  const over = refineRays(world(S2, [...fill, filler(9, 64), ...sky.records]));
  eq(over.cuts, 0, "a list already over the cap gets no cuts");
  eq(over.rounds, 1);
  ok(over.dropped > 0 && !over.converged, `the solver dropped ${over.dropped}, and that is not converged`);
  print(`    refine at the cap: ${near.cuts} cuts, ${near.rows} rows, worst ${near.worst.toFixed(2)} m; over the cap (${over.rows} rows): dropped ${over.dropped}, converged ${over.converged}`);
});

/* ══ a coastline ════════════════════════════════════════════════════════ */

/* A coast drawn the way a hand traces one: a vertex every 5 m of x along
   an S-curve 3.4 km wide, land to its left (north, walking east). */
const drawn = [];
for (let x = -1700; x <= 1700; x += 5) drawn.push([x, 450 * Math.sin(x / 450)]);

test("a traced coastline round-trips: drawn, stated, solved, and found again in the ground", () => {
  const coast = fromCoastline(drawn, { side: "left", level: 0, size: SIZE });
  eq(coast.reason, null); eq(coast.coarsened, false);
  ok(coast.records.length >= 2, `split into ${coast.records.length} records`);
  for (const r of coast.records) {
    ok(r.points.length <= MAX_POLYLINE, "each within MAX_POLYLINE vertices");
    ok(polylineSamples(r.points, SHORE_STEP).length <= SHORE_SAMPLES, "and sampled at SHORE_STEP, not coarser");
  }
  ok(coast.rows <= MAX_ROWS, `${coast.rows} rows`);
  close(coast.step, SHORE_STEP, SHORE_STEP / 2, "samples about SHORE_STEP apart");
  eq(intentErrors(coast.records, { size: SIZE }).length, 0);
  // Consecutive records meet at a shared vertex: one coast.
  for (let i = 1; i < coast.records.length; i++) {
    const a = coast.records[i - 1].points, b = coast.records[i].points;
    eq(JSON.stringify(a[a.length - 1]), JSON.stringify(b[0]), `record ${i} starts where ${i - 1} ends`);
  }

  const [s, ms] = timed(() => createHeightSampler(world(S2, coast.records)));
  const c = s.conditioning;
  ok(c.converged && c.dropped === 0, "converged, nothing dropped");
  ok(c.miss <= 0.02, `miss ${c.miss.toFixed(4)} m`);
  ok(coast.vertices.deviation <= 5, `decimation leaves every drawn vertex within ${coast.vertices.deviation.toFixed(2)} m of the stated line`);
  // Round trip: along each drawn vertex's normal, where does S2 cross the waterline?
  let far = 0, wrongSide = 0, vert = 0;
  for (const [x, z] of drawn) vert = Math.max(vert, Math.abs(s(x, z)));
  for (let i = 1; i < drawn.length - 1; i++) {
    const [x, z] = drawn[i];
    const dx = drawn[i + 1][0] - drawn[i - 1][0], dz = drawn[i + 1][1] - drawn[i - 1][1], l = Math.hypot(dx, dz);
    const nx = dz / l, nz = -dx / l; // left of the heading
    // Every sign change on a 0.5 m walk across ±40 m; the nearest one is the waterline here.
    let found = null;
    for (let d = -40; d < 40; d += 0.5) {
      const a = s(x + nx * d, z + nz * d), b = s(x + nx * (d + 0.5), z + nz * (d + 0.5));
      if ((a <= 0) !== (b <= 0)) { const at = Math.abs(d + 0.25); if (found === null || at < found) found = at; }
    }
    far = Math.max(far, found === null ? Infinity : found);
    if (!(s(x + nx * 40, z + nz * 40) > 0 && s(x - nx * 40, z - nz * 40) < 0)) wrongSide++;
  }
  /* Between the samples (~48 m apart) the ground is free, and on a gentle
     beach a little height is a long way: measured, S2 stands at most 1.13 m
     off the waterline at any drawn vertex, and with the shore's slope there
     that puts the waterline up to 6.75 m from the drawn one. */
  ok(vert <= 1.5, `every drawn vertex within 1.5 m of the waterline: worst ${vert.toFixed(2)} m`);
  ok(far <= 10, `the recovered waterline within 10 m of the drawn one everywhere: worst ${far.toFixed(2)} m`);
  eq(wrongSide, 0, "land on the left, sea on the right, 40 m out, at every drawn vertex");
  print(`    coastline: ${drawn.length} drawn vertices → ${coast.vertices.kept} kept in ${coast.records.length} records, ${coast.rows} rows, step ${coast.step.toFixed(1)} m, deviation ${coast.vertices.deviation.toFixed(2)} m; drawn vertices within ${vert.toFixed(2)} m of the waterline, recovered line within ${far.toFixed(2)} m; nats ${c.nats.toFixed(2)}, miss ${c.miss.toFixed(4)} m, held ${c.active}, solve ${ms.toFixed(0)} ms`);
});

test("a coast too long for the budget is stated whole and coarser, never halfway", () => {
  // A spiral of 2 000 vertices, ~30 km of line on a 4 km plate.
  const spiral = [];
  for (let i = 0; i < 2000; i++) { const a = i * 0.02, r = 200 + i * 0.85; spiral.push([r * Math.cos(a), r * Math.sin(a)]); }
  const coast = fromCoastline(spiral, { side: "right", level: 2, size: SIZE });
  eq(coast.reason, null);
  ok(coast.coarsened, "coarsened");
  ok(coast.rows <= MAX_ROWS && coast.records.length <= MAX_INTENT, `${coast.rows} rows in ${coast.records.length} records`);
  eq(intentErrors(coast.records, { size: SIZE }).length, 0);
  ok(coast.records.every((r) => r.level === 2 && r.side === "right"), "every piece carries the level and the side");
  ok(coast.vertices.deviation > 0 && Number.isFinite(coast.vertices.deviation), `and says what coarsening cost: ${coast.vertices.deviation.toFixed(0)} m`);
  // Near the row cap, and still a list the solver meets.
  const [sol, msc] = timed(() => createHeightSampler(world(S2, coast.records)).conditioning);
  ok(sol.converged && sol.dropped === 0 && sol.miss <= 0.05, `S2 meets it: converged, miss ${sol.miss.toFixed(3)} m`);
  const unsided = fromCoastline(spiral, { size: SIZE });
  ok(unsided.rows <= MAX_ROWS && unsided.coarsened, `unsided: ${unsided.rows} rows in ${unsided.records.length} records`);
  ok(unsided.vertices.deviation < coast.vertices.deviation, "with a row a sample instead of three, more of it fits, and it departs less");
  const none = fromCoastline(spiral, { side: "left", size: SIZE, maxRows: 100 });
  eq(none.records.length, 0, "a budget that cannot hold the line coarsely holds none of it");
  ok(/budget/.test(none.reason), none.reason);
  // Clipped at the plate: a line that leaves and comes back is two coasts.
  const across = fromCoastline([[-1000, 0], [3000, 0], [3000, 500], [-1000, 500]], { size: SIZE });
  eq(across.records.length, 2, "two runs");
  ok(across.records.every((r) => r.points.every(([x, z]) => Math.abs(x) <= SIZE / 2 && Math.abs(z) <= SIZE / 2)), "all on the plate");
  eq(fromCoastline([[0, 0]]).records.length, 0, "a point is not a coast");
  // A side's offset is checked as the record will be, not dropped or passed through.
  const near = fromCoastline(drawn, { side: "left", offset: 5, size: SIZE });
  ok(near.records.length === 0 && /12/.test(near.reason), `an offset under 12 m is refused: ${near.reason}`);
  ok(/side/.test(fromCoastline(drawn, { offset: 40, size: SIZE }).reason), "an offset without a side is refused");
  eq(fromCoastline(drawn, { side: "left", offset: 40, size: SIZE }).records[0].offset, 40, "a good offset is carried");
  print(`    long coast: 2000 vertices → ${coast.records.length} records, ${coast.rows} rows, step ${coast.step.toFixed(0)} m, deviation ${coast.vertices.deviation.toFixed(0)} m, on S2 ${sol.nats.toFixed(0)} nats, miss ${sol.miss.toFixed(3)} m, ${msc.toFixed(0)} ms; unsided ${unsided.records.length} records, ${unsided.rows} rows, deviation ${unsided.vertices.deviation.toFixed(0)} m`);
});

/* The clip's crossing points are x0 + dx·t, and rounding can land them a few
   ulps off the plate — which intentErrors, and so a saved world, refuses.
   Oblique lines through the edges and corners, at three plate sizes. */
test("a coast clipped at the plate's edge stays on the plate, at every crossing", () => {
  const r = mulberry32(0xc11b), bad = [];
  let lines = 0;
  for (const size of [4096, 3000, 1234.5]) {
    const h = size / 2;
    for (let i = 0; i < 2000; i++) {
      const a = [(r() - 0.5) * 3 * h, (r() - 0.5) * 3 * h], b = [(r() - 0.5) * 3 * h, (r() - 0.5) * 3 * h];
      const coast = fromCoastline([a, b], { size });
      if (!coast.records.length) continue;
      lines++;
      if (intentErrors(coast.records, { size }).length) bad.push([size, a, b]);
    }
  }
  eq(bad.length, 0, `every clipped line is on its plate (${lines} lines crossed one)`);
  ok(lines > 1000, "and most of them crossed an edge");
});

report("evidence");
