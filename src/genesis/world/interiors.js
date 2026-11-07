// interiors.js — the inside of a building, as ordinary placements.
//
// The rule that shapes everything here: AN INTERIOR IS EDITABLE. Every piece
// is a normal prop record — uid, ref, proc, position, rotationY, scale — so it
// selects with the gizmo, moves with the arrows, undoes with the stack and
// serializes into params exactly like a house does. Nothing is baked into the
// building shell, because geometry baked into a block is geometry nobody can
// touch.
//
// This file is the PIPELINE. It owns the order of the ten stages and the
// handover between them; the reasoning for each lives in its own module,
// because a room's purpose, its walls and its furniture are three different
// problems and solving them in one function is how you get a props table.
//
//    1 survey        archetype.js    measure the shell: floor area per storey,
//                                    aspect, windows and WHICH WALLS they are
//                                    in, headroom, entrances
//    2 classify      archetype.js    decide what the building IS from that
//                                    evidence plus what it was placed from
//    3 divide        core/partition  cut the floor into rooms big enough to
//                                    use — and, where the building is the kind
//                                    that has one, cut the CORRIDOR first and
//                                    hang the rooms off it
//    4 assign        core/partition  public rooms at the door, private behind,
//                                    with a doorway on every edge of a
//                                    spanning tree back to the entrance; then
//                                    swap same-depth purposes until the rooms
//                                    that belong beside each other are
//    5 anchors       interior-plan   the pieces the room exists for, in the
//                                    century it was built in
//    6 supporting    interior-plan   what stands around them, and what sits on
//                                    them, placed against their hosts
//    7 context       archetype.js +  the household: trade, activity, wealth,
//                    interior-plan   children, condition — and the building's
//                                    own century and climate, which are not
//                                    the household's and reach sealed rooms
//    8 validate      interior-valid  re-derive every rule from the finished
//                                    layout and REJECT what fails, per room
//                                    AND once more over the whole storey,
//                                    which is where "you cannot get to the
//                                    back of this building" lives
//    9 vary          here            re-plan a rejected room from a different
//                                    draw, prune what still will not pass, and
//                                    clear whatever is standing between a
//                                    cut-off room and the rest of the floor
//   10 emit          here            ordinary records, derived from the world
//                                    seed and the building's uid alone, each
//                                    carrying what it is FOR (affordance.js)
//
// The three ideas that survive the engine's rules and shape the rest:
//
//   ONLY WHERE THE WORLD REACHES. A floor gets furnished when something can
//   arrive at it — the ground floor (there is a door) and any tier head a
//   walkway actually matched. Cost scales with CONNECTIONS, not storeys, so a
//   24-storey spire with one bridge furnishes two levels, not twenty-four.
//
//   THE ROOM LIGHTS ITSELF. block-shapes lifts its lit slab clear of any room
//   it declares and hangs a soffit there instead, so the window still reads as
//   lit from the street while the room is lit from inside. The fake is kept
//   for floors nobody can reach and dropped where anyone can stand.
//
//   HEIGHT-INDEPENDENT CIRCULATION. A shaft is one cylinder at any height; a
//   flight of stairs per storey is per-floor cost by definition. Short blocks
//   get real stairs because they are cheap there; towers get the shaft.
//
//   A ROOM IS SOMETHING YOU DO THINGS IN. Every placement carries a verb —
//   sit, open, search, pick up, use, light — and the floor somebody has to be
//   standing on for that verb to be possible (js/affordance.js). The planner
//   refuses a position whose verb has nowhere to happen, which is what turns
//   "there is a chair here" into "you can sit down". The verb is DATA on the
//   record, so it survives an export and a handoff, and the runtime that
//   reads it (engine/props/fittings.js) imports nothing from this layer.
//
// Pure JS — no three.js — so all of it runs under the JavaScriptCore tests.

import { toWorld } from "../../kernel/core/ports.js";
import { mulberry32, seedChannel } from "../../kernel/seed.js";
import { interiorStyle, buildPiece, CATALOGUE, shade } from "./furniture.js";
import { planRoom, PROGRAMS } from "./interior-plan.js";
import { classify, occupantsOf, roomProgramme, ceilingOf, glazedFaces, climateOf,
         corridorOn, affinityOf } from "./archetype.js";
import { useRecord } from "./affordance.js";
import { planFloor, partitionRuns, WALL_T } from "../../kernel/core/partition.js";
import { validateRoom, validateFloor } from "./interior-validate.js";

export const INTERIOR_VERSION = 1;

// Every interior record's ref starts with this. `ref` is one of the fields
// buildFusionRecord carries through to VSight and the exporters, so tagging
// the kind here costs no contract change and cannot be dropped in transit.
export const INTERIOR_REF = "interior/";
export const isInterior = (rec) => !!rec?.ref?.startsWith(INTERIOR_REF);

const r2 = (v) => Math.round(v * 1000) / 1000;
const round2 = (v) => Math.round(v * 100) / 100;

// Above this many storeys a building gets a shaft rather than a stair: the
// stair is per-floor cost and the shaft is not.
const SHAFT_ABOVE = 4;

/* ── part emitters ──
   Interior-only, so they live here rather than in the catalog's block-shapes.
   All of them emit by texture ROLE (concrete/metal/board), never by a baked
   colour scheme, so themes.js re-dresses an interior with the building it
   stands in.

   AND THEY WEAR THE ROOM'S STYLE. Every one of these used to carry a hex of
   its own — one plaster, one concrete, one grey — which meant that whatever
   a world said about the inside of its buildings, the walls you actually
   stood between were the same colour in all of them. A room is identified by
   its SURFACES before it is identified by its furniture: pink boards under a
   white beamed roof is a beach house, ivory stone under a vault is a throne
   hall, and neither of those is a thing you can say with a settee. So each
   emitter takes the style the furniture is already built from and reads the
   three surface keys off it (`wall`, `floor`, `beam`).

   The default is the old constant, so a caller with no style — the suite,
   an editor placement — gets exactly what it got before. */
