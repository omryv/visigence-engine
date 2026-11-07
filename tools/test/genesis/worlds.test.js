/* The worlds.
 *
 * WHAT THIS FILE IS FOR, and it is not "does it run". World grammars that all
 * technically generate is the failure this whole change exists to
 * undo: the editor used to ship four finished worlds that differed in palette,
 * weather and building style and produced the same map, and no test could have
 * told you, because every one of them built something.
 *
 * So the assertions here are about IDENTITY and DIFFERENCE.
 *
 *   identity   each world's composition survives a change of seed. The castle
 *              is on high ground on every seed, the coastal village is on a
 *              coast on every seed, the island world has an island in it and
 *              almost nothing else on every seed.
 *   difference no world is another. Measured, pairwise, on the things
 *              a person actually reads at thumbnail size — extent, water,
 *              density, road structure, palette — and not on their names.
 *   honesty    a world that says it has a moat has water in it; a world that
 *              says it has no roads declares no routes; planting stays out of
 *              the sea and out of the settlements.
 *
 * All of it runs headless. `planWorld` is the same landform pass the build
 * runs, against the analytic surface rather than the eroded one — which is
 * the harder case, since erosion only ever makes ground easier to build and
 * route on.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { WORLDS, WORLD_IDS, WAYS, screenFor, paramsFor, fullParams, planWorld, siteRadius } from "../../../src/genesis/world/worlds.js";
import { shapeWorld } from "../../../src/genesis/world/landform.js";
import { plantCountry } from "../../../src/genesis/world/landform.js";
import { SITE_KINDS, blockSpec, recipeBlocks, makePlan } from "../../../src/genesis/world/worldplan.js";
import { composeSite } from "../../../src/genesis/world/compose.js";
import { isInterior } from "../../../src/genesis/world/interiors.js";
import { PALETTES } from "../../../src/genesis/style/palettes.js";
import { THEMES } from "../../../src/genesis/props/themes.js";
import { DEFAULT_PARAMS } from "../../../src/kernel/presets.js";
import { createHeightSampler, bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { floodFromSea, wetAt } from "../../../src/kernel/water/flood.js";
import { mulberry32 } from "../../../src/kernel/seed.js";

// Seeded, so the file measures the same worlds on every run. A test that
// resamples is a test that fails at random and gets muted.
const stream = (n) => mulberry32(n);
const seedsFor = (world, n, salt = 1) => {
  const rng = stream(0x51EED + salt);
  return Array.from({ length: n }, () => screenFor(world, { rng }).seed);
};
// One plan per (world, seed), memoised: a plan is real generation and this
// file asks several questions of each one.
const plans = new Map();
const plan = (id, seed) => {
  const key = `${id}|${seed}`;
  if (!plans.has(key)) plans.set(key, planWorld(WORLDS[id], seed));
  return plans.get(key);
};
const floodOf = (p) => {
  if (!p._flood) {
    p._flood = floodFromSea(bakeHeightField(p.params, 257, p.shaped.height), null, 0);
  }
  return p._flood;
};

/* ══ the set ══════════════════════════════════════════════════════════ */

test("there are two worlds, and every world cut from the set is gone", () => {
  eq(WORLD_IDS.length, 2, "the rail no longer holds two worlds");
  /* Three generations of dead template: the palette-swap era; Elderreach,
     cut when the set tightened to paired worlds; and then the two castle
     kingdoms. Crownway and Sunhollow were the two heaviest worlds here and
     the two that leaned hardest on a keep the composer had to get right —
     tools/walk-world.mjs was finding eighteen faults in Sunhollow alone,
     rooms with no way into them and roads with water across them. The set is
     the coastal village and the island now: what is left is what the walker
     says is walkable. */
  for (const dead of ["heartland", "nightfall", "bloom", "frostmarch", "elderreach",
                      "crownway", "sunhollow"]) {
    ok(!WORLDS[dead], `${dead} is still in the set`);
  }
  eq(WORLD_IDS.filter((id) => WORLDS[id].lead).length, 1, "exactly one world may lead the rail");
});

