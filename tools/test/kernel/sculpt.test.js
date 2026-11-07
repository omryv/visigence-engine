// Hand-sculpting contracts: the stroke list is the source of truth (it is
// what params carries to VSight and the exporters), replay must be exact,
// and the world edge must fall away to open water.
//
// AND THE BRUSH DELIVERS WHAT IT SAYS. Everything below the "the brush is
// faithful" heading is here because it did not: the offset field was a 257²
// raster — 16 m a cell on a 4 km world — and the brush UI starts at 10 m, so
// the small end of its own range wrote a fraction of its stated depth, or at
// a cell centre nothing at all. None of the tests above that heading could see
// it, because every one of them uses a radius of 300 m or more, where the
// raster is accurate to under a percent. The radii here are the ones a person
// actually drags with.
import { test, eq, close, ok, report } from "./harness.js";
import { SculptLayer, strokeOffsetAt, SCULPT_LIVE_CAP } from "../../../src/kernel/terrain/sculpt.js";
import { createHeightSampler, EDGE_START } from "../../../src/kernel/terrain/heightfield.js";
import { DEFAULT_PARAMS, makeParams } from "../../../src/kernel/presets.js";

const SIZE = 4096;
const flat = () => 0;
const layer = () => new SculptLayer({ size: SIZE, res: 129 });

test("an untouched layer contributes nothing", () => {
  const l = layer();
  ok(l.empty, "starts empty");
  eq(l.offsetAt(0, 0), 0);
  eq(l.offsetAt(123.4, -800), 0);
});

test("raise lifts the centre most and the rim least", () => {
  const l = layer();
  l.apply({ x: 0, z: 0, r: 400, amount: 10, mode: "raise" }, flat);
  const centre = l.offsetAt(0, 0);
  const mid = l.offsetAt(200, 0);
  const outside = l.offsetAt(700, 0);
  ok(centre > 9, `centre lifted ${centre}`);
  ok(mid > 0 && mid < centre, `falloff: ${mid} between 0 and ${centre}`);
  close(outside, 0, 1e-6);
});

test("lower is the inverse of raise", () => {
  const up = layer(), down = layer();
  up.apply({ x: 100, z: -50, r: 300, amount: 7, mode: "raise" }, flat);
  down.apply({ x: 100, z: -50, r: 300, amount: 7, mode: "lower" }, flat);
  close(up.offsetAt(100, -50), -down.offsetAt(100, -50), 1e-6);
});

test("replay reproduces the field exactly", () => {
  const a = layer();
  a.apply({ x: 0, z: 0, r: 500, amount: 12, mode: "raise" }, flat);
  a.apply({ x: 260, z: 120, r: 300, amount: 5, mode: "lower" }, flat);
  a.apply({ x: 60, z: 0, r: 420, amount: 9, mode: "smooth" }, flat);

  // This is the VSight boot path: same strokes, same base → same ground.
  const b = layer().replay(a.strokes, flat);
  for (const [x, z] of [[0, 0], [120, 60], [-300, 220], [700, -640]]) {
    close(b.offsetAt(x, z), a.offsetAt(x, z), 1e-9);
  }
});

test("replaying against a swapped base converges on the new base's field", () => {
  // The erosion path: strokes are first rasterized against the analytic base,
  // then erosion swaps the base and the engine re-replays them against it.
  // The re-replay must land bit-identically on what a session that only ever
  // saw the eroded base computes — flatten/smooth read the base, so this is
  // the property the seed's determinism promise leans on.
  const baseA = flat;
  const baseB = (x, z) => Math.sin(x * 0.01) * 8 + Math.cos(z * 0.013) * 5;
  const live = layer();
  live.apply({ x: 0, z: 0, r: 500, amount: 12, mode: "raise" }, baseA);
  live.apply({ x: 120, z: -80, r: 380, amount: 6, mode: "flatten" }, baseA);
  live.apply({ x: -60, z: 40, r: 300, amount: 9, mode: "smooth" }, baseA);
  live.replay(live.strokes, baseB); // what the engine does when erosion lands

  const reboot = layer().replay(live.strokes, baseB); // VSight / reopen
  for (const [x, z] of [[0, 0], [120, -80], [-60, 40], [400, 300]]) {
    close(reboot.offsetAt(x, z), live.offsetAt(x, z), 1e-9, `(${x},${z})`);
  }
});

