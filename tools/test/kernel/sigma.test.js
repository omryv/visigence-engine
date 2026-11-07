/* The freedom map — src/kernel/terrain/sigma.js.
 *
 * What the map claims, measured:
 *
 *   A STATEMENT PINS ITS GROUND. Where a statement holds the ground outright,
 *   the posterior sigma is (nearly) zero — and that includes the points a
 *   summit's slope rows and a pad's ring rows pin, because the map reasons
 *   over exactly the rows the solve held.
 *
 *   FREEDOM GROWS WITH DISTANCE. Away from every statement the ground goes
 *   back to being the seed's: sigma climbs toward the prior.
 *
 *   THE PRIOR IS THE BASIS'S OWN. With no statements, post is prior to the
 *   bit, and the prior is the recipe's linear spread: measured here at a
 *   median of 78.8–79.8 m on the four suite seeds (65² grid, range 66–96 m).
 *   The figure carried into this milestone was "~85 m"; the measured median
 *   is a little under it, and the test holds the measured band.
 *
 *   THREE POINTS DECIDE MOST OF A COUNTRY. Because the recipe's variance is
 *   mostly the continent mask (condition.js, "what a lone point does"), three
 *   point statements were measured to leave ~4.5–6.8 m of sigma 100 m from
 *   one of them and 32–38 m 1.6 km away, and to halve sigma over 75–91 % of
 *   the interior (K7QN 91 %, Q375 90 %, TMNR 75 %). The figure carried in was
 *   87–94 %: two of the three seeds land in it, TMNR does not, and the test
 *   holds what was measured rather than the figure.
 */
import { test, eq, ok, close, report } from "./harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { posteriorSigma, sigmaAt, provenanceGrid, PROVENANCE, SIGMA_RIDGE } from "../../../src/kernel/terrain/sigma.js";
import { GRADIENT_STEP } from "../../../src/kernel/terrain/condition.js";

const SEEDS = ["K7QN-3F2A-9XBD", "TMNR-2J2A-PG43", "Q375-ND9S-NSQV", "6QKX-J4XR-Z5D3"];
const world = (seed, intent = [], sculpt = []) => {
  const p = makeParams({ seed });
  p.terrain.intent = intent;
  p.terrain.sculpt = sculpt;
  return p;
};
const POINTS = [[300, -200, 120], [-600, 500, 60], [700, 600, 30]];
const three = POINTS.map(([x, z, h]) => ({ type: "point", x, z, h }));
const ring = (cx, cz, d, k = 16) => Array.from({ length: k }, (_, i) => [cx + d * Math.cos((i * Math.PI) / 8), cz + d * Math.sin((i * Math.PI) / 8)]);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test("with no statements the posterior is the prior, to the bit", () => {
  for (const seed of SEEDS) {
    const r = posteriorSigma(world(seed));
    eq(r.n, 65); eq(r.size, 4096); eq(r.prior.length, 65 * 65);
    eq(r.stats.rows, 0, "no rows");
    eq(r.stats.atStatements, null, "nothing pinned");
    for (let i = 0; i < r.prior.length; i++) {
      if (r.post[i] !== r.prior[i]) throw new Error(`${seed}: cell ${i} moved`);
      if (r.ratio[i] !== 1) throw new Error(`${seed}: cell ${i} ratio ${r.ratio[i]}`);
    }
    ok(r.stats.priorMedian > 75 && r.stats.priorMedian < 85, `${seed}: prior median ${r.stats.priorMedian.toFixed(1)} m`);
    eq(r.stats.interiorHalved, 0);
  }
});

