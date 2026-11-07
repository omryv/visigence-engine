/* src/kernel/core — the procedural core (the Genesis Kernel).
 *
 * Everything re-exported here is renderer-free, DOM-free, storage-free and
 * deterministic: given the same inputs it returns the same structured data,
 * and it returns DATA. Nothing in this layer builds a mesh, touches a scene,
 * reads a global, loads an asset, or knows the name of a single object in
 * either game.
 *
 * That is not an aspiration written in a comment. `tools/check-imports.mjs`
 * fails if a kernel file imports anything bare (three.js) or anything outside
 * src/kernel/, and tools/test/kernel/boundary.test.js fails if one touches
 * `document`, storage, a canvas, the network, a clock or `Math.random`, or if
 * CORE_MODULES stops being exactly the files of src/kernel/ — which is how the
 * boundary stays true after the person who drew it has stopped looking.
 *
 * ── where it came from
 *
 * The kernel was lifted unchanged from omryv/Visigenesis (archived) at
 * 33bd4d0 (main, 2026-11-07), where it sat under engine/ beside a WebGL
 * renderer and a world editor (js/). Comments in these files still cite that
 * repository's files where a decision was settled — js/worldfile.js,
 * js/landform.js, js/certificate.js, engine/player/*, engine/props/*, and the
 * suites not yet ported here (ground, condition, overworld, ports) — and those
 * citations are to that commit. Neither the WebGL renderer nor the world
 * editor is part of this engine; the world document, the certificate and the
 * town builder are still to be ported (README.md, "What is not in yet").
 *
 * ── what belongs here, and what does not
 *
 * The test is not "is it useful"; it is "would a DIFFERENT game need this,
 * unchanged". A slice partition would. A weighted pick would. A ward with
 * four beds in it would not, and neither would a hospital gurney: those are
 * content, and content lives with the game that means it.
 *
 * So the core holds ALGORITHMS and CONTRACTS:
 *
 *   presets     `params` — the core's INPUT CONTRACT. It belongs here and it
 *               was nearly left out: the first time the core was exercised
 *               standing alone, createHeightSampler returned NaN, because a
 *               caller cannot build a complete params object without the
 *               defaults, and the defaults were outside the boundary. An
 *               engine whose input shape is defined somewhere else is not
 *               separable, whatever the import graph says.
 *   seed        deterministic streams, and the channel discipline that lets
 *               two subsystems draw from one seed without entangling
 *   seedpath    the same discipline as a grammar every repository writes the
 *               same way: canonical paths, a 64-bit path hash, and streams in
 *               two modes — legacy32 (today's channelRng, bit for bit) and v2
 *   noise       value/fbm noise, and the feature fields a stack composes from
 *   noise-stack the SHAPE as an ordered list of blended, masked layers
 *   climate     temperature/moisture fields, and which biome a point is in;
 *               anchors travel in as data because a palette is content
 *   heightfield samplers, baking, elevation
 *   condition   intent: statements about the ground made true by the least
 *               improbable change to the seed's own lattice — points, summits,
 *               pads and levels, and (v2) shorelines, sightlines and roads
 *   sigma       the freedom map: how much of the ground the statements
 *               decided (kriging sigma over the solve's own rows), and which
 *               cells are free, conditioned or hand-sculpted
 *   masks       terrain-derived masks
 *   erosion     the droplet and thermal simulations, as pure functions
 *   canonical   THE ground a world has: bake, erode, flood, drain at 513²
 *   fingerprint the ground as numbers — hashes over the field and masks, the
 *               parameter hash, placementsHash, and the A/B/C verdict
 *   ground      the canonical bake and its manifest in one call — the ground
 *               a sibling repository can be held to (schema/ground.schema.json)
 *   sculpt      a replayable offset layer over any base surface
 *   shading     slope/elevation to material weights
 *   skyvis      sky-visibility integration over a height field
 *   flood       sea-connected fill
 *   partition   slice a rectangle into usable rooms; adjacency; doorways
 *   graph       depth, routes, routes-avoiding, dead ends, spanning trees
 *   ports       local↔world placement geometry, and socket matching
 *   shelter     the volumes a placement encloses, and the openings in them
 *   survey      screening a candidate seed before anybody is shown it, and
 *               conditioning one onto a bar instead of throwing it away
 *   reach       walking a building with the engine's own collision rules, to
 *               answer the one question a graph cannot: which of the rooms
 *               it declares can a player actually stand in
 *   controller  the one player body as frozen data — speeds, step, head,
 *               radius, the slope and wading limits, the climb rule — the
 *               record tools/test/kernel/vectors/controller.json publishes to siblings
 *   terrain-reach  the same question asked of the land: which cells of a
 *               baked field that body can stand on and walk to from a spawn,
 *               every region of it at once, and the quickest route between
 *               two cells, priced as par
 *   evidence    worlds from evidence: spot heights, a traced coastline and
 *               a photograph's skyline turned into the intent records
 *               condition.js already meets, and the band-aware residual
 *               and registration gate that say when a tolerance can be
 *               trusted. The focal length is handed in, never guessed
 *   claims      what a world can be held to, as a tree, and a registry that
 *               says how every leaf of it is known — declared, rederived from
 *               the params, derived by re-baking, or unknown with a reason.
 *               The signature over it lives one layer out (js/certificate.js),
 *               because a signature needs WebCrypto and the core reaches for
 *               no ambient global
 *
 * ── what consumes it
 *
 * `engine/` above this line renders. `js/` composes the peaceful worlds and
 * runs the editor. `game/` is what you do in a world. All three import the
 * core; the core imports none of them, and cannot, because the test says so.
 *
 * ── using it without a renderer
 *
 * This is the whole point, and it is the thing that was not true before:
 *
 *     import { mulberry32, subdivide, spanningTree } from "./engine/core/index.js";
 *
 * runs under plain node with no canvas, no WebGL and no DOM, which is how
 * the entire test suite already runs and how a headless world audit or a
 * server-side generator would.
 */

