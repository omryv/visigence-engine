/* affordance.js — what you can DO with a thing, and where you have to stand
 * to do it.
 *
 * The catalogue (furniture.js) says what a piece IS and the planner
 * (interior-plan.js) says where it stands. Neither of them says that a chair
 * is for sitting in, and until this file existed nothing did: a room came out
 * correct, plausible, navigable and INERT. You could walk up to a cold store
 * and look at it.
 *
 * An affordance here is two claims, and the second is the one that costs
 * something:
 *
 *   THE VERB     what pressing E does — sit, open, search, pick up, use,
 *                light. One verb per piece, because a prompt that offers two
 *                is a prompt nobody reads.
 *   THE SPOT     the patch of floor a person has to be standing on for the
 *                verb to be possible. A chair pushed up to a table is used
 *                from BEHIND it; a cupboard is used from in FRONT; a bed is
 *                used from whichever long side is not against the wall. That
 *                is the difference between an object that says "Sit" and an
 *                object you can actually sit in, and it is the thing the
 *                validator can check.
 *
 * The spot is why this is a module rather than a column in the catalogue.
 * `clear` — the floor a piece needs in front of it — already exists and is
 * NOT the same quantity: a chair declares zero clearance on purpose, because
 * the floor in front of it is the table it is drawn up to, and asking for it
 * to be empty would refuse every chair in the world. The floor a chair needs
 * to be USABLE is behind it. Two different rectangles, two different
 * questions, and conflating them is how you get a room full of seating nobody
 * can reach.
 *
 * WHAT IS DELIBERATELY NOT HERE. A thing that looks openable and is not is
 * worse than a thing that plainly is not, so this is an explicit list rather
 * than a rule with exceptions. A throne is the clearest case: it is a seat,
 * it has the `sit` tag, and it affords nothing, because the entire room it
 * stands in is an argument for a chair nobody may sit in. Deriving the verb
 * from the tag would have put "Sit" on it.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

import { CATALOGUE, WALK } from "./furniture.js";

/* ── the verbs ──────────────────────────────────────────────────────────
   Six, and the list is closed. Each one is a different thing happening in
   the world rather than a different word for the same thing:

     sit / rest    the player's own position changes
     open          geometry moves — a leaf swings, on the engine's own hinge
     search        state changes and what is inside is reported; nothing moves,
                   because a lid that pivots about the wrong axis reads worse
                   than a lid that does not pivot
     take          the object leaves the room and joins the person
     work          neither moves; the ACTIVITY is the point (a workbench, a
                   loom, a basin) and something else — a mode, a quest, a
                   crafting screen — decides what it produces
     light         a flame goes on or out

   `reach` is how far away the verb still works, in metres. It is not one
   number for everything: you can reach a lamp from further away than you can
   climb into a bed. */
export const USES = {
  sit:    { verb: "Sit",      reach: 1.15, hold: true },
  rest:   { verb: "Lie down", reach: 1.15, hold: true },
  open:   { verb: "Open",     reach: 1.30, swings: true },
  search: { verb: "Search",   reach: 1.20 },
  take:   { verb: "Pick up",  reach: 0.90, removes: true },
  work:   { verb: "Use",      reach: 1.25 },
  light:  { verb: "Light",    reach: 1.10, toggles: true },
};

export const USE_KINDS = Object.keys(USES);

/* ── which piece affords what ───────────────────────────────────────────
   Read as a list of decisions, not as a lookup table. Anything absent
   affords nothing, and most of the catalogue is absent: a rug, a banner, a
   partition and a rose window are all things you walk past.

   The three the brief names by name are all here — a chair sits, a book is
   picked up, a cold store opens — and each brought the rest of its own kind
   with it, because an interior in which one of the four cupboards opens is
   worse than one in which none of them does. */
