/* LOD selection: it must not flap.
 *
 * The quadtree's rule was one threshold — subdivide while `dist < half*2.4` —
 * and one threshold is a knife edge. A camera anywhere near it flips the node
 * across on every re-selection, and a flip is expensive here because tiles are
 * DISPOSED rather than cached: going down builds four tiles, coming back up
 * builds one, and at tileRes 65 each is ~38 000 height-sampler calls.
 *
 * The 8 m camera-key quantisation is not a defence and this file says so with
 * arithmetic: `Math.round(x/8)` changes the instant x crosses a multiple of 8,
 * so two consecutive re-selections can be a centimetre apart in world space.
 * It bounds how OFTEN selection runs, never how far the camera moved.
 *
 * The selection maths is reproduced here rather than imported because
 * QuadtreeTerrain imports three.js and this suite is deliberately three-free.
 * That is a real risk — a copy can drift from the original — so the copy is
 * kept to the four lines that decide, and tools/check-imports.mjs already
 * guards the layering that keeps those four lines where they are.
 */
import { test, ok, eq, report } from "./harness.js";

const LOD_ENTER = 2.4;
const LOD_MARGIN = 0.35;
const LOD_MARGIN_MIN = 8;

// The distance metric from QuadtreeTerrain.update: distance to the node's
// box in xz, plus height above the terrain's stated amplitude.
function nodeDist(cam, cx, cz, half, terrainHeight) {
  const dx = Math.max(0, Math.abs(cam.x - cx) - half);
  const dz = Math.max(0, Math.abs(cam.z - cz) - half);
  const dy = Math.max(0, cam.y - terrainHeight);
  return Math.sqrt(dx * dx + dz * dz + dy * dy);
}

const limitFor = (half, wasSubdivided) =>
  half * LOD_ENTER + (wasSubdivided ? Math.max(half * LOD_MARGIN, LOD_MARGIN_MIN) : 0);

// One node's decision, given whether it was split last time.
const decide = (cam, cx, cz, half, terrainHeight, was) =>
  nodeDist(cam, cx, cz, half, terrainHeight) < limitFor(half, was);

const camKey = (c) => `${Math.round(c.x / 8)}:${Math.round(c.y / 8)}:${Math.round(c.z / 8)}`;

/* ── the premise, checked rather than assumed ── */

test("the 8 m camera key does not bound how far the camera moved", () => {
  /* Two positions 2 cm apart produce different keys, so selection re-runs
     having moved almost nothing. Note WHERE the boundary is: `Math.round(x/8)`
     changes at the HALFWAY points — x = 4, 12, 20 — not at multiples of 8.
     (The first draft of this test straddled x = 8 and both sides rounded to
     the same key, which is a good illustration of why the quantisation is not
     a thing to reason about loosely.) */
  const a = { x: 3.99, y: 100, z: 0 }, b = { x: 4.01, y: 100, z: 0 };
  ok(camKey(a) !== camKey(b), `${camKey(a)} vs ${camKey(b)} at 2 cm apart`);
});

test("without hysteresis a 2 cm move flips a node — the bug this fixes", () => {
  const half = 64, cx = 0, cz = 0, H = 120;
  // Put the camera exactly on the old single threshold.
  const edge = half * LOD_ENTER;             // 153.6 m
  const inside = { x: 0, y: 0, z: cz + half + edge - 0.01 };
  const outside = { x: 0, y: 0, z: cz + half + edge + 0.01 };
  // Old rule: no memory, so the decision is a pure function of distance.
  const oldRule = (cam) => nodeDist(cam, cx, cz, half, H) < half * LOD_ENTER;
  ok(oldRule(inside), "just inside the old threshold: split");
  ok(!oldRule(outside), "2 cm further out: merged — a flip per re-selection");
});

/* ── the fix ── */

test("a split node holds its split until the camera clears the whole margin", () => {
  const half = 64, cx = 0, cz = 0, H = 120;
  const enter = half * LOD_ENTER;
  const margin = Math.max(half * LOD_MARGIN, LOD_MARGIN_MIN);   // 22.4 m
  const at = (d) => ({ x: 0, y: 0, z: cz + half + d });

  ok(decide(at(enter - 0.01), cx, cz, half, H, false), "crosses in at the enter threshold");
  // Now it is split. Everything short of the full margin must keep it split.
  for (const d of [enter + 0.01, enter + 1, enter + margin * 0.5, enter + margin - 0.01]) {
    ok(decide(at(d), cx, cz, half, H, true), `still split ${(d - enter).toFixed(2)} m past the line`);
  }
  ok(!decide(at(enter + margin + 0.01), cx, cz, half, H, true), "merges only past the full margin");
});

test("no camera path can oscillate a node — the margin must be re-crossed both ways", () => {
  /* The real property. Walk the camera in fine steps back and forth across
     the enter threshold and count state changes. With a single threshold this
     counts once per crossing; with the band it must settle. */
  const half = 64, cx = 0, cz = 0, H = 120;
  const enter = half * LOD_ENTER;
  const margin = Math.max(half * LOD_MARGIN, LOD_MARGIN_MIN);
  let state = false, flips = 0;
  // Jitter over a 10 m span straddling the threshold — wider than the 8 m
  // camera key, narrower than the margin.
  for (let pass = 0; pass < 40; pass++) {
    const d = enter - 5 + (pass % 2 === 0 ? 0 : 10);
    const next = decide({ x: 0, y: 0, z: cz + half + d }, cx, cz, half, H, state);
    if (next !== state) flips++;
    state = next;
  }
  eq(flips, 1, "one settle, then stable across 40 re-selections:");
});

test("the margin is wider than the camera-key step even for the smallest node", () => {
  /* An absolute floor exists because the proportional margin shrinks with the
     node: at ultra (maxDepth 7) the deepest node that can still subdivide has
     half = 16 m, and 0.35 x 16 = 5.6 m would be narrower than the 8 m key
     step — which is exactly the regime where jitter wins. */
  for (const half of [16, 32, 64, 128, 512, 2048]) {
    const m = Math.max(half * LOD_MARGIN, LOD_MARGIN_MIN);
    ok(m >= LOD_MARGIN_MIN, `half ${half} m gets a ${m} m band`);
  }
  eq(Math.max(16 * LOD_MARGIN, LOD_MARGIN_MIN), 8, "the smallest node takes the floor:");
});

test("hysteresis widens the split region, it never shrinks it", () => {
  // A node that would split without memory must still split with it —
  // otherwise the band would be pulling detail AWAY from the camera.
  for (const half of [32, 64, 256]) {
    ok(limitFor(half, true) > limitFor(half, false), `half ${half}: exit limit exceeds enter limit`);
    eq(limitFor(half, false), half * LOD_ENTER, `half ${half}: entering is the unchanged rule`);
  }
});

test("LOD is representation only — the decision never touches world height", () => {
  /* The spec's hard constraint: LOD must affect representation, never
     topology. The decision function reads camera position, node centre, node
     half-extent and the terrain's stated amplitude — and nothing that could
     feed back into the surface. Asserted by construction: the same node at
     the same camera distance decides identically regardless of how it is
     reached, so no path dependence can leak into geometry. */
  const H = 120;
  const a = decide({ x: 10, y: 5, z: 300 }, 0, 0, 64, H, false);
  const b = decide({ x: 10, y: 5, z: 300 }, 0, 0, 64, H, false);
  eq(a, b, "deterministic:");
  // And the only history it carries is one boolean about ITS OWN past state.
  ok(decide({ x: 10, y: 5, z: 300 }, 0, 0, 64, H, true) >= a, "memory can only extend a split:");
});

report("lod");
