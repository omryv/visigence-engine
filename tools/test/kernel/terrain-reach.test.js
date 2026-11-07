// Reach and par on terrain: what the body in controller.js can walk to, and
// how long a fair course should allow for it.
//
// Two halves. The first runs on THE default world — bakeCanonicalGround of
// makeParams(), the 513² eroded ground every consumer holds — because a
// reach check is only worth having if it gives a sensible answer on the
// ground people actually stand on. The second builds small fields by hand,
// one per rule, because on a real world a rule that is wrong in one
// direction is usually hidden by another that happens to be right.
//
// Imports nothing but the engine, so it runs under JavaScriptCore as well as
// Node.
import { test, eq, ok, close, report } from "./harness.js";
import {
  reachTerrain, parRoute, walkableCells, SNAP_CELLS, ROUTE_LIMITS, CONTROLLER, CORE_MODULES,
} from "../../../src/kernel/core/index.js";
import { bakeCanonicalGround, CANONICAL_RES } from "../../../src/kernel/terrain/canonical.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { hashSeed } from "../../../src/kernel/seed.js";

const clock = typeof performance !== "undefined" && performance.now
  ? () => performance.now()
  : () => Date.now();
const log = typeof print === "function" ? print : console.log;

const cellXZ = (field, p) => {
  const i = p % field.res, j = (p - i) / field.res;
  return [(i / (field.res - 1) - 0.5) * field.size, (j / (field.res - 1) - 0.5) * field.size];
};

/* A hand-built field: `h(x, z)` sampled on the same lattice bakeHeightField
   writes. */
function field(res, size, h) {
  const data = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      data[j * res + i] = h((i / (res - 1) - 0.5) * size, (j / (res - 1) - 0.5) * size, i, j);
    }
  }
  return { res, size, data };
}

test("both modules are in the core, so the boundary test covers them", () => {
  ok(CORE_MODULES.includes("src/kernel/core/controller.js"));
  ok(CORE_MODULES.includes("src/kernel/core/terrain-reach.js"));
});

// ── the default world ───────────────────────────────────────────────────────

const PARAMS = makeParams();
const LEVEL = PARAMS.water.level || 0;
const t0 = clock();
const GROUND = bakeCanonicalGround(PARAMS);
const BAKE_MS = clock() - t0;
const F = GROUND.field;
const OPTS = { level: LEVEL, wet: GROUND.wet };

/* Measured with this module as written, on seed K7QN-3F2A-9XBD at 513²:
   186 273 of 263 169 cells are walkable (70.8 %), and from the centre of the
   map 185 140 of them are reached (99.39 %). The 1 133 the flood does not get
   to are 832 separate scraps of eight cells or fewer, and 1 125 of the 1 133
   (99.3 %) lie in the outer fifth of the map, the steep ring where the edge
   falloff drops the plate into the sea — there is no second island on this
   world, which is why "across the sea" is built by hand further down. Pinned exactly, because the bake is
   bit-exact (noise-stack's GOLDEN) and these are counts over it: a change
   here is a change to what "walkable" means, and should be made on purpose. */
test("the default world: walkable and reached fractions, pinned", () => {
  eq(F.res, CANONICAL_RES);
  const r = reachTerrain(F, { spawn: [0, 0], ...OPTS });
  eq(r.walkableCount, 186273, "walkable cells;");
  eq(r.reachedCount, 185140, "reached cells;");
  close(r.walkableFraction, 186273 / (513 * 513), 1e-15);
  close(r.reachedFraction, 185140 / 186273, 1e-15);
  ok(r.walkableFraction > 0.6 && r.walkableFraction < 0.8, `walkable fraction ${r.walkableFraction}`);
  eq(r.spawnCell, 256 * 513 + 256, "the centre of the map is a lattice point and is walkable;");
  eq(r.snapped, false);
  // every reached cell is walkable
  for (let p = 0; p < r.reached.length; p++) if (r.reached[p] && !r.walkable[p]) throw new Error(`cell ${p} reached, not walkable`);
});

/* The objective is found by a scan rather than written in: the highest
   reached cell on the map, which on this world is (560, 864) at 253.0 m —
   the summit — from a spawn at the centre, 116.8 m. Measured: 1 096 m of
   walking, 137.2 m of climb, par 373.2 s against 182.7 s for the same
   distance on the flat; the steepest single step 0.83, under the 0.85 limit,
   and one decimated stretch at 0.55 that earns the steep-leg warning — path
   segment [14, 15], starting at (280, 448). */