test("strokes serialize as plain numbers", () => {
  const l = layer();
  l.apply({ x: 12.3456, z: -7.891, r: 100, amount: 3.14159, mode: "lower" }, flat);
  const s = l.strokes[0];
  eq(typeof s.x, "number"); eq(typeof s.m, "number");
  eq(JSON.parse(JSON.stringify(s)).m, 1, "lower is mode 1");
  ok(String(s.x).length <= 7, `rounded for transport: ${s.x}`);
});

test("smooth pulls a spike toward its surroundings", () => {
  const l = layer();
  l.apply({ x: 0, z: 0, r: 200, amount: 40, mode: "raise" }, flat);
  const peak = l.offsetAt(0, 0);
  for (let i = 0; i < 8; i++) l.apply({ x: 0, z: 0, r: 260, amount: 20, mode: "smooth" }, flat);
  ok(l.offsetAt(0, 0) < peak, `smoothed ${l.offsetAt(0, 0)} < ${peak}`);
});

test("the world edge falls below sea level", () => {
  const h = createHeightSampler(makeParams({ seed: "K7QN-3F2A-9XBD", preset: "highlands" }));
  const half = DEFAULT_PARAMS.terrain.size / 2;
  // Sea level is y=0 by construction, so the rim must be under it on all sides.
  for (const [x, z] of [[half - 2, 0], [-half + 2, 0], [0, half - 2], [0, -half + 2], [half - 2, half - 2]]) {
    ok(h(x, z) < 0, `edge (${x}, ${z}) = ${h(x, z).toFixed(1)}m must be underwater`);
  }
  // ...and the interior is untouched by the falloff.
  ok(EDGE_START > 0.5 && EDGE_START < 1, "falloff only affects the outer margin");
  const inner = h(0, 0), innerEdge = h(half * EDGE_START * 0.98, 0);
  ok(Number.isFinite(inner) && Number.isFinite(innerEdge), "interior still samples");
});

test("a stroke on the rim reaches past the plate edge, smoothly", () => {
  /* analyticAt used to TRUNCATE its bucket index (`|0` rounds toward zero),
     so a query just off the plate at x < -size/2 aliased into bucket 0 as if
     it were on the plate, while the out-of-range guard on the positive side
     returned 0 — the same rim stroke read differently off the two ends. The
     clamp matches _index's rule on both sides: a stroke whose radius crosses
     the edge contributes across it, and the falloff answers 0 farther out. */
  const l = layer();
  const half = SIZE / 2;
  l.apply({ x: -half + 10, z: 0, r: 120, amount: 8, mode: "raise" }, flat);
  const on = l.offsetAt(-half + 1, 0);
  const off = l.offsetAt(-half - 1, 0);
  ok(on > 0, "the stroke reaches the rim from inside");
  ok(off > 0, "…and continues just past it, instead of snapping to 0");
  ok(Math.abs(on - off) < 0.5, `no cliff at the plate edge: ${on} vs ${off}`);
  // Mirror stroke on the far rim behaves identically — no truncation bias.
  const r = layer();
  r.apply({ x: half - 10, z: 0, r: 120, amount: 8, mode: "raise" }, flat);
  close(r.offsetAt(half + 1, 0), off, 1e-9, "the two rims disagree");
  // Far off the plate is still exactly nothing.
  eq(l.offsetAt(-half - 500, 0), 0, "distance still wins");
});