test("every world is complete, and names only things that exist", () => {
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    for (const key of ["label", "reads", "line", "inside", "biome", "theme", "terrain", "screen",
                       "land", "places", "planting", "interior"]) {
      ok(w[key] != null, `${id}: no ${key}`);
    }
    ok(PALETTES[w.biome], `${id}: unknown biome ${w.biome}`);
    ok(THEMES[w.theme], `${id}: unknown theme ${w.theme}`);
    ok(w.hour >= 0 && w.hour < 24, `${id}: hour ${w.hour}`);
    ok(["clear", "rain", "snow"].includes(w.weather), `${id}: weather ${w.weather}`);
    for (const p of w.places) {
      ok(SITE_KINDS[p.kind], `${id}: unknown site kind ${p.kind}`);
      ok(["small", "medium", "large"].includes(p.size), `${id}: ${p.kind} size ${p.size}`);
      ok(siteRadius(p) > 8, `${id}: ${p.kind} has no radius`);
    }
    for (const s of w.strays || []) ok(blockSpec(s.block), `${id}: stray block ${s.block} does not exist`);
    for (const sp of w.planting.species) ok(blockSpec(sp), `${id}: planting species ${sp} does not exist`);
  }
});

test("every block a world can reach is procedural and carries no url", () => {
  const ids = new Set();
  for (const id of WORLD_IDS) {
    for (const p of WORLDS[id].places) for (const b of recipeBlocks(p.kind)) ids.add(b);
    for (const s of WORLDS[id].strays || []) ids.add(s.block);
    for (const sp of WORLDS[id].planting.species) ids.add(sp);
  }
  for (const way of Object.values(WAYS)) {
    for (const key of ["block", "junction", "bridge"]) if (way[key]) ids.add(way[key]);
  }
  for (const b of ids) {
    const spec = blockSpec(b);
    ok(spec, `no such block: ${b}`);
    ok(spec.proc?.parts?.length, `${b}: not procedural`);
    ok(!spec.url, `${b}: carries a url`);
  }
});

test("a world's params patch is a whole world, not a hole in one", () => {
  /* The patch names six of the fourteen terrain fields. Splatting rather than
     deep-merging drops octaves, lacunarity, gain and warp — and the terrain
     that then screens is not the terrain that gets built. */
  for (const id of WORLD_IDS) {
    const p = fullParams(WORLDS[id], "TEST-SEED-0001");
    for (const key of Object.keys(DEFAULT_PARAMS.terrain)) {
      ok(p.terrain[key] !== undefined, `${id}: terrain.${key} lost in the merge`);
    }
    eq(p.biome, WORLDS[id].biome);
    eq(p.structure.theme, WORLDS[id].theme);
    ok(Number.isFinite(createHeightSampler(p)(0, 0)), `${id}: sampler returns non-finite`);
    ok(Array.isArray(paramsFor(WORLDS[id], "X").terrain.sculpt), `${id}: sculpt is not an array`);
  }
});

/* ══ the grammar itself ═══════════════════════════════════════════════ */

test("a landform is deterministic, and its strokes are real sculpt strokes", () => {
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    const seed = seedsFor(w, 1)[0];
    const p = fullParams(w, seed);
    const sampler = createHeightSampler(p);
    const a = shapeWorld({ grammar: w.land, seed, size: p.terrain.size, sampler });
    const b = shapeWorld({ grammar: w.land, seed, size: p.terrain.size, sampler });
    eq(JSON.stringify(a.strokes), JSON.stringify(b.strokes), `${id}: landform drifted between runs`);
    eq(JSON.stringify(a.anchors), JSON.stringify(b.anchors), `${id}: anchors drifted between runs`);
    const half = p.terrain.size / 2;
    for (const s of a.strokes) {
      ok(Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.a), `${id}: non-finite stroke`);
      ok(s.r > 0, `${id}: a stroke with no radius`);
      ok(s.m >= 0 && s.m <= 3, `${id}: unknown stroke mode ${s.m}`);
      ok(Math.abs(s.x) < half * 1.05 && Math.abs(s.z) < half * 1.05, `${id}: a stroke off the plate`);
    }
  }
});

