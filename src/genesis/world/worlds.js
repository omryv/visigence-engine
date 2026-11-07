/* worlds.js — FOUR WORLD GRAMMARS, ONE ENGINE.
 *
 * Everything else in this editor is a tool: a brush you aim, a recipe you
 * place, a catalogue you pick from. All of it is correct and all of it assumes
 * the person holding it already knows what a world is supposed to be made of.
 * Most people opening this do not, and asking them to sculpt a valley before
 * they have seen the thing work is asking them to earn the demo.
 *
 * A WORLD is the other door. Press one and the tool does what a level designer
 * would do with a week — but the interesting claim is not the amount of work,
 * it is that the four of them are four different KINDS of place rather than
 * four colour schemes over one.
 *
 * ── what makes them different, and what does not
 *
 * The thing that used to differ between the editor's finished worlds was
 * palette, weather and building style, and it was not enough: four templates
 * all put two or three towns on the flattest dry ground and ran a road between
 * them, so at any distance where you could see the whole map they were the
 * same map. Recognition does not live in materials. It lives in:
 *
 *   TERRAIN        what the ground is doing at kilometre scale
 *   SILHOUETTE     what the tallest thing is, and how much taller
 *   HIERARCHY      the order the eye reads the parts in from above
 *   WATER TOPOLOGY where the sea is, and whether it wraps, cuts or surrounds
 *   DENSITY        how much of the map is built on — from 0.3% to a district
 *   ROAD STRUCTURE straight ceremony, one dirt lane out of town, or nothing
 *
 * So a world here is FOUR pieces of data and no code of its own:
 *
 *   terrain    the noise the seed grows, and the bar a seed has to clear
 *   land       a landform grammar (js/landform.js) — where the ground is read
 *              and where it is cut, and which anchors the composition hangs on
 *   places     which site recipe (js/worldplan.js) stands on which anchor
 *   dressing   biome palette (and, where a world wants more than one kind of
 *              country, the CLIMATE that decides where each falls), structure
 *              theme, hour, weather, planting
 *
 * ── press it twice
 *
 * A world is not a scene. Nothing is stored, nothing is downloaded, and every
 * metre is generated from a seed screened at build time against that world's
 * own bar. Press the same one again and the castle is on a different hill,
 * the river takes a different course to a different coast, the town is on the
 * other side of the water and the forest is somewhere else — and it is
 * unmistakably the same world, because the grammar said "high ground in the
 * inner half" and "a fifth of the world away, whichever way has land" rather
 * than naming a coordinate.
 *
 * Everything it makes is ordinary. The blocks are the same blocks the
 * catalogue places, the strokes are the same strokes the sculpt brush writes,
 * and one ⌘Z takes the whole thing back off again.
 *
 * No three.js import: the engine arrives as an argument, so the planning half
 * of this file runs headless — which is how the suite checks the grammars and
 * how the Worlds rail draws a real plan of each one on its card.
 */

import { makeParams, mergeParams } from "../../kernel/presets.js";
import { createHeightSampler, bakeHeightField } from "../../kernel/terrain/heightfield.js";
import { CANONICAL_RES } from "../../kernel/terrain/canonical.js";
import { floodFromSea, wetAt } from "../../kernel/water/flood.js";
import { conditionSeed } from "../../kernel/core/survey.js";
import { mulberry32, seedChannel, randomSeed } from "../../kernel/seed.js";
import { makeUid, nextUidIndex } from "./fusion.js";
import { composeSite } from "./compose.js";
import { makePlan, blockSpec, SITE_KINDS } from "./worldplan.js";
import { groundBuildings } from "./footing.js";
import { planRoute, planAvenue, layRoad } from "./roadnet.js";
import { shapeWorld, plantCountry, placeStrays } from "./landform.js";

/* ══════════════════════════════════════════════════════════════════════════
   THE WAYS

   Which pieces a declared route is actually built out of. A world says
   "avenue" or "track"; this is the only place that knows an avenue is a
   fifteen-metre band of pale stone laid dead straight and a track is old
   paving that goes round the hill. `bridgeSpan` is how much open water the
   way will deck rather than ford — a ceremonial approach crosses its moat,
   a country lane does not build a causeway across a bay.
   ══════════════════════════════════════════════════════════════════════════ */
export const WAYS = {
  avenue: { block: "avenue", junction: null, bridge: "bridge", straight: true,
            bridgeSpan: 170, pad: { every: 2, radius: 22, amount: 6 } },
  lane:   { block: "lane", junction: "junction", bridge: "bridge",
            bridgeSpan: 95, pad: { every: 4, radius: 13, amount: 3.2 } },
  track:  { block: "track", junction: "junction", bridge: "bridge",
            bridgeSpan: 145, pad: { every: 4, radius: 14, amount: 3.4 } },
  road:   { block: "road", junction: "junction", bridge: "bridge",
            bridgeSpan: 60, pad: { every: 4, radius: 13, amount: 3.2 } },
};

/* ══════════════════════════════════════════════════════════════════════════
   THE FOUR

   Written as data because that is what they are. No world is allowed a branch
   of its own anywhere below this table: if a world needs behaviour the others
   do not have, that behaviour becomes an OP — in the landform grammar or in a
   site recipe — and every other world can then reach for it too. That rule is
   the difference between one engine with N grammars and N special cases
   wearing a shared name.
   ══════════════════════════════════════════════════════════════════════════ */