const SHELL = {
  wall: 0xb0a89a, floor: 0x6f7378, beam: 0x8a6a44, board: 0xcfc8b8,
  stair: 0x7d8288, core: 0x8d939b, coreRail: 0x9aa2ab,
};
const surf = (style, key) => (style && style[key] != null ? style[key] : SHELL[key]);

// One storey of floor, for a level that is not the ground.
export function floorPlateParts({ w = 8, d = 8, style = null } = {}) {
  return { grime: 0, parts: [
    { shape: "box", dims: [r2(w), 0.18, r2(d)], pos: [0, 0.09, 0], bevel: 0.02,
      color: surf(style, "floor"), tex: "concrete", tint: false },
  ] };
}

/* ── what is over your head ──
   The one surface the pipeline never emitted at all. A furnished ground room
   had a floor (the shell's), four walls (partitions) and, above the wall
   plate, nothing — you were standing in a box open to whatever the block's
   roof happened to be, which reads as a room somebody forgot to finish.

   Two answers, because there are two kinds of room and the difference is
   most of an interior's character:

     BEAMS   a roof you can see the structure of. Purlins across the short
             span with a ridge along the long one — a cottage, a workshop, a
             timber-framed study. Emitted in `beam`, which is why a world can
             have white ones over pink boards.
     VAULT   a roof that hides its structure and springs from the walls
             instead: ribs rising from each corner to a boss in the middle,
             in the same stone the room is walled with. What a hall is for.

   Which one a room gets is the ARCHETYPE's business, not a world's — see
   ARCHETYPES.ceiling in archetype.js. Both are one emitter of a handful of
   boxes, because a ceiling nobody stands under does not earn a mesh each.
   `noCollide` throughout: a beam you can walk into is a beam at head height
   in a room whose headroom the solver already planned around. */
export function ceilingParts({ w = 6, d = 6, h = 3, kind = "beams", style = null } = {}) {
  const parts = [];
  // Every surface here declines the theme's role tint — see partMaterial in
  // engine/props/Props.js. These colours are the world's, not the genre's.
  const flat = { bevel: 0.02, noCollide: true, tint: false };
  const soft = { noCollide: true, tint: false };

  if (kind === "vault") {
    /* A vault is a CEILING with ribs on it, not four sticks in the air. The
       first pass emitted only the ribs, so the surface between them was
       whatever the block's underside happened to be — which is how a hall
       eight metres to the crown came out reading as a lit box with four
       diagonals floating in it. The web is the thing you actually see. */
    const stone = surf(style, "wall");
    const rise = Math.min(1.6, h * 0.3);
    const springs = h - rise;
    const web = shade(stone, 0.06);
    // Four canted webs meeting at the crown: a groin vault, cheapest honest
    // form. Each is one box tilted about its own long axis.
    const spanW = w / 2, spanD = d / 2;
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [r2(w + 0.3), 0.12, r2(Math.hypot(spanD, rise) + 0.2)],
        pos: [0, r2(springs + rise / 2), r2(s * spanD / 2)],
        rotX: r2(s * Math.atan2(rise, spanD)), color: web, tex: "concrete", ...soft });
      parts.push({ shape: "box", dims: [r2(Math.hypot(spanW, rise) + 0.2), 0.12, r2(d + 0.3)],
        pos: [r2(s * spanW / 2), r2(springs + rise / 2), 0],
        rotZ: r2(-s * Math.atan2(rise, spanW)), color: web, tex: "concrete", ...soft });
    }
    // The ribs the webs meet on — corner to crown, and a boss where they meet.
    const rib = shade(stone, -0.14);
    const span = Math.hypot(w, d) / 2;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      parts.push({ shape: "box", dims: [r2(span), 0.3, 0.34],
        pos: [r2(Math.cos(a) * span * 0.5), r2(springs + rise * 0.5), r2(Math.sin(a) * span * 0.5)],
        rotY: r2(-a), rotZ: r2(Math.atan2(rise, span)), color: rib, tex: "concrete", ...flat });
    }
    // …and the transverse ribs, which is what makes it read as a bay rather
    // than as a tent. Along both axes, at the springing line.
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [r2(w), 0.3, 0.34], pos: [0, r2(springs + 0.15), r2(s * (d / 2 - 0.2))],
        color: rib, tex: "concrete", ...flat });
      parts.push({ shape: "box", dims: [r2(d), 0.3, 0.34], pos: [r2(s * (w / 2 - 0.2)), r2(springs + 0.15), 0],
        rotY: r2(Math.PI / 2), color: rib, tex: "concrete", ...flat });
    }
    parts.push({ shape: "sphere", dims: [0.42], pos: [0, r2(h - 0.18), 0],
      color: rib, tex: "concrete", noCollide: true, tint: false });
    // A cornice where the vault springs off the wall.
    const trim = shade(stone, 0.1);
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [r2(w + 0.2), 0.24, 0.26], pos: [0, r2(springs - 0.14), r2(s * (d / 2 - 0.12))],
        color: trim, tex: "concrete", ...flat });
      parts.push({ shape: "box", dims: [r2(d + 0.2), 0.24, 0.26], pos: [r2(s * (w / 2 - 0.12)), r2(springs - 0.14), 0],
        rotY: r2(Math.PI / 2), color: trim, tex: "concrete", ...flat });
    }
    return { grime: 0, parts };
  }

  /* ── beams ──
     A CEILING, and then the timber on it. Same correction as the vault: this
     emitted rafters alone, so the surface between them was missing and the
     room read as its darkest element — measured, the study's ceiling came out
     hue 31 at 61 saturation, a saturated orange-brown, where its reference is
     white boarding with dark beams across it.

     `pitch` is what makes the beach house's roof the shape it is: the
     reference ceiling is not flat, it rises to a ridge and the rafters follow
     it. A flat one is the same emitter with the rise set to nothing. */
  const timber = surf(style, "beam");
  const board = surf(style, "board");
  const pitched = kind === "pitched";
  const rise = pitched ? Math.min(1.9, w * 0.17) : 0;
  const base = h - rise;

  if (!pitched) {
    parts.push({ shape: "box", dims: [r2(w), 0.1, r2(d)], pos: [0, r2(h - 0.05), 0],
      color: board, tex: "plaster", ...soft });
  } else {
    // Two boarded slopes meeting at a ridge, and the gable triangles that
    // close the ends — without them a pitched ceiling is two flaps.
    const slope = Math.hypot(w / 2, rise);
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [r2(slope + 0.1), 0.09, r2(d)],
        pos: [r2(s * w / 4), r2(base + rise / 2), 0],
        rotZ: r2(-s * Math.atan2(rise, w / 2)), color: board, tex: "plaster", ...soft });
    }
  }

  // The ridge, then the rafters across it. About one every metre and a half,
  // which is the pitch a joiner would actually have set them at.
  if (pitched) {
    parts.push({ shape: "box", dims: [0.2, 0.26, r2(d)], pos: [0, r2(h - 0.12), 0],
      color: timber, tex: "wood", ...flat });
  }
  const n = Math.max(3, Math.round(d / 1.5));
  for (let i = 0; i < n; i++) {
    const z = (i / (n - 1) - 0.5) * (d - 0.3);
    if (pitched) {
      const slope = Math.hypot(w / 2, rise);
      for (const s of [1, -1]) {
        parts.push({ shape: "box", dims: [r2(slope), 0.16, 0.16],
          pos: [r2(s * w / 4), r2(base + rise / 2 - 0.11), r2(z)],
          rotZ: r2(-s * Math.atan2(rise, w / 2)), color: timber, tex: "wood", ...flat });
      }
      // A collar tie across the pair: the member that stops a roof spreading,
      // and the one the eye reads the span from.
      if (i % 2 === 0) {
        parts.push({ shape: "box", dims: [r2(w * 0.58), 0.14, 0.14], pos: [0, r2(base + rise * 0.42), r2(z)],
          color: timber, tex: "wood", ...flat });
      }
    } else {
      parts.push({ shape: "box", dims: [r2(w), 0.2, 0.18], pos: [0, r2(h - 0.22), r2(z)],
        color: timber, tex: "wood", ...flat });
    }
  }
  // A plate along each long wall, so the rafters land on something.
  for (const s of [1, -1]) {
    parts.push({ shape: "box", dims: [r2(w), 0.18, 0.18], pos: [0, r2(base - 0.06), r2(s * (d / 2 - 0.1))],
      color: timber, tex: "wood", ...flat });
  }
  return { grime: 0, parts };
}