test("authored arrays are not shared between worlds", () => {
  const a = makeParams({ seed: "AAAA-2222-2222", preset: "highlands" });
  const b = makeParams({ seed: "BBBB-2222-2222", preset: "highlands" });
  a.terrain.sculpt.push({ x: 0, z: 0, r: 10, a: 1, m: 0 });
  a.props.grass.patches.push({ x: 0, z: 0, r: 9, n: 110 });
  eq(b.terrain.sculpt.length, 0, "a second world starts unsculpted");
  eq(b.props.grass.patches.length, 0, "a second world starts ungrassed");
  eq(DEFAULT_PARAMS.terrain.sculpt.length, 0, "the defaults stay pristine");
  eq(DEFAULT_PARAMS.props.grass.patches.length, 0, "the defaults stay pristine");
});

/* ══ the brush is faithful ═══════════════════════════════════════════════════
   The editor's brush slider runs from 10 m to 400 m (editor.html). On a 4096 m
   world the raster these used to land on is 16 m a cell, so the bottom of that
   range was below one cell and the tests below all failed:

     r = 10 m at a cell centre   0.00 m of a requested 8.00 — a silent no-op
     r = 10 m on a grid node     8.00 m
     r = 20 m between nodes      3.22 m

   The delivered depth was a function of where between grid nodes the pointer
   landed, which is not a thing an author can see, aim at, or work around. */

const SUB_CELL = [10, 12, 16, 20, 25, 40];   // the small end of the brush's own range
// The brush's falloff at a fraction of its radius — 1 at the centre, 0 at the rim.
const fall = (u) => { const t = 1 - u; return t * t * (3 - 2 * t); };

test("a brush at the smallest radius the UI offers is never a silent no-op", () => {
  // Swept across a cell of the 4096/128 = 32 m grid this layer() uses, INCLUDING
  // the cell centre, which is the worst case: the nearest grid node is a full
  // cell·√2/2 away and a small brush used to reach none of them.
  const cell = SIZE / 128;
  for (let fx = 0; fx <= 1.0001; fx += 0.25) {
    for (let fz = 0; fz <= 1.0001; fz += 0.25) {
      const x = fx * cell, z = fz * cell;
      const l = layer();
      l.apply({ x, z, r: 10, amount: 8, mode: "raise" }, flat);
      close(l.offsetAt(x, z), 8, 1e-9,
        `a 10 m brush at (${x.toFixed(1)}, ${z.toFixed(1)}) delivered`);
    }
  }
});

test("delivered depth does not depend on where between grid cells the pointer landed", () => {
  const cell = SIZE / 128;
  for (const r of SUB_CELL) {
    for (const off of [0, 0.5, 1 / 3, 0.9]) {
      const l = layer();
      // Sampled at the stroke's OWN recorded position: `apply` rounds x and z
      // to the centimetre on the way into params, and a test that ignored that
      // would be measuring the rounding rather than the brush.
      const s = l.apply({ x: off * cell, z: off * cell, r, amount: 6, mode: "raise" }, flat);
      close(l.offsetAt(s.x, s.z), 6, 1e-9, `r=${r} at +${(off * cell).toFixed(1)} m:`);
      // …and the rim is still the rim, so it is a brush and not a spike.
      close(l.offsetAt(s.x + r, s.z), 0, 1e-9, `r=${r} rim:`);
      close(l.offsetAt(s.x + r * 0.5, s.z), 6 * 0.5, 1e-9, `r=${r} half way out:`);
    }
  }
});

test("lower is exact at the same radii, and raise over lower cancels", () => {
  for (const r of SUB_CELL) {
    const l = layer();
    l.apply({ x: 7, z: -13, r, amount: 4, mode: "lower" }, flat);
    close(l.offsetAt(7, -13), -4, 1e-9, `lower r=${r}:`);
    l.apply({ x: 7, z: -13, r, amount: 4, mode: "raise" }, flat);
    close(l.offsetAt(7, -13), 0, 1e-9, `raise over lower r=${r}:`);
  }
});