const R0 = reachTerrain(F, { spawn: [0, 0], ...OPTS });
let SUMMIT = -1;
for (let p = 0; p < R0.reached.length; p++) {
  if (R0.reached[p] && (SUMMIT < 0 || F.data[p] > F.data[SUMMIT])) SUMMIT = p;
}
const GOAL = cellXZ(F, SUMMIT);

test("a route to the summit exists, with a plausible par", () => {
  eq(GOAL.join(), "560,864", "the summit moved;");
  const r = parRoute(F, [0, 0], GOAL, { ...OPTS, reach: R0 });
  ok(r.verdict !== "error", `verdict ${r.verdict}: ${JSON.stringify(r.issues)}`);
  ok(r.distance / CONTROLLER.walk <= r.parSeconds, `par ${r.parSeconds} beats walking ${r.distance} m flat out`);
  // Descent is free, so par is EXACTLY the Naismith sum over the route.
  close(r.parSeconds, (r.distance + CONTROLLER.climb.flatPerClimb * r.climb) / CONTROLLER.walk, 1e-9);
  const straight = Math.sqrt(GOAL[0] * GOAL[0] + GOAL[1] * GOAL[1]);
  ok(r.distance >= straight, `route ${r.distance} m shorter than the straight line ${straight} m`);
  ok(r.distance < straight * 1.25, `route ${r.distance} m is a detour of more than 25 % on open hills`);
  ok(r.climb >= F.data[SUMMIT] - F.data[R0.spawnCell] - 1e-3, "climbed less than the height gained");
  ok(r.maxGrade <= CONTROLLER.maxSlope + 1e-12, `a step at grade ${r.maxGrade}`);
  close(r.distance, 1095.96, 0.01); close(r.climb, 137.17, 0.01); close(r.parSeconds, 373.18, 0.01);
  eq(r.issues.map((x) => x.id).join(), "steep-leg");
  eq(r.verdict, "warning");
  // the issue says where: the 2dgen shape, with the stretch located
  eq(JSON.stringify(r.issues[0].at), "[280,448]");
  eq(r.issues[0].entityId, null);
  eq(JSON.stringify(r.issues[0].segments), "[[14,15]]");
  const [a, b] = r.issues[0].segments[0];
  eq(r.path[a].slice(0, 2).join(), "280,448");
  ok(Math.abs(r.path[b][2] - r.path[a][2]) / Math.hypot(r.path[b][0] - r.path[a][0], r.path[b][1] - r.path[a][1]) > ROUTE_LIMITS.steepGrade);
  // The route itself, pinned: the cell count, the measures to the last bit and
  // a hash of the path's JSON (FNV-1a, src/kernel/seed.js). Every operation behind
  // them is an IEEE add, multiply, divide or sqrt, and JSON's number printing
  // is fixed by the language, so a JavaScriptCore run must print these too.
  eq(r.cells, 109); eq(r.path.length, 28);
  eq(r.distance, 1095.9595949289326); eq(r.climb, 137.17141723632812); eq(r.parSeconds, 373.1757897608332);
  eq(hashSeed(JSON.stringify(r.path)), 4280335090, "summit path hash;");
  // the path: decimated, starts and ends where the route does, [x, z, y]
  ok(r.path.length >= 2 && r.path.length < r.cells, `path ${r.path.length} of ${r.cells} cells`);
  eq(r.path[0].join(), [0, 0, F.data[R0.spawnCell]].join());
  eq(r.path.at(-1).join(), [...GOAL, F.data[SUMMIT]].join());
  eq(r.goal.snapped, false);
});

test("a point out in the open sea is an error, not a route", () => {
  const r = parRoute(F, [0, 0], [-2000, 0], { ...OPTS, reach: R0 });
  eq(r.verdict, "error");
  eq(r.issues[0].id, "objective-unreachable");
  eq(r.issues[0].severity, "error");
  eq(JSON.stringify(r.issues[0].at), "[-2000,0]", "the issue points at the objective;");
  eq(r.path.length, 0);
  eq(r.parSeconds, null);
});

test("a start in the sea is an error of its own", () => {
  const r = parRoute(F, [-2000, -2000], [0, 0], OPTS);
  eq(r.verdict, "error");
  eq(r.issues.map((x) => x.id).join(), "start-unwalkable");
  eq(JSON.stringify(r.issues[0].at), "[-2000,-2000]");
});