test("a second seed is a second world, not a shuffled copy", () => {
  /* The one property that separates a grammar from a scene. Two screened
     seeds must move the composition — the lead site somewhere else, the
     ground under it a different shape — while the world stays the same KIND
     of place, which the identity tests below are what check. */
  for (const id of WORLD_IDS) {
    const [s1, s2] = seedsFor(WORLDS[id], 2);
    ok(s1 !== s2, `${id}: screening returned the same seed twice`);
    const a = plan(id, s1), b = plan(id, s2);
    const la = a.sites.find((s) => s.lead) || a.sites[0];
    const lb = b.sites.find((s) => s.lead) || b.sites[0];
    const moved = Math.hypot(la.x - lb.x, la.z - lb.z);
    ok(moved > a.size * 0.02, `${id}: the lead site moved ${Math.round(moved)} m between seeds`);
    ok(JSON.stringify(a.shaped.strokes) !== JSON.stringify(b.shaped.strokes),
      `${id}: the same land on two seeds`);
  }
});

test("every world puts every place it declares somewhere, on most seeds", () => {
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    let got = 0, want = 0;
    for (const seed of seedsFor(w, 4)) {
      const p = plan(id, seed);
      got += p.sites.length; want += w.places.length;
      for (const s of p.sites) {
        ok(Math.abs(s.x) < p.size * 0.45 && Math.abs(s.z) < p.size * 0.45,
          `${id}: ${s.name} is off the plate`);
      }
    }
    ok(got >= want * 0.9, `${id}: only ${got} of ${want} places found ground over four seeds`);
  }
});

/* ══ identity ═════════════════════════════════════════════════════════
   One test per world, asserting the thing that world IS. These are the
   assertions that would fail if a grammar quietly decayed into the generic
   two-towns-and-a-road every generated world in this engine used to be. */

test("Farshore: a village on a coast, its study on the height, one road that leaves", () => {
  const w = WORLDS.farshore;
  eq(w.places.length, 2, "Farshore is a village and its study, nothing more");
  ok(w.places.find((p) => p.kind === "field-station")?.lead,
    "the study is the building this world is about — it leads");
  for (const seed of seedsFor(w, 3)) {
    const p = plan("farshore", seed);
    eq(p.sites.length, 2, "grew places it did not declare");
    const v = p.sites.find((s) => s.kind === "shore-village");
    const study = p.sites.find((s) => s.kind === "field-station");
    ok(v && study, "a place is missing");
    ok(p.shaped.height(v.x, v.z) > 0, "the village is under water");

    // The sea is close, and there is country behind: that is what a coast is.
    let nearest = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      for (let d = 40; d < 900; d += 40) {
        if (p.shaped.height(v.x + Math.cos(a) * d, v.z + Math.sin(a) * d) < 0) { nearest = Math.min(nearest, d); break; }
      }
    }
    ok(nearest < 520, `the sea is ${nearest === Infinity ? "nowhere" : Math.round(nearest) + " m"} from the village`);

    /* The study has the HIGHER ground — "a research building on higher
       ground" is the reference's whole composition, so it is measured, not
       assumed. And it stands close enough that the path up is a walk. */
    ok(p.shaped.height(study.x, study.z) > p.shaped.height(v.x, v.z) + 6,
      `the study stands ${Math.round(p.shaped.height(study.x, study.z) - p.shaped.height(v.x, v.z))} m over the village`);
    ok(Math.hypot(study.x - v.x, study.z - v.z) < p.size * 0.12,
      "the study is an expedition away from its own town");

    eq(p.shaped.routes.length, 2, "not the two ways Farshore declares");
    const out = p.shaped.routes.find((r) => r.name === "the road out");
    // The road out goes somewhere that is NOT a settlement — the point of it.
    ok(out && !p.sites.some((s) => Math.hypot(s.x - out.to.x, s.z - out.to.z) < s.r + 60),
      "the road out of town arrives at a settlement");
  }
});