export const WORLDS = {
  /* ── 01 ───────────────────────────────────────────────────────────────
     SMALL COASTAL STARTING VILLAGE.

     The harder of the two, because its identity is what is NOT there. Five
     or six houses standing apart on grass, one larger hall on the rise behind
     them, a couple of worked plots, the sea on one side and the forest
     starting almost immediately on the other. One dirt lane leaves town and
     stops in the trees — it goes somewhere, and the somewhere is not on this
     map. The empty ground is the composition; overbuilding it is the only way
     to get this world wrong. */
  farshore: {
    label: "Farshore",
    lead: true,
    reads: "Small coastal starting town under its study",
    line: "A handful of houses on the grass above a bay, a field study on the height "
        + "behind them, and one dirt lane that leaves town and stops in the trees.",
    biome: "shoreland",
    /* AND THE COUNTRY BEHIND THE TOWN IS NOT THE SHORE. The lane leaves the
       village and stops in the trees, and until now it stopped in ground
       painted exactly like the beach it started from, because a world wore
       one palette from the waterline to the last hill.

       `climate` names the biomes this world's ground may be, and where each
       one falls follows two slow temperature/moisture fields
       (engine/terrain/climate.js) rather than a coordinate — so on every seed
       the shore is shoreland's sand and evergreen, the open country inland
       reads as parkland's brighter lawn, and the border between them lands
       somewhere different each time.

       shoreland first because the primary biome still owns the water, the
       sky, the fog and the materials; parkland because it is 0.284 away in
       climate space, which measured leaves 71% of the plate committed to one
       biome or the other. Weald is the obvious thematic partner for a wooded
       inland and it is 0.082 away — the same climate wearing another name,
       and the field would have painted the whole world in the average of the
       two. climate.js drops a pairing that close rather than blending it. */
    climate: ["shoreland", "parkland"],
    theme: "homestead",
    /* Late morning, thin air. At 9.4 with a 0.17 haze the plate rendered
       overcast-grey, and the reference town is having a SUNNY day — the
       whole friendly-beginning read depends on it. */
    hour: 10.6,
    haze: 0.09,
    weather: "clear",
    sky: { cloudCover: 0.22, turbidity: 2.2 },
    water: { preset: "ocean", waveHeight: 0.5 },
    terrain: { size: 3072, ridged: 0.34, plateau: 0.08, island: 0.3, frequency: 1.5,
               height: 320, seaLevel: 0.3, erosion: { enabled: true, drops: 30000 } },
    screen: { land: [0.18, 0.6], relief: 120 },

    land: [
      { op: "anchor", role: "village", find: "coast", band: [0.1, 0.5], minLand: 0.25 },
      /* A low green shelf above the sand. The coast finder does its job and
         picks ground a metre or two above the waterline, which is inside the
         palette's beach band — so the houses came out standing on the beach
         rather than above it. Nine metres of lift is the difference between a
         village on a shore and a village on a sandbank. */
      { op: "mount", at: "village", r: 210, rise: 9, lobes: 3, flatness: 0.55 },
      { op: "level", at: "village", r: 140, amount: 5 },
      /* The study's height. Inland of the village and LIFTED — the reference
         composition is a town read from its own research building's porch,
         which only works if the building actually has the higher ground. The
         mount is offset from the village by less than the route detour cap,
         so the path up is a path, not an expedition. */
      { op: "offset", role: "height", from: "village", distance: [0.09, 0.14], bearing: "open" },
      /* Twenty-four metres, not fifteen: the offset scores for open ground,
         not high ground, so on some seeds it starts BELOW the village's own
         nine-metre shelf — and a study four metres over its town has not got
         the higher ground, it has got a speed bump. The mound op normalises
         to the asked-for rise, so this clears the village on every seed. */
      { op: "mount", at: "height", r: 130, rise: 24, lobes: 3, flatness: 0.5 },
      // Where the lane goes: inland, into whatever country the seed grew. No
      // settlement stands on it, and that is the point of it.
      { op: "offset", role: "wild", from: "village", distance: [0.3, 0.42], bearing: "open" },
      { op: "route", from: "village", to: "height", style: "lane", name: "the study path" },
      { op: "route", from: "village", to: "wild", style: "lane", name: "the road out" },
    ],
    places: [
      /* The study LEADS. The village is most of the pieces, but the world is
         about the building that watches over it — the arrival lands on the
         study, and the study is the interior this world is paired with. */
      { role: "height", kind: "field-station", size: "small", name: "the study", interiorMax: 1, lead: true },
      { role: "village", kind: "shore-village", size: "medium", name: "the village", interiorMax: 6 },
    ],
    /* ELEVATED, and framed on the VILLAGE rather than on the study. The lead
       place is overloaded — it is the spawn and the paired interior as well
       as the camera's subject — so without this the arrival is a portrait of
       a thirty-metre research hut, where the plate is the whole settlement
       with the hut on its rise and the forest behind. */
    arrival: { fill: 0.5, rake: 0.66, thirds: 0.22, frame: 230 },
    inside: "Inside the study: off-white walls, exposed timber, maps and a brass instrument.",
    /* Inside, Farshore is HONEY TIMBER AND PAPER: a sunlit workroom of maps,
       books and instruments over a red rug, and the cottages below keep the
       same warm wood. The study's telescope comes from its own programme
       (a landmark classified as a working study); the dress is what makes
       the room read warm instead of municipal.

       The reference room is TIMBER AND WHITEWASH, and the ratio matters: the
       floor and the frame are wood, the walls between them are not. Take the
       off-white away and the room goes to log cabin; take the timber away and
       it goes to clinic. */
    interior: {
      wood: 0xb07c4c, woodDark: 0x7c5632, woodPale: 0xd8ac74,
      cloth: 0xb85040, clothAlt: 0x8fae6a, paper: 0xe8dcb4, stone: 0xcfc8b8,
      // Off-white boarding, DARK beams across it: the reference study's
      // ceiling is white between its timbers, not timber all over.
      wall: 0xece6da, floor: 0xba8a55, beam: 0x6b4a2c, board: 0xeae5da, paint: 0xa8794a,
      glow: 0xffcf9a, glowPower: 1.2, grime: 0.35,
    },
    strays: [
      { block: "lodge", count: 1, along: true, offset: 40 },
      { block: "fence", count: 6, along: true, offset: 20 },
    ],
    // Dense and tight to the village: the forest is supposed to feel like the
    // edge of the world you are standing at the beginning of.
    planting: { species: ["pine", "pine", "tree", "birch", "bush"], count: 4200,
                bands: [0.04, 0.62], clumping: 0.68, grain: 4.6,
                nearRole: "village", nearPull: 0.38, nearReach: 0.66 },
    grass: 26,
  },

  /* ── 02 ───────────────────────────────────────────────────────────────
     TINY PINK HOUSE LOST IN AN OCEAN.

     The procedural challenge here is restraint, and it is a real one: every
     instinct this engine has is to fill a map. So the terrain is tuned to
     grow NO LAND AT ALL — the screen bar demands under two per cent — and the
     only ground in the world is an island the landform raises out of the
     shallowest water it can find. One house, five palms, a jetty. Nothing
     else, no roads, no planting, and the ratio between the water and the
     island IS the identity. */
  lonepalm: {
    label: "Lonepalm",
    reads: "Tiny pink house lost in an ocean",
    line: "One pink house on a sand island, five palms and a jetty. Everything else, "
        + "for two kilometres in every direction, is water.",
    biome: "atoll",
    theme: "seaside",
    hour: 12.6,
    haze: 0.08,
    weather: "clear",
    sky: { cloudCover: 0.22, turbidity: 1.8 },
    water: { preset: "ocean", waveHeight: 0.42 },
    // No erosion: there is nothing above water to erode, and the pass would
    // cost four seconds to rearrange a seabed nobody will ever see.
    terrain: { size: 2048, ridged: 0.18, plateau: 0, island: 0, frequency: 0.85,
               height: 200, seaLevel: 0.8, erosion: { enabled: false, drops: 0 } },
    screen: { land: [0, 0.02], relief: 18 },

    land: [
      { op: "anchor", role: "island", find: "shallow", band: [0.06, 0.34] },
            /* A smaller island in the SAME lagoon: the shelf radii are multiples of
         the island's, so shrinking the sand without widening them would have
         pulled the pale water in with it. The ring of shallows is half the
         picture. */
      { op: "island", at: "island", r: 102, to: 7.5, lobes: 5, shelfR: 5.0, lagoonR: 2.9 },
    ],
    places: [
      { role: "island", kind: "sand-cottage", size: "medium", name: "the island", interiorMax: 1, lead: true },
    ],
    /* EXTREME NEGATIVE SPACE, AND DEAD CENTRE. This is the only world whose
       subject is a RATIO — a toy-sized island against two kilometres of sea —
       and it is the one thing the default framing cannot express: at 0.88
       fill the island is a portrait of a house and the ocean is a backdrop,
       which is the picture inverted. `thirds: 0` because a dot parked off
       centre reads as a mistake rather than as composition, and the plate
       has it exactly in the middle. */
    arrival: { fill: 0.13, rake: 0.5, thirds: 0 },
    inside: "Inside the house: pink boards, white rafters, a coral settee, mint by the kitchen.",
    /* Inside the pink house: CORAL AND MINT OVER WARM BOARDS. One room of
       soft domestic comfort — the settee coral, the second cloth mint, pale
       bright timber — because the whole world is one interior and it has to
       land the first time.

       And the room itself is THREE surfaces, which is the entire reference
       plate: pink painted boarding on the walls, WHITE rafters over it, and a
       honey floor under both. Nothing else in the room is doing that work —
       take the white ceiling away and the pink closes over your head like a
       box. `paint` is the mint, so the kitchen run comes out green against
       the pink exactly as the plate has it. */
    interior: {
      wood: 0xc08a56, woodDark: 0x8a6038, woodPale: 0xe2ba8a,
      cloth: 0xe8685c, clothAlt: 0x9fd4bc, paper: 0xeee0c8, stone: 0xd8cdb8,
      // White rafters over white boarding — the beach house's whole upper
      // half, and the thing that keeps the pink from closing over your head.
      wall: 0xeeb0b4, floor: 0xd79f63, beam: 0xefe6d6, board: 0xf8f3ea, paint: 0x9fd4bc,
      glow: 0xffd9a8, glowPower: 1.25, grime: 0.2,
    },
    strays: [],
    planting: { species: [], count: 0, bands: [0, 1] },
    // Not one blade. Painted grass on a sand spit is the single detail that
    // would say nobody looked at this world.
    grass: 0,
  },
};