/* Corner to corner, pinned the same way as the summit: 444 cells, 4 893 m, par
   1 219 s, measured with this module as written. Repeating the call in one
   process proves little on its own (it would pass with any tie rule), so the
   answer is pinned too, for another engine or a later change to the neighbour
   order or the heap to be checked against. */
test("deterministic: the same ground and points give the same path, pinned", () => {
  const a = parRoute(F, [-1700, -1700], [1700, 1700], OPTS);
  const b = parRoute(F, [-1700, -1700], [1700, 1700], OPTS);
  eq(JSON.stringify(a.path), JSON.stringify(b.path));
  eq(a.parSeconds, b.parSeconds);
  eq(a.cells, b.cells);
  // a reach handed in gives the route a fresh flood gives
  const c = parRoute(F, [-1700, -1700], [1700, 1700], { ...OPTS, reach: a.reach });
  eq(JSON.stringify(c.path), JSON.stringify(a.path));
  eq(a.cells, 444); eq(a.path.length, 56);
  eq(a.distance, 4892.679359086825); eq(a.parSeconds, 1219.2885825316905);
  eq(hashSeed(JSON.stringify(a.path)), 3480848979, "corner-to-corner path hash;");
  // Both corners sit exactly halfway between lattice points (±1700 m is 43.5
  // cells off the centre), 5.66 m — √2 · 4 m, half a cell's diagonal — from
  // the four cells round them. That is as close as a lattice cell can be, so
  // it is not a snap, whichever of the four the tie picks.
  eq(a.start.snapped, false); close(a.start.snapMetres, 4 * Math.SQRT2, 1e-9);
  eq(a.goal.snapped, false); close(a.goal.snapMetres, 4 * Math.SQRT2, 1e-9);
});

/* Runtime at 513², measured on the Node 22 this suite runs on: the flood
   (walkable mask + BFS) ~29 ms, the corner-to-corner route (a fresh flood
   plus Dijkstra across 4.9 km of the map, early exit at the goal) ~130 ms;
   the canonical bake itself ~450 ms. Printed each run, and bounded loosely —
   ten times over — so a machine that is merely slow does not fail, but an
   accidental O(N²) does. */
test("runtime at 513² is measured and recorded", () => {
  let t = clock();
  const r = reachTerrain(F, { spawn: [0, 0], ...OPTS });
  const reachMs = clock() - t;
  t = clock();
  const route = parRoute(F, [-1700, -1700], [1700, 1700], OPTS);
  const routeMs = clock() - t;
  log(`    513²: bake ${BAKE_MS.toFixed(0)} ms · reachTerrain ${reachMs.toFixed(1)} ms · parRoute corner→corner ${routeMs.toFixed(1)} ms` +
    ` (${route.cells} cells, ${route.distance.toFixed(0)} m, par ${route.parSeconds.toFixed(0)} s, ${route.path.length} path points)` +
    ` · walkable ${(r.walkableFraction * 100).toFixed(2)} % · reached ${(r.reachedFraction * 100).toFixed(2)} %`);
  ok(reachMs < 1000, `reachTerrain took ${reachMs} ms`);
  ok(routeMs < 3000, `parRoute took ${routeMs} ms`);
  eq(route.issues.map((x) => x.id).join(), "steep-leg,long-leg", "corner to corner is long and crosses steep ground;");
});

// ── one rule at a time ──────────────────────────────────────────────────────

test("flat ground: par is distance over walking speed, and distance is octile", () => {
  const f = field(65, 640, () => 10); // 10 m cells
  const r = parRoute(f, [-300, -300], [300, 100], {});
  eq(r.verdict, "ok");
  // 60 cells across, 40 up: 40 diagonals and 20 straights
  close(r.distance, 40 * 10 * Math.SQRT2 + 20 * 10, 1e-9);
  close(r.parSeconds, r.distance / 6, 1e-9);
  eq(r.climb, 0); eq(r.descent, 0); eq(r.maxGrade, 0);
  eq(r.path[0].join(), "-300,-300,10");
  eq(r.path.at(-1).join(), "300,100,10");
  eq(r.reach.reachedFraction, 1);
});