test("Lonepalm: an island in an ocean, and the confidence to build nothing else", () => {
  const w = WORLDS.lonepalm;
  eq(w.places.length, 1, "Lonepalm has grown a second settlement");
  eq((w.land || []).filter((s) => s.op === "route").length, 0, "Lonepalm has grown a road");
  eq(w.planting.count, 0, "Lonepalm has grown a forest");
  for (const seed of seedsFor(w, 3)) {
    const p = plan("lonepalm", seed);
    eq(p.shaped.routes.length, 0, "routes on a one-house island");
    const isle = p.shaped.anchors.island[0];
    ok(p.shaped.height(isle.x, isle.z) > 3, "the island did not come out of the water");

    // The ratio IS the identity: measured over the whole plate, not asserted.
    const flood = floodOf(p);
    let dry = 0;
    for (let k = 0; k < flood.wet.length; k++) if (!flood.wet[k]) dry++;
    const land = dry / flood.wet.length;
    ok(land > 0.001, "there is no island at all");
    ok(land < 0.06, `${Math.round(land * 100)}% of the world is land — this one is meant to be ocean`);

    // And there is a beach: the shelf under the island, shallow water round it.
    let shelf = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const h = p.shaped.height(isle.x + Math.cos(a) * 230, isle.z + Math.sin(a) * 230);
      if (h < 0 && h > -30) shelf++;
    }
    ok(shelf >= 12, `only ${shelf}/16 of the lagoon round the island is shallow`);
  }
});

test("every world is a pair: an exterior and the inside of its own landmark", () => {
  /* The product claim this set was rebuilt around: a world is defined by two
     linked views — the aerial, and the room inside the building the aerial
     is composed under. So each world must carry an interior dress, its lead
     place must be enterable, and composing that place must actually produce
     furnished rooms wearing the dress. */
  const cloths = [], walls = [];
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    ok(w.interior && w.interior.cloth != null && w.interior.wood != null,
      `${id}: no interior dress declared`);
    cloths.push(w.interior.cloth);
    /* The three SURFACES, which are the room rather than the things standing
       in it. A world that states its cloths but not its walls is a world
       whose four interiors are the same grey-beige box with different
       furniture in it — which is what all four of these were until the
       shell emitters learned to read a dress. */
    for (const key of ["wall", "floor", "beam", "paint"]) {
      ok(w.interior[key] != null, `${id}: the dress names no ${key}`);
    }
    walls.push(w.interior.wall);
    const lead = w.places.find((p) => p.lead);
    ok(lead, `${id}: no lead place`);
    ok((lead.interiorMax ?? 0) >= 1, `${id}: the landmark cannot be entered`);

    const out = composeSite({
      plan: makePlan({ kind: lead.kind, size: lead.size }),
      center: { x: 0, z: 0 }, seed: "PAIR-TEST-1", sampler: () => 12, waterLevel: 0,
      interiorMax: lead.interiorMax, interiorBudget: 1, dress: w.interior,
    });
    const inn = out.records.filter(isInterior);
    ok(inn.length > 3, `${id}: the landmark interior came out as ${inn.length} pieces`);
    // The dress reached the room: the world's own timber is on some part.
    const worn = new Set();
    for (const r of inn) for (const p of r.proc?.parts || []) worn.add(p.color);
    ok(worn.has(w.interior.wood) || worn.has(w.interior.woodDark) || worn.has(w.interior.cloth),
      `${id}: no interior piece wears the world's dress`);

    /* …and it reached the ROOM ITSELF. Not the partitions — a throne hall is
       one undivided volume and correctly has none — but the ceiling, which
       every furnished room has, and which is the surface both castle plates
       spend half their frame on. Its colour must be the world's. */
    const kinds = new Set(inn.map((r) => r.ref.replace("interior/", "")));
    ok(kinds.has("ceiling"), `${id}: the landmark's rooms are open to the sky`);
    ok(worn.has(w.interior.wall) || worn.has(w.interior.beam),
      `${id}: the room's own surfaces are not the world's`);

    /* Nothing on a dressed surface may take the structure theme's colour on
       top of the world's. The role tints are exterior numbers — 1.85 on
       plaster — and an authored ivory multiplied by them is white. */
    for (const r of inn) {
      const k = r.ref.replace("interior/", "");
      if (k !== "partition" && k !== "ceiling" && k !== "floor" && k !== "stair") continue;
      for (const p of r.proc.parts) {
        ok(p.tint === false, `${id}: ${k} lets the theme re-tint a colour the world authored`);
      }
    }
  }
  eq(new Set(cloths).size, cloths.length, "two worlds share an interior cloth");
  eq(new Set(walls).size, walls.length, "two worlds stand between the same walls");
});