/* ── the daylight ──
   Every one of the four reference rooms is lit by the SUN: through a doorway
   open onto a beach, through tall traceried windows, through a skylight,
   through most of a glazed wall. The pipeline had no such thing. A room's only
   light sources were the ones in the furniture catalogue — a hearth, candles,
   an oil lamp — and every one of them burns the world's `glow`, which is
   amber by construction. Measured, all four landmark interiors came out lit
   entirely at hue 31–39: the pink house, the ivory hall, the cream court and
   the whitewashed study were the same yellow room.

   So a room that has openings gets the light that comes through them. One
   real light, because the lamp pool is eight deep across the whole world and
   an interior earns one of them, plus emissive panes along the wall the door
   is in so the source has a place to be. `day` and `dayPower` are the dress's,
   like every other colour here, so a world states the light it is seen in. */
export function daylightParts({ w = 6, d = 6, h = 3, style = null } = {}) {
  const col = style?.day ?? 0xf2f2ee;
  const power = style?.dayPower ?? 1.6;
  const reach = Math.max(6, Math.hypot(w, d) * 0.62);
  const sill = Math.min(h * 0.55, 1.9);
  const parts = [
    // The light itself, hung high and toward the opening rather than at the
    // room's centre — a window is a wall, so the falloff should read as
    // directional even though a point light is not.
    { shape: "sphere", dims: [0.16], pos: [0, r2(h * 0.72), r2(d * 0.3)],
      tex: "none", color: col, emissive: col,
      emissiveIntensity: r2(power * 0.5), noCollide: true, light: r2(reach) },
  ];
  /* The panes. Emissive geometry is free where a light is not, so the wall
     the door is in carries a band of it — this is the same trick the block
     shells already use to make a window read as lit from the street, turned
     round to face the room it is supposed to be lighting. */
  const n = 3;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) - 0.5) * (w - 1.6);
    parts.push({ shape: "box", dims: [r2(Math.min(1.6, w / n - 0.3)), 0.9, 0.06],
      pos: [r2(x), r2(sill + 0.45), r2(d / 2 - 0.16)], tex: "none", color: col,
      emissive: col, emissiveIntensity: r2(power), noCollide: true });
  }
  return { grime: 0, parts };
}

/* The shaft: circulation that costs the same at four storeys and forty.
   Hollow, so you can stand in it — an extruded ring, one mesh, rather than a
   solid cylinder with a second one subtracted from it. The ladder rail reads
   as the way up without a rung per metre. */