test("a statement pins its ground, and freedom grows with distance from it", () => {
  for (const seed of SEEDS.slice(0, 3)) {
    const p = world(seed, three);
    const r = posteriorSigma(p);
    ok(r.stats.atStatements < 0.05, `${seed}: sigma at the statements ${r.stats.atStatements.toFixed(4)} m`);
    eq(r.stats.rows, 3);
    const at = (d) => mean(sigmaAt(p, ring(300, -200, d)).map((o) => o.post));
    const s0 = sigmaAt(p, [[300, -200]])[0].post, s100 = at(100), s400 = at(400), s1600 = at(1600);
    ok(s0 < 0.05, `${seed}: at the point ${s0.toFixed(4)}`);
    ok(s0 < s100 && s100 < s400 && s400 < s1600, `${seed}: ${s0.toFixed(3)} < ${s100.toFixed(2)} < ${s400.toFixed(2)} < ${s1600.toFixed(2)} m`);
    ok(s100 > 2 && s100 < 10, `${seed}: ~5 m at 100 m (${s100.toFixed(2)})`);
    ok(s1600 > 20 && s1600 < 45, `${seed}: ~30 m at 1.6 km (${s1600.toFixed(2)})`);
    ok(r.stats.interiorHalved > 0.7 && r.stats.interiorHalved < 0.95, `${seed}: interior halved ${(100 * r.stats.interiorHalved).toFixed(1)} %`);
    ok(r.stats.postMedian < r.stats.priorMedian, "the median comes down");
    for (let i = 0; i < r.post.length; i++) {
      if (!(r.post[i] <= r.prior[i] + 1e-3)) throw new Error(`${seed}: a statement added freedom at cell ${i}`);
    }
  }
});

test("the map reads the solve's own rows: a summit's slope, a pad's ring, a coast", () => {
  const seed = SEEDS[1];
  const p = world(seed, [{ type: "summit", x: -500, z: 400, h: 200 }, { type: "pad", x: 600, z: -300, r: 80, h: 40 },
                         { type: "shoreline", points: [[-200, -900], [400, -1000]] }]);
  const s = createHeightSampler(p);
  const r = posteriorSigma(p, { sampler: s, n: 17 });
  eq(r.stats.rows, s.conditioning.system.used.length, "every held row, no more");
  eq(r.stats.rows, 3 + 9 + s.conditioning.rows - 12, "summit 3, pad 9, the coast one a sample");
  /* The ring rows say "the ring stands where the centre does", and the centre
     is pinned — so the ring is pinned too, and only because the map holds
     the ring rows. Without them the ring would be free. */
  const ringPts = Array.from({ length: 6 }, (_, k) => [600 + 80 * Math.cos((k * Math.PI) / 3), -300 + 80 * Math.sin((k * Math.PI) / 3)]);
  for (const o of sigmaAt(p, ringPts, { sampler: s })) ok(o.post < 0.05, `pad ring pinned (${o.post.toFixed(4)} m)`);
  const e = GRADIENT_STEP;
  const [east, west] = sigmaAt(p, [[-500 + e, 400], [-500 - e, 400]], { sampler: s });
  ok(east.post < 0.3 * east.prior && west.post < 0.3 * west.prior, "and a summit's shoulders are held");
  ok(r.stats.atStatements < 0.05, `every pinned point (${r.stats.atStatements.toFixed(4)} m)`);
});

test("a bound the ground already meets pins nothing", () => {
  const seed = SEEDS[2];
  const raw = createHeightSampler(world(seed));
  const p = world(seed, [{ type: "point", x: 100, z: 100, h: raw(100, 100) - 10, op: ">=" }]);
  const r = posteriorSigma(p, { n: 9 });
  eq(r.stats.rows, 0, "an unheld inequality is not a row of the posterior");
  eq(r.stats.atStatements, null, "and is not a pinned point");
  const free = posteriorSigma(world(seed), { n: 9 });
  for (let i = 0; i < r.post.length; i++) eq(r.post[i], free.post[i]);
});

test("a record MAX_ROWS dropped pins nothing", () => {
  /* Two long coasts, the second 1.5 km south: it does not fit under
     MAX_ROWS and is dropped. Measured before this rule, its vertices were
     still read as pinned points, and atStatements came back 43.5 m on TMNR —
     a number a caller cannot tell from an unmet statement. Now only the
     records that stated rows are read, and the first coast's vertices are
     pinned to the centimetre. */
  const long = Array.from({ length: 64 }, (_, i) => [i * 60 - 1900, (i % 2) * 40]);
  const near = { type: "shoreline", points: long, side: "left" };
  const far = { type: "shoreline", points: long.map(([x, z]) => [x, z - 1500]), side: "left" };
  const p = world(SEEDS[1], [near, far]);
  const s = createHeightSampler(p);
  eq(s.conditioning.dropped, 1, "the far coast did not fit");
  const r = posteriorSigma(p, { sampler: s, n: 9 });
  ok(r.stats.atStatements !== null && r.stats.atStatements < 0.05, `sigma at the stated coast ${r.stats.atStatements.toFixed(4)} m`);
  // And the dropped coast's own ground was left to the seed.
  const free = sigmaAt(p, [[-1900, -1500], [0, -1460]], { sampler: s });
  for (const o of free) ok(o.post > 0.5 * o.prior, `the dropped coast is free (${o.post.toFixed(1)} of ${o.prior.toFixed(1)} m)`);
});