export * from "../presets.js";
export * from "../seed.js";
export * from "./seedpath.js";
export * from "../terrain/noise.js";
export * from "../terrain/noise-stack.js";
export * from "../terrain/climate.js";
export * from "../terrain/heightfield.js";
export * from "../terrain/condition.js";
export * from "../terrain/sigma.js";
export * from "../terrain/masks.js";
export * from "../terrain/erosion.js";
export * from "../terrain/canonical.js";
export * from "../terrain/fingerprint.js";
export * from "../terrain/ground.js";
export * from "../terrain/shading.js";
export * from "../terrain/sculpt.js";
export * from "../terrain/skyvis.js";
export * from "../water/flood.js";
export * from "./partition.js";
export * from "./graph.js";
export * from "./ports.js";
export * from "./shelter.js";
export * from "./survey.js";
export * from "./reach.js";
export * from "./controller.js";
export * from "./terrain-reach.js";
export * from "./evidence.js";
export * from "./claims.js";

/* The modules the core is made of, as data. The boundary test walks this
   list, and so can anything else that wants to know what the core IS
   without parsing this file's exports. */
export const CORE_MODULES = [
  "src/kernel/presets.js",
  "src/kernel/seed.js",
  "src/kernel/core/seedpath.js",
  "src/kernel/terrain/noise.js",
  "src/kernel/terrain/noise-stack.js",
  "src/kernel/terrain/climate.js",
  "src/kernel/terrain/heightfield.js",
  "src/kernel/terrain/condition.js",
  "src/kernel/terrain/sigma.js",
  "src/kernel/terrain/masks.js",
  /* The pipeline that turns params into THE ground, and the numbers that say
     which ground it was. These were core in all but name — pure, import-free
     of anything outside — and were left off this list only because nothing
     had needed to lift them out. ground.js does, and a core module may only
     import the core, so they came in with it. */
  "src/kernel/terrain/erosion.js",
  "src/kernel/terrain/canonical.js",
  "src/kernel/terrain/fingerprint.js",
  "src/kernel/terrain/ground.js",
  "src/kernel/terrain/shading.js",
  "src/kernel/terrain/sculpt.js",
  "src/kernel/terrain/skyvis.js",
  "src/kernel/water/flood.js",
  "src/kernel/core/partition.js",
  "src/kernel/core/graph.js",
  "src/kernel/core/ports.js",
  "src/kernel/core/shelter.js",
  "src/kernel/core/room-probe.js",
  "src/kernel/core/survey.js",
  "src/kernel/core/reach.js",
  "src/kernel/core/controller.js",
  "src/kernel/core/terrain-reach.js",
  "src/kernel/core/evidence.js",
  "src/kernel/core/claims.js",
];
