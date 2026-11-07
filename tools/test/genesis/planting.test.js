/* The woods a seed's world grows (src/genesis/world/planting.js plantWorld): the same seed plants the same woods,
 * nothing stands in the water or on what is already placed, and the species follow the world's climate. */
import { test, eq, ok, report } from "../kernel/harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { DEFAULT_SEED } from "../../../src/kernel/seed.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { plantWorld, SPECIES } from "../../../src/genesis/world/planting.js";

const params = makeParams({ seed: DEFAULT_SEED });
const sampler = createHeightSampler(params);
const woods = plantWorld({ params, sampler });

test("the same seed plants the same woods, to the record", () => {
  eq(JSON.stringify(plantWorld({ params, sampler: createHeightSampler(params) })), JSON.stringify(woods));
  ok(woods.length > 1000, `only ${woods.length} stems on a world that is mostly land`);
  const other = makeParams({ seed: "K7QN-3F2A-9XBD" });
  ok(JSON.stringify(plantWorld({ params: other, sampler: createHeightSampler(other) })) !== JSON.stringify(woods), "another seed, the same woods");
});

test("nothing is planted in the water, and every stem is a species of the world's climate", () => {
  const level = params.water.level || 0;
  ok(woods.every((t) => sampler(t.x, t.z) >= level + 2.5), "a stem stands in the water");
  ok(woods.every((t) => SPECIES.temperate.includes(t.id)), "a species from another climate");
});

test("what is placed is kept clear", () => {
  const keepClear = [{ x: woods[0].x, z: woods[0].z, r: 120 }];
  const cleared = plantWorld({ params, sampler, keepClear });
  ok(cleared.every((t) => Math.hypot(t.x - keepClear[0].x, t.z - keepClear[0].z) > 100), "a tree grows through a building");
});

report("planting");