export function coreParts({ h = 12, r = 1.5, style = null } = {}) {
  const ring = [], hole = [];
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    ring.push([r2(Math.cos(a) * r), r2(Math.sin(a) * r)]);
  }
  // Wound the other way: a hole must not share its outline's winding.
  for (let i = N - 1; i >= 0; i--) {
    const a = (i / N) * Math.PI * 2;
    hole.push([r2(Math.cos(a) * (r - 0.22)), r2(Math.sin(a) * (r - 0.22))]);
  }
  return { grime: 1.1, parts: [
    { shape: "extrude", depth: r2(h), rotX: r2(-Math.PI / 2), pos: [0, 0, 0],
      color: style?.wall != null ? shade(style.wall, -0.12) : SHELL.core,
      tex: "concrete", outline: ring, holes: [hole], tint: false },
    { shape: "cylinder", dims: [0.05, r2(h - 0.4)], seg: 8, pos: [r2(r - 0.34), r2(h / 2), 0],
      color: style?.metal ?? SHELL.coreRail, tex: "metal", metalness: 0.6, roughness: 0.45, grime: false },
  ] };
}

/* A straight flight. Cost grows with its own rise, which is why this is only
   ever used for the two or three storeys where that is still cheap. */
export function stairParts({ rise = 3.2, w = 1.4, style = null } = {}) {
  const steps = Math.max(3, Math.min(16, Math.round(rise / 0.22)));
  const t = rise / steps, run = t * 1.1;
  const parts = [];
  // A stair is walked on, so it is the FLOOR's material rather than the
  // wall's — which is also what makes a red-carpeted flight possible: a world
  // that wants one dresses its floor in the cloth.
  const tread = style?.floor != null ? shade(style.floor, -0.06) : SHELL.stair;
  for (let i = 0; i < steps; i++) {
    parts.push({ shape: "box", dims: [r2(w), r2(t), r2(run)],
      pos: [0, r2(t * (i + 0.5)), r2((i - (steps - 1) / 2) * run)],
      color: tread, tex: "concrete", tint: false });
  }
  return { grime: 0.8, parts };
}

/* A partition. Deliberately shorter than the span it divides: collision is one
   box per mesh, so a wall with a doorway punched in it is solid — the gap has
   to be the absence of geometry, exactly as with the entrance face. */
export function partitionParts({ len = 4, h = 3, gap = 1.3, style = null } = {}) {
  const solid = Math.max(0.6, (len - gap) / 2);
  const parts = [];
  const face = surf(style, "wall");
  for (const s of [1, -1]) {
    parts.push({ shape: "box", dims: [r2(solid), r2(h), 0.18],
      pos: [r2(s * (len / 2 - solid / 2)), r2(h / 2), 0], color: face, tex: "plaster", tint: false });
  }
  // A head over the opening, high enough to duck under rather than stop at.
  parts.push({ shape: "box", dims: [r2(gap), r2(Math.max(0.2, h - 2.3)), 0.18],
    pos: [0, r2(h - Math.max(0.2, h - 2.3) / 2), 0], color: face, tex: "plaster", tint: false });
  return { grime: 0.7, parts };
}

/* One run of internal wall: a straight length with nothing punched in it.
   The zoner emits a plan's partitions as runs precisely so a doorway is the
   ABSENCE of a run rather than a hole in one — same reason as above, and the
   reason this is a separate emitter from partitionParts. Length runs along
   local x; the caller turns it. */
export function wallRunParts({ len = 3, h = 2.8, thick = 0.18, style = null } = {}) {
  /* Still exactly one box, and that is load-bearing rather than tidy: this
     is the emitter whose output IS the collider (one box per mesh), so a
     second part here is a second thing to walk into on every internal wall in
     every building in every world. The colour is the only thing that needed
     to change. */
  /* GRIME 0, and it is not a detail. The weathering pass darkens a surface
     toward the floor by up to 42% AND warms it as it goes — the vertex colour
     is [s, s·0.985, s·0.955], so the blue channel loses most. On an exterior
     wall that is rain and soot and it is right. On an interior wall somebody
     painted last spring it is a yellow stain climbing a metre up every wall in
     the world, which is exactly what it looked like: pink boarding, ivory
     ashlar and off-white plaster all came out the same dirty cream. */
  return { grime: 0, parts: [
    { shape: "box", dims: [r2(len), r2(h), r2(thick)], pos: [0, r2(h / 2), 0],
      bevel: 0.01, color: surf(style, "wall"), tex: "plaster", tint: false },
  ] };
}

/* ── room envelopes ──
   A block declares its rooms in LOCAL space (block-shapes `rooms`); this puts
   them where the placement actually stands, slope and rotation included. */
export function roomsOf(record) {
  const rooms = record?.proc?.rooms;
  if (!rooms?.length) return [];
  return rooms.map((rm) => {
    const [x, y, z] = toWorld(record, [rm.x, rm.y, rm.z]);
    const s = record.scale ?? 1;
    return {
      uid: record.uid, level: rm.level, at: rm.at, x, y, z,
      w: rm.w * s, d: rm.d * s, h: rm.h * s,
      rotationY: record.rotationY || 0,
    };
  });
}

/* Which tier heads a walkway actually reached. Deliberately does NOT seed
   level 0: the ground room is admitted on its own evidence (it has a door),
   and the bottom tier's HEAD room also carries level 0 — seeding it here
   furnished a terrace-level floor that nothing could get to. */
export function connectedLevels(uid, links = []) {
  const levels = new Set();
  for (const l of links) {
    for (const p of [l.a, l.b]) if (p.uid === uid) levels.add(p.level || 0);
  }
  return [...levels].sort((a, b) => a - b);
}

// The catalogue id a placement came from — "street/row-house" → "row-house".
function kindOf(rec) {
  const ref = String(rec?.ref || "");
  const id = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
  if (id.startsWith("block-")) return "block";
  return id;
}

/* How big a single room is allowed to get before the floor is cut, in square
   metres. This is the one number that decides whether a building reads as a
   dwelling or as a shed, and it is a property of the archetype rather than of
   the floor: a cottage of forty square metres is two rooms and a barn of two
   hundred is one, because that is what each is FOR. */