test("no two worlds wear the same palette or the same dressing", () => {
  const biomes = WORLD_IDS.map((id) => WORLDS[id].biome);
  const themes = WORLD_IDS.map((id) => WORLDS[id].theme);
  eq(new Set(biomes).size, biomes.length, "two worlds share a biome");
  eq(new Set(themes).size, themes.length, "two worlds share a structure theme");
});

/* …and it has to still be true IN THE FRAME.
   A theme's role tint is a per-channel multiplier and the material colour
   clamps at 1.0, so a tint authored for a distant sunlit wall can push two
   of three channels over and land every world on the same neutral. That is
   not a subtle loss: Crownway's ivory ashlar and Sunhollow's cream one both
   rendered #ffffe5, the two castle worlds became a palette swap of each
   other, and every check in this file still passed because all of them read
   the authored hex.

   So this one reads what comes OUT. It renders each world's landmark
   masonry through its own theme, exactly as engine/props/Props.js does —
   sRGB → linear, multiply, clamp — and asks whether they are still distinct. */
test("every landmark is its own colour once the theme has been applied", () => {
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const rendered = (color, tint) => {
    const ch = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    // The clamp is the whole point: past 1.0 a channel stops carrying a ratio.
    return ch.map((v, i) => Math.min(1, toLinear(v / 255) * (tint?.[i] ?? 1)));
  };
  const masonry = [];
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    const lead = w.places.find((p) => p.lead);
    // The landmark is the block its recipe centres on.
    const spec = recipeBlocks(lead.kind).map(blockSpec).find((s) => s?.proc?.parts?.length);
    ok(spec, `${id}: the lead site has no block to measure`);
    /* Its biggest WALL — what the eye reads the building as. Deliberately not
       "the biggest masonry part": on both keeps the largest stone-family part
       is the plinth, in `concrete`, and measuring that asks about the step a
       building stands on rather than about the building. Walls wear `stone`,
       `plaster`, or — where a block is painted board, as the pink house is —
       the untextured `paint` role. */
    const WALL = new Set(["stone", "plaster", "none"]);
    let big = null, area = -1;
    for (const p of spec.proc.parts) {
      if (p.emissive != null || p.color == null || !WALL.has(p.tex)) continue;
      const a = (p.dims || [1, 1, 1]).reduce((x, y) => x * y, 1);
      if (a > area) { area = a; big = p; }
    }
    ok(big, `${id}: the landmark has no walls`);
    const role = big.tex === "none" ? "paint" : big.tex;
    const tint = THEMES[w.theme].map?.[role]?.tint;
    const out = rendered(big.color, tint);
    /* NOT A CHANNEL OVER. A clamped channel is one the authored colour can no
       longer reach through: it stops carrying its share of the hue, and — the
       part that is easy to miss — it stops carrying LIGHT, so a lit face and a
       shaded one render the same. Being bright is fine. Being pinned is the
       defect, and it is how Crownway's ivory and Sunhollow's cream both
       arrived in frame as #ffffe5. */
    const over = out.map((v, k) =>
      (toLinear(((big.color >> (16 - 8 * k)) & 255) / 255) * (tint?.[k] ?? 1)) > 1.001);
    ok(!over.some(Boolean),
      `${id}: ${over.filter(Boolean).length} channel(s) of the landmark's walls clamp — `
      + `the authored colour cannot reach the frame, and the wall cannot shade`);
    masonry.push({ id, out });
  }
  for (let i = 0; i < masonry.length; i++) {
    for (let j = i + 1; j < masonry.length; j++) {
      const d = masonry[i].out.reduce((s, v, k) => s + Math.abs(v - masonry[j].out[k]), 0);
      ok(d > 0.06,
        `${masonry[i].id} and ${masonry[j].id} render the same walls — they are a palette swap`);
    }
  }
});

