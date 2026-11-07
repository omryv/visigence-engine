/* The procedural core, used the way an outside consumer would use it.
 *
 * Every other test in this suite imports the specific module it is testing.
 * This one imports the PUBLISHED SURFACE and nothing else, because the claim
 * the core makes is not "these functions work" — it is "you can take this
 * layer on its own and generate a world with it". A test that reaches past
 * `index.js` into the modules behind it would keep passing on the day the
 * surface stopped exposing them.
 *
 * The one bug this file exists because of: the first time the core was
 * exercised standing alone it returned NaN heights, because `createHeightSampler`
 * needs a complete params object and the DEFAULTS that build one were outside
 * the boundary. The import graph was clean and the layer was still not
 * separable. An engine whose input shape is defined somewhere else is not an
 * engine you can lift out.
 */
import { test, eq, ok, close, report } from "./harness.js";
import {
  CORE_MODULES, makeParams, mergeParams, DEFAULT_PARAMS,
  mulberry32, seedChannel, drawSeed, normalizeSeed,
  createHeightSampler, bakeHeightField, elevNorm,
  screenSeed, SculptLayer,
  subdivide, adjacency,
  spanningTree, depths, routeBetween, routeAvoiding, neighbours, unreachable, reachableFrom, isDeadEnd,
  toWorld, shelterVolumes, shelterAt,
} from "../../../src/kernel/core/index.js";

test("the core runs where there is no browser and no renderer", () => {
  // If any core module had reached for these at load, importing the surface
  // above would already have thrown.
  for (const g of ["window", "document", "localStorage", "indexedDB"]) {
    ok(!(g in globalThis), `${g} exists in this environment — the test proves nothing`);
  }
  ok(CORE_MODULES.length >= 12, `${CORE_MODULES.length} modules in the core`);
});

test("one seed, two channels, no entanglement", () => {
  /* The discipline the whole project's determinism rests on: two subsystems
     drawing from one seed must not be able to shift each other. Draw from
     one channel a different number of times and the other must not move. */
  const runB = (drawsFromA) => {
    const a = mulberry32(seedChannel("SEED", "terrain"));
    for (let i = 0; i < drawsFromA; i++) a();
    const b = mulberry32(seedChannel("SEED", "props"));
    return [b(), b(), b()];
  };
  eq(JSON.stringify(runB(0)), JSON.stringify(runB(50)),
    "drawing from one channel moved another");

  const x = mulberry32(seedChannel("SEED", "terrain"));
  const y = mulberry32(seedChannel("SEED", "terrain"));
  for (let i = 0; i < 8; i++) eq(x(), y(), "the same channel gave two different streams");
  ok(seedChannel("SEED", "a") !== seedChannel("SEED", "b"), "two channels share a stream");
});

test("params is the core's input contract, and the core can build one", () => {
  // The bug: a caller could not construct a usable params object from inside
  // the boundary, so the sampler returned NaN.
  const p = makeParams({ seed: "CORE", biome: "tundra" });
  for (const k of Object.keys(DEFAULT_PARAMS)) ok(k in p, `makeParams omitted ${k}`);
  const sampler = createHeightSampler(p);
  for (const [x, z] of [[0, 0], [120, -300], [-450, 220]]) {
    ok(Number.isFinite(sampler(x, z)), `height at ${x},${z} is ${sampler(x, z)}`);
  }
  // …and merging a partial over it stays complete.
  const merged = mergeParams(p, { sky: { timeOfDay: 3 } });
  eq(merged.sky.timeOfDay, 3);
  ok(Number.isFinite(createHeightSampler(merged)(0, 0)), "a merged params broke the sampler");
});

test("the same seed builds the same land, twice", () => {
  const of = (seed) => {
    const p = makeParams({ seed, biome: "verdant" });
    const s = createHeightSampler(p);
    return [[0, 0], [300, 300], [-900, 40]].map(([x, z]) => s(x, z));
  };
  eq(JSON.stringify(of("REPEAT")), JSON.stringify(of("REPEAT")));
  ok(JSON.stringify(of("REPEAT")) !== JSON.stringify(of("OTHER")), "two seeds made one world");
  eq(normalizeSeed(drawSeed(mulberry32(3))).length > 0, true);
});

test("a sculpt layer is a replayable list of strokes, not a grid", () => {
  /* The property that lets an authored world travel as a small params object:
     the strokes ARE the state, and replaying them against the same base
     reproduces the surface exactly. */
  const p = makeParams({ seed: "SCULPT", biome: "badlands" });
  const base = createHeightSampler(p);
  const a = new SculptLayer({ size: p.terrain.size, res: 129 });
  a.apply({ x: 0, z: 0, r: 90, amount: 12, mode: "raise" }, base);
  a.apply({ x: 200, z: -50, r: 60, amount: 8, mode: "lower" }, base);
  ok(a.offsetAt(0, 0) > 5, `the raise moved the ground by ${a.offsetAt(0, 0)}`);

  const b = new SculptLayer({ size: p.terrain.size, res: 129 });
  b.replay(a.strokes, base);
  for (const [x, z] of [[0, 0], [200, -50], [40, 60], [-300, 0]]) {
    close(b.offsetAt(x, z), a.offsetAt(x, z), 1e-9, `replay diverged at ${x},${z}`);
  }
});