const GRAIN = {
  residence: 26, workshop: 55, tavern: 46, shop: 34, warehouse: 220,
  farm: 130, guardpost: 26, admin: 44, temple: 240, infirmary: 52,
  /* A throne hall is ONE room and a study is nearly one. Both were `admin`
     until now, at a 44 m² grain — which cut a sixteen-by-fourteen keep into
     five parlours and then furnished each of them with a desk. The whole
     effect of both reference interiors is uninterrupted floor. */
  palace: 260, court: 240, study: 110,
};
// …and how many rooms it will bear. A warehouse divided into four is a
// warehouse nobody can get a cart through.
const ZONE_CAP = { warehouse: 2, temple: 2, farm: 2, guardpost: 2, palace: 2, court: 2, study: 2 };

/* How many rooms a floor is cut into — and it asks the archetype's OWN grain,
   not a constant. It used to divide by a flat 15 m², which disagreed with
   every number in GRAIN directly above it: a residence declares 26 m² rooms
   and was then asked for one room per 15, so the reference beach house — a
   single 8.8 × 7.8 volume with a sofa at one end and a stove at the other —
   came out cut into four, and because the zone filler repeats an archetype's
   last named room, three of the four were kitchens.

   Nine tenths of the grain rather than all of it: a floor gains a room when
   the second one would still be worth having, which is a little before the
   first has exactly reached its limit. Every distinction the old constant
   drew is still drawn — a dwelling divides where a warehouse does not —
   because it is now drawn by the same numbers that describe the rooms. */
function zoneCount(archetype, area) {
  const grain = (GRAIN[archetype] ?? 34) * 0.9;
  return Math.max(1, Math.min(ZONE_CAP[archetype] ?? 4, Math.floor(area / grain)));
}

// A zone's assigned purpose, as a programme the planner actually has. A space
// too small to turn round in is a cupboard whatever the grammar called it.
function programIdFor(purpose, area) {
  if (area < 7.5) return "store";
  return PROGRAMS[purpose] ? purpose : "store";
}

const overlapsRect = (a, b) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

/* Which of a zone's four walls are the BUILDING's walls rather than
   partitions. Only those can hold a window, which is the difference between
   a front room that must keep its glazing clear and a back room that has no
   outside wall at all. A finger's tolerance, because zone edges are rounded
   to the millimetre and an exact comparison would report a room flush
   against the frontage as being off it. */
function outerFaces(zone, room) {
  const t = 0.08, out = [];
  if (zone.z - zone.d / 2 <= -room.d / 2 + t) out.push("north");
  if (zone.z + zone.d / 2 >= room.d / 2 - t) out.push("south");
  if (zone.x - zone.w / 2 <= -room.w / 2 + t) out.push("west");
  if (zone.x + zone.w / 2 >= room.w / 2 - t) out.push("east");
  return out;
}

/* An upper floor, cut into the slabs that surround its stairwell. Four bands
   at most — the strip in front of the well, the strip behind it, and the two
   beside — any of which may be empty when the well is against a wall. The
   opening is what is NOT emitted. */
function floorSlabs(room, well) {
  if (!well) return [{ x: 0, z: 0, w: room.w, d: room.d }];
  const hw = room.w / 2, hd = room.d / 2;
  const x0 = Math.max(-hw, well.x - well.w / 2), x1 = Math.min(hw, well.x + well.w / 2);
  const z0 = Math.max(-hd, well.z - well.d / 2), z1 = Math.min(hd, well.z + well.d / 2);
  if (x1 <= x0 || z1 <= z0) return [{ x: 0, z: 0, w: room.w, d: room.d }];
  const out = [];
  const band = (x, z, w, d) => { if (w > 0.12 && d > 0.12) out.push({ x, z, w, d }); };
  band(0, (-hd + z0) / 2, room.w, z0 + hd);              // in front of the well
  band(0, (z1 + hd) / 2, room.w, hd - z1);               // behind it
  band((-hw + x0) / 2, (z0 + z1) / 2, x0 + hw, z1 - z0); // beside, one side
  band((x1 + hw) / 2, (z0 + z1) / 2, hw - x1, z1 - z0);  // and the other
  return out;
}

/* ── stages 8 and 9 · validate, then vary ────────────────────────────────
   The planner enforces its constraints as it places, and the validator
   re-derives them from the finished layout without sharing a line of code
   with it. Where they disagree the LAYOUT loses: the room is re-planned from
   a different draw, up to three times, and anything that still fails a
   structural rule is pruned rather than shipped.

   That is what makes the validator load-bearing rather than decorative. A
   check whose failure changes nothing is a comment. */
export function planValidated({ room, programId, style, seed, key, door, blocked, budget = 1, profile = null,
                                daylight = 0, openings = null, glazed = null, climate = "temperate" }) {
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const rng = mulberry32(seedChannel(seed, `${key}:${attempt}`));
    // The last try is a sparser room: most failures that survive two draws
    // are a room asked to hold more than it can.
    const plan = planRoom({ room, programId, style, rng, door, blocked, profile, daylight,
      openings, glazed, climate, budget: attempt === 2 ? budget * 0.6 : budget });
    const check = validateRoom({ room, placed: plan.placed, door, programId, blocked,
      extraIds: plan.extras, openings, glazed });
    if (check.ok) return { placed: plan.placed, extras: plan.extras, check, attempt };
    if (!best || check.violations.length < best.check.violations.length) {
      best = { placed: plan.placed, extras: plan.extras, check, attempt };
    }
  }
  return { ...best, placed: prune(best.placed, best.check) };
}

/* What is left when the rejected pieces are taken out. Only the structural
   codes are pruned — an object in the wrong place is a fault in that object,
   while a dark or sparse room is a fault in the room and removing things from
   it cannot help. Anything standing on a pruned piece goes with it. */