test("the evaluator the landform predicts with is the evaluator that renders", () => {
  /* js/landform.js decides slopes, water routing and where a moat sits against
     the post-stroke height, before anything has been applied. It used to carry
     its own copy of this arithmetic and therefore reasoned about a surface it
     would not get. It now imports this one; that is what this asserts. */
  const l = layer();
  const strokes = [
    { x: 0, z: 0, r: 300, a: 12, m: 0 },
    { x: 120, z: -60, r: 45, a: 7, m: 1 },
    { x: -200, z: 80, r: 18, a: 3, m: 0 },
  ];
  l.replay(strokes, flat);
  for (const [x, z] of [[0, 0], [120, -60], [-200, 80], [40, 40], [-260, 130]]) {
    close(l.offsetAt(x, z), strokeOffsetAt(strokes, x, z), 1e-9, `at ${x},${z}:`);
  }
  // `limit` is how the landform reads the ground as it stood before a cut.
  close(strokeOffsetAt(strokes, 120, -60, 1), 12 * fall(Math.hypot(120, 60) / 300), 1e-9,
    "the ground before the cut still has the raise on it");
});

test("retirement is deterministic, and the field survives it", () => {
  /* Past the live cap the oldest strokes are rasterised so sampling stays
     bounded — see the note in sculpt.js. Two things must hold across that
     boundary: replaying the same list twice must give the same ground (it is
     what `params` promises), and a stroke laid AFTER the boundary must still
     be exact, because it is the one under the author's hand. */
  const many = [];
  for (let k = 0; k < SCULPT_LIVE_CAP + 200; k++) {
    many.push({ x: -1800 + (k % 60) * 60, z: -1800 + ((k / 60) | 0) * 60, r: 40, a: 2, m: 0 });
  }
  const a = layer().replay(many, flat);
  const b = layer().replay(many, flat);
  ok(a._live.length <= SCULPT_LIVE_CAP, "the live set outgrew its cap");
  ok(a._live.length > 0, "everything retired — nothing is exact any more");
  for (const [x, z] of [[0, 0], [-1740, -1740], [900, -300], [1500, 1200]]) {
    close(b.offsetAt(x, z), a.offsetAt(x, z), 1e-12, `replay diverged at ${x},${z}:`);
  }
  // The newest stroke is live, so it lands at full strength on any sub-cell offset.
  const l = layer().replay(many, flat);
  l.apply({ x: 333.7, z: -111.3, r: 12, amount: 5, mode: "raise" }, flat);
  const before = a.offsetAt(333.7, -111.3);
  close(l.offsetAt(333.7, -111.3) - before, 5, 1e-9, "a fresh small stroke past the cap:");
});

test("flatten reasons about the exact ground, not a quantised one", () => {
  /* Flatten targets the surface height under the brush CENTRE and pulls the
     ground around it to that height, so the centre is the reference and does
     not move — the thing to check is a point out on the slope.

     It has to see the live analytic strokes to do that. Reading only the
     raster would leave it working on a ground with every raise missing from
     it: `here` would be 0 instead of 26.88, so it would add the whole 30 on
     top of a hillside that was already at 26.88 and end at 56.9 — nearly
     double the height it was aiming at. Hence the tight bound. */
  const l = layer();
  l.apply({ x: 0, z: 0, r: 200, amount: 30, mode: "raise" }, flat);   // a hill, live
  close(l.offsetAt(0, 0), 30, 1e-9, "the hill");
  const slope = 30 * fall(40 / 200);
  close(l.offsetAt(40, 0), slope, 1e-9, "the hillside before flattening");

  l.apply({ x: 0, z: 0, r: 150, amount: 30, mode: "flatten" }, flat);
  close(l.offsetAt(0, 0), 30, 1e-9, "flatten moved the height it was aiming at");
  /* 40 m out the pull saturates, so the hillside arrives AT the target — to
     within the quarter metre the raster still costs. Flatten is a rastered
     mode by design (it needs a surface to reason about), so its correction is
     written to grid nodes and read back bilinearly between them; that residual
     is the honest remainder and it is two orders of magnitude under the 56.9 m
     this reads if the analytic strokes are left out of the ground. */
  close(l.offsetAt(40, 0), 30, 0.5, "flatten did not level the slope onto its target");
});

report("sculpt");