export const AFFORD = {
  /* ── seating ──
     Everything with a seat height, EXCEPT the throne. A pew is included: a
     sanctuary you can sit down in is the whole point of a sanctuary. */
  chair: "sit", stool: "sit", bench: "sit", settee: "sit", armchair: "sit", pew: "sit",

  // ── sleeping ──  A cradle is not on this list, for the obvious reason.
  bed: "rest", cot: "rest",

  /* ── casework that opens ──
     A LEAF ON A VERTICAL HINGE, which is the whole membership rule. Every one
     of these has a door you could stand in front of and pull, and
     furniture.js emits a real `proc.door` for exactly this list — so the
     swing is the engine's own door machinery (engine/props/doors.js) rather
     than a second implementation of it. The leaf swings, its collider drops
     out while it is open, and the E key already toggles it: the cold store in
     a kitchen opens by the same code path as the front door of the house it
     is in. */
  wardrobe: "open", cabinet: "open", coldStore: "open", counterRun: "open",

  /* ── containers you look inside ──
     A lid or a drawer, not a leaf. These get a verb and a state and no
     motion, and that is a refusal rather than an omission: the engine hinges
     about the vertical axis, a chest lid pivots about a horizontal one, and a
     chest that rotates bodily when you open it is worse than a chest that
     stays still. */
  chest: "search", strongbox: "search", crate: "search", barrel: "search",
  basket: "search", shelfUnit: "search", wallShelf: "search", mediaStand: "search",

  /* ── what you can carry away ──
     Everything the surface pass puts on a tabletop. This is the brief's
     "a book click E to pick up", and it is the one verb that changes what is
     in the room rather than what state it is in. */
  books: "take", bowl: "take", bottle: "take", crock: "take", pot: "take",
  specimenJar: "take", mineral: "take", candle: "take", lampTable: "take",

  /* ── what you stand at and work ──
     The pieces a room exists FOR. None of them moves and none of them opens;
     what they afford is the activity, and a mode that wants to build
     something on a workbench has somewhere to hang it. */
  workbench: "work", worktop: "work", loom: "work", instrument: "work",
  desk: "work", table: "work", lowTable: "work", basin: "work", washstand: "work",
  stove: "work", toolRack: "work", armsRack: "work", lectern: "work", altar: "work",
  pegRail: "work",

  // ── flames ──  Everything that burns, whether it stands, hangs or is fixed.
  hearth: "light", brazier: "light", lampFloor: "light", sconce: "light",
  pendant: "light", chandelier: "light",
};

/* What a piece affords, resolved. Returns null for the things that afford
   nothing, which is most of them. */
export function affordanceOf(id) {
  const kind = AFFORD[id];
  if (!kind) return null;
  const use = USES[kind];
  const spec = CATALOGUE[id];
  return {
    kind,
    verb: use.verb,
    reach: use.reach,
    // A piece the player ends up ON has to say how high its seat is, or
    // sitting down puts the camera on the floor beside it.
    seatH: kind === "sit" || kind === "rest" ? seatHeight(id, spec) : null,
  };
}

/* The height a person's eye rides at once they have taken the piece up on its
   offer. A chair seat is knee height by construction; a bed is its own deck.
   Read off the catalogue rather than declared again, so a taller stool is a
   taller sit. */
function seatHeight(id, spec) {
  if (!spec) return 0.45;
  if (spec.tags?.includes("sleep")) return 0.58;
  return 0.45;
}

/* ── where you stand to do it ───────────────────────────────────────────
   The candidate spots, in the same room-local metres the planner works in,
   given a placement {id, x, z, rot, foot}.

   Every one is a POINT rather than a rectangle, because the question is only
   ever "can somebody stand here" and a flood fill answers that about a cell.
   More than one is returned wherever more than one is honest: a bed against a
   wall is climbed into from whichever side is free, and insisting on a
   particular side would reject half the beds in the world for being against
   the correct wall.

   WHICH SIDES ARE OFFERED IS THE ANCHOR'S BUSINESS, not the verb's, and that
   is the whole subtlety of this function. A chair is sat in from BEHIND,
   because the floor in front of it is the table it is drawn up to. A settee
   is sat in from in FRONT, because the floor behind it is the wall it is
   backed against. Both are `sit`. Deriving the approach from the verb put the
   settee's only spot inside the plaster and rejected every soft seat in every
   room in the project. */