export const WORLD_IDS = Object.keys(WORLDS);

/* ── the seed ──
   Every seed is a world. This used to be a search: mint candidates, measure
   what they grew, keep the first that cleared the world's bar — and if thirty
   draws found nothing, issue the closest, because a build button that can
   decline to build is not a build button. Measured on the default terrain,
   four candidates in five failed the bar.

   Now the first seed drawn is the seed built. If it misses the bar it is
   CARRIED onto it: engine/core/survey.js conditionSeed returns the intent
   (engine/terrain/condition.js) that makes this seed clear this bar, by the
   least improbable change to its own lattice — the continent swells or sinks
   until the land is right, and if the relief is short the seed's own highest
   ground becomes a crest. A seed that already clears the bar is untouched.

   The bars disagree violently on purpose. Farshore wants a real coast with
   a height behind it and Lonepalm wants under two per cent land, and a single
   global screen would hand both of them the same compromise: the middling
   green continent that every generated world in this engine used to be.

   ── and the same seed is the same world ──
   The intent is a pure function of (world, seed), so it is never stored here
   and never needs to be: paramsFor derives it the same way screenFor does,
   from the same memo. Name a seed — a redo, a rebuild — and the identical
   intent comes back with it, so the world that comes back is the world that
   was built. */
const DEFAULT_BAR = { land: [0.4, 0.85], relief: 160 };
const barOf = (world) => world.screen || DEFAULT_BAR;