const STRUCTURAL = new Set([
  "INTERSECT", "OUT_OF_BOUNDS", "UNREACHABLE", "FLOATING",
  "WALL_DETACHED", "HEAVY_UNSUPPORTED", "SEAT_UNUSABLE", "OUT_OF_PROGRAM",
  /* All three name ONE object and are cured by removing it: a chair nobody
     can stand behind, a wardrobe across the only window, a chest inside the
     stairwell. DEAD_LIGHT and UNLIT_TASK are deliberately absent — taking the
     lamp out of a room that is already too dark is not a repair. */
  "UNUSABLE", "BLOCKS_WINDOW", "BLOCKS_FIXTURE",
  /* …and the way in. This was absent for a good reason and the reason was
     wrong: no single object owns a blocked doorway, so the code named none,
     so the pruner — which works by name — could do nothing with it, so a room
     whose second doorway was walled in was re-planned three times and then
     SHIPPED walled in. The validator now names the piece nearest the blocked
     opening, which is the repair a person would make. */
  "BLOCKS_DOOR",
]);
function prune(placed, check) {
  const drop = new Set();
  for (const v of check.violations) {
    if (!STRUCTURAL.has(v.code)) continue;
    // An intersection names both parties; the later placement is the one that
    // should not have been committed, so that is the one that goes.
    for (const id of String(v.id).split("/")) {
      for (let i = placed.length - 1; i >= 0; i--) {
        if (placed[i].id === id && !drop.has(i)) { drop.add(i); break; }
      }
    }
  }
  if (!drop.size) return placed;
  const kept = placed.filter((_, i) => !drop.has(i));
  // Only orphaned if NO piece of that kind is left standing: a room with two
  // tables that lost one should not lose the other's crockery as well.
  const standing = new Set(kept.filter((p) => !p.host || p.host === "wall").map((p) => p.id));
  return kept.filter((p) => !p.host || p.host === "wall" || p.host === "ceiling"
    || standing.has(p.host));
}

/* ── the pass ──
   Furnish every reachable room. Returns ordinary records; the caller places
   them exactly as it places anything else. */