test("no two worlds are the same place", () => {
  /* Not "their names differ". The signature is the things a person reads
     at thumbnail scale, measured off the real plan: how big the plate is, how
     much of it is water, how many places are on it, how many ways join them,
     and how thickly it is planted. Any two worlds must differ on at least
     three of the six, or one of them is a re-skin. */
  const sig = {};
  for (const id of WORLD_IDS) {
    const p = plan(id, seedsFor(WORLDS[id], 1)[0]);
    const flood = floodOf(p);
    let dry = 0;
    for (let k = 0; k < flood.wet.length; k++) if (!flood.wet[k]) dry++;
    sig[id] = [
      Math.round(p.size / 512),                                  // extent
      Math.round((dry / flood.wet.length) * 5),                  // how wet
      p.sites.length,                                            // how settled
      [...new Set(p.shaped.routes.map((r) => r.style))].sort().join("+") || "none",
      (p.sites.find((s) => s.lead) || p.sites[0]).kind,          // what it is about
      Math.round((WORLDS[id].planting.count || 0) / 1500),        // how planted
    ];
  }
  for (let i = 0; i < WORLD_IDS.length; i++) {
    for (let j = i + 1; j < WORLD_IDS.length; j++) {
      const a = sig[WORLD_IDS[i]], b = sig[WORLD_IDS[j]];
      const differ = a.filter((v, k) => v !== b[k]).length;
      ok(differ >= 3,
        `${WORLD_IDS[i]} and ${WORLD_IDS[j]} differ on only ${differ}/6 readings: ${a} vs ${b}`);
    }
  }
});

test("the density profiles are genuinely far apart", () => {
  // From "one house" to "a district" — the range is the argument, so it is
  // measured rather than described.
  const built = {};
  for (const id of WORLD_IDS) {
    const p = plan(id, seedsFor(WORLDS[id], 1)[0]);
    built[id] = p.sites.reduce((s, x) => s + Math.PI * x.r * x.r, 0) / (p.size * p.size);
  }
  const vals = Object.values(built).sort((a, b) => a - b);
  ok(vals[vals.length - 1] / Math.max(vals[0], 1e-9) > 3,
    `the sparsest and densest worlds are within ${(vals[vals.length - 1] / vals[0]).toFixed(1)}× of each other`);
});

/* ══ honesty ══════════════════════════════════════════════════════════ */

test("planting stays out of the sea, off the cliffs and out of the settlements", () => {
  for (const id of WORLD_IDS) {
    const w = WORLDS[id];
    if (!w.planting.count) continue;
    const seed = seedsFor(w, 1)[0];
    const p = plan(id, seed);
    const trees = plantCountry({
      seed, size: p.size, sampler: p.shaped.height, waterLevel: 0,
      species: w.planting.species, count: w.planting.count, bands: w.planting.bands,
      heightRef: p.params.terrain.height,
      clumping: w.planting.clumping ?? 0.6, grain: w.planting.grain ?? 3.4,
      field: p.shaped.field, sites: p.sites, roads: [],
    });
    ok(trees.length > w.planting.count * 0.4,
      `${id}: only ${trees.length} of ${w.planting.count} plants found ground`);
    for (const t of trees) {
      ok(p.shaped.height(t.x, t.z) > 0, `${id}: a plant in the sea`);
      for (const s of p.sites) {
        ok(Math.hypot(s.x - t.x, s.z - t.z) > s.r * 0.6, `${id}: a plant inside ${s.name}`);
      }
    }
    ok(new Set(trees.map((t) => t.id)).size > 1, `${id}: one species everywhere`);
  }
});