test("uphill costs Naismith's climb, downhill costs nothing extra", () => {
  // a plane rising 0.3 m per m in +x
  const f = field(41, 400, (x) => 0.3 * x + 200);
  const upR = parRoute(f, [-150, 0], [150, 0], {});
  const downR = parRoute(f, [150, 0], [-150, 0], {});
  close(upR.distance, 300, 1e-9); close(downR.distance, 300, 1e-9);
  close(upR.climb, 90, 1e-3); close(downR.descent, 90, 1e-3);
  close(downR.parSeconds, 300 / 6, 1e-9);
  close(upR.parSeconds, (300 + (25 / 3) * upR.climb) / 6, 1e-9);
  ok(upR.parSeconds > 2 * downR.parSeconds, "the climb was not charged");
  // a straight line on a plane decimates to its two ends
  eq(upR.path.length, 2);
});

test("the slope limit: 0.8 is a hillside, 0.9 is a wall", () => {
  for (const [grade, walkable] of [[0.8, true], [0.9, false]]) {
    const f = field(33, 320, (x) => grade * x);
    const w = walkableCells(f, { level: -1e9 });
    eq(w.count === 33 * 33, walkable, `grade ${grade};`);
  }
  // a cliff band across an otherwise flat map cuts it in two
  const cliff = field(33, 320, (x) => (x > 0 ? 50 : 0) + 100);
  const r = parRoute(cliff, [-100, 0], [100, 0], {});
  eq(r.verdict, "error");
  eq(r.issues[0].id, "objective-unreachable");
  ok(/start cannot walk to/.test(r.issues[0].message), r.issues[0].message);
});

/* Two islands 20 m above a channel whose depth is the variable: 0.5 m is a
   wade, 0.9 m is the deepest wade there is, 1.0 m is a swim, and a swim is not
   a walking route. */
test("across water: wade the shallows, never the sea", () => {
  const islands = (depth) => field(65, 640, (x) => (Math.abs(x) < 40 ? -depth : 0.5));
  for (const [depth, verdict] of [[0.5, "ok"], [0.9, "ok"], [1.0, "error"], [30, "error"]]) {
    const r = parRoute(islands(depth), [-200, 0], [200, 0], { level: 0 });
    eq(r.verdict, verdict, `channel ${depth} m deep;`);
    if (verdict === "error") {
      eq(r.issues[0].id, "objective-unreachable");
      ok(/start cannot walk to/.test(r.issues[0].message), "the far island is walkable ground, just not reachable");
    } else {
      close(r.distance, 400, 1e-9);
    }
  }
});

test("a dry hollow below the waterline is ground, when the flood says so", () => {
  // a 10 m deep bowl in the middle of dry land, its rim far above the sea
  const f = field(33, 320, (x, z) => (x * x + z * z < 60 * 60 ? -10 : 5));
  const dry = new Uint8Array(33 * 33); // the sea-connected mask: nothing is wet
  ok(walkableCells(f, { level: 0, wet: dry }).count > walkableCells(f, { level: 0 }).count,
    "the mask did not make the hollow walkable");
  const inBowl = reachTerrain(f, { spawn: [0, 0], level: 0, wet: dry, snapCells: 0 });
  ok(inBowl.spawnCell >= 0, "the bowl floor is not walkable with a dry mask");
  const noMask = reachTerrain(f, { spawn: [0, 0], level: 0, snapCells: 0 });
  eq(noMask.spawnCell, -1, "without a mask, ten metres under the line is sea");
});

test("snapping: a spawn just off the beach is lifted onto it, and says so", () => {
  // land for x ≤ 0, a 22 m drop into deep sea beyond; 10 m cells. The last
  // land cell, x = 0, is NOT where the spawn lands: its own gradient spans the
  // drop (22 m over 20 m, 1.1 > 0.85), so it is a cliff lip, and the snap
  // goes one cell further inland, to x = −10, 31 m from a spawn at x = 21.
  const f = field(33, 320, (x) => (x <= 0 ? 2 : -20));
  const near = reachTerrain(f, { spawn: [21, 0], level: 0 });
  ok(near.spawnCell >= 0);
  eq(near.snapped, true);
  close(near.snapMetres, 31, 1e-9);
  eq(cellXZ(f, near.spawnCell).join(), "-10,0");
  eq(near.walkable[16 * 33 + 16], 0, "the lip cell is walkable");
  // the first walkable cell is −10 m; a spawn SNAP_CELLS + 1 cells beyond
  // that is out of reach of the snap
  const far = reachTerrain(f, { spawn: [-10 + 10 * (SNAP_CELLS + 1), 0], level: 0 });
  eq(far.spawnCell, -1, "snapped further than SNAP_CELLS");
  eq(far.reachedFraction, 0);
});

