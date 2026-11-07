// Seed-issuing contracts. The landing film hands the editor a real world, so
// what the screen picks has to be a seed the engine would have produced on its
// own — and the two pages have to agree on where it is parked in between.
import { test, eq, ok, report } from "./harness.js";
import { screenSeed } from "../../../src/kernel/core/survey.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { normalizeSeed, drawSeed, mulberry32 } from "../../../src/kernel/seed.js";

test("screening issues a seed with land on it", () => {
  let drawn = 0;
  const names = ["AAAA-AAAA-AAAA", "BBBB-BBBB-BBBB", "CCCC-CCCC-CCCC"];
  const pick = screenSeed({
    mint: () => names[drawn++ % names.length],
    samplerFor: (seed) => {
      // Only the third candidate is a workable world; the first two are an
      // ocean and a plateau with no relief. The cone's shoreline sits at
      // r ≈ 1 315 m, so a bit over half the screened box comes out dry.
      const shape = seed === "CCCC-CCCC-CCCC"
        ? (x, z) => 220 - Math.hypot(x, z) * 0.167
        : seed === "AAAA-AAAA-AAAA" ? () => -300 : () => 40;
      return { height: shape, size: 4096 };
    },
    res: 24,
  });
  eq(pick.seed, "CCCC-CCCC-CCCC");
  eq(pick.screened, true);
  ok(pick.land > 0.38 && pick.land < 0.82, `land fraction ${pick.land}`);
  ok(pick.relief > 180, `relief ${pick.relief}`);
});

test("an all-ocean world is rejected, a flat one too", () => {
  for (const shape of [() => -300, () => 40]) {
    const pick = screenSeed({
      mint: () => "ZZZZ-ZZZZ-ZZZZ",
      samplerFor: () => ({ height: shape, size: 4096 }),
      attempts: 3, res: 16,
    });
    eq(pick.screened, false, "a world with no land or no relief passed the screen;");
  }
});

test("screening still issues something when nothing clears the bar", () => {
  // A page the visitor is already looking at must not loop forever waiting
  // for a world it likes.
  const pick = screenSeed({
    mint: () => "ZZZZ-ZZZZ-ZZZZ",
    samplerFor: () => ({ height: () => -900, size: 4096 }),
    attempts: 5, res: 16,
  });
  eq(pick.seed, "ZZZZ-ZZZZ-ZZZZ");
  eq(pick.screened, false);
});

test("a screened seed is a real world seed, not a doctored one", () => {
  // The screen picks AMONG candidates; it must never mint something the
  // engine would not have produced on its own, or the world the editor grows
  // is not the world the page named.
  const issued = [];
  const pick = screenSeed({
    mint: () => { const s = `SEED-${issued.length}-XXXX`; issued.push(s); return s; },
    samplerFor: () => ({ height: (x, z) => 200 - Math.hypot(x, z) * 0.16, size: 4096 }),
    res: 16,
  });
  ok(issued.includes(pick.seed), "screen returned a seed it never drew");
});

test("it stops drawing as soon as one passes", () => {
  let drawn = 0;
  screenSeed({
    mint: () => { drawn++; return "GOOD-GOOD-GOOD"; },
    samplerFor: () => ({ height: (x, z) => 220 - Math.hypot(x, z) * 0.167, size: 4096 }),
    attempts: 24, res: 16,
  });
  eq(drawn, 1, "screening kept drawing after a candidate passed;");
});

test("what the screen issues survives the trip to the editor", () => {
  // The landing writes a seed and the editor runs it through normalizeSeed
  // before trusting it. A real minted seed has to come back unchanged.
  const rng = mulberry32(40);
  for (let i = 0; i < 40; i++) {
    const s = drawSeed(rng);
    eq(normalizeSeed(s), s, "a minted seed did not survive normalization;");
  }
});

test("the terrain that is screened is the terrain that boots", () => {
  // The screen samples makeParams({seed}); the editor boots makeParams({seed}).
  // If those two ever produced different surfaces the screening would be
  // measuring a world nobody is shown, and the biome must not move the ground
  // under it either.
  const seed = "K7QN-3F2A-9XBD";
  const a = createHeightSampler(makeParams({ seed }));
  const b = createHeightSampler(makeParams({ seed, biome: "tundra" }));
  for (const [x, z] of [[0, 0], [412, -900], [-1500, 1500]]) {
    eq(a(x, z), b(x, z), `biome changed the ground at ${x},${z};`);
  }
});

test("the coastline the screen measures is the world's own waterline", () => {
  // The same cone measured at two levels: at the natural coastline it is a
  // workable island; with the flood raised 150 m most of it is drowned and
  // the screen must SAY so rather than counting wet ground as land. y > 0
  // used to be hardcoded, which screened a raised-flood world against a
  // coastline the renderer would immediately contradict.
  const cone = (x, z) => 220 - Math.hypot(x, z) * 0.167;
  const at = (level) => screenSeed({
    mint: () => "CONE-CONE-CONE",
    samplerFor: () => ({ height: cone, size: 4096, level }),
    attempts: 1, res: 24,
  });
  const natural = at(0), flooded = at(150);
  ok(natural.land > flooded.land, `raising the flood must shrink the land: ${natural.land} vs ${flooded.land}`);
  ok(flooded.land < 0.38, "a mostly-drowned cone still screened as workable");
  // …and omitting the level entirely is exactly level 0.
  const legacy = screenSeed({
    mint: () => "CONE-CONE-CONE",
    samplerFor: () => ({ height: cone, size: 4096 }),
    attempts: 1, res: 24,
  });
  eq(legacy.land, natural.land, "the default moved — existing callers changed behaviour");
});

report("survey");
