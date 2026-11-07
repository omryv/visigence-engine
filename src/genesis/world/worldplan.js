// worldplan.js — the vocabulary a generated site is described in.
//
// A PLAN is the small, human- (or model-) writable description of intent:
// which kind of site, how big, on what ground. It is a COMPILER INPUT, not a
// runtime format — compose.js turns it into ordinary prop records and the
// plan is then discarded. Nothing downstream (VSight, exports, fusion) ever
// sees a plan, so the ONE-params invariant is untouched.
//
// Recipes below are DATA: an ordered list of ops that compose.js interprets.
// Editing a recipe changes what a village *is* without touching any logic.
//
// Pure JS (no three.js) — runs under JavaScriptCore tests.

import { findItem } from "./props-packs.js";

export const PLAN_VERSION = 1;

/* ── block metadata ──
   Placement knowledge lives HERE, not in props-packs.js: the catalog should
   not know a composer exists. Footprints are computed from the geometry, so
   there is no hand-kept table to drift out of sync.

   face  — which local axis the block's front points down ("+z" for a house
           door, "+x" for the lamp's arm and for run-along-X pieces).
   axis  — for pieces that form runs/spans: the local axis of their length.
   tile  — length of one repeat in metres (wall runs, fences, bridge spans).
   role  — how the composer is allowed to use it.
   ground— "flat" refuses steep sites; "any" tolerates them.            */