export function useSpots(p, kind = AFFORD[p.id]) {
  if (!USES[kind]) return [];
  const spec = CATALOGUE[p.id];
  const f = p.foot || { w: 0.5, d: 0.5 };
  const c = Math.cos(p.rot || 0), s = Math.sin(p.rot || 0);
  // Piece-local (ox, oz) → room space. Same convention as the seating pass in
  // interior-plan.js: local +z is the face the piece presents to the room.
  const at = (ox, oz) => ({ x: p.x + ox * c + oz * s, z: p.z - ox * s + oz * c });
  const front = f.d / 2 + STAND;
  const side = f.w / 2 + STAND;

  switch (spec?.anchor) {
    /* Backed against something. The only honest approach is the face it
       presents, and there is exactly one of it. */
    case "wall": case "corner":
      return [at(0, front)];

    /* Drawn up to its host. Behind first, then either end — which is how
       somebody gets into the chair at the end of a bench run. */
    case "companion":
      return [at(0, -front), at(side, 0), at(-side, 0)];

    /* Fixed above the floor or standing on something else. Neither has a
       footprint worth approaching, so the spot is an arm's length away in
       each direction and the nearest usable one wins. `wallHigh` gets only
       the room side, since the other three are masonry. */
    case "wallHigh":
      return [at(0, ARM)];
    case "surface": case "ceiling":
      return [at(0, ARM), at(0, -ARM), at(ARM, 0), at(-ARM, 0)];

    /* Free-standing: all four sides, because that is what free-standing
       means. Four points rather than a ring — the walk grid is a quarter of
       a metre, so four is already finer than the thing being asked about. */
    default:
      return [at(0, front), at(0, -front), at(side, 0), at(-side, 0)];
  }
}

/* How far clear of a piece's own body the standing spot sits, in metres.

   A WHOLE person, not half of one, and the difference is not fussiness. The
   walk grid these points are tested against is a quarter of a metre and is
   eroded by a cell before the flood runs, so a spot half a body-width off a
   wardrobe lands inside the eroded band and reads as unstandable — measured,
   that rejected the bed in every bedroom in the project, because a bed's
   front spot is exactly one shoulder off the end of the mattress. Standing in
   front of something takes a person's own depth of floor, and the catalogue
   already has a number for that. */
const STAND = WALK;
/* …and for the things with no body to stand clear of: a candle on a table, a
   sconce on a wall. You reach ACROSS the piece those stand on, so the spot is
   an arm away rather than a step away, and it is deliberately longer than
   STAND — reaching over a tabletop is most of what an arm is for. */
const ARM = 0.9;

/* ── the record's own account of itself ─────────────────────────────────
   What interiors.js hangs on the emitted placement, and the only thing the
   runtime is given. Deliberately small and deliberately data: `params` is the
   whole world, so an affordance that lives in a Map somewhere in the editor
   is an affordance that does not survive an export, a reload or a handoff.

   The runtime (engine/props/fittings.js) reads exactly these fields and
   imports nothing from this layer — the engine sits BELOW the editor and may
   not reach up into it, which is why this is a plain object rather than a
   shared class. */
export function useRecord(id) {
  const a = affordanceOf(id);
  if (!a) return null;
  const out = { kind: a.kind, verb: a.verb, reach: a.reach };
  if (a.seatH != null) out.seatH = a.seatH;
  return out;
}

/* Which pieces claim a swinging leaf. The catalogue is where the hinge
   actually gets emitted — a piece knows where its own doors are and this
   module does not — so the two are kept honest by CHECKING rather than by
   sharing: the suite asserts that this set and the set of catalogue entries
   declaring `opens` are the same set. Importing one from the other would
   close a cycle (this module already reads the catalogue) and would only
   move the drift somewhere quieter.

   That drift is exactly how you get a prompt saying "Open" on a cupboard
   whose doors are painted on. */
export const SWINGS = new Set(
  Object.keys(AFFORD).filter((id) => USES[AFFORD[id]].swings));

export { STAND, ARM };