test("no squeezing between two corners", () => {
  // two dry cells touching only at a corner, sea around them
  const f = field(9, 80, (x, z, i, j) => ((i === 3 && j === 3) || (i === 4 && j === 4) ? 0.5 : -20));
  const r = reachTerrain(f, { spawn: cellXZ(f, 3 * 9 + 3), level: 0, snapCells: 0 });
  eq(r.reachedCount, 1, "the diagonal past two sea cells was walked");
});

test("warnings: a long flat walk is a long leg; a steep ramp is a steep leg", () => {
  const big = field(129, 5120, () => 1); // 40 m cells, 4.4 km across
  const long = parRoute(big, [-2400, 0], [2400, 0], {});
  eq(long.verdict, "warning");
  eq(long.issues.map((x) => x.id).join(), "long-leg");
  ok(long.parSeconds > ROUTE_LIMITS.longParSeconds);
  const ramp = field(41, 400, (x) => 0.7 * x + 300);
  const steep = parRoute(ramp, [-100, 0], [100, 0], {});
  eq(steep.issues.map((x) => x.id).join(), "steep-leg");
  close(steep.maxGrade, 0.7, 1e-4);
  // and the same ramp is fine if the course allows 0.75
  eq(parRoute(ramp, [-100, 0], [100, 0], { steepGrade: 0.75 }).verdict, "ok");
});

test("a reach from another start is refused, not silently reused", () => {
  const f = field(33, 320, () => 1);
  const other = reachTerrain(f, { spawn: [100, 100] });
  let threw = false;
  try { parRoute(f, [-100, -100], [0, 0], { reach: other }); } catch { threw = true; }
  ok(threw, "a mismatched reach was accepted");
});

/* Ties broken by cell index, made into a test that can fail. A flat 7 × 7
   field at 6 m spacing (one straight step is exactly one second at walk 6), a
   3 × 3 pit in the middle marked wet, the start and the objective on the
   centre line either side of it. Going round to the left and going round to
   the right cost exactly the same — every step cost and every sum along the
   two detours are mirror images, the same numbers added in the same order —
   so which detour comes back is decided by the heap's tie rule and nothing
   else. Measured: with the smaller index winning ties the route goes round
   the left (−x, lower index) side; with the tie rule in makeHeap reversed it
   goes round the right, and this test fails. */
test("ties break by cell index: an exactly symmetric detour goes left", () => {
  const res = 7, size = 36;
  const f = { res, size, data: new Float32Array(res * res).fill(1) };
  const wet = new Uint8Array(res * res);
  for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) wet[j * res + i] = 1;
  const r = parRoute(f, [0, -18], [0, 18], { level: 10, wet, tolerance: 0 });
  eq(r.verdict, "ok");
  eq(r.cells, 9);
  close(r.parSeconds, 6 + 2 * Math.SQRT2, 1e-12, "four straights and two diagonals;");
  eq(JSON.stringify(r.path),
    "[[0,-18,1],[-6.000000000000001,-18,1],[-12.000000000000002,-12.000000000000002,1]," +
    "[-12.000000000000002,5.999999999999998,1],[-12.000000000000002,12.000000000000002,1]," +
    "[-6.000000000000001,12.000000000000002,1],[0,18,1]]");
  for (const p of r.path) ok(p[0] <= 0, `the route went round the right, through x = ${p[0]}`);
});

// ── the objective is snapped onto ground, then asked whether it is reached ──

test("an objective on a plateau above a cliff is unreachable, not moved below it", () => {
  // 10 m cells; x > 0 is 50 m higher. (20, 0) is on the plateau's flat top,
  // two cells from the lip: walkable, and not reachable from x < 0.
  const cliff = field(33, 320, (x) => (x > 0 ? 50 : 0) + 100);
  const own = reachTerrain(cliff, { spawn: [20, 0], snapCells: 0 });
  ok(own.spawnCell >= 0, "the plateau top is walkable ground");
  const r = parRoute(cliff, [-100, 0], [20, 0], {});
  eq(r.verdict, "error");
  eq(r.issues.map((x) => x.id).join(), "objective-unreachable");
  ok(/stands on walkable ground at \(20\.0, 0\.0\)/.test(r.issues[0].message), r.issues[0].message);
  eq(JSON.stringify(r.issues[0].at), "[20,0]");
  eq(r.goal, null); eq(r.path.length, 0);
});