export const BLOCK_META = {
  house:    { face: "+z", role: "building", ground: "flat" },
  tower:    { face: "+z", role: "building", ground: "flat" },
  platform: { face: "+z", role: "building", ground: "flat" },
  stall:    { face: "+z", role: "stall",    ground: "flat" },
  well:     { face: "+z", role: "feature",  ground: "flat" },
  campfire: { face: "+z", role: "feature",  ground: "flat" },
  arch:     { face: "+z", role: "feature",  ground: "any" },
  scaffold: { face: "+z", role: "feature",  ground: "any" },
  gate:     { face: "+z", role: "gate",     ground: "flat", axis: "x", tile: 2.1 },
  door:     { face: "+z", role: "gate",     ground: "any",  axis: "x", tile: 6 },
  doorway:  { face: "+z", role: "gate",     ground: "flat", axis: "x", tile: 6 },
  wall:     { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 6 },
  fence:    { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 3 },
  barrier:  { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 3 },
  bridge:   { face: "+z", role: "span",     ground: "any",  axis: "z", tile: 6.2 },
  ramp:     { face: "+z", role: "traverse", ground: "any",  axis: "z", tile: 6.4 },
  stairs:   { face: "+z", role: "traverse", ground: "any",  axis: "z", tile: 6 },
  pillar:   { face: "+z", role: "fragment", ground: "any" },
  crate:    { face: "+z", role: "clutter",  ground: "any" },
  floor:    { face: "+z", role: "pad",      ground: "flat", axis: "x", tile: 6 },
  lamp:     { face: "+x", role: "light",    ground: "any" },

  /* ── street pack ──
     Roads are runs on the same 6 m module as walls and fences, so a street
     lays with the same alongTo() a perimeter does. Row units are buildings
     that are ALSO runs: 6 m of frontage each, blind party walls, and a tile
     length, so a row of them abuts into one continuous street wall. */
  road:       { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  "road-plain": { face: "+z", role: "run",    ground: "flat", axis: "x", tile: 6 },
  crossing:   { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  junction:   { face: "+z", role: "pad",      ground: "flat" },
  plaza:      { face: "+z", role: "pad",      ground: "flat", axis: "x", tile: 6 },
  "block-low":  { face: "+z", role: "building", ground: "flat" },
  "block-mid":  { face: "+z", role: "building", ground: "flat" },
  "block-high": { face: "+z", role: "building", ground: "flat" },
  "block-stack": { face: "+z", role: "building", ground: "flat" },
  "block-spire": { face: "+z", role: "building", ground: "flat" },
  civic:      { face: "+z", role: "building", ground: "flat" },
  "row-house": { face: "+z", role: "building", ground: "flat", axis: "x", tile: 6 },
  "row-shop":  { face: "+z", role: "building", ground: "flat", axis: "x", tile: 6 },
  tree:       { face: "+z", role: "nature",   ground: "any" },
  "tree-small": { face: "+z", role: "nature", ground: "any" },
  pine:       { face: "+z", role: "nature",   ground: "any" },
  birch:      { face: "+z", role: "nature",   ground: "any" },
  bush:       { face: "+z", role: "nature",   ground: "any" },
  hedge:      { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 3 },

  /* ── land pack ──
     The world scale. A castle is a `landmark` rather than a `building`: the
     distinction is that nothing else in a site may be placed as if it were
     one of several, and the pads and road anchors are measured off it.

     The ways run on the same 6 m module as the streets, so `layRoad` and
     `alongTo` lay a dirt lane exactly as they lay a carriageway — which is
     the whole reason a world can change what its roads ARE without any code
     downstream of this table noticing. */
  "castle-spires":  { face: "+z", role: "landmark", ground: "flat" },
  "castle-round":   { face: "+z", role: "landmark", ground: "flat" },
  "castle-citadel": { face: "+z", role: "landmark", ground: "flat" },
  // A landmark the size of a hall: it is the ROLE that matters, because the
  // study is the building its whole world is composed under, exactly as a
  // castle is — the footprint discipline scales, the argument does not.
  study:            { face: "+z", role: "landmark", ground: "flat" },
  rampart:    { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 6 },
  "ruin-wall":{ face: "+z", role: "run",      ground: "any",  axis: "x", tile: 6 },
  lane:       { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  track:      { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  avenue:     { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  jetty:      { face: "+z", role: "run",      ground: "any",  axis: "x", tile: 6 },
  setts:      { face: "+z", role: "run",      ground: "flat", axis: "x", tile: 6 },
  "junction-setts": { face: "+z", role: "pad", ground: "flat" },
  crops:      { face: "+z", role: "pad",      ground: "flat", axis: "x", tile: 6 },
  fountain:   { face: "+z", role: "feature",  ground: "flat" },
  palm:       { face: "+z", role: "nature",   ground: "any" },
  cottage:    { face: "+z", role: "building", ground: "flat" },
  "cottage-slate": { face: "+z", role: "building", ground: "flat" },
  villa:      { face: "+z", role: "building", ground: "flat" },
  hall:       { face: "+z", role: "building", ground: "flat" },
  lodge:      { face: "+z", role: "building", ground: "flat" },
};

/* ── footprint ──
   Ground extent of a proc block, derived from its parts. Used for spacing,
   collision and pad sizing — approximate on purpose: an axis-aligned box
   grown by each part's own rotation. */
function partExtent(p) {
  const dims = p.dims || [1, 1, 1];
  let hw, hd, cx = 0, cz = 0;
  switch (p.shape) {
    case "cylinder": hw = hd = Math.max(dims[0], p.rTop ?? 0); break;
    case "cone":
    case "sphere":
    case "blob":     hw = hd = dims[0] * (p.shape === "blob" ? 1.2 : 1); break; // blob wobble grows the radius
    case "lathe": {
      let m = 0;
      for (const [r] of p.profile || []) m = Math.max(m, r);
      hw = hd = m;
      break;
    }
    case "extrude": {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of p.outline || []) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!isFinite(x0)) { x0 = x1 = y0 = y1 = 0; }
      hw = (x1 - x0) / 2; cx = (x0 + x1) / 2;
      /* An extrude laid FLAT — rotX or rotZ near a quarter turn — puts its
         outline's Y range on the ground, not its depth. A parapet ring or a
         castle's curtain wall is authored that way, and reading `depth` there
         reports a 60 m enclosure as 70 cm deep: the composer then packs
         buildings inside a footprint it thinks is a kerbstone. Both current
         users are symmetric about their own origin, so the centre stays 0;
         an off-centre flat extrude would need the sign of the rotation too. */
      const flat = Math.abs(Math.sin(p.rotX || 0)) > 0.3 || Math.abs(Math.sin(p.rotZ || 0)) > 0.3;
      hd = flat ? (y1 - y0) / 2 : (p.depth || 0) / 2;
      if (flat) cz = (y0 + y1) / 2;
      break;
    }
    default: hw = dims[0] / 2; hd = dims[2] / 2; // box, wedge
  }
  // The part's own rotY turns its box; take the enclosing axis-aligned one.
  const ry = p.rotY || 0;
  const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
  const ew = hw * c + hd * s;
  const ed = hw * s + hd * c;
  const rc = Math.cos(ry), rs = Math.sin(ry);
  const ox = cx * rc + cz * rs, oz = -cx * rs + cz * rc;
  const [px, , pz] = p.pos || [0, 0, 0];
  return { x0: px + ox - ew, x1: px + ox + ew, z0: pz + oz - ed, z1: pz + oz + ed };
}

// → { w, d, r } in metres. r is the enclosing radius used for collision.
export function footprintOf(proc) {
  if (!proc?.parts?.length) return { w: 2, d: 2, r: 1.5 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of proc.parts) {
    const e = partExtent(p);
    x0 = Math.min(x0, e.x0); x1 = Math.max(x1, e.x1);
    z0 = Math.min(z0, e.z0); z1 = Math.max(z1, e.z1);
  }
  const w = x1 - x0, d = z1 - z0;
  return { w, d, r: Math.hypot(w, d) / 2 };
}

// Catalog lookup + metadata + footprint, or null if the id is unknown.
// Generated sites are procedural-only: a recipe may never reach for a GLB.
export function blockSpec(id) {
  const item = findItem(`builder/${id}`) || findItem(id);
  if (!item || !item.proc || item.url) return null;
  return {
    id: item.id,
    ref: `${item.pack}/${item.id}`,
    label: item.label,
    proc: item.proc,
    meta: BLOCK_META[item.id] || { face: "+z", role: "clutter", ground: "any" },
    foot: footprintOf(item.proc),
  };
}

/* ── site recipes ──
   Ops, in order. compose.js implements each; the numbers here are the design.

     center    one block at the middle
     ring      count blocks on a circle, facing in/out
     rows      two facing rows flanking the centre (a market lane)
     spots     explicit [angleTurns, radiusFactor] placements
     perimeter a fence/wall chain around the site, gap-filling BETWEEN the
               ring buildings, with a gate on the approach and flanking lamps
     scatter   clutter in an annulus, optionally hugging building walls
     fragments scatter + decay (squashed height, heavy rotation jitter)
     span      a bridge across a found crossing, with end props
     spread    buildings loose on open ground, spaced rather than aligned
     plots     rectangular worked patches on the module grid
     crest     one block on the highest usable ground inside the site
     pier      a run of deck walking out from the shore into the water     */
export const SITE_KINDS = {
  "market-hamlet": {
    label: "Market Hamlet",
    hint: "Houses ringed around a well, with a short market lane.",
    ground: "flat",
    counts: { small: 4, medium: 6, large: 9 },
    radius: (n) => 12.5 + n * 2.1,
    steps: [
      { op: "center", block: "well", pad: 6 },
      { op: "ring", block: "house", count: "n", facing: "in", jitter: 0.09, pad: 1.5 },
      { op: "rows", block: "stall", count: 4, facing: "lane", lane: 9, spacing: 5.4, at: 0.42 },
      { op: "perimeter", block: "fence", gate: "gate", gateLamps: "lamp" },
      { op: "scatter", block: "crate", count: 5, hug: "building", jitter: 0.5 },
      { op: "scatter", block: "lamp", count: 3, at: [0.5, 0.66], facing: "in" },
    ],
  },

  "trading-outpost": {
    label: "Trading Outpost",
    hint: "Walled compound: tower, platform, two stalls, one guarded gate.",
    ground: "flat",
    counts: { small: 3, medium: 4, large: 6 },
    radius: (n) => 13 + n * 1.9,
    shape: "square",
    steps: [
      { op: "spots", block: "tower", at: [[0.62, 0.62]], facing: "in", pad: 2 },
      { op: "spots", block: "platform", at: [[0.5, 0.66]], facing: "in", pad: 1.5 },
      { op: "spots", block: "scaffold", at: [[0.38, 0.62]], facing: "in" },
      { op: "rows", block: "stall", count: 2, facing: "lane", lane: 7.5, spacing: 0, at: 0.1 },
      { op: "perimeter", block: "wall", shape: "square", gate: "gate", gateLamps: "lamp" },
      { op: "scatter", block: "crate", count: 6, hug: "run", jitter: 0.4 },
      { op: "scatter", block: "lamp", count: 3, at: [0.45, 0.6], facing: "in" },
    ],
  },

  "bridge-checkpoint": {
    label: "Bridge Checkpoint",
    hint: "A crossing over water or a ravine, barriered and lit at both ends.",
    ground: "crossing",
    counts: { small: 1, medium: 2, large: 3 },
    radius: () => 10,
    steps: [
      { op: "span", block: "bridge" },
      { op: "ends", block: "lamp", offset: 2.4, side: "alternate", facing: "span" },
      { op: "line", block: "barrier", side: "near", count: 3, offset: 4.5 },
      { op: "scatter", block: "crate", count: 3, at: [0.45, 0.8], side: "near" },
    ],
  },

  "stacked-district": {
    label: "Stacked District",
    hint: "Setback towers around a plaza, joined by walkways at several levels.",
    ground: "flat",
    counts: { small: 3, medium: 5, large: 7 },
    // Wide enough that adjacent towers land inside the matcher's span, close
    // enough that they land inside it at all — a ring this size puts
    // neighbours roughly 20-35 m apart, which is walkway range.
    radius: (n) => 15 + n * 2.6,
    steps: [
      { op: "center", block: "plaza", pad: 6 },
      { op: "ring", block: "block-stack", count: "n", facing: "in", jitter: 0.06, pad: 2.5 },
      { op: "spots", block: "block-spire", at: [[0.0, 0.0]], facing: "in", pad: 3 },
      { op: "scatter", block: "lamp", count: 4, at: [0.55, 0.78], facing: "in" },
      { op: "scatter", block: "crate", count: 5, hug: "building", jitter: 0.6 },
    ],
  },

  maze: {
    label: "Maze",
    hint: "A walled grid you can actually get lost in — E opens the doors.",
    ground: "flat",
    counts: { small: 4, medium: 6, large: 8 },   // cells per side
    radius: (n) => (n * 6) / 2 * 1.4,
    pad: { scale: 1.15, amount: 10 },            // a maze wants truly level ground
    patterns: ["cells", "winding", "braided"],
    steps: [
      { op: "maze", wall: "wall", door: "door", pitch: 6, doorChance: 0.42 },
    ],
  },

  "ruined-hamlet": {
    label: "Ruined Hamlet",
    hint: "A hamlet the forest took back: broken walls, snapped pillars.",
    ground: "flat",
    counts: { small: 2, medium: 3, large: 5 },
    radius: (n) => 13 + n * 2.4,
    decayTint: [0.86, 0.9, 0.82],
    steps: [
      { op: "center", block: "well", pad: 5, decay: { rot: 0.12 } },
      { op: "ring", block: "house", count: "n", facing: "in", jitter: 0.3, pad: 1.5, decay: { rot: 0.16 } },
      { op: "fragments", block: "wall", count: "n*3", squash: [0.2, 0.6], at: [0.35, 0.95] },
      { op: "fragments", block: "pillar", count: 4, squash: [0.3, 0.9], at: [0.25, 0.6] },
      { op: "spots", block: "arch", at: [[0.0, 0.78]], facing: "in", decay: { rot: 0.1 } },
      { op: "spots", block: "scaffold", at: [[0.78, 0.72]], facing: "in" },
      { op: "scatter", block: "crate", count: 6, at: [0.3, 0.9], jitter: 1 },
    ],
  },

  /* ── the grid recipes ──
     Everything above rings a courtyard. A TOWN DOES NOT: it is laid out by
     its streets, and the buildings are what fills in between them. That is a
     different geometry, not a bigger one, and it is why the two ops below
     exist rather than a `ring` with a larger count.

     The pitch is 36 m throughout — six road modules — because every piece in
     the street pack is 6 m long and 9 m kerb-to-kerb. 36 leaves a 27 m band
     between two streets, which is exactly two 8.5 m-deep lots facing opposite
     ways with a back gap between them. Any other number leaves either a seam
     in the carriageway or a terrace with no back yard.

     A `streets` op records the cells it enclosed; `frontage` then fills them.
     Splitting it in two is what lets a district be dense at the middle and
     residential at the edge without a second grid. */
  town: {
    label: "Market Town",
    walkways: false,
    hint: "A street grid around a square: terraces on the frontage, a civic hall on the plaza.",
    ground: "flat",
    // The count is the grid's RADIUS in cells, not a building count.
    counts: { small: 1, medium: 2, large: 3 },
    radius: (n) => 39 * n + 32,
    pad: { scale: 1.1, amount: 9 },
    steps: [
      { op: "streets", road: "road", junction: "junction", crossing: "crossing", plaza: "plaza", pitch: 39 },
      { op: "frontage", row: ["row-house", "row-house", "row-shop"], depth: 8.5 },
      { op: "landmark", block: "civic", pad: 2.4 },
      { op: "infill", blocks: ["block-low", "block-low", "block-mid"], within: 0.55 },
      { op: "streetside", block: "lamp", every: 2 },
      { op: "streetside", block: "tree", every: 3, offset: 1.4 },
    ],
  },

  city: {
    label: "City District",
    hint: "Towers on a full street grid, shops at street level, a plaza at the centre.",
    ground: "flat",
    counts: { small: 2, medium: 3, large: 4 },
    radius: (n) => 39 * n + 36,
    pad: { scale: 1.08, amount: 12 },
    steps: [
      { op: "streets", road: "road", junction: "junction", crossing: "crossing", plaza: "plaza", pitch: 39 },
      { op: "frontage", row: ["row-shop", "row-shop", "row-house"], depth: 8.5, skipInner: 0.42 },
      { op: "landmark", block: "block-spire", pad: 2.8 },
      { op: "infill", blocks: ["block-high", "block-mid", "block-stack", "block-mid"], within: 0.62 },
      { op: "infill", blocks: ["block-low", "block-mid"], within: 1.0, from: 0.62 },
      { op: "streetside", block: "lamp", every: 2 },
    ],
  },

  hamlet: {
    label: "Roadside Hamlet",
    walkways: false,
    hint: "A dozen houses either side of one lane, with a well and a stand of trees.",
    ground: "flat",
    counts: { small: 1, medium: 1, large: 2 },
    radius: (n) => 39 * n + 24,
    pad: { scale: 1.12, amount: 7 },
    steps: [
      { op: "streets", road: "road", junction: "junction", crossing: "crossing", plaza: "plaza",
        pitch: 39, axes: "u" },
      { op: "frontage", row: ["row-house"], depth: 8.5 },
      { op: "landmark", block: "well", pad: 1.6 },
      { op: "streetside", block: "lamp", every: 3 },
      { op: "streetside", block: "tree", every: 2, offset: 2.2 },
      { op: "scatter", block: "crate", count: 4, hug: "building", jitter: 0.5 },
    ],
  },

  /* ══ the world sites ═════════════════════════════════════════════════
     Everything above is a SETTLEMENT: a courtyard, a grid, a compound. The
     five recipes below are the other thing a world needs — the place the
     whole map is arranged around, and the two kinds of settlement that are
     not laid out by streets at all.

     They are ordinary recipes and they show up in the Sites panel like every
     other one, because a castle you can aim at ground you chose is a tool.
     Nothing here knows which world it belongs to.                         */

  "old-town": {
    label: "Old Town",
    walkways: false,
    hint: "Setts round a square: terraced houses on the frontage, a hall on the plaza, cottages behind.",
    ground: "flat",
    // The count is the grid's RADIUS in cells, not a building count.
    counts: { small: 1, medium: 2, large: 3 },
    radius: (n) => 39 * n + 32,
    pad: { scale: 1.1, amount: 9 },
    /* The same street grid `town` lays, on the same 39 m pitch — and every
       piece in it swapped. A kingdom's market town gets setts rather than
       tarmac and cottages behind the frontage rather than the flat-roofed
       office blocks `infill` reaches for by default, which is the whole
       difference between a fairytale approach and a business park. */
    steps: [
      { op: "streets", road: "setts", junction: "junction-setts", crossing: "setts", plaza: "plaza", pitch: 39 },
      { op: "frontage", row: ["row-house", "row-house", "row-shop"], depth: 8.5 },
      { op: "landmark", block: "civic", pad: 2.4 },
      /* Slate first. The reference capital's town is a BLUE roofscape read
         from two kilometres up — it is the one thing at that distance that
         says the houses belong to the castle — so the blue-roofed cottage
         leads the mix rather than being one of four. */
      { op: "infill", blocks: ["cottage-slate", "cottage", "cottage-slate", "lodge", "house"], within: 0.62 },
      { op: "streetside", block: "lamp", every: 3 },
      { op: "streetside", block: "tree", every: 3, offset: 1.4 },
    ],
  },

  "castle-court": {
    label: "Castle Court",
    hint: "A spired castle on a stepped court, two lodges and a gate onto the approach.",
    ground: "flat",
    counts: { small: 1, medium: 2, large: 3 },
    radius: (n) => 62 + n * 15,
    // A castle brings its own aprons; the pad only has to stop the terrain
    // coming through them, and a hard plateau would show its own edge.
    pad: { scale: 1.14, amount: 10 },
    steps: [
      { op: "center", block: "castle-spires", pad: 1.2 },
      { op: "spots", block: "lodge", at: [[0.27, 0.68], [-0.27, 0.68]], facing: "in", pad: 1.5 },
      { op: "spots", block: "arch", at: [[0.0, 0.88]], facing: "in" },
      { op: "scatter", block: "lamp", count: 8, at: [0.52, 0.82], facing: "in" },
      { op: "scatter", block: "tree", count: 7, at: [0.8, 1.02] },
    ],
  },

  "royal-park": {
    label: "Royal Park",
    hint: "A round castle above a parterre: clipped hedges, a fountain on the approach.",
    ground: "flat",
    counts: { small: 2, medium: 3, large: 4 },
    radius: (n) => 44 + n * 15,
    pad: { scale: 1.12, amount: 9 },
    steps: [
      { op: "center", block: "castle-round", pad: 1.2 },
      { op: "spots", block: "fountain", at: [[0.0, 0.6]] },
      { op: "rows", block: "hedge", count: 12, facing: "lane", lane: 30, spacing: 6.4, at: 0.5 },
      { op: "spots", block: "lodge", at: [[0.2, 0.8], [-0.2, 0.8]], facing: "in", pad: 1.4 },
      { op: "scatter", block: "bush", count: 10, at: [0.52, 0.9] },
      { op: "scatter", block: "tree", count: 12, at: [0.7, 1.04] },
      { op: "scatter", block: "lamp", count: 6, at: [0.44, 0.62], facing: "in" },
    ],
  },

  citadel: {
    label: "Citadel",
    hint: "A walled keep on high ground, with what is left of its outworks around it.",
    ground: "flat",
    counts: { small: 1, medium: 2, large: 3 },
    radius: (n) => 96 + n * 13,
    pad: { scale: 1.02, amount: 13 },
    steps: [
      { op: "center", block: "castle-citadel", pad: 0.98 },
      { op: "fragments", block: "ruin-wall", count: "n*3", squash: [0.55, 1.0], at: [0.84, 1.04] },
      { op: "spots", block: "tower", at: [[0.24, 0.94], [-0.29, 0.99]], facing: "in" },
      { op: "scatter", block: "pine", count: 9, at: [0.88, 1.08] },
    ],
  },

  "shore-village": {
    label: "Shore Village",
    hint: "A handful of houses loose on the grass, a hall on the rise, and a plot or two.",
    ground: "flat",
    // A count of HOUSES, and the whole point of this recipe is that it is a
    // small number. The empty grass between them is the composition.
    counts: { small: 3, medium: 5, large: 8 },
    radius: (n) => 40 + n * 8,
    // Barely levelled. A village on rolling ground should still be on rolling
    // ground; footing.js gives each house the plinth it needs.
    pad: { scale: 1.2, amount: 3.2 },
    steps: [
      { op: "center", block: "well", pad: 3 },
      /* A lodge on the crest, not a hall: the reference town's big building
         is the study on its own height, and two civic masses in one small
         village would argue with each other. The lodge reads as the barn. */
      { op: "crest", block: "lodge", at: [0.5, 0.94], pad: 1.6 },
      /* Slate-heavy on purpose: the roofscape of the reference is blue with
         one or two warm exceptions, and the mix is the message — a town of
         individual houses rather than an estate of one. */
      { op: "spread", blocks: ["cottage-slate", "cottage", "cottage-slate"], count: "n",
        at: [0.3, 0.96], gap: 17, facing: "in", jitter: 0.5 },
      { op: "plots", block: "crops", count: 3, at: [0.42, 0.9], w: 3, d: 2 },
      { op: "scatter", block: "bush", count: 8, at: [0.45, 1.0] },
      { op: "scatter", block: "tree", count: 7, at: [0.82, 1.05] },
    ],
  },

  "field-station": {
    label: "Field Station",
    hint: "One wide study on the height above town: a porch, an instrument drum, and the view.",
    ground: "flat",
    counts: { small: 1, medium: 1, large: 1 },
    radius: () => 30,
    pad: { scale: 1.15, amount: 7 },
    steps: [
      { op: "center", block: "study", pad: 1.35 },
      { op: "spots", block: "lamp", at: [[0.2, 0.66], [-0.2, 0.66]], facing: "in" },
      { op: "scatter", block: "crate", count: 2, hug: "building", jitter: 0.5 },
      { op: "scatter", block: "bush", count: 4, at: [0.6, 0.95] },
    ],
  },

  "sand-cottage": {
    label: "Sand Cottage",
    hint: "One house on a sand spit, a few palms, and a jetty out into the water.",
    ground: "flat",
    counts: { small: 1, medium: 1, large: 2 },
    radius: () => 32,
    pad: { scale: 0.85, amount: 4 },
    steps: [
      { op: "center", block: "villa", pad: 1.5 },
      { op: "spread", blocks: ["palm", "palm", "palm"], count: 5, at: [0.4, 0.9], gap: 9, facing: "free" },
      /* A NARROW dock, which is what the reference has: a short run of deck
         off one side of a fifty-metre island, not a forty-metre pier that
         reads as half the land area again. The run also stops itself where
         the seabed drops away, so `length` is a ceiling rather than a count. */
      { op: "pier", block: "jetty", length: 4 },
      { op: "scatter", block: "crate", count: 2, hug: "building", jitter: 0.5 },
    ],
  },
};

export const SITE_SIZES = ["small", "medium", "large"];

/* ── the plan ── */
export const patternsOf = (kind) => SITE_KINDS[kind]?.patterns || null;

export function makePlan({ kind, size = "medium", pattern } = {}) {
  const k = SITE_KINDS[kind] ? kind : "market-hamlet";
  const pats = patternsOf(k);
  const plan = {
    v: PLAN_VERSION,
    kind: k,
    size: SITE_SIZES.includes(size) ? size : "medium",
  };
  if (pats) plan.pattern = pats.includes(pattern) ? pattern : pats[0];
  return plan;
}

// Strict allowlist. A plan is untrusted input (a person, later a model), so
// nothing reaches the composer that isn't a known kind, size and pattern.
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["plan missing"];
  if (plan.v !== PLAN_VERSION) errors.push(`plan version ${plan.v} ≠ ${PLAN_VERSION}`);
  if (!SITE_KINDS[plan.kind]) errors.push(`unknown kind: ${plan.kind}`);
  if (!SITE_SIZES.includes(plan.size)) errors.push(`unknown size: ${plan.size}`);
  const pats = patternsOf(plan.kind);
  if (pats && !pats.includes(plan.pattern)) errors.push(`unknown pattern: ${plan.pattern}`);
  if (!pats && plan.pattern != null) errors.push(`${plan.kind} has no patterns`);
  return errors;
}

/* Every block a recipe can reach for must exist and be procedural — checked
   by the tests, so a typo in a recipe can never ship as a broken generate.

   The LIST-valued keys are here for a reason: `frontage`, `infill` and
   `spread` name their blocks in an array, and while this only read the
   singular keys a typo in any of the three was invisible to the check that
   exists to catch exactly that. */
const BLOCK_KEYS = ["block", "gate", "gateLamps", "wall", "door", "junction", "crossing", "road", "plaza"];
const BLOCK_LIST_KEYS = ["blocks", "row"];

export function recipeBlocks(kind) {
  const rec = SITE_KINDS[kind];
  if (!rec) return [];
  const ids = new Set();
  for (const step of rec.steps) {
    for (const key of BLOCK_KEYS) if (typeof step[key] === "string") ids.add(step[key]);
    for (const key of BLOCK_LIST_KEYS) {
      for (const id of step[key] || []) if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
}