/* One conditioning per (world, seed). A build asks twice — screenFor, then
   paramsFor — and the suite asks of the same seeds many times over. Bounded,
   oldest out first; the answer is deterministic, so eviction only costs time. */
const CONDITIONED = new WeakMap();
const CONDITIONED_CAP = 256;
function conditionFor(world, seed) {
  let memo = CONDITIONED.get(world);
  if (!memo) CONDITIONED.set(world, (memo = new Map()));
  let found = memo.get(seed);
  if (!found) {
    // A DEEP merge, not a spread. `world.terrain` names six of the fourteen
    // terrain fields; splatting it over the defaults drops octaves,
    // lacunarity, gain and warp, and every seed would then be conditioned
    // against a world nobody is going to build. The patch also carries the
    // world's own waterline, which conditionSeed measures land against — a
    // raised flood is sea, not land that happens to be wet.
    const params = mergeParams(makeParams({ seed }), patchFor(world, seed));
    found = conditionSeed({ params, bar: barOf(world) });
    memo.set(seed, found);
    if (memo.size > CONDITIONED_CAP) memo.delete(memo.keys().next().value);
  }
  return found;
}
// Fresh copies out of the memo: a caller holding params may edit them.
const intentOf = (found) => found.intent.map((r) => ({ ...r }));

export function screenFor(world, { attempts = 34, rng = null, seed = null } = {}) {
  const bar = barOf(world);
  /* A NAMED seed is built, not replaced. It is conditioned exactly as a drawn
     one would be — deterministically, so a world reopened from its seed comes
     back as the world that was saved — and the caller is told what it grew. */
  const rounds = seed ? 1 : attempts;
  let best = null;
  for (let attempt = 0; attempt < rounds; attempt++) {
    const s = seed || randomSeed(rng || undefined);
    const found = conditionFor(world, s);
    const one = {
      seed: s, land: found.land, relief: found.relief, intent: intentOf(found),
      conditioned: found.conditioned, nats: found.nats, attempt,
    };
    if (seed) return { ...one, screened: found.met, pinned: true };
    if (found.met) return { ...one, screened: true };
    /* Conditioning could not carry this seed onto the bar — which no seed in
       the suite's sweep does, but the loop that used to be the whole search is
       kept as the backstop rather than trusting that it never will. */
    const mid = (bar.land[0] + bar.land[1]) / 2;
    const score = -Math.abs(one.land - mid) + Math.min(one.relief / (bar.relief * 1.4 || 1), 1) * 0.4;
    if (!best || score > best.score) best = { ...one, screened: false, score };
  }
  return best;
}

/** A complete params object for a world+seed — the patch below, deep-merged
    into the defaults. Anything that needs a SAMPLER rather than a patch (seed
    screening, the rail's preview, the suite) goes through here. */
export function fullParams(world, seed, dress = null) {
  return mergeParams(makeParams({ seed }), paramsFor(world, seed, dress));
}

/** The params a world wants, as one patch.
 *
 *  `dress` is the OPTIONAL second opinion, and the only caller that has one is
 *  the machine page: a person who typed "an old town in the rain" has named
 *  three things this function otherwise takes from the grammar. It may carry
 *  `hour`, `weather`, `haze` and `theme`, and it carries a key ONLY when the
 *  brief actually said so (js/make-brief.js) — an absent key must fall through
 *  to the world's own value rather than to a default, or every brief would
 *  quietly reset the weather to clear.
 *
 *  Deliberately a narrow door. The grammar owns the world's IDENTITY — its
 *  terrain, its biome, its water, its places, its planting — and none of that
 *  is reachable from here, because a brief that could move the sea level is a
 *  brief that can break the composition its own grammar was tuned for. What is
 *  reachable is the dressing: what hour it is, what the weather is doing, how
 *  far you can see, and how old the buildings look. */
export function paramsFor(world, seed, dress = null) {
  const patch = patchFor(world, seed, dress);
  // The intent that carries this seed onto this world's bar — [] for a seed
  // that clears it unaided. Written even when empty, so applying the patch
  // clears whatever intent the previous world carried.
  if (seed) patch.terrain.intent = intentOf(conditionFor(world, seed));
  return patch;
}

/* The patch without the intent: what conditioning is measured against. */
function patchFor(world, seed, dress = null) {
  const d = dress || {};
  return {
    seed,
    biome: world.biome,
    /* A world that names no climate is one biome everywhere, which is what
       every world here was until Farshore named two. Written explicitly as
       null rather than omitted so the patch always fully describes the
       world's dressing — a grammar losing its climate must clear the field,
       not inherit the last one. */
    climate: world.climate ? { biomes: [...world.climate], scale: world.climateScale ?? 1 } : null,
    structure: { theme: d.theme ?? world.theme },
    terrain: { ...world.terrain, sculpt: [], intent: [] },
    /* The spread stays after the world's own sky block, because a grammar may
       state a cloud cover and a turbidity that belong to it whatever hour the
       brief asks for — and before nothing, because the two the brief may name
       have to win. */
    sky: { timeOfDay: world.hour, weather: world.weather, ...(world.sky || {}),
           ...(d.hour === undefined ? {} : { timeOfDay: d.hour }),
           ...(d.weather === undefined ? {} : { weather: d.weather }) },
    fog: { density: d.haze ?? world.haze },
    water: { level: 0, ...(world.water || {}) },
    props: { grass: { patches: [] }, scatter: [] },
    fx: { fires: [] },
  };
}

/** A complete height sampler for a world+seed, with its landform applied.
    Headless: no engine, no erosion, no renderer. This is what the Worlds rail
    draws its preview from, and what the suite measures a grammar with.

    KNOWN LIMIT: the preview reasons on the UN-ERODED base. Erosion is
    resolution-dependent (erosion.js header) and cannot be faked at 56² — a
    low-res pass is a different world, worse than none — so the card's coasts
    and routes can differ in detail from the built world's. The water LEVEL,
    though, is the world's own: the grammar and the flood here used to assume
    level 0, which showed a raised-flood world a coastline the build would
    immediately contradict. */