test("an objective across a one-cell trench is unreachable, on either depth", () => {
  // 8 m cells, the canonical spacing; one column of cells at x = 0 sunk under
  // the line. 1.5 m is deeper than wadeDepth, 30 m is a sea trench. (16, 0)
  // and (24, 0) are dry ground two and three cells beyond it — within the
  // snap reach of the start's side, which is why this used to come back ok.
  for (const depth of [1.5, 30]) {
    const f = field(129, 1024, (x) => (x === 0 ? -depth : 0.5));
    for (const ox of [16, 24]) {
      const r = parRoute(f, [-200, 0], [ox, 0], { level: 0 });
      eq(r.verdict, "error", `trench ${depth} m, objective at x = ${ox};`);
      eq(r.issues[0].id, "objective-unreachable");
      ok(/stands on walkable ground/.test(r.issues[0].message), r.issues[0].message);
    }
    // and the same objective mirrored onto the start's side is a route
    const near = parRoute(f, [-200, 0], [-16, 0], { level: 0 });
    eq(near.verdict, "ok");
    close(near.distance, 184, 1e-9);
  }
});

test("off the map: a point is snapped only if the lattice is really within reach", () => {
  const flat = field(33, 320, () => 1); // 10 m cells, the plate spans ±160 m
  const goal = (to) => parRoute(flat, [0, 0], to, {});
  // a kilometre, a million metres, ±Infinity and NaN off the plate: nothing
  for (const to of [[1e6, 0], [0, -1e9], [Infinity, 0], [-Infinity, 5], [NaN, 0], [201, 0]]) {
    const r = goal(to);
    eq(r.verdict, "error", `objective ${to};`);
    eq(r.issues[0].id, "objective-unreachable", `objective ${to};`);
    eq(r.goal, null);
  }
  // 40 m past the edge is exactly 4 cells, the edge of SNAP_CELLS (inclusive;
  // 41 m, above, is not): snapped, and warned
  const edge = goal([200, 0]);
  eq(edge.verdict, "warning");
  eq(edge.issues.map((x) => x.id).join(), "objective-snapped");
  eq(edge.goal.snapped, true); close(edge.goal.snapMetres, 40, 1e-9);
  eq(JSON.stringify(edge.issues[0].at), "[200,0]");
  ok(/\(160\.0, 0\.0\), 40\.0 m away/.test(edge.issues[0].message), edge.issues[0].message);
  // 5 m past the edge is half a cell: on its own cell, not a snap
  const half = goal([165, 0]);
  eq(half.verdict, "ok"); eq(half.goal.snapped, false); close(half.goal.snapMetres, 5, 1e-9);
  // the start the same way
  for (const from of [[-1e9, -1e9], [Infinity, 0], [NaN, NaN]]) {
    const r = parRoute(flat, from, [0, 0], {});
    eq(r.issues.map((x) => x.id).join(), "start-unwalkable", `start ${from};`);
    eq(reachTerrain(flat, { spawn: from }).spawnCell, -1);
  }
});

test("the snap reach is a circle measured from the point", () => {
  // One walkable cell, (0, 0) on 10 m cells, in deep water: the field is flat
  // at −50 m so slope never decides, and the wet mask marks every cell but
  // that one, so footing does. A spawn along the diagonal 3·√2 = 4.24 cells
  // away is beyond SNAP_CELLS, though it is only 3 cells off in x and in z.
  const flat = { res: 33, size: 320, data: new Float32Array(33 * 33).fill(-50) };
  const wet = new Uint8Array(33 * 33).fill(1); wet[16 * 33 + 16] = 0;
  eq(reachTerrain(flat, { spawn: [30, 30], level: 0, wet }).spawnCell, -1, "4.24 cells was snapped;");
  eq(reachTerrain(flat, { spawn: [40, 0], level: 0, wet }).spawnCell, 16 * 33 + 16, "4 cells was not snapped;");
  eq(reachTerrain(flat, { spawn: [28, 28], level: 0, wet }).spawnCell, 16 * 33 + 16, "3.96 cells was not snapped;");
});

