/* One seed in 2D: terrain-reach's regions, and the overworld projection
 * (js/overworld.js) onto apps/builder2d's adventure genre.
 *
 *   - terrainRegions partitions the walkable ground, and flooding reachTerrain
 *     from any cell of a region reaches exactly that region (the claim its
 *     comment makes, on the default world at the canonical grid);
 *   - the committed level apps/builder2d/tools/test/fixtures/overworld-K7QN
 *     .json is what the projection makes of schema/examples/K7QN.intent.json
 *     compiled at 513² TODAY, byte for byte — so a change to the bake, the
 *     solve or the projection that moves the level fails here, and the
 *     fixture is regenerated with the two commands in README.md rather than
 *     drifting;
 *   - the builder's own two doors accept it: normalizeProject with no
 *     warning, analyzeLevel with the goal reachable;
 *   - the start and the goal are on the largest region, and the 3D route
 *     between them exists;
 *   - the numbers DEEP_WATER's comment quotes: the default world tiled
 *     48 × 48, the water tiles and how many are shallower than 8, 16, 32 and
 *     64 m.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { makeParams } from "../../../src/kernel/presets.js";
import { groundBundle } from "../../../src/kernel/terrain/ground.js";
import { terrainRegions, reachTerrain } from "../../../src/kernel/core/terrain-reach.js";
import { buildWorldFile } from "../../../src/genesis/world/worldfile.js";
import { paramsForIntent } from "../../../src/genesis/world/author.js";
import { projectOverworld, serializeOverworld, TILE, OVERWORLD_SIZE, DEEP_WATER } from "../../../src/genesis/world/overworld.js";
import { builderVerdict } from "../../../bin/genesis.mjs";

const EXAMPLE = JSON.parse(readFileSync(new URL("../../../schema/examples/K7QN.intent.json", import.meta.url), "utf8"));
const FIXTURE = readFileSync(new URL("../fixtures/overworld-K7QN.json", import.meta.url), "utf8");

// ── terrainRegions ──
const plain = groundBundle(makeParams({ seed: "K7QN-3F2A-9XBD" }));
const regions = terrainRegions(plain.field, { level: plain.manifest.waterLevel, wet: plain.wet });
test("terrainRegions labels every walkable cell once, and nothing else", () => {
  let labelled = 0, stray = 0;
  for (let p = 0; p < regions.labels.length; p++) {
    if (regions.labels[p] >= 0) labelled++;
    if ((regions.labels[p] >= 0) !== (regions.walkable[p] === 1)) stray++;
  }
  eq(stray, 0);
  eq(labelled, regions.walkableCount);
  eq(regions.sizes.reduce((a, b) => a + b, 0), regions.walkableCount);
  // The numbers terrain-reach.js quotes for this world.
  eq(regions.sizes.length, 833);
  eq(regions.sizes.filter((s) => s === 1).length, 641);
  ok(regions.sizes.every((s, k) => s <= regions.sizes[regions.largest] && (s < regions.sizes[regions.largest] || k >= regions.largest)), "largest is the largest, the first on a tie");
});

test("reachTerrain flooded from a cell of a region reaches exactly that region", () => {
  const N = plain.field.res, size = plain.field.size;
  const order = regions.sizes.map((s, k) => [s, k]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [s, k] of [order[0], order[1], order[Math.floor(order.length / 2)]]) {
    const p = regions.labels.indexOf(k);
    const i = p % N, j = (p - i) / N;
    const r = reachTerrain(plain.field, { spawn: [(i / (N - 1) - 0.5) * size, (j / (N - 1) - 0.5) * size], level: plain.manifest.waterLevel, wet: plain.wet, snapCells: 0 });
    eq(r.spawnCell, p, `region ${k}: spawned on its own cell`);
    eq(r.reachedCount, s, `region ${k}: reached count`);
    let outside = 0;
    for (let q = 0; q < r.reached.length; q++) if (r.reached[q] && regions.labels[q] !== k) outside++;
    eq(outside, 0, `region ${k}: reached only itself`);
  }
});

test("DEEP_WATER's numbers: the default world tiled 48 × 48 has 493 water tiles, 38 of them under 32 m", () => {
  // The projection's own water rule (js/overworld.js): a tile is water when
  // at least half its lattice cells are wet, and its depth is their mean.
  const { field, wet } = plain, N = field.res, level = plain.manifest.waterLevel, W = 48, c = N / W;
  const depths = [];
  for (let ty = 0; ty < W; ty++) for (let tx = 0; tx < W; tx++) {
    const a0 = Math.floor(tx * c), a1 = Math.max(a0 + 1, Math.ceil((tx + 1) * c));
    const b0 = Math.floor(ty * c), b1 = Math.max(b0 + 1, Math.ceil((ty + 1) * c));
    let n = 0, wn = 0, d = 0;
    for (let j = b0; j < b1 && j < N; j++) for (let i = a0; i < a1 && i < N; i++) {
      const p = j * N + i; n++;
      if (wet[p]) { wn++; d += level - field.data[p]; }
    }
    if (wn * 2 >= n) depths.push(d / wn);
  }
  const under = (m) => depths.filter((x) => x < m).length;
  eq(depths.length, 493);
  eq(JSON.stringify([under(8), under(16), under(32), under(64)]), JSON.stringify([0, 1, 38, 134]));
  eq(DEEP_WATER, 32);
});

// ── the projection ──
const { params } = paramsForIntent(EXAMPLE);
const bundle = groundBundle(params);
const world = buildWorldFile({ params, propRecords: [], field: bundle.field, world: null, ground: bundle.manifest });
const made = projectOverworld(world);
const again = projectOverworld(JSON.parse(JSON.stringify(world)));

test("the committed level is what the example compiles and projects to today, byte for byte", () => {
  eq(serializeOverworld(made.project) === FIXTURE, true,
    "apps/builder2d/tools/test/fixtures/overworld-K7QN.json has drifted — regenerate it (README.md, For AI authors)");
  eq(serializeOverworld(again.project), serializeOverworld(made.project), "deterministic");
});

test("the builder loads it with no warning and finds the goal reachable", () => {
  const v = builderVerdict(made.project);
  eq(v.warnings.length, 0, v.warnings.join("; "));
  ok(v.goalReachable);
  eq(v.errors.length, 0, v.errors.join(", "));
});

test("start and goal stand on the largest region, joined in 2D and in 3D", () => {
  const r = made.report;
  eq(r.width, OVERWORLD_SIZE.width); eq(r.height, OVERWORLD_SIZE.height);
  ok(r.route.verdict !== "error");
  ok(r.steps2d > 0);
  const lvl = made.project.levels[0];
  const ents = Object.fromEntries(lvl.entities.map((e) => [e.id, e]));
  eq(ents.start.type, "player"); eq(ents.goal.type, "goal");
  const r2 = terrainRegions(bundle.field, { level: bundle.manifest.waterLevel, wet: bundle.wet });
  const N = bundle.field.res, size = bundle.field.size;
  const cell = ([x, z]) => Math.round((z / size + 0.5) * (N - 1)) * N + Math.round((x / size + 0.5) * (N - 1));
  eq(r2.labels[cell(r.start.world)], r2.largest, "start on the largest region");
  eq(r2.labels[cell(r.goal.world)], r2.largest, "goal on the largest region");
  const counts = Object.values(r.counts).reduce((a, b) => a + b, 0);
  eq(counts, r.width * r.height);
  eq(JSON.stringify(Object.keys(TILE).sort()), JSON.stringify(["path", "pond", "tallgrass", "wall"]));
});

test("a world whose ground block is not its bake is refused, and so is a size the genre cannot hold", () => {
  const lying = JSON.parse(JSON.stringify(world));
  lying.ground.heightHash = (lying.ground.heightHash ^ 1) >>> 0;
  let threw = null;
  try { projectOverworld(lying); } catch (e) { threw = e; }
  ok(threw && /ground block/.test(threw.message), String(threw));
  threw = null;
  try { projectOverworld(world, { width: 200, height: 32 }); } catch (e) { threw = e; }
  ok(threw instanceof RangeError, String(threw));
});

report("overworld");