export function planWorld(world, seed, { res = 56 } = {}) {
  const params = fullParams(world, seed);
  const base = createHeightSampler(params);
  const shaped = shapeWorld({
    grammar: world.land || [], seed, size: params.terrain.size, sampler: base, res,
    level: params.water?.level || 0,
  });
  const sites = resolveSites(world, shaped.anchors);
  return { params, base, shaped, sites, size: params.terrain.size };
}

/* Which anchor each place stands on, and how big it will be. A place whose
   anchor the finders could not produce is simply dropped — three settlements
   on a world that only grew room for two is better than a build that fails.

   `dress.size` is the machine page's one word about scale — "a little village"
   — and it applies to every place, which sounds coarse and is not: a recipe
   whose counts do not vary with size is unaffected by construction (a field
   station is one study at every size, because that is what its table says).
   What it moves is the recipes that DO count houses, which is the only place
   the word meant anything. */
export function resolveSites(world, anchors, dress = null) {
  const out = [];
  for (const place of world.places || []) {
    const m = /^(.*)#(\d+)$/.exec(place.role);
    const list = anchors[m ? m[1] : place.role] || [];
    const at = m ? list[+m[2]] : list[out.filter((o) => o.role === place.role).length];
    if (!at) continue;
    const sized = dress?.size ? { ...place, size: dress.size } : place;
    out.push({ ...sized, x: at.x, z: at.z, r: siteRadius(sized), anchor: at });
  }
  return out;
}

/* The radius a place will actually occupy — read from the recipe rather than
   guessed, because the road anchors and the spacing rule both depend on it
   and a guess would put the highway through the terraces. */
export function siteRadius(place) {
  const rec = SITE_KINDS[place.kind];
  if (!rec) return 60;
  return rec.radius(rec.counts[place.size] ?? 3);
}

/* ══════════════════════════════════════════════════════════════════════════
   THE BUILD

   Stage by stage, and every stage yields the main thread back before the
   next. A world of this size is two or three seconds of real work; three
   seconds of BLOCKED work is a page the browser offers to kill, and a
   progress bar that cannot paint is worse than no progress bar.

   `hooks.stage(name, detail, progress)` is the only thing this reports
   through; `hooks.frame()` is what it yields with.
   ══════════════════════════════════════════════════════════════════════════ */
/* Yielding is a `setTimeout(0)`, deliberately NOT a requestAnimationFrame.
   The engine draws on its own rAF loop the moment anything invalidates it, so
   handing the event loop back is all this needs to do — and waiting on a
   PAINTED frame instead ties the build's speed to the renderer's. On a
   software rasteriser with three thousand props a frame can take a second and
   a half, which turned forty yields into a minute of nothing happening. */
const idle = () => new Promise((r) => setTimeout(r, 0));

/* `seed` pins the world instead of screening for one. Everything downstream
   of the seed is already deterministic, so naming it makes the whole build
   reproducible: name the seed and the same world comes back, however much has
   changed around it. That is what the gallery's plate shooter relied on
   before it was retired, and it is what the command palette's rebuild and
   redo's re-press rely on now. Omit it and the build behaves as it always
   has: screen a fresh seed against this world's own bar. */