test("planting is woods and clearings, not an even fuzz", () => {
  /* The single loudest tell that a world was generated. Uniform rejection
     sampling puts the same number of trees in every hectare; a real
     distribution does not.

     RUN ON FLAT DRY GROUND ON PURPOSE. Over real terrain the water, slope and
     band rules reject most of the map, and the variance that produces swamps
     the density field's own by an order of magnitude — the measurement would
     come out the same with the field switched off, which is exactly the
     failure it is meant to catch. On a featureless plain the ONLY thing that
     can vary the count per cell is the thing under test. */
  const flat = () => 40;
  const SIZE = 4096;
  const common = {
    seed: "WOOD-TEST-0001", size: SIZE, sampler: flat, waterLevel: 0,
    species: ["tree", "pine"], count: 4000, bands: [0.0, 1.0],
    heightRef: 400, sites: [], roads: [],
  };
  const spread = (trees) => {
    const N = 14, cells = new Array(N * N).fill(0);
    for (const t of trees) {
      const i = Math.min(N - 1, Math.max(0, Math.floor((t.x / (SIZE * 0.94) + 0.5) * N)));
      const j = Math.min(N - 1, Math.max(0, Math.floor((t.z / (SIZE * 0.94) + 0.5) * N)));
      cells[j * N + i]++;
    }
    const mean = trees.length / cells.length;
    return Math.sqrt(cells.reduce((s, c) => s + (c - mean) ** 2, 0) / cells.length) / Math.max(mean, 1);
  };
  const even = spread(plantCountry({ ...common, clumping: 0 }));
  const clumped = spread(plantCountry({ ...common, clumping: 0.74, grain: 3 }));
  ok(clumped > even * 1.6,
    `clumped planting is no lumpier than uniform (${clumped.toFixed(2)} vs ${even.toFixed(2)})`);
  // And the clumping must not simply thin the forest out of existence.
  ok(plantCountry({ ...common, clumping: 0.74, grain: 3 }).length > common.count * 0.6,
    "clumping cost most of the forest");
});

test("a way is built out of pieces that tile", () => {
  // Every way runs on the same 6 m module the streets do, because layRoad and
  // alongTo lay them all with the same arithmetic.
  for (const [name, way] of Object.entries(WAYS)) {
    const spec = blockSpec(way.block);
    ok(spec, `${name}: no such block`);
    eq(spec.meta.axis, "x", `${name}: does not run along X`);
    eq(spec.meta.tile, 6, `${name}: is not on the 6 m module`);
    ok(way.bridgeSpan > 0, `${name}: cannot cross water at all`);
  }
});

test("the plan reasons at the world's own waterline, not at zero", () => {
  // planWorld used to leave shapeWorld's `level` unset while buildWorld
  // passed params.water.level — so the rail's card was composed against a
  // coastline the build would immediately contradict on any world with a
  // raised flood. The level must travel from the world's params into the
  // surveyed field the grammar reads.
  const flooded = { ...WORLDS.farshore, water: { ...(WORLDS.farshore.water || {}), level: 25 } };
  const plan = planWorld(flooded, "AAAA-BBBB-CCCC");
  eq(plan.params.water.level, 25, "the world's waterline did not reach params");
  eq(plan.shaped.field.level, 25, "the grammar surveyed a different waterline than the world's");
  // …and the default is still exactly 0.
  eq(planWorld(WORLDS.farshore, "AAAA-BBBB-CCCC").shaped.field.level, 0);
});

report("worlds");