export function composeInteriors({ records, links = [], seed = "", uidAt, index = 0, budget = 1,
                                   dress = null, biome = null, report = null }) {
  /* THE WEATHER, ONCE, FOR THE WHOLE PASS. A world states its biome and a
     biome implies its climate (archetype.js climateOf), which decides whether
     a house is built round a fire or round the shade. Derived rather than
     configured, because a climate declared beside a biome is a climate that
     can disagree with the trees outside the window. */
  const climate = climateOf(biome);
  const out = [];
  let n = index;
  let homeUid = null;   // the shell currently being furnished
  const place = (ref, label, proc, x, y, z, rotationY, use = null) => {
    const rec = {
      uid: uidAt(n++), ref: INTERIOR_REF + ref, url: null, label,
      proc, position: [round2(x), round2(y), round2(z)],
      rotationY: r2(rotationY || 0), scale: 1, autoFit: false,
      // An interior piece stands on a floor slab, never on the terrain.
      seat: "point",
    };
    /* WHAT YOU CAN DO WITH IT, on the record rather than in a registry.
       `params` is the whole world: an affordance held in a Map beside the
       editor is one that does not survive a reload, an export or a handoff to
       a runtime, and the runtime is the only place it matters. So the verb
       rides with the placement, and engine/props/fittings.js reads it without
       importing a line of this layer. */
    if (use) rec.use = use;
    /* WHICH BUILDING THIS IS IN. Not for the renderer — for the person who
       clicks a chair and wants to know why there is a chair there. Without it
       the only way back from a placement to the reasoning that produced it is
       a spatial search, which is a guess wearing arithmetic. */
    rec.home = homeUid;
    out.push(rec);
  };

  for (const rec of records) {
    if (!rec?.proc?.rooms?.length) continue;
    const levels = connectedLevels(rec.uid, links);
    const storeys = storeyCount(rec.proc);
    const kind = kindOf(rec);
    const chan = seed || rec.uid;

    /* Stages 1, 2 and 7: what this building is, and who is in it. Everything
       downstream reads the answer — a 6 × 8 space is a parlour in a cottage,
       a taproom in a tavern and a stock room in a warehouse, and no amount of
       care about furniture placement will fix having asked the wrong
       question. */
    homeUid = rec.uid;
    const cls = classify({ proc: rec.proc, kind, seed: chan, uid: rec.uid });
    const rng = cls.rng;
    // Which faces of the shell carry glass. Measured off the block's own
    // parts, so a builder who places a blind gable gets a blind gable.
    const glazed = glazedFaces(cls.evidence);
    const people = occupantsOf({ archetype: cls.archetype, evidence: cls.evidence, rng });
    /* The household still rolls its timbers and cloths — and then the WORLD
       has the last word. `dress` is a world grammar's interior identity (a
       royal blue, a coral-and-mint, a scholar's honey wood) laid over the
       rolled style, so every interior in a world agrees about what country
       it is in while still differing house to house in everything the dress
       does not name. Weathering already happened inside interiorStyle; a
       dressed colour arrives as authored, which is right — a world that
       states its colours is a world that keeps them. */
    const style = { ...interiorStyle({ wealth: people.wealth, age: people.age, wear: people.wear, rng }),
                    ...(dress || {}) };

    // The ground room is always reachable — the door proves it. A head room
    // is reachable only if a walkway actually landed on the terrace above.
    const reachable = roomsOf(rec).filter(
      (rm) => rm.at === "ground" || levels.includes(rm.level));
    if (!reachable.length) continue;

    /* ── circulation ──
       A stair exists to reach a floor. That sentence is the whole rule, and
       breaking it is what put a staircase into the ceiling of every
       two-storey cottage in every world: the old test was `storeys > 1`, and
       `storeys` counts FLOORS while a block declares a room per TIER. A
       two-floor row house declares one furnishable room, has no upper floor
       modelled at all, and was given a flight of stairs up to blank plaster.

       So the test is now the honest one — is there a reachable room ABOVE
       the ground one — and where there is, that room gets a real floor plate
       with the stairwell left out of it, because a stair that arrives at
       nothing is only half the fault.

       Still ONE object for the whole building rather than one per floor: a
       shaft rises through every storey it serves. */
    const g = reachable.find((rm) => rm.at === "ground") || reachable[0];
    const above = reachable.filter((rm) => rm.y > g.y + 1.0).sort((a, b) => a.y - b.y);
    let core = null;
    if (above.length) {
      const rot = g.rotationY;
      const ax = Math.cos(rot), az = -Math.sin(rot);
      const bx = Math.sin(rot), bz = Math.cos(rot);
      const cu = g.w / 2 - 1.9, cv = -(g.d / 2 - 1.9);
      const cx = g.x + ax * cu + bx * cv, cz = g.z + az * cu + bz * cv;
      const top = above[above.length - 1];
      if (storeys > SHAFT_ABOVE) {
        place("core", "Service core", coreParts({ h: top.y - g.y + top.h - 0.4, r: 1.5, style }), cx, g.y, cz, rot);
        core = { x: cu, z: cv, w: 3.4, d: 3.4 };
      } else {
        // The rise is the distance to the floor it lands on, not a nominal
        // storey height — the two differ wherever a tier is set back.
        place("stair", "Stair", stairParts({ rise: above[0].y - g.y, style }), cx, g.y, cz, rot + Math.PI / 2);
        core = { x: cu, z: cv, w: 2.0, d: 3.0 };
      }
      /* The floor those stairs arrive at. Emitted as slabs AROUND the
         stairwell rather than one plate with a hole in it: collision is one
         box per mesh here, so an opening has to be an absence of geometry —
         the same rule that shapes the partitions and the entrance face. */
      for (const rm of above) {
        for (const slab of floorSlabs(rm, core)) {
          const [wx, wz] = [rm.x + Math.cos(rm.rotationY) * slab.x + Math.sin(rm.rotationY) * slab.z,
                           rm.z - Math.sin(rm.rotationY) * slab.x + Math.cos(rm.rotationY) * slab.z];
          place("floor", "Floor", floorPlateParts({ w: slab.w, d: slab.d, style }), wx, rm.y - 0.18, wz, rm.rotationY);
        }
      }
    }

    for (const room of reachable) {
      const rot = room.rotationY;
      // Room axes in world space: +x along the frontage, +z into the depth.
      const ax = Math.cos(rot), az = -Math.sin(rot);   // local +x
      const bx = Math.sin(rot), bz = Math.cos(rot);    // local +z
      const at = (u, v) => [room.x + ax * u + bx * v, room.z + az * u + bz * v];
      const ground = room.at === "ground";

      /* Stages 3 and 4. The way in is the front door on the ground — which
         block-shapes puts on the +z face — and the stair head above it, so
         the plan is laid out around the route people actually take. */
      const entrance = ground || !core
        ? { x: 0, z: room.d / 2, side: "south" }
        : { x: core.x, z: core.z, side: "north" };
      const zones = zoneCount(cls.archetype, room.w * room.d);
      const programme = roomProgramme({
        archetype: cls.archetype, level: room.level, at: room.at, zones, rng,
      });
      const floor = planFloor({
        w: room.w, d: room.d, entrance, programme, rng,
        grain: GRAIN[cls.archetype] ?? 34, maxZones: zones, keepOut: core,
        /* Does this building put a passage on this floor? A cottage does not
           and a ward block cannot work without one — see corridorOn. The
           zoner cuts the spine first and hangs the rooms off it, which is the
           order a plan like that is actually designed in. */
        corridor: corridorOn({ archetype: cls.archetype, at: room.at, level: room.level }),
        /* …and which purposes want a door between them. planFloor knows
           about rectangles and deliberately not about rooms, so the table
           that knows a kitchen belongs beside the room people eat in is
           handed in rather than looked up. */
        affinity: affinityOf,
      });

      // The partitions those cuts imply, doorways left out of them.
      /* The graph as well as the doors: a wall exists wherever two rooms
         face each other, and a doorway is a hole in one. Walking the doors
         alone left two rooms on the same flank of a corridor with nothing
         between them, because neither is connected to the other. */
      for (const run of partitionRuns({ zones: floor.zones, doors: floor.doors,
                                        edges: floor.edges, h: room.h })) {
        const len = run.hi - run.lo;
        const [u, v] = run.axis === "x"
          ? [run.at, (run.lo + run.hi) / 2]
          : [(run.lo + run.hi) / 2, run.at];
        const [wx, wz] = at(u, v);
        place("partition", "Partition", wallRunParts({ len, h: run.h, thick: WALL_T, style }),
          wx, room.y + run.y, wz, rot + (run.axis === "x" ? Math.PI / 2 : 0));
      }

      /* The daylight, before anything is planned in it — the layout solver
         reads how much of the floor is already lit and stops adding candles
         to a room the sun is already in. */
      place("daylight", "Daylight", daylightParts({ w: room.w, d: room.d, h: room.h, style }),
        room.x, room.y, room.z, rot);

      /* What is over the room. ONE piece for the whole floor rather than one
         per zone: a roof does not stop at a stud wall, and four ceilings in a
         cottage is four times the geometry for a worse answer. The kind comes
         from the archetype, which is the only thing that knows whether this
         building is a house with rafters or a hall with a vault. */
      const ceiling = ceilingOf(cls.archetype);
      if (ceiling) {
        place("ceiling", ceiling === "vault" ? "Vault" : "Beams",
          ceilingParts({ w: room.w, d: room.d, h: room.h, kind: ceiling, style }),
          room.x, room.y, room.z, rot);
      }

      // Stages 5 to 9, per room.
      const onFloor = [], checks = [], pending = [];
      for (const zone of floor.zones) {
        const local = { w: zone.w, d: zone.d, h: room.h, area: zone.w * zone.d };
        const blocked = core && overlapsRect(core, zone)
          ? [{ x: core.x - zone.x, z: core.z - zone.z, w: core.w, d: core.d }]
          : [];
        const plan = planValidated({
          room: local, programId: programIdFor(zone.purpose, local.area), style,
          seed: chan, key: `room:${rec.uid}:${room.level}:${room.at}:${zone.index}`,
          door: zone.door, blocked, budget, profile: people, climate,
          // Every doorway in this zone's walls, so the room stays passable
          // and not merely enterable.
          openings: zone.openings,
          // …and which of its own four walls carry the building's glass. A
          // zone only inherits a face it actually TOUCHES: an inner room cut
          // off the back of a plan has no outside wall and therefore no
          // window to build out.
          glazed: ground ? outerFaces(zone, room).filter((s) => glazed.includes(s)) : [],
          // How much of this room the sun already reaches, from the shell's
          // own evidence: a wall of glass is daylight, a blind store room is
          // not. cls.evidence.windows is the density the surveyor measured.
          daylight: ground ? Math.min(1, (cls.evidence.windows ?? 0) * 1.1) : 0,
        });

        /* HELD, NOT EMITTED. The floor-scale check below can only repair a
           layout it is allowed to change, and a record already minted is a
           record with a uid in it: dropping one afterwards would leave a hole
           in the sequence the caller counts on. So the pieces wait here until
           the whole storey has been checked. */
        for (const p of plan.placed) {
          const piece = buildPiece(p.id, { style, rng, room: local, foot: p.foot });
          const [wx, wz] = at(zone.x + p.x, zone.z + p.z);
          pending.push({ id: p.id, label: piece.label, proc: piece.proc,
            wx, wy: room.y + p.y, wz, rot: rot + p.rot });
          onFloor.push({ ...p, x: zone.x + p.x, z: zone.z + p.z });
        }
        // `attempt` rides along so the panel can say "planned twice before it
        // passed" — the validator's refusals are the interesting half of it.
        checks.push({ zone: zone.index, purpose: zone.purpose, check: plan.check, attempt: plan.attempt });
      }

      /* ── stage 8, at the scale no room can be asked about ──
         Every room has now been checked on its own and passed. That is not
         the same as the FLOOR working: a plan can be four rooms each of which
         is furnished, lit, navigable and reachable through its own door, and
         still be a building whose back half nobody can get to, because the
         failure lives in the join. Measured over 200 furnished storeys, the
         two checks disagreed about one in forty — every one of them a room
         whose own doorway was clear from the inside and pinched from the
         other side.

         So it is a REPAIR rather than a report. The check rebuilds the whole
         storey as one grid, floods it from the front door, and names the
         piece standing between a cut-off room and the part of the building
         that can be reached; that piece comes out and the floor is asked
         again. Three passes, because a room walled in by three separate
         things is a plan that was wrong before the furniture arrived, and at
         that point removing a fourth is guessing. */
      let floorCheck = null;
      for (let pass = 0; pass < 3; pass++) {
        floorCheck = validateFloor({
          w: room.w, d: room.d, zones: floor.zones, doors: floor.doors,
          placed: onFloor, entrance: { x: entrance.x, z: entrance.z }, wallT: WALL_T,
        });
        if (floorCheck.ok) break;
        const blame = floorCheck.violations
          .map((v) => v.blame).filter((i) => i >= 0)
          .sort((a, b) => b - a);                       // last first, so indices hold
        if (!blame.length) break;
        for (const i of [...new Set(blame)]) { onFloor.splice(i, 1); pending.splice(i, 1); }
      }

      for (const q of pending) {
        place(q.id, q.label, q.proc, q.wx, q.wy, q.wz, q.rot, useRecord(q.id));
      }

      // The hook the suite drives a corpus through: a check nobody can look
      // at is a check nobody can believe.
      if (report) {
        report({
          uid: rec.uid, archetype: cls.archetype, level: room.level, at: room.at,
          zones: floor.zones, doors: floor.doors, placed: onFloor, rooms: checks,
          check: floorCheck,
          /* Everything the pipeline REASONED with, not just what it produced.
             js/export-site.js reads this verdict, and it can only be
             honest about a decision that is actually in the payload: the
             evidence the shell was classified on, how close the runner-up
             was, who was decided to live here, and the two inputs that
             reweight the catalogue underneath all of it. */
          label: cls.label, confidence: cls.confidence, ranked: cls.ranked,
          evidence: cls.evidence, people, climate, storeys,
          /* WHERE THE FLOOR IS. Everything else in this payload is in
             floor-local metres, which is the right frame for a checker and
             useless to anything that has to put something in the world. The
             room's own placement is the missing half, and without it the only
             way back to world space is to re-derive a transform that already
             exists here. */
          origin: { x: round2(room.x), y: round2(room.y), z: round2(room.z), rot: r2(rot) },
        });
      }
    }
  }
  return out;
}

/* How many storeys the block actually has.
   A generated block states it (buildingParts sets proc.storeys). A
   hand-authored one does not, and the old fallback — the tallest part
   divided by a floor height — counted the ROOF: a single-storey cottage with
   a chimney measured two storeys and was given a staircase to nowhere. So the
   fallback reads the rooms the block declares, which is the only part of a
   proc that actually claims to be a floor. */
function storeyCount(proc) {
  if (Number.isFinite(proc.storeys)) return Math.max(1, proc.storeys);
  const levels = new Set((proc.rooms || []).map((r) => r.level ?? 0));
  return Math.max(1, levels.size);
}