export async function buildWorld({ engine, id, seed = null, dress = null, hooks = {} }) {
  const world = WORLDS[id];
  if (!world) throw new Error(`unknown world: ${id}`);
  let mark = Date.now();
  const say = (stage, detail = "", progress = 0) => {
    if (stage !== say._last) {
      if (say._last) console.info(`[world] ${say._last}: ${Date.now() - mark} ms`);
      say._last = stage; mark = Date.now();
    }
    hooks.stage?.(stage, detail, progress);
  };
  const breathe = hooks.frame || idle;
  const placed = [];          // every record this build added, for one undo
  const t0 = Date.now();

  /* ── the renderer stands down while this runs ──
     And this is not an optimisation detail, it is the difference between a
     button that works and one that does not. The engine draws whenever
     anything invalidates it, and a build invalidates constantly: three
     thousand placements, five terrain rebuilds, a scatter field. Every yield
     back to the event loop therefore paid for a full frame — shadow pass,
     post stack, the lot — over a scene that was growing as it went. Measured
     on a software rasteriser it was 215 seconds of RENDERING inside a build
     whose own work took seven.

     So the world is drawn once, at the end, by the camera move that was
     always going to reveal it. What the author watches meanwhile is the
     progress on the deck, which is the honest report anyway. */
  const wasPaused = engine.paused;
  engine.setPaused(true);
  document.body.classList.add("building");

  try {
    /* ── THE WORLD IS REPLACED, NOT ADDED TO ──
       The panel has always said "building replaces what is in the world", the
       undo entry has always restored every record on the assumption that the
       build owned all of them, and the build itself never removed anything.
       On one world at a time that reads as a slightly crowded map. On worlds
       of different EXTENTS it is unmissable: press Lonepalm after Farshore and
       a village and its study hang in the sky over the ocean, because they
       were placed on a plate half again as wide.
       The caller has already snapshotted everything for the undo. */
    for (const r of engine.props.records()) engine.props.remove(r.uid);
    engine.setNewestProp(null);
    /* 1 · THE GROUND. Screened, then applied — and applied as ONE patch, so
       the terrain is rebuilt once rather than once per property. */
    say(seed ? "Rebuilding a named world" : "Screening seeds",
      seed ? seed : "measuring what each one grew", 0.03);
    await breathe();
    const found = screenFor(world, { seed });
    say("Shaping the land", `${found.seed} · ${Math.round(found.land * 100)}% land`, 0.1);
    await breathe();
    engine.applyParams(paramsFor(world, found.seed, dress));
    // Erosion runs on a worker and is what finally decides where the hollows
    // are; the landform is cut into the ERODED surface, so this waits for it
    // rather than racing it.
    await settle(engine);

    const size = engine.params.terrain.size;
    const waterLevel = engine.params.water.level || 0;
    const sampler = (x, z) => engine.sampleHeight(x, z);

    /* 2 · THE LANDFORM. Read the ground, then cut it: the mount under the
       castle, the ring of water round it, the river that gives that ring
       somewhere to drain, the terraces, the island. Emitted as ordinary
       sculpt strokes, so ⌘Z takes the geography off with everything else and
       the whole thing travels in params. */
    say("Cutting the land", "mounts, water and the ground between", 0.16);
    await breathe();
    const shaped = shapeWorld({
      grammar: world.land || [], seed: engine.params.seed, size, sampler, level: waterLevel,
    });
    for (let i = 0; i < shaped.strokes.length; i++) {
      const s = shaped.strokes[i];
      engine.sculptAt(s.x, s.z, { radius: s.r, amount: s.a, mode: STROKE_MODES[s.m] || "raise" });
      if (i % 40 === 39) await breathe();
    }
    if (shaped.strokes.length) engine.commitSculpt();
    /* Rivers the grammar solved (the `river` op): the strokes just replayed
       are theirs — strokeStart/strokeCount index into the list the engine
       now holds — and the records give the ribbon its water surface. An
       engine stand-in (tools/lib/headless.mjs) has no ribbons to refresh. */
    if (shaped.rivers?.length) {
      engine.params.terrain.rivers = shaped.rivers;
      engine.refreshRivers?.();
    }
    await breathe();

    /* WHERE THE WATER ACTUALLY IS, once the cutting is done.
       Everything below asks this — the router refuses to cross it, the ways
       decide where to bridge, the planting stays out of it — and "below the
       waterline" is not the answer. The flood is the answer, and it is one
       bake and one breadth-first fill (engine/water/flood.js), which is what
       the renderer is about to compute for its own water plane anyway — and
       at the same CANONICAL_RES grid, so the router, the bridges and the
       planting agree with the drawn shoreline cell for cell. */
    const floodField = bakeHeightField(engine.params, CANONICAL_RES, sampler);
    const flood = floodFromSea(floodField, null, waterLevel);
    const isWet = (x, z) => wetAt(flood, x, z);

    /* 3 · THE PLACES. Every site stands on an anchor the landform chose, so a
       castle is on its own mount and a village is on its own coast. */
    const sites = resolveSites(world, shaped.anchors, dress);
    if (!sites.length) throw new Error("this seed grew nowhere to build");

    /* Which way each place FACES, and it is the routes that say. A town on a
       ceremonial avenue lays its street grid along the avenue and gates onto
       it; the castle at the avenue's other end opens its court back down it;
       a village with one lane out gates onto the lane. Without this every
       site draws a random bearing, and the reference read this whole grammar
       exists for — one straight line from the town square through the gate to
       the castle door — happens on one seed in six. Avenues outrank lanes
       outrank tracks, because when a place is on both it was built for the
       ceremony and merely visited by the traffic. */
    const RANK = { avenue: 0, lane: 1, track: 2, road: 3 };
    const approaches = new Map();
    for (const rt of [...shaped.routes].sort((a, b) => (RANK[a.style] ?? 9) - (RANK[b.style] ?? 9))) {
      const a = nearestSite(sites, rt.from), b = nearestSite(sites, rt.to);
      if (a && !approaches.has(a)) approaches.set(a, Math.atan2(rt.to.z - a.z, rt.to.x - a.x));
      if (b && b !== a && !approaches.has(b)) approaches.set(b, Math.atan2(rt.from.z - b.z, rt.from.x - b.x));
    }

    /* Everything from here to the end of the ways is ONE bulk transaction. The
       engine keeps painting throughout — watching the world appear is half the
       point of the button — but nothing that walks the whole world runs per
       placement. See Props.beginBulk. */
    engine.props.beginBulk();
    let uid = nextUidIndex(engine.props.records());
    /* THE REASONING, KEPT. Every furnished storey reports what it was
       classified as, who was decided to live in it, the period and climate it
       was furnished against, what each room is for, and what the validator
       caught. js/export-site.js reads one of these into site.json and the
       editor puts them on screen — see `interiors` on the build result. */
    const interiorReports = [];
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      say(`Building ${s.name}`, `${s.kind.replace(/-/g, " ")}, ${s.size}`, 0.24 + 0.38 * (i / sites.length));
      await breathe();

      const out = composeSite({
        plan: makePlan({ kind: s.kind, size: s.size }),
        center: { x: s.x, z: s.z },
        seed: engine.params.seed,
        sampler,
        uidStart: uid,
        siteIndex: i,
        waterLevel,
        interiorMax: s.interiorMax,
        interiorBudget: 0.72,
        approach: approaches.has(s) ? approaches.get(s) : null,
        dress: world.interior || null,
        // What country this is. The interiors read it as climate, so a
        // house on an atoll is not furnished round a fireplace.
        biome: engine.params.biome,
        // Why every room came out the way it did, kept per building so the
        // editor can answer the question rather than only the suite.
        onInterior: (rep) => interiorReports.push(rep),
      });
      if (!out.records.length) continue;
      s.r = out.radius;

      for (const p of out.pads) engine.sculptAt(p.x, p.z, { radius: p.r, amount: p.amount, mode: "flatten" });
      if (out.pads.length) engine.commitSculpt();
      await breathe();

      const footed = groundBuildings({
        records: out.records,
        sampler,
        uidAt: (n) => makeUid(engine.params.seed, n),
        index: uid + out.records.length + 4,
      });
      uid += out.records.length + footed.footings.length + 8;

      const all = [...footed.records, ...footed.footings];
      say(`Building ${s.name}`, `${all.length} pieces`, 0.24 + 0.38 * ((i + 0.5) / sites.length));
      for (let n = 0; n < all.length; n++) {
        await engine.props.add(all[n]);
        // Every few hundred, hand the frame back. The adds are cheap
        // individually and ruinous in one unbroken run.
        if (n % 480 === 479) await breathe();
      }
      for (const r of all) placed.push({ ...engine.props.get(r.uid).record });
      s.built = all.length;
    }

    /* 4 · THE WAYS.
       Not a spanning tree over the settlements any more — the world says what
       connects to what and in what style, because "there is a road between
       every pair of towns" is itself a grammar, and it is the wrong one for
       both of these. Farshore has a lane that leaves and does not arrive;
       Lonepalm has nothing at all, and a road network on a one-house island
       would be the loudest possible statement that nobody looked at it.

       Each leg is anchored at the EDGE of a settlement, not at its middle, so
       the way meets the streets instead of ploughing through them. */
    const roadPoints = [];
    const laidRoutes = [];
    for (let i = 0; i < shaped.routes.length; i++) {
      const rt = shaped.routes[i];
      const way = WAYS[rt.style] || WAYS.road;
      const spec = blockSpec(way.block);
      if (!spec) continue;
      const junction = way.junction ? blockSpec(way.junction) : null;
      const bridge = way.bridge ? blockSpec(way.bridge) : null;

      const a = nearestSite(sites, rt.from), b = nearestSite(sites, rt.to);
      const d = Math.hypot(rt.to.x - rt.from.x, rt.to.z - rt.from.z) || 1;
      const ux = (rt.to.x - rt.from.x) / d, uz = (rt.to.z - rt.from.z) / d;
      const from = { x: rt.from.x + ux * (a?.r || 0), z: rt.from.z + uz * (a?.r || 0) };
      const to = { x: rt.to.x - ux * (b?.r || 0), z: rt.to.z - uz * (b?.r || 0) };

      say("Surveying the ways", rt.name || `${rt.style} ${i + 1}`,
        0.64 + 0.08 * (i / Math.max(1, shaped.routes.length)));
      await breathe();

      const plan = way.straight
        ? planAvenue({ sampler, from, to })
        : planRoute({ sampler, waterLevel, from, to, bridgeSpan: way.bridgeSpan, wetAt: isWet });
      if (!plan) {
        console.info(`[world] no ${rt.style} for ${rt.name || i} — water or cliff between the ends`);
        continue;
      }
      const laid = layRoad({
        route: plan.points, road: spec, junction, bridge, sampler, waterLevel, wetAt: isWet,
        uidAt: (n) => makeUid(engine.params.seed, n), index: uid,
        bridgeSpan: way.bridgeSpan,
        padEvery: way.pad.every, padRadius: way.pad.radius, padAmount: way.pad.amount,
      });
      uid += laid.records.length + 4;
      for (const p of laid.pads) engine.sculptAt(p.x, p.z, { radius: p.r, amount: p.amount, mode: "flatten" });
      if (laid.pads.length) engine.commitSculpt();
      await breathe();
      for (let n = 0; n < laid.records.length; n++) {
        await engine.props.add(laid.records[n]);
        if (n % 480 === 479) await breathe();
      }
      for (const r of laid.records) placed.push({ ...engine.props.get(r.uid).record });
      const pts = laid.records.map((r) => ({ x: r.position[0], z: r.position[2], r: way.pad.radius }));
      roadPoints.push(...pts);
      laidRoutes.push({ ...rt, points: plan.points });
      console.info(`[world] ${rt.style} ${rt.name || i}: ${laid.length} m in ${laid.records.length} pieces,`
        + ` ${laid.bridges} bridged${plan.strained ? `, strained to a ${plan.grade} grade` : ""}`);
    }

    /* 5 · THE STRAYS. Single objects that belong to the WORLD rather than to a
       settlement: a watchtower on a rise, broken wall beside an old road, an
       arch with nothing left round it. Placed against the ways as well as the
       ground, which is what makes a ruin field read as the remains of
       something rather than as debris. */
    if (world.strays?.length) {
      say("Leaving the ruins", "towers, walls and what the roads passed", 0.76);
      await breathe();
      const strays = placeStrays({
        seed: engine.params.seed, size, sampler, waterLevel,
        specs: world.strays.filter((s) => (s.count || 0) > 0),
        field: shaped.field, anchors: shaped.anchors, routes: laidRoutes, sites,
      });
      const strayRecs = [];
      for (const st of strays) {
        const spec = blockSpec(st.id);
        if (!spec) continue;
        strayRecs.push({
          uid: makeUid(engine.params.seed, uid++), ref: spec.ref, url: null, label: spec.label,
          proc: spec.proc, position: [st.x, sampler(st.x, st.z), st.z],
          rotationY: Math.round(st.rotationY * 1000) / 1000, scale: 1, autoFit: false,
        });
      }
      /* A STRAY THAT DECLARES A ROOM IS A BUILDING, and gets the same ground
         a building in a settlement gets. This pass was inside the site loop
         only, so a watchtower left on a rise was seated on the ONE sample
         under its centre — and a tower is five metres across on ground that
         was chosen for being a rise. The turf came up through its floor: the
         checker found the ground 0.4 m above the floor of the room inside it,
         which is the exact bug footing.js was written to end. */
      const footedStrays = groundBuildings({
        records: strayRecs, sampler,
        uidAt: (n) => makeUid(engine.params.seed, n), index: uid,
      });
      uid += strayRecs.length + footedStrays.footings.length + 4;
      const allStrays = [...footedStrays.records, ...footedStrays.footings];
      for (let n = 0; n < allStrays.length; n++) {
        await engine.props.add(allStrays[n]);
        placed.push({ ...engine.props.get(allStrays[n].uid).record });
        if (n % 40 === 39) await breathe();
      }
    }

    engine.props.endBulk();

    /* 6 · THE COUNTRY. Planting and grass, both of which live in params rather
       than in the placement list — they travel with the world into the export
       without being ten thousand objects in the register. */
    const plant = world.planting || {};
    say("Planting", plant.count ? `${plant.count} trees and shrubs` : "nothing: this world is water", 0.84);
    await breathe();
    const nearAnchor = plant.nearRole ? (shaped.anchors[plant.nearRole] || [])[0] : null;
    const scatter = plantCountry({
      seed: engine.params.seed, size, waterLevel, sampler,
      species: plant.species || [], count: plant.count || 0, bands: plant.bands || [0.05, 0.6],
      heightRef: engine.params.terrain.height,
      clumping: plant.clumping ?? 0.6, grain: plant.grain ?? 3.4, field: shaped.field,
      near: nearAnchor ? { x: nearAnchor.x, z: nearAnchor.z, reach: plant.nearReach ?? 0.4 } : null,
      nearPull: plant.nearPull ?? 0,
      sites, roads: roadPoints,
    });
    engine.applyParams({ props: { scatter } });
    engine.rebuildScatter();
    await breathe();

    say("Dressing", "grass, and the light to see it in", 0.93);
    const home = sites.find((s) => s.lead) || sites[0];
    const grng = mulberry32(seedChannel(engine.params.seed, "world:grass"));
    for (let i = 0; i < (world.grass || 0); i++) {
      const a = grng() * Math.PI * 2, rr = home.r * (1.15 + grng() * 1.5);
      const gx = home.x + Math.cos(a) * rr, gz = home.z + Math.sin(a) * rr;
      if (sampler(gx, gz) < waterLevel + 2) continue;
      engine.addGrassPatch(gx, gz, { r: 22 + grng() * 16 });
    }

    /* 7 · WHERE YOU LAND. The world's lead site — the one thing on the whole
       map somebody would actually have walked out of. */
    const spawn = { x: home.x, z: home.z };
    engine.markSpawn(spawn.x, spawn.z, { visible: false });
    /* "Jump to the newest placement" should land somewhere worth landing. The
       last record a build emits is a broken wall in a field; the thing an
       author actually wants to be taken to is the landmark. So the newest is
       the biggest structure nearest the middle of the lead site. */
    let landmark = null, best = Infinity;
    for (const r of placed) {
      if (!r.proc?.rooms?.length) continue;
      const d = Math.hypot(r.position[0] - home.x, r.position[2] - home.z);
      if (d < best) { best = d; landmark = r; }
    }
    engine.setNewestProp(landmark?.uid || null);
    await breathe();

    say("Ready", `${placed.length} pieces placed`, 1);
    console.info(`[world] Ready: total ${Date.now() - t0} ms`);
    return {
      id, world, seed: found.seed, screened: found.screened,
      sites, spawn, placed, scatter: scatter.length, strokes: shaped.strokes.length,
      /* One entry per furnished storey, keyed by the shell it belongs to.
         The editor answers "why is this room like this" out of these; nothing
         downstream requires them, and a build with no interiors returns an
         empty list rather than nothing. */
      interiors: interiorReports,
      /* The ways travel back as GEOMETRY, not as a count. The arrival
         director (js/cinematic.js) flies down a world's ceremonial approach
         when it laid one, and it can only find that route if the route is in
         the result — a number tells it there were two of something. */
      ways: laidRoutes, routes: laidRoutes.length, roads: roadPoints.length, ms: Date.now() - t0,
    };
  } finally {
    /* Whatever happened in there — a throw, a seed that grew nowhere — the
       world is visible again and the bulk transaction is closed. It used to
       be the caller's job and the caller could not do it: an exception between
       beginBulk and endBulk left the engine skipping every whole-world pass
       for the rest of the session, which looks like the renderer breaking
       rather than like a build failing. */
      engine.props.endBulk();
      document.body.classList.remove("building");
      engine.setPaused(wasPaused);
  }
}

