/* Which plants get drawn, asserted against a frustum whose answer is known by
 * inspection.
 *
 * Scatter.js imports three and cannot be loaded here, which is exactly why the
 * arithmetic lives in props/scatter-cull.js — the same split as burn-spec.js
 * and bloom-plan.js. And it is worth splitting, because the failure modes of a
 * cull are all invisible in the frame that causes them: a plant dropped one
 * metre too early does not look like a bug, it looks like there was never a
 * tree there. The browser cannot answer "is the forest right"; a box frustum
 * and eight known points can.
 *
 * The frustum below is an axis-aligned box spanning ±10 on every axis, so
 * every expectation in this file can be checked by reading the coordinates.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { cullSpecies, speciesRadius, shadowThrow } from "../../../src/genesis/props/scatter-cull.js";

// inside is n·p + d >= 0, so each plane is written to vanish at ±10.
const BOX = new Float32Array([
  1, 0, 0, 10, -1, 0, 0, 10,
  0, 1, 0, 10, 0, -1, 0, 10,
  0, 0, 1, 10, 0, 0, -1, 10,
]);

/* Drive the cull over a list of [x, y, z, radius] plants and return the
   indices it kept, in the order it kept them. */
function cull(plants, { cam = [0, 0, 0], dist = 1000, throw: thr = [0, 0, 0], planes = BOX } = {}) {
  const n = plants.length;
  const origins = new Float32Array(n * 3), radii = new Float32Array(n);
  plants.forEach(([x, y, z, r], i) => {
    origins[i * 3] = x; origins[i * 3 + 1] = y; origins[i * 3 + 2] = z; radii[i] = r || 0;
  });
  const out = new Int32Array(n);
  const kept = cullSpecies(out, origins, radii, n, planes,
    cam[0], cam[1], cam[2], dist, thr[0], thr[1], thr[2]);
  return Array.from(out.slice(0, kept));
}

test("a plant inside the frustum and inside range is drawn", () => {
  eq(cull([[0, 0, 0, 1]]).length, 1);
  eq(cull([[9, 9, 9, 0]]).length, 1, "a plant just inside the box is inside the box");
});

test("a plant outside the frustum is not drawn", () => {
  eq(cull([[40, 0, 0, 1]]).length, 0, "40 m off to the side is not in a box that ends at 10");
  eq(cull([[0, 0, -40, 1]]).length, 0, "and neither is a plant behind the camera");
});

test("a plant's own size is what decides whether it reaches into view", () => {
  // Origin outside, canopy inside: a tree whose trunk is past the edge of the
  // frustum still has leaves in the shot, and dropping it pops a hole.
  eq(cull([[12, 0, 0, 0]]).length, 0, "a point at 12 is outside a box ending at 10");
  eq(cull([[12, 0, 0, 3]]).length, 1, "the same plant with a 3 m canopy reaches in and must be kept");
});

test("the draw distance is a hard cap, whatever shadow a plant throws", () => {
  /* The ordering that matters. The shadow sweep keeps casters the frustum
     would drop, so it has to come AFTER the distance test. The first version
     of this cull got that half right and the other half wrong: it exempted
     anything inside the SHADOW VOLUME, and that volume grows with altitude
     and with how far the framing subject sits from the camera — measured at
     3072 m on a built world. Everything inside the draw distance was exempt,
     the frustum test became dead code, and turning ninety degrees changed the
     drawn count by nothing at all. */
  const far = [[0, 0, 500, 1]];
  eq(cull(far, { dist: 100 }).length, 0, "beyond the draw distance");
  eq(cull(far, { dist: 100, throw: [0, -400, 400] }).length, 0,
    "no shadow, however long, may resurrect a plant past the draw distance");

  // The cap read from the other side: a plant the frustum is perfectly happy
  // with still goes when it is further off than the tier draws.
  const inView = [[0, 0, 5, 1]];
  eq(cull(inView, { dist: 100 }).length, 1, "5 m away and in shot");
  eq(cull(inView, { dist: 1 }).length, 0, "the same plant, with a draw distance that does not reach it");
});