test("a point halfway between cells is not 'snapped'", () => {
  const flat = field(33, 320, () => 1);
  const r = reachTerrain(flat, { spawn: [5, 5] });
  eq(r.snapped, false);
  close(r.snapMetres, 5 * Math.SQRT2, 1e-9);
  // a start on a wet beach IS snapped, and parRoute says so
  const beach = field(33, 320, (x) => (x <= 0 ? 2 : -0.5)); // x > 0 is 0.5 m under
  const shallow = field(33, 320, (x) => (x <= 0 ? 2 : 1.9));
  const wet = new Uint8Array(33 * 33);
  for (let j = 0; j < 33; j++) for (let i = 17; i < 33; i++) wet[j * 33 + i] = 1;
  // the shallows are 0.5 m under a waterline at 2.4 m: wadeable, so no snap
  eq(parRoute(shallow, [30, 0], [-100, 0], { level: 2.4, wet }).issues.map((x) => x.id).join(), "");
  const r2 = parRoute(beach, [30, 0], [-100, 0], { level: 2, wet });
  eq(r2.issues[0].id, "start-snapped");
  eq(r2.issues[0].severity, "warning");
  eq(JSON.stringify(r2.issues[0].at), "[30,0]");
  ok(r2.start.snapped && r2.start.snapMetres > 10);
});

// ── the reach handed in must be the one parRoute would have made ──

test("a reach flooded under other settings is refused, by name", () => {
  const hill = field(33, 320, (x) => 0.7 * x + 300);
  const loose = { ...CONTROLLER, maxSlope: 2 };
  const reach = reachTerrain(hill, { spawn: [-100, 0], controller: loose });
  const throws = (opts, re) => {
    let msg = "";
    try { parRoute(hill, [-100, 0], [100, 0], { reach, ...opts }); } catch (e) { msg = e.message; }
    ok(re.test(msg), `expected ${re}, got "${msg}"`);
  };
  throws({ controller: { ...loose, maxSlope: 0.5 } }, /different maxSlope/);
  throws({ controller: { ...loose, wadeDepth: 0.5 } }, /different wadeDepth/);
  throws({ controller: { ...loose, version: 2 } }, /different version/);
  throws({ controller: loose, level: 5 }, /different level/);
  throws({ controller: loose, wet: new Uint8Array(33 * 33) }, /different wet mask/);
  throws({ controller: loose, snapCells: 2 }, /different snapCells/);
  const copy = { ...hill, data: hill.data.slice() };
  let msg = "";
  try { parRoute(copy, [-100, 0], [100, 0], { reach, controller: loose }); } catch (e) { msg = e.message; }
  ok(/different field/.test(msg), msg);
  // and with matching settings it is used
  eq(parRoute(hill, [-100, 0], [100, 0], { reach, controller: loose }).verdict, "warning");
});

test("a search that cannot finish is an error, never an infinite par", () => {
  // A reach whose mask was edited by hand to claim the plateau: the settings
  // match, the goal is "reached", and Dijkstra still cannot get there.
  const cliff = field(33, 320, (x) => (x > 0 ? 50 : 0) + 100);
  const reach = reachTerrain(cliff, { spawn: [-100, 0] });
  reach.reached[16 * 33 + 18] = 1;
  const r = parRoute(cliff, [-100, 0], [20, 0], { reach });
  eq(r.verdict, "error");
  eq(r.issues.map((x) => x.id).join(), "objective-unreachable");
  eq(r.parSeconds, null); eq(r.distance, null); eq(r.path.length, 0); eq(r.goal, null);
});

test("a missing start is the module's own error", () => {
  const f = field(9, 80, () => 1);
  const reach = reachTerrain(f, { spawn: [0, 0] });
  for (const opts of [{}, { reach }]) {
    let msg = "";
    try { parRoute(f, undefined, [0, 0], opts); } catch (e) { msg = e.message; }
    eq(msg, "parRoute: start [x, z] is required");
  }
});

test("a NaN height is not ground, and neither is the ground beside it", () => {
  const f = field(9, 80, () => 1); // 10 m cells
  f.data[4 * 9 + 4] = NaN;
  const w = walkableCells(f);
  eq(w.walkable[40], 0, "the NaN cell is walkable");
  // its four straight neighbours difference across it, so their gradient is
  // NaN too; the other 76 cells are flat
  eq(w.count, 81 - 5);
  const r = parRoute(f, [-30, 0], [30, 0], {});
  eq(r.verdict, "ok");
  for (const p of r.path) ok(Number.isFinite(p[2]), "the route crossed the NaN");
  ok(r.distance > 60, "the route went straight through the hole");
});

report("terrain-reach");