const STROKE_MODES = ["raise", "lower", "smooth", "flatten"];

// The site a route endpoint belongs to, if any: a way is anchored at the edge
// of a settlement rather than at its middle.
function nearestSite(sites, p) {
  let best = null, bd = Infinity;
  for (const s of sites) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < bd) { bd = d; best = s; }
  }
  return bd < (best?.r || 0) + 40 ? best : null;
}

/* Wait for the terrain to stop changing under us.
   Erosion runs on a worker, and the height field it produces is what the
   landform is cut into and what every placement is measured against —
   planning a village against the pre-erosion surface and then letting the
   erosion land is how a house ends up in a gully it dug afterwards.

   So this waits for the ENGINE TO SAY SO rather than counting frames. The
   timeout is the honest fallback: on a machine where the worker never
   answers, a world that builds against the analytic surface is a great deal
   better than one that never builds. */
function settle(engine, { timeout = 12000 } = {}) {
  /* `groundSettled` rather than "is erosion switched on": a world whose
     ground was HANDED to the engine already carved (Engine.adoptGround) emits
     its one "erosion" event inside the build, before this listener could
     exist, so waiting for it would spend the whole timeout waiting for
     something that has already happened. */
  if (engine.groundSettled) return new Promise((r) => setTimeout(r, 60));
  return new Promise((resolve) => {
    let done = false;
    /* Both halves are released, and the subscription is the one that mattered:
       `engine.on` hands back an unsubscribe and this used to drop it, so every
       world built in a session left another dead closure in the engine's
       "erosion" listener set — never called twice thanks to `done`, never
       collected either, and holding this promise's `resolve` with it. Fifty
       worlds is fifty of them, walked on every erosion pass forever. */
    let off = null, timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      off?.();
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    off = engine.on("erosion", finish);
    timer = setTimeout(finish, timeout);
  });
}