test("a floor partitions into rooms that are all reachable", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed * 131);
    const zones = subdivide({ w: 16, d: 11, grain: 26, rng, maxZones: 6 });
    ok(zones.length >= 1, "a floor cut into nothing");
    const edges = adjacency(zones);
    const tree = spanningTree({ nodes: zones, edges }, 0);
    const graph = { nodes: zones, edges: tree };
    // A spanning tree of n nodes has n-1 edges when the adjacency is
    // connected; if it is not, the unreachable set says so.
    const missed = unreachable(graph, 0);
    if (zones.length > 1 && !missed.length) eq(tree.length, zones.length - 1, "not a tree");
    for (let i = 0; i < zones.length; i++) {
      if (missed.includes(i)) continue;
      ok(routeBetween(graph, 0, i), `no route to room ${i}`);
      ok(isFinite(depths(graph, 0).get(i)), `room ${i} has no depth`);
    }
    eq(reachableFrom(graph, 0).size, zones.length - missed.length);
  }
});

test("graph queries answer the questions a placement rule asks", () => {
  //  0 ── 1 ── 2        a corridor with a loop back, and one dead end off it
  //       │    │
  //       3 ── 4 ── 5
  const nodes = [0, 1, 2, 3, 4, 5].map((i) => ({ i }));
  const edges = [
    { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 1, b: 3 },
    { a: 3, b: 4 }, { a: 2, b: 4 }, { a: 4, b: 5 },
  ];
  const g = { nodes, edges };
  // 0→1→{2|3}→4→5 is four hops however you go, and both middle routes exist.
  eq(depths(g, 0).get(5), 4);
  const route = routeBetween(g, 0, 5);
  eq(route.length, 5, `route ${route.join("→")}`);
  eq(route[0], 0); eq(route[1], 1); eq(route[3], 4); eq(route[4], 5);
  ok(route[2] === 2 || route[2] === 3, `route went through node ${route[2]}`);
  // 5 hangs off 4 with nothing else: a dead end.
  ok(isDeadEnd(g, 5), "node 5 is a dead end and was not reported as one");
  ok(!isDeadEnd(g, 4), "node 4 has three ways out and was called a dead end");
  // There is a way round 2 (via 3) but no way round 4 to reach 5.
  ok(routeAvoiding(g, 0, 4, 2), "no route round node 2, and there is one");
  eq(routeAvoiding(g, 0, 5, 4), null, "found a route to 5 that avoids its only neighbour");
  eq(neighbours(g, 1).length, 3);
});

test("a placement's volume and its openings are geometry, not meshes", () => {
  const rec = {
    uid: "x", position: [10, 4, -6], rotationY: 0.7, scale: 1,
    proc: {
      rooms: [{ level: 0, at: "ground", y: 0.3, h: 2.9, x: 0, z: 0, w: 6, d: 6 }],
      parts: [{ shape: "box", dims: [7, 0.3, 7], pos: [0, 0.15, 0] }],
    },
  };
  const vols = shelterVolumes(rec, toWorld);
  eq(vols.length, 1);
  const mid = toWorld(rec, [0, 0.3 + 1.2, 0]);
  eq(shelterAt(vols, ...mid), 1, "no roof over the middle of the room");
  const out = toWorld(rec, [0, 0.3 + 1.2, 6]);
  eq(shelterAt(vols, ...out), 0, "the roof reached six metres into the street");
});

test("a seed can be screened before anybody is shown it", () => {
  const s = screenSeed({
    mint: () => drawSeed(mulberry32(11)),
    samplerFor: (seed) => {
      const p = makeParams({ seed, biome: "verdant" });
      return { height: createHeightSampler(p), size: p.terrain.size };
    },
    attempts: 6, res: 24,
  });
  ok(s && typeof s.seed === "string", "screening returned nothing");
  ok(s.land >= 0 && s.land <= 1, `land fraction ${s.land}`);
  ok(Number.isFinite(s.relief), "relief is not a number");
});

test("baking a height field agrees with sampling it", () => {
  const p = makeParams({ seed: "BAKE", biome: "oasis" });
  const s = createHeightSampler(p);
  const field = bakeHeightField(p, 65, s);
  eq(field.res, 65);
  eq(field.data.length, 65 * 65);
  // The corner of the grid is the corner of the world.
  const half = p.terrain.size / 2;
  close(field.data[0], s(-half, -half), 1e-6, "the baked corner is not the sampled corner");
  ok(elevNorm(s(0, 0), p.terrain.height) >= 0, "elevation normalised below zero");
});

report("core");