test("a caster is kept when its shadow reaches the shot, and not otherwise", () => {
  /* The artefact this exists to prevent: cull on the view frustum alone and
     the shadow of everything behind you vanishes, so shadows pop in as you
     turn around. The fix is bounded — the caster is swept along the direction
     its shadow actually travels, so a plant whose shadow lands nowhere near
     the frustum still goes. */
  const behind = [[0, 0, -40, 1]];
  eq(cull(behind).length, 0, "behind the camera, casting nothing, it goes");
  eq(cull(behind, { throw: [0, -10, 60] }).length, 1,
    "a shadow long enough to reach the box keeps the plant that throws it");
  eq(cull(behind, { throw: [0, -1, 2] }).length, 0,
    "a shadow that lands two metres away does not, and this is what a volume test could never say");
});

test("a shadow is thrown away from the sun, and further as the sun drops", () => {
  const out = new Float64Array(3);
  shadowThrow(out, 10, 0, 1, 0, 1e9);
  eq(Array.from(out).map((v) => +v.toFixed(4)).join(","), "0,-10,0",
    "sun overhead: the shadow is the plant's own height, straight down");

  shadowThrow(out, 10, 0.6, 0.8, 0, 1e9);
  // The vertical drop is the plant's own height at ANY elevation — that is
  // what "reaches the ground" means, and it is why only the horizontal reach
  // grows as the sun sinks.
  eq(out[1].toFixed(3), "-10.000", "the sweep drops by exactly the plant's height");
  eq(Math.hypot(...out).toFixed(3), "12.500", "and travels 10/0.8 to do it");
  ok(out[0] < 0, "away from the sun, not toward it");

  const low = new Float64Array(3), high = new Float64Array(3);
  shadowThrow(low, 10, 0.98, 0.2, 0, 1e9);
  shadowThrow(high, 10, 0, 1, 0, 1e9);
  ok(Math.hypot(...low) > Math.hypot(...high), "a low sun throws a longer shadow than a high one");
});

test("the shadow sweep is bounded at both ends", () => {
  const out = new Float64Array(3);
  /* Floored elevation: at sunrise the true throw is effectively infinite, and
     a cull that keeps the whole world at dawn is not a cull. */
  shadowThrow(out, 10, 0.999, 0.001, 0, 1e9);
  ok(Math.hypot(...out) <= 10 / 0.15 + 1e-6, "a sun on the horizon must not throw an unbounded shadow");

  // Capped by the shadow volume: past its edge there is no map to land in.
  shadowThrow(out, 1000, 0, 1, 0, 50);
  eq(Math.hypot(...out).toFixed(3), "50.000", "the cap is the shadow volume");

  // Night: nothing casts, so nothing is swept.
  shadowThrow(out, 10, 0, -0.4, 0, 1e9);
  eq(Array.from(out).join(","), "0,0,0", "a sun below the horizon casts nothing");
});

test("the kept indices come out ascending, so a compacted buffer is stable", () => {
  /* Scatter copies instance k's matrix AND its colour by this index. If the
     order were not deterministic, a still camera could reshuffle which tint
     landed on which tree between two frames that look identical. */
  const plants = [[0, 0, 0, 1], [40, 0, 0, 1], [1, 1, 1, 1], [-40, 0, 0, 1], [2, 2, 2, 1]];
  const kept = cull(plants);
  eq(kept.join(","), "0,2,4");
  for (let i = 1; i < kept.length; i++) ok(kept[i] > kept[i - 1], "indices must ascend");
});

test("an empty species culls to nothing without complaining", () => {
  eq(cull([]).length, 0);
});

test("a species' radius is how far its furthest part reaches", () => {
  /* Not the biggest part's own radius: a canopy sitting 4 m up a trunk is 5 m
     from the plant's origin however small the canopy is, and a sphere that
     does not contain it will cull the tree while its leaves are still on
     screen. */
  eq(speciesRadius([{ offset: 0, radius: 0.4 }, { offset: 4, radius: 1.5 }]), 5.5);
  eq(speciesRadius([{ offset: 0, radius: 2 }]), 2);
  eq(speciesRadius([]), 0, "a species with no parts has no reach");
});

report("scatter-cull");