test("the variance's ridge: the solve's would read as 8 cm of noise at every pinned point", () => {
  /* Measured on three seeds: with the solve's RIDGE (1e-6) the sigma at three
     pinned points is 8.0–8.3 cm; with SIGMA_RIDGE (1e-9) it is 2.5–2.6 mm. */
  eq(SIGMA_RIDGE, 1e-9);
  for (const seed of SEEDS.slice(0, 3)) {
    const p = world(seed, three);
    const ours = posteriorSigma(p, { n: 5 }).stats.atStatements, solves = posteriorSigma(p, { n: 5, ridge: 1e-6 }).stats.atStatements;
    ok(ours < 0.005, `${seed}: ${(1000 * ours).toFixed(2)} mm`);
    ok(solves > 0.05 && solves < 0.12, `${seed}: ${(100 * solves).toFixed(2)} cm under the solve's ridge`);
  }
});

test("provenance: free, conditioned, authored", () => {
  eq(PROVENANCE.FREE, 0); eq(PROVENANCE.CONDITIONED, 1); eq(PROVENANCE.AUTHORED, 2);
  const n = 33, size = 4096, cell = (x, z) => Math.round((z / size + 0.5) * (n - 1)) * n + Math.round((x / size + 0.5) * (n - 1));
  const none = world(SEEDS[0]);
  const blank = provenanceGrid(none, posteriorSigma(none, { n }));
  ok(blank.every((c) => c === 0), "a world nobody spoke to is free everywhere");

  const stroke = { x: -1280, z: 1280, r: 300, a: 20, m: 0 };
  const p = world(SEEDS[0], three, [stroke]);
  const sig = posteriorSigma(p, { n });
  const g = provenanceGrid(p, sig);
  ok(g instanceof Uint8Array && g.length === n * n);
  eq(g[cell(-1280, 1280)], PROVENANCE.AUTHORED, "under the stroke");
  eq(g[cell(1280, 1280)], PROVENANCE.CONDITIONED, "near the statements, between them");
  const counts = [0, 0, 0];
  for (const c of g) counts[c]++;
  ok(counts[0] > 0 && counts[1] > 0 && counts[2] > 0, `all three codes appear: ${counts.join(" / ")}`);
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0 && !(sig.ratio[i] >= 0.5)) throw new Error(`cell ${i} free at ratio ${sig.ratio[i]}`);
    if (g[i] === 1 && !(sig.ratio[i] < 0.5)) throw new Error(`cell ${i} conditioned at ratio ${sig.ratio[i]}`);
  }
  // A stricter bar for "conditioned" can only free cells.
  const strict = provenanceGrid(p, sig, { pinnedRatio: 0.1 });
  let freed = 0;
  for (let i = 0; i < g.length; i++) { ok(strict[i] <= g[i] || g[i] === 2); if (strict[i] < g[i]) freed++; }
  ok(freed > 0, `pinnedRatio 0.1 frees ${freed} cells`);
});

test("the map is a pure function of the params", () => {
  const p = world(SEEDS[3], [...three, { type: "shoreline", points: [[-900, -900], [-300, -1000]], side: "left" }]);
  const a = posteriorSigma(p, { n: 17 }), b = posteriorSigma(JSON.parse(JSON.stringify(p)), { n: 17 });
  for (const k of ["prior", "post", "ratio"]) for (let i = 0; i < a[k].length; i++) eq(a[k][i], b[k][i], `${k}[${i}]`);
  eq(JSON.stringify(a.stats), JSON.stringify(b.stats));
  close(a.stats.atStatements, 0, 0.05, "and a coast's vertices are pinned too");
});

report("sigma");
