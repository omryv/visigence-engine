/* interior-plan.js — where the furniture goes.
 *
 * The catalogue (furniture.js) says what a piece IS. This says where it can
 * stand, and it is the half that has to be right: a believable room is not a
 * good object list, it is a good object list in defensible positions.
 *
 * The design is a reservation system rather than a scatter with rejection.
 * Every piece declares a footprint and the floor it needs in front of it to
 * be usable; the planner keeps an occupancy grid of the room and will only
 * commit a placement whose footprint AND clearance are free. Nothing is
 * placed and then checked for overlap afterwards, because "check afterwards"
 * degrades into "sometimes overlap" the moment a room is tight.
 *
 * The constraints, and where each is enforced:
 *
 *   no intersection            reserve() refuses a cell that is taken
 *   clear walking paths        walkable() re-floods from the door after every
 *                              commit and rolls the piece back if the room
 *                              stopped being connected
 *   nothing blocks the door    the door span and its approach are reserved
 *                              before anything else is offered a cell
 *   beds against walls         anchor drives the candidate generator; a
 *                              wall piece is only ever offered wall cells
 *   chairs near tables         companions are placed against their host's
 *                              own edges, not sampled from the room
 *   lamps light usable floor   a coverage pass measures unlit usable area and
 *                              adds light until it is covered or it runs out
 *   heavy things on the floor  `heavy` pieces are refused a surface
 *   wall-mounted stays on wall  wallHigh reserves no floor and takes its
 *                              position from the wall run, not from the grid
 *
 * Determinism: every decision draws from the rng handed in, which the caller
 * seeds from the building's uid. Same seed, same house, forever.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

import { CATALOGUE, footprintOf, WALK, CLEAR } from "./furniture.js";
import { useSpots } from "./affordance.js";

const CELL = 0.25;                 // occupancy grid pitch, metres
const PERSON = 1;                  // erosion radius in cells: a 0.75 m corridor
const r3 = (v) => Math.round(v * 1000) / 1000;

// Grid values. Anything non-zero is unavailable to a footprint; PATH is also
// unavailable but is what walkability floods through.
const FREE = 0, TAKEN = 1, PATH = 2;

/* ── room programs ──────────────────────────────────────────────────────
   What a room is FOR, expressed as the pieces it must have, the ones it may
   have, and how densely it fills. `must` is placed first and a room that
   cannot fit its own must-list is downgraded rather than left empty.

   Read these as a brief to a joiner, not as a spawn table: a kitchen has a
   fire and a work surface because a kitchen without them is a room with a
   pot in it.

   `density` is FLOOR PIECES PER SQUARE METRE, set from what rooms actually
   hold rather than from what is comfortable to place. A forty-square-metre
   living room has eight or nine pieces of furniture in it, not three — and
   three is what the first pass of this file produced, which is exactly the
   "empty shell with a couple of props in it" the system exists to stop. A
   store packs tighter than a hall because that is what stores do. */
export const PROGRAMS = {
  /* ── the room the beach house is ──
     Read off the plate rather than off a generic idea of a parlour: a coral
     settee with a low table in front of it on a woven rug, a soft pale chair
     turned to face the door, a screen on a low stand, pictures, plants, and
     the ocean through an open door. No fire — this room is in the tropics and
     the hearth that used to be its must-list is the single most out-of-place
     object the old catalogue could put in it. SEALED, so the household's
     trade cannot bring a loom to the beach. */
  living: {
    label: "Living room",
    must: ["settee", "lowTable", "rug"],
    /* THE DINING TABLE LIVES HERE, not in the kitchen. The reference room is
       one volume — "a small living room AND kitchen-dining area" — and when
       the floor is cut, the kitchen half comes out a three-metre galley with
       its walls taken by the counter run, where a two-metre table and four
       chairs cannot stand. So the table belongs to the open side, which is
       where the plate actually has it: between the sofa and the counter. */
    may: [["armchair", 0.85], ["table", 0.85], ["plant", 0.75], ["mediaStand", 0.7],
          ["painting", 0.7], ["shelfUnit", 0.35], ["cabinet", 0.3], ["lampFloor", 0.3],
          ["hanging", 0.3], ["stool", 0.3], ["basket", 0.25], ["chest", 0.25],
          ["pegRail", 0.55]],
    /* Thin. Once the dining set moved into this zone the room was carrying a
       sofa, a low table, a rug, a dining table, its chairs, an armchair, a
       stand and a cabinet in forty square metres — and measured, you could
       reach 76% of the floor. The reference room is mostly EMPTY floor with a
       rug in the middle of it, which is what a holiday house looks like. */
    /* …and what a soft seat WAS. Upholstery is recent; the same room far
       enough back is a bench along the wall and a table in front of it.
       Without this the must-list put a settee in every cottage of every
       century, which is the one object in the room that dates it. */
    era: { settee: ["bench", 0.35] },
    seatsPerTable: [2, 3], density: 0.1, sealed: true,
  },

  /* The kitchen the plate has: a RUN of painted base units under a timber
     worktop with a basin in it, a tall cold store beside them, open shelves of
     crockery above, and a round table with chairs pulled up to it. What it is
     not is a medieval scullery of barrels and crates, which is what its old
     may-list mostly held. */
  kitchen: {
    label: "Kitchen",
    /* The TABLE first. The must-list is placed in order into an empty room,
       and a counter run laid down first takes the wall the table then cannot
       get clear of — measured, the reference kitchen's round table and its
       four chairs never appeared at all. The thing the room is arranged
       around goes down before the thing that lines its wall. */
    /* A GALLEY. Once the floor is divided this room is the narrow half, and
       what a narrow kitchen is, is a run of units with a basin in it and a
       tall cold store at the end — the reference kitchen exactly. Its table
       is on the living side of the same volume. */
    must: ["counterRun"],
    /* …and what that run WAS. A kitchen is the room the century shows in
       first: fitted base units are recent, and the same room far enough back
       is a fire with a pot over it. `era` names the older thing and the date
       the newer one arrived, and interior-plan's must pass reads it. */
    era: { counterRun: ["hearth", 0.45] },
    may: [["basin", 0.85], ["coldStore", 0.8], ["wallShelf", 0.85], ["stove", 0.5],
          ["worktop", 0.45], ["shelfUnit", 0.4], ["plant", 0.45], ["cabinet", 0.35],
          ["basket", 0.3], ["stool", 0.3], ["pegRail", 0.35]],
    seatsPerTable: [3, 4], density: 0.2, sealed: true,
  },

  bedroom: {
    label: "Bedroom",
    must: ["bed"],
    may: [["chest", 0.75], ["wardrobe", 0.55], ["cabinet", 0.4], ["stool", 0.4],
          ["rug", 0.45], ["cradle", 0.18], ["hanging", 0.35], ["shelfUnit", 0.3],
          ["bench", 0.3], ["basket", 0.35], ["desk", 0.25], ["lampFloor", 0.3]],
    seatsPerTable: [0, 1], density: 0.17,
  },
  workshop: {
    label: "Workshop",
    must: ["workbench"],
    may: [["toolRack", 0.85], ["crate", 0.7], ["barrel", 0.6], ["shelfUnit", 0.5],
          ["stool", 0.6], ["loom", 0.25], ["basket", 0.35], ["bench", 0.4],
          ["chest", 0.4], ["cabinet", 0.3], ["worktop", 0.4], ["table", 0.3]],
    seatsPerTable: [0, 1], density: 0.24,
  },
  shopfloor: {
    label: "Shop floor",
    must: ["worktop", "shelfUnit"],
    may: [["crate", 0.75], ["barrel", 0.65], ["cabinet", 0.5], ["bench", 0.45],
          ["basket", 0.6], ["hanging", 0.3], ["chest", 0.45], ["stool", 0.4],
          ["shelfUnit", 0.6], ["table", 0.35]],
    seatsPerTable: [0, 2], density: 0.26,
  },
  store: {
    label: "Store",
    must: ["shelfUnit"],
    may: [["crate", 0.9], ["barrel", 0.85], ["basket", 0.6], ["chest", 0.45],
          ["shelfUnit", 0.7], ["cabinet", 0.35], ["stool", 0.2]],
    seatsPerTable: [0, 0], density: 0.3,
  },
  /* ── the room that is not a room ──
     A corridor exists so that the rooms either side of it do not have to be
     walked through, and everything about how it is furnished follows from
     that one sentence: the middle of the floor stays EMPTY, whatever stands
     in it stands against a wall and is shallow, and most of what is in it is
     on the walls rather than on the ground.

     The lowest density in the table by a wide margin, and that is the point.
     A passage furnished at a parlour's density is a passage you cannot get
     down, which is the exact failure the corridor was cut to prevent — it
     would be perfectly possible to spend a whole pass adding circulation and
     then fill it with chests.

     SEALED, because a corridor has no trade. Nobody works in one. */
  corridor: {
    label: "Passage",
    must: ["runner"],
    may: [["pegRail", 0.8], ["painting", 0.7, 3], ["hanging", 0.45], ["bench", 0.4],
          ["chest", 0.3], ["plant", 0.4], ["shelfUnit", 0.2], ["basket", 0.2],
          ["wallMap", 0.25], ["lampFloor", 0.2]],
    seatsPerTable: [0, 0], density: 0.07, sealed: true,
  },

  hall: {
    label: "Hall",
    must: ["table"],
    may: [["bench", 0.9], ["hanging", 0.8], ["roseWindow", 0.85], ["rug", 0.6], ["lampFloor", 0.5],
          ["banner", 0.7], ["painting", 0.55], ["plant", 0.5],
          ["cabinet", 0.35], ["shelfUnit", 0.3], ["chest", 0.3], ["table", 0.4],
          ["barrel", 0.25], ["stool", 0.35]],
    seatsPerTable: [4, 8], density: 0.15, hang: "chandelier",
  },

  /* ── the room a kingdom is composed around ──
     `hall` is a mead hall: a long table, benches down it, and people eating.
     Both castle plates are a different room entirely — nobody eats in them,
     nothing is stored in them, and the whole floor is kept EMPTY so that one
     seat at the far end can be walked toward. So the density is the lowest in
     the table by some way, the must-list is one object, and what fills the
     walls is cloth and gold rather than furniture. */
  throneroom: {
    label: "Throne room",
    /* Read off the plate: a seat at the far end on a dais, a runner down the
       middle of the floor at it, benches along the sides and nothing else in
       the middle at all. The walls do the work — banners in a repeating row
       down both sides, glass at the end, gold on everything. SEALED, because
       the keep's steward is a trade and trades brought a hearth, a tool rack
       and crates into the one room this whole world is an argument for. */
    must: ["throne", "runner"],
    may: [["banner", 0.95, 14], ["plant", 0.8], ["pew", 0.75], ["bench", 0.7],
          ["roseWindow", 0.85], ["painting", 0.45, 4], ["brazier", 0.3]],
    seatsPerTable: [0, 0], density: 0.075, sealed: true, hang: "chandelier",
  },

  /* ── the room you arrive in ──
     The other castle interior. A throne room is composed around a seat you
     may not sit in; a LOBBY is composed around the way up — carpet, flowers,
     pictures, glass at the far end, and deliberately nothing to sit on in the
     middle of it. Same masonry and the same chandeliers as the throne room,
     and not one object in common at the centre of the floor, which is the
     whole difference between the two castle plates. */
  lobby: {
    label: "Lobby",
    /* The other castle interior, and it shares not one object with the throne
       room at the centre of its floor. The plate: a red carpet up a stair
       that splits, cream arches, urns of flowers along the walls, framed
       landscapes between them, glass at the rear, and a floor kept clear so
       the medallion in it can be seen. */
    must: ["runner"],
    may: [["plant", 0.95], ["plant", 0.9], ["painting", 0.85, 6], ["roseWindow", 0.9],
          ["banner", 0.85, 10], ["bench", 0.6], ["settee", 0.4], ["hanging", 0.45],
          ["lampFloor", 0.3]],
    seatsPerTable: [0, 2], density: 0.085, sealed: true, hang: "chandelier",
  },

  office: {
    label: "Office",
    must: ["desk"],
    may: [["shelfUnit", 0.8], ["cabinet", 0.6], ["chest", 0.35], ["rug", 0.4],
          ["hanging", 0.45], ["painting", 0.5], ["plant", 0.5],
          ["lampFloor", 0.3], ["bench", 0.3], ["stool", 0.35],
          ["crate", 0.25], ["wardrobe", 0.25], ["strongbox", 0.3]],
    seatsPerTable: [1, 2], density: 0.19,
  },

  /* ── the room that looks at things ──
     An office keeps records; a study makes them. Same desks, but the walls
     carry charts instead of ledgers, the benches carry specimens instead of
     strongboxes, and there is an instrument standing in the light — which is
     the single object that separates research from administration, and which
     the reference study is built around. Denser than an office because a
     working study is covered in what is being worked on. */
  study: {
    label: "Study",
    /* The reference room is a WORKING one: long tables you stand at with the
       work spread over them, a telescope in the window, specimens and
       minerals out on the benches, charts on the wall, binders on the
       shelves, and stools rather than chairs because nobody sits still in it.
       Sealed — as `admin` it was drawing a trade's cabinets and a cooper's
       barrels, and came out with eight cabinets and four barrels in it. */
    must: ["workbench", "instrument", "desk"],
    may: [["shelfUnit", 0.9], ["shelfUnit", 0.85], ["wallMap", 0.9, 4],
          ["table", 0.8], ["workbench", 0.7], ["stool", 0.8], ["stool", 0.7],
          ["plant", 0.8], ["rug", 0.7], ["painting", 0.5], ["lampFloor", 0.35],
          ["cabinet", 0.3], ["chest", 0.25]],
    seatsPerTable: [1, 2], density: 0.2, sealed: true,
  },

  guardroom: {
    label: "Guard room",
    must: ["armsRack", "table"],
    may: [["bench", 0.85], ["brazier", 0.6], ["chest", 0.6], ["strongbox", 0.4],
          ["crate", 0.5], ["barrel", 0.45], ["shelfUnit", 0.45], ["cabinet", 0.3],
          ["hanging", 0.25], ["cot", 0.35], ["lampFloor", 0.25]],
    seatsPerTable: [2, 4], density: 0.21,
  },
  sanctuary: {
    /* Rows facing one thing. The only room in the catalogue whose furniture
       is mostly ONE piece repeated, because that is what the room is. */
    label: "Sanctuary",
    must: ["altar", "pew"],
    may: [["pew", 0.9], ["roseWindow", 0.8], ["bench", 0.55], ["lectern", 0.55], ["brazier", 0.5],
          ["chest", 0.35], ["hanging", 0.6], ["shelfUnit", 0.3], ["basket", 0.25],
          ["crate", 0.2], ["lampFloor", 0.3]],
    seatsPerTable: [0, 0], density: 0.19,
  },
  /* ── the seven the brief's other buildings needed ──
     Each of these was previously furnished from the nearest room in the table
     above, and each came out as that room with the wrong label on it: a mill
     was a large workshop, a museum was a hall with pictures, a schoolroom was
     an office with too many desks, a library was a store of books. The
     difference between them is never the density and rarely the storage — it
     is the ONE object the room is arranged around, which is why every one of
     these has a short must-list and a long may-list. */

  /* A room built round a machine and the fire that drives it. Denser than a
     workshop because industry is: a workshop is one person's bench with
     space to work at it, and a mill floor is as many machines as the shaft
     will reach. */
  workfloor: {
    label: "Work floor",
    must: ["machine", "workbench"],
    may: [["machine", 0.8], ["machine", 0.6], ["furnace", 0.55], ["toolRack", 0.7],
          ["crate", 0.8], ["barrel", 0.65], ["shelfUnit", 0.45], ["worktop", 0.5],
          ["stool", 0.45], ["chest", 0.3], ["basket", 0.3]],
    seatsPerTable: [0, 1], density: 0.22,
  },

  /* Cases and plinths with room to walk between them, and the walls doing
     half the work. The floor is kept EMPTY down the middle for the same
     reason a throne room's is: a gallery is a route past things, and a
     gallery you cannot walk down is a store. */
  gallery: {
    label: "Gallery",
    must: ["displayCase", "plinth"],
    may: [["displayCase", 0.85], ["plinth", 0.8], ["painting", 0.9, 6], ["displayCase", 0.6],
          ["bench", 0.7], ["wallMap", 0.5, 2], ["plant", 0.5], ["roseWindow", 0.4],
          ["lampFloor", 0.35], ["hanging", 0.3]],
    seatsPerTable: [0, 0], density: 0.11, sealed: true, hang: "chandelier",
  },

  /* Where the books are READ, as opposed to where they are kept. Long tables
     with chairs at them, shelves round the walls, and a lectern — which is
     the object that says the room is a library rather than a dining hall. */
  readingroom: {
    label: "Reading room",
    must: ["table", "shelfUnit"],
    may: [["shelfUnit", 0.9], ["shelfUnit", 0.85], ["lectern", 0.7], ["table", 0.7],
          ["desk", 0.6], ["stool", 0.5], ["bench", 0.5], ["painting", 0.5],
          ["cabinet", 0.35], ["plant", 0.45], ["lampFloor", 0.4], ["wallMap", 0.4]],
    seatsPerTable: [2, 4], density: 0.17, sealed: true,
  },

  /* And where they are kept: shelving wall to wall, one ladder's worth of
     aisle between, and nothing to sit on. The densest programme in the table
     after a store, because that is what a stack IS. */
  stacks: {
    label: "Stacks",
    must: ["shelfUnit"],
    may: [["shelfUnit", 0.95], ["shelfUnit", 0.9], ["shelfUnit", 0.8], ["chest", 0.35],
          ["crate", 0.3], ["lectern", 0.3], ["stool", 0.25], ["wallShelf", 0.5]],
    seatsPerTable: [0, 0], density: 0.28, sealed: true,
  },

  /* Desks in rows facing one wall, and that wall carrying the board. The
     board is the whole difference from an office and it is the must-list
     entry that cannot be dropped. */
  classroom: {
    label: "Schoolroom",
    must: ["blackboard", "desk", "desk"],
    may: [["desk", 0.9], ["desk", 0.85], ["bench", 0.7], ["shelfUnit", 0.6],
          ["cabinet", 0.45], ["wallMap", 0.7, 2], ["stool", 0.5], ["table", 0.4],
          ["plant", 0.4], ["chest", 0.3], ["lampFloor", 0.3]],
    seatsPerTable: [1, 2], density: 0.2, sealed: true,
  },

  /* Stalls down one side and the tack for them on the other. Like a
     sanctuary, a room made mostly of one object repeated. */
  stables: {
    label: "Stables",
    must: ["stall"],
    may: [["stall", 0.9], ["stall", 0.8], ["pegRail", 0.7], ["barrel", 0.6],
          ["crate", 0.5], ["toolRack", 0.5], ["basket", 0.45], ["chest", 0.35],
          ["bench", 0.3], ["shelfUnit", 0.3]],
    seatsPerTable: [0, 0], density: 0.22,
  },

  /* Water, benches to leave your clothes on, and as much light as the
     building can afford. Deliberately sparse: a bath hall is mostly wet
     floor, and filling it is the one way to make it read as a laundry. */
  bathhall: {
    label: "Bath hall",
    must: ["tub", "bench"],
    may: [["tub", 0.7], ["bench", 0.8], ["washstand", 0.7], ["basin", 0.5],
          ["pegRail", 0.7], ["screen", 0.5], ["plant", 0.55], ["shelfUnit", 0.3],
          ["basket", 0.4], ["brazier", 0.35], ["roseWindow", 0.4]],
    seatsPerTable: [0, 0], density: 0.12, sealed: true,
  },

  /* Cots in rows and a chest at the foot of each. A ward is care and a
     dormitory is discipline; what separates them is the arms rack. */
  dormitory: {
    label: "Dormitory",
    must: ["cot", "cot"],
    may: [["cot", 0.9], ["cot", 0.85], ["chest", 0.8], ["armsRack", 0.5],
          ["bench", 0.5], ["washstand", 0.45], ["pegRail", 0.6], ["shelfUnit", 0.3],
          ["basket", 0.35], ["stool", 0.35], ["lampFloor", 0.3]],
    seatsPerTable: [0, 0], density: 0.2,
  },

  ward: {
    label: "Ward",
    must: ["cot", "washstand"],
    may: [["cot", 0.9], ["screen", 0.55], ["cabinet", 0.5], ["shelfUnit", 0.5],
          ["chest", 0.45], ["basket", 0.4], ["table", 0.35], ["crate", 0.25],
          ["lampFloor", 0.3], ["hanging", 0.2], ["barrel", 0.2]],
    seatsPerTable: [0, 1], density: 0.2,
  },
};

/* Which small things belong on which surface. A worktop gets crockery, a desk
   gets books and a light — the difference is most of what tells you which
   room you are standing in when you look at the tabletops. */
const SURFACE_KIT = {
  table: [["bowl", 0.6], ["bottle", 0.4], ["candle", 0.45], ["books", 0.45], ["plant", 0.25]],
  desk: [["books", 0.85], ["lampTable", 0.65], ["bottle", 0.2], ["specimenJar", 0.35], ["mineral", 0.3]],
  worktop: [["pot", 0.7], ["bowl", 0.65], ["crock", 0.6], ["candle", 0.4]],
  workbench: [["pot", 0.3], ["crock", 0.35], ["candle", 0.5], ["books", 0.15],
              ["mineral", 0.5], ["specimenJar", 0.45]],
  cabinet: [["candle", 0.5], ["crock", 0.45], ["books", 0.35], ["lampTable", 0.3], ["plant", 0.3]],
  chest: [["basket", 0.3], ["candle", 0.35]],
  shelfUnit: [["books", 0.85], ["books", 0.7], ["crock", 0.3], ["bowl", 0.25],
              ["bottle", 0.3], ["specimenJar", 0.45], ["mineral", 0.4]],
  crate: [["basket", 0.3], ["bowl", 0.2]],
  barrel: [["crock", 0.4], ["bowl", 0.3], ["candle", 0.3]],
  wallShelf: [["books", 0.6], ["crock", 0.4], ["candle", 0.4], ["plant", 0.3]],
  altar: [["candle", 0.7], ["books", 0.5], ["bowl", 0.3]],
  washstand: [["bowl", 0.85], ["crock", 0.4], ["candle", 0.35]],
  strongbox: [["books", 0.3], ["candle", 0.3]],
  // The low table is what the room's clutter actually lands on: a book left
  // open, a bowl, the pot somebody moved off the sill.
  lowTable: [["books", 0.6], ["bowl", 0.45], ["plant", 0.4], ["candle", 0.3], ["bottle", 0.2]],
};

/* ── stage 7 · who lives here, in objects ───────────────────────────────
   The programme says what a KIND of room holds. This says what THIS
   household's version of it holds, which is the difference between a correct
   room and an inhabited one.

   Three inputs, each of which changes a real house:

     TRADE       a weaver's parlour has a loom in it and a chandler's has
                 crates of tallow. The trade follows the person, not the room,
                 so it reaches into whichever room they work in.
     ACTIVITY    what was happening here recently — a meal left out, a workday
                 interrupted, a building shut up for the season. This is the
                 single thing that most makes a room read as lived in.
     HOUSEHOLD   money buys cabinets and hangings; children bring a cradle and
                 baskets; a neglected building has fewer lights burning.

   Everything returned here is a WEIGHTED OFFER, not a placement: the solver
   still refuses anything that will not fit. `ids` is handed to the validator
   so a weaver's loom in a weaver's parlour is not reported as an object with
   no reason to exist — which, for that household, it is not. */
const TRADE_KIT = {
  joiner: [["workbench", 0.8], ["toolRack", 0.8], ["crate", 0.5]],
  smith: [["workbench", 0.7], ["toolRack", 0.8], ["barrel", 0.45]],
  cooper: [["barrel", 0.85], ["workbench", 0.6], ["toolRack", 0.6]],
  potter: [["worktop", 0.6], ["shelfUnit", 0.6], ["basket", 0.5]],
  tanner: [["barrel", 0.7], ["workbench", 0.5], ["basket", 0.4]],
  wheelwright: [["workbench", 0.7], ["toolRack", 0.7], ["crate", 0.45]],
  weaver: [["loom", 0.75], ["basket", 0.6], ["chest", 0.4]],
  clerk: [["desk", 0.6], ["shelfUnit", 0.6], ["chest", 0.35]],
  reeve: [["desk", 0.6], ["strongbox", 0.5], ["shelfUnit", 0.4]],
  steward: [["cabinet", 0.6], ["strongbox", 0.45], ["shelfUnit", 0.4]],
  merchant: [["crate", 0.7], ["strongbox", 0.5], ["chest", 0.45]],
  carter: [["crate", 0.7], ["barrel", 0.5], ["basket", 0.4]],
  grocer: [["barrel", 0.7], ["crate", 0.7], ["basket", 0.6]],
  draper: [["chest", 0.7], ["shelfUnit", 0.6], ["hanging", 0.5]],
  baker: [["worktop", 0.7], ["basket", 0.6], ["barrel", 0.4]],
  chandler: [["crate", 0.6], ["shelfUnit", 0.5], ["barrel", 0.4]],
  apothecary: [["shelfUnit", 0.8], ["cabinet", 0.6], ["basket", 0.4]],
  physician: [["cabinet", 0.7], ["shelfUnit", 0.6], ["washstand", 0.5]],
  herbalist: [["shelfUnit", 0.7], ["basket", 0.6], ["crock", 0.4]],
  innkeeper: [["barrel", 0.8], ["bench", 0.7], ["crate", 0.4]],
  farmer: [["crate", 0.7], ["basket", 0.7], ["barrel", 0.5]],
  herder: [["basket", 0.6], ["crate", 0.5], ["chest", 0.35]],
  fisher: [["basket", 0.7], ["crate", 0.5], ["barrel", 0.4]],
  labourer: [["crate", 0.5], ["chest", 0.45], ["basket", 0.4]],
  watchman: [["armsRack", 0.6], ["chest", 0.5], ["bench", 0.5]],
  priest: [["lectern", 0.6], ["chest", 0.4], ["shelfUnit", 0.4]],
  widow: [["chest", 0.6], ["basket", 0.5], ["cabinet", 0.35]],
  // The three the study and the palace brought with them.
  naturalist: [["shelfUnit", 0.8], ["workbench", 0.6], ["plant", 0.7]],
  cartographer: [["wallMap", 0.9], ["desk", 0.7], ["lectern", 0.4]],
  surveyor: [["instrument", 0.8], ["wallMap", 0.6], ["chest", 0.4]],
  herald: [["banner", 0.8], ["lectern", 0.5], ["chest", 0.35]],
};

const ACTIVITY = {
  settled: { density: 1.0, kit: 1.0, may: [] },
  meal:    { density: 1.0, kit: 1.4, may: [["table", 0.5], ["bench", 0.5], ["basket", 0.4]] },
  working: { density: 1.08, kit: 1.2, may: [["crate", 0.6], ["toolRack", 0.7], ["barrel", 0.4]] },
  packing: { density: 1.16, kit: 0.8, may: [["crate", 0.85], ["basket", 0.6], ["barrel", 0.55]] },
  shut:    { density: 0.72, kit: 0.45, may: [["crate", 0.3], ["chest", 0.3]] },
};

/* ── stage 7 · the century ──────────────────────────────────────────────
   `period` has been rolled per building since the profile existed — one
   value per building rather than per world, because a street is not built in
   a year — and until now nothing read it. A building's age changed the
   COLOUR of its timber and nothing about what stood on it, so a cottage and
   the fitted kitchen in the cottage were three hundred years apart and the
   only difference between them was the varnish.

   0 is the oldest thing this catalogue can furnish and 1 is the newest.
   `from` is when a thing became available and `until` is when it stopped
   being what people used; a piece with neither is furniture, and most of the
   catalogue is furniture. A table is a table.

   The ramp either side is deliberately soft: a technology does not arrive on
   a Tuesday, and a hard cutoff produces two catalogues with a wall between
   them rather than one catalogue with a grain. */
const ERA = {
  // The fire, and what replaced it.
  hearth: { until: 0.55 }, brazier: { until: 0.5 },
  stove: { from: 0.3 }, counterRun: { from: 0.45 }, coldStore: { from: 0.72 },
  basin: { from: 0.42 }, washstand: { until: 0.72 },
  // Light, in the order it was invented.
  candle: { until: 0.9 }, sconce: { until: 0.85 },
  lampTable: { from: 0.28 }, lampFloor: { from: 0.44 }, pendant: { from: 0.5 },
  // Work, and what stopped being done at home.
  loom: { until: 0.6 }, instrument: { from: 0.25 },
  // The two that date a room on sight.
  mediaStand: { from: 0.86 }, settee: { from: 0.35 },
};
const RAMP = 0.22;   // how long a thing takes to arrive, in period units
function eraFit(id, period) {
  const e = ERA[id];
  if (!e || period == null) return 1;
  let f = 1;
  if (e.from != null) f *= clamp01((period - e.from) / RAMP + 0.5);
  if (e.until != null) f *= clamp01((e.until - period) / RAMP + 0.5);
  return f;
}

/* ── stage 7 · the weather ──────────────────────────────────────────────
   What a building is built against. A hearth is the single most out-of-place
   object a warm-country house can hold and the single most necessary one a
   cold-country house can lack, and everything else here follows from the same
   sentence: cold rooms are lined and closed, hot rooms are opened and
   shaded. Multipliers rather than lists, so a climate BENDS a programme
   instead of replacing it — a kitchen is a kitchen everywhere. */
const CLIMATE_KIT = {
  cold: { hearth: 1.6, brazier: 1.4, rug: 1.35, hanging: 1.45, wardrobe: 1.2,
          plant: 0.55, screen: 0.8, basin: 0.85 },
  temperate: {},
  hot: { hearth: 0, brazier: 0.35, rug: 0.65, hanging: 0.6, wardrobe: 0.8,
         plant: 1.6, screen: 1.35, basin: 1.25, washstand: 1.2 },
};

/* …and what a climate ADDS, which a multiplier cannot do.
   Scaling only ever bends a list the programme already holds, and the fire is
   exactly the case that needs more than that: `living` was written off a
   tropical beach house and carries no hearth anywhere in it, so a cottage in
   the tundra came out with no way of heating the room somebody sits in. A
   multiplier of 1.6 on an offer that is not there is 1.6 times nothing.

   Room by room, because the answer is: a cold country arranges its living
   room round a fire, its hall round a bigger one, and its bedroom round
   neither. These join the HOUSEHOLD's offers rather than the trade's, so a
   sealed room still gets them — the weather is a property of the building,
   and a throne hall in the north is cold whoever is standing in it. */
const CLIMATE_ROOMS = {
  cold: {
    living: [["hearth", 0.9], ["rug", 0.5]],
    hall: [["hearth", 0.7], ["brazier", 0.55]],
    bedroom: [["hearth", 0.3], ["rug", 0.4]],
    workshop: [["brazier", 0.45]],
    guardroom: [["brazier", 0.7]],
    throneroom: [["brazier", 0.5]],
    sanctuary: [["brazier", 0.45]],
    ward: [["hearth", 0.4]],
  },
  temperate: {
    living: [["hearth", 0.5]],
    hall: [["hearth", 0.4]],
    guardroom: [["brazier", 0.4]],
  },
  // Nothing to heat, and everything to open. A screen is shade and a plant
  // is what stands in the light a shutter lets through.
  hot: {
    living: [["plant", 0.55], ["screen", 0.35]],
    bedroom: [["screen", 0.4]],
    ward: [["screen", 0.45]],
  },
};

// Which rooms a person's trade actually reaches into. A smith does not keep
// his anvil in the bedroom, and a shopkeeper's stock is not in the sanctuary.
const TRADE_ROOMS = new Set(["living", "workshop", "shopfloor", "store", "office", "hall", "kitchen"]);

export function contextual({ profile, programId, climate = "temperate" }) {
  /* The century and the weather apply to EVERY room, including the sealed
     ones and including a room with nobody in it. They are properties of the
     building rather than of the household — a hall built in a cold country
     three hundred years ago is cold and old whether or not anybody has moved
     in — so `scale` is minted before the early return. */
  const clim = CLIMATE_KIT[climate] || CLIMATE_KIT.temperate;
  const period = profile?.period;
  const scale = (id) => eraFit(id, period) * (clim[id] ?? 1);

  if (!profile) return { may: [], work: [], density: 1, kit: 1, ids: new Set(), scale };
  const act = ACTIVITY[profile.activity] || ACTIVITY.settled;

  /* TWO LISTS, NOT ONE, and the split is what `sealed` is really about.

     `work` is what somebody's JOB drags into a room: a weaver's loom, a
     cooper's barrels, the crates of a day spent packing. Every measured
     failure a seal was added to stop came from here — a hearth and a tool
     rack in a throne hall, eight cabinets and four barrels in a research
     study, a loom in a beach house.

     `may` is what a LIFE leaves in a room: what money buys, what children
     need. None of that has ever put an object where it did not belong, and
     sealing it out is why the two rooms most people actually stand in
     showed nothing of the people in them. A sealed room now drops the
     trade and keeps the household. */
  const work = TRADE_ROOMS.has(programId) ? (TRADE_KIT[profile.trade] || []).slice() : [];
  work.push(...act.may);
  const may = ((CLIMATE_ROOMS[climate] || {})[programId] || []).slice();
  // Money shows up as cased furniture and soft goods; its absence shows up as
  // open storage. Both are real and both are visible from the doorway.
  const w = profile.wealth ?? 0.5;
  if (w > 0.6) may.push(["cabinet", (w - 0.6) * 1.4], ["hanging", (w - 0.6) * 1.2], ["rug", (w - 0.6) * 1.1]);
  if (w < 0.4) may.push(["crate", (0.4 - w) * 1.3], ["basket", (0.4 - w) * 1.2]);
  if ((profile.children || 0) > 0 && (programId === "bedroom" || programId === "living")) {
    may.push(["cradle", Math.min(0.7, 0.3 + profile.children * 0.2)], ["basket", 0.4], ["stool", 0.3]);
  }
  const real = (list) => list.filter(([id, chance]) => CATALOGUE[id] && chance > 0.02);
  const kept = real(may), trade = real(work);
  return {
    may: kept, work: trade,
    // A crowded household fills a room; a shut-up one empties it.
    density: act.density * (1 + Math.min(0.25, (profile.occupants || 2) * 0.03)),
    kit: act.kit * (profile.wear > 0.75 ? 0.7 : 1),
    // Everything the household justifies, sealed or not. The validator is
    // handed this so a weaver's loom in a weaver's parlour is not reported as
    // an object with no reason to exist; a room that refused the offer simply
    // never has one to report.
    ids: new Set([...kept, ...trade].map(([id]) => id)),
    scale,
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* Which piece a programme's anchor actually is, this many centuries back.
   `era` maps an id to [what stood there before it, when it arrived]; a
   building older than that date gets the older thing. Exported for the suite,
   which has to be able to assert that every substitute is itself placeable —
   a swap that names something the must pass cannot draw is a room with no
   anchor at all. */
export function inPeriod(program, id, period) {
  const swap = program.era?.[id];
  if (!swap || period == null) return id;
  const [was, arrived] = swap;
  return period < arrived ? was : id;
}

/* ── the grid ───────────────────────────────────────────────────────────── */
function makeGrid(w, d) {
  const nx = Math.max(2, Math.round(w / CELL));
  const nz = Math.max(2, Math.round(d / CELL));
  /* THE SCRATCH IS PART OF THE GRID, not something walkable() allocates.
     That function is 42% of this file's cost measured, and it ran three
     fresh typed arrays every call — once per candidate position of every
     piece, and a wall run offers sixty. The buffers are shared, so ONE walk
     is live at a time: every caller here consumes its result before anything
     floods again, and the one that holds a flood across a loop (the wall
     pass) does no placing inside it. */
  const n = nx * nz;
  return { nx, nz, w, d, cells: new Uint8Array(n),
           row: new Uint8Array(n), open: new Uint8Array(n),
           seen: new Uint8Array(n), queue: new Int32Array(n), undo: new Uint8Array(n) };
}
// Room-local metres → cell index, clamped to the grid.
const cx = (g, x) => Math.min(g.nx - 1, Math.max(0, Math.floor((x + g.w / 2) / CELL)));
const cz = (g, z) => Math.min(g.nz - 1, Math.max(0, Math.floor((z + g.d / 2) / CELL)));

/* The axis-aligned bounding box of a rectangle turned by `rot`. Conservative
   on purpose: reserving the AABB rather than the exact rotated rect costs a
   few centimetres and buys an overlap test that cannot be wrong. */
function aabb(x, z, w, d, rot) {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  return { x, z, w: w * c + d * s, d: w * s + d * c };
}

function areaIs(g, box, want) {
  const i0 = cx(g, box.x - box.w / 2), i1 = cx(g, box.x + box.w / 2 - 1e-6);
  const j0 = cz(g, box.z - box.d / 2), j1 = cz(g, box.z + box.d / 2 - 1e-6);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) if (!want(g.cells[j * g.nx + i])) return false;
  }
  return true;
}
function fill(g, box, value) {
  const i0 = cx(g, box.x - box.w / 2), i1 = cx(g, box.x + box.w / 2 - 1e-6);
  const j0 = cz(g, box.z - box.d / 2), j1 = cz(g, box.z + box.d / 2 - 1e-6);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * g.nx + i;
      // A footprint outranks a path reservation; a path never overwrites one.
      if (value === TAKEN || g.cells[k] === FREE) g.cells[k] = value;
    }
  }
}
const isFree = (g, box) => areaIs(g, box, (v) => v === FREE);
// Clearance may lie over a path — that is what a path in front of a chest is
// FOR — but never over another piece's body.
const isWalkOver = (g, box) => areaIs(g, box, (v) => v !== TAKEN);

/* ── walkability ────────────────────────────────────────────────────────
   Erode the free space by a person's half-width, then flood from the door.
   Anything the flood does not reach is a place you cannot get to, however
   pretty it looks from outside. */
function walkable(g, doorCell) {
  const { nx, nz, cells } = g;
  /* TWO 1-D PASSES. Eroding by a square is separable — a cell survives if it
     survives along x and then along z — so this costs 2(2r+1) per cell
     instead of (2r+1)². The saving is worth naming because this function is
     the most expensive thing in the file BY FAR: it re-floods on every
     candidate position of every piece, and a wall run offers forty of them.
     Same answer, exactly, because the element is a square.

     Outside the room reads as blocked throughout: a corridor cannot run
     through a wall just because the array ended. */
  const { open, row } = g;
  for (let j = 0; j < nz; j++) {
    const base = j * nx;
    for (let i = 0; i < nx; i++) {
      let ok = i >= PERSON && i < nx - PERSON;
      for (let di = -PERSON; di <= PERSON && ok; di++) if (cells[base + i + di] === TAKEN) ok = false;
      row[base + i] = ok ? 1 : 0;
    }
  }
  for (let j = 0; j < nz; j++) {
    const base = j * nx;
    for (let i = 0; i < nx; i++) {
      let ok = j >= PERSON && j < nz - PERSON;
      for (let dj = -PERSON; dj <= PERSON && ok; dj++) if (!row[(j + dj) * nx + i]) ok = false;
      open[base + i] = ok ? 1 : 0;
    }
  }
  const start = doorCell.j * nx + doorCell.i;
  const seen = g.seen;
  seen.fill(0);
  if (!open[start]) {
    // The door cell itself is pinched: search outward for the nearest open
    // cell before giving up, since the door span is a couple of cells wide.
    let found = -1;
    for (let rad = 1; rad <= 4 && found < 0; rad++) {
      for (let di = -rad; di <= rad && found < 0; di++) {
        const ii = doorCell.i + di, jj = doorCell.j - rad + Math.abs(di);
        if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && open[jj * nx + ii]) found = jj * nx + ii;
      }
    }
    if (found < 0) return { open, seen, reached: 0 };
    return flood(found);
  }
  return flood(start);

  function flood(from) {
    const q = g.queue;
    let head = 0, tail = 0, reached = 0;
    q[tail++] = from; seen[from] = 1;
    while (head < tail) {
      const p = q[head++]; reached++;
      const i = p % nx, j = (p / nx) | 0;
      if (i > 0 && open[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; q[tail++] = p - 1; }
      if (i < nx - 1 && open[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; q[tail++] = p + 1; }
      if (j > 0 && open[p - nx] && !seen[p - nx]) { seen[p - nx] = 1; q[tail++] = p - nx; }
      if (j < nz - 1 && open[p + nx] && !seen[p + nx]) { seen[p + nx] = 1; q[tail++] = p + nx; }
    }
    return { open, seen, reached };
  }
}
// Is this rectangle standing somewhere a person can actually get to?
function reachable(g, walk, box) {
  const i0 = cx(g, box.x - box.w / 2), i1 = cx(g, box.x + box.w / 2 - 1e-6);
  const j0 = cz(g, box.z - box.d / 2), j1 = cz(g, box.z + box.d / 2 - 1e-6);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (walk.seen[j * g.nx + i]) return true;
  return false;
}
/* Can somebody be standing on this exact point? The flood has already eroded
   by a person's half-width, so a cell it reached is a cell with room in it —
   which is the whole reason the erosion happens before the flood rather than
   the check happening after. A point outside the room is not a place to
   stand, and clamping would have quietly said it was. */
/* Can the flood from the front door still get to this doorway? A couple of
   cells of slack, because a door cell is where the LEAF is and the standable
   floor is just inside it. */
function mouthOpen(g, walk, cell) {
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      const i = cell.i + di, j = cell.j + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
      if (walk.seen[j * g.nx + i]) return true;
    }
  }
  return false;
}

/* Is this point inside the room and on floor nothing is standing on? The
   cheap half of `standable`, asked before the flood rather than after it. */
function onFloorPlan(g, at) {
  if (Math.abs(at.x) > g.w / 2 || Math.abs(at.z) > g.d / 2) return false;
  return g.cells[cz(g, at.z) * g.nx + cx(g, at.x)] !== TAKEN;
}

function standable(g, walk, at) {
  if (Math.abs(at.x) > g.w / 2 || Math.abs(at.z) > g.d / 2) return false;
  return !!walk.seen[cz(g, at.z) * g.nx + cx(g, at.x)];
}

/* ── candidate positions ────────────────────────────────────────────────
   One generator per anchor. Each yields {x, z, rot} in room-local metres,
   with rot already turned so the piece faces the way that piece should face:
   a wall piece has its back to the wall, which for every build() in the
   catalogue means local −z points at it. */
function wallSlots(room, f, rng, margin = 0.06) {
  const out = [];
  const hw = room.w / 2 - margin, hd = room.d / 2 - margin;
  // north (−z) wall faces +z, and so on round. Step along each wall at a
  // pitch fine enough to find a gap but coarse enough to stay cheap.
  const walls = [
    { rot: 0,             along: "x", fixed: -hd + f.d / 2, span: room.w },
    { rot: Math.PI,       along: "x", fixed:  hd - f.d / 2, span: room.w },
    { rot: Math.PI / 2,   along: "z", fixed: -hw + f.d / 2, span: room.d },
    { rot: -Math.PI / 2,  along: "z", fixed:  hw - f.d / 2, span: room.d },
  ];
  for (const wall of walls) {
    const usable = wall.span - f.w - margin * 2;
    if (usable <= 0) continue;
    const steps = Math.max(1, Math.round(usable / 0.35));
    for (let k = 0; k <= steps; k++) {
      const t = -usable / 2 + (usable * k) / steps;
      out.push(wall.along === "x"
        ? { x: t, z: wall.fixed, rot: wall.rot }
        : { x: wall.fixed, z: t, rot: wall.rot });
    }
  }
  // Shuffled by the room's own rng, so two rooms of the same size do not
  // fill their walls in the same order.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cornerSlots(room, f) {
  const hw = room.w / 2 - 0.06 - f.w / 2, hd = room.d / 2 - 0.06 - f.d / 2;
  return [
    { x: -hw, z: -hd, rot: 0 }, { x: hw, z: -hd, rot: 0 },
    { x: -hw, z: hd, rot: Math.PI }, { x: hw, z: hd, rot: Math.PI },
  ];
}

/* `margin` is the floor left between a free-standing piece and the wall: half
   a metre for something you walk round, a couple of centimetres for something
   you walk ON. Without the second figure a runner could not be laid in a
   corridor at all — 1.2 m of carpet in a 1.5 m passage leaves 15 cm a side,
   and the walking-room margin refused every position on the floor. */
function floorSlots(room, f, rng, margin = 0.5) {
  const out = [];
  const hw = room.w / 2 - margin - f.w / 2, hd = room.d / 2 - margin - f.d / 2;
  if (hw <= 0 || hd <= 0) return out;
  const nx = Math.max(1, Math.round(hw * 2 / 0.5)), nz = Math.max(1, Math.round(hd * 2 / 0.5));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = -hw + (2 * hw * i) / nx, z = -hd + (2 * hd * j) / nz;
      // A free-standing piece may square up to either axis.
      out.push({ x, z, rot: rng() < 0.5 ? 0 : Math.PI / 2 });
    }
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ── the planner ────────────────────────────────────────────────────────
   room     {w, d, h, area} in metres, local space, origin at the centre
   door     {x, side} where the way in meets the wall; `side` names the wall
            and `x` is the offset ALONG it — an x for north/south, a z for
            east/west, which is what a zoned floor hands back
   blocked  rectangles the building itself owns (a stair, a chimney breast)
   profile  the household, from archetype.js — trade, activity, wealth
   Returns placements: {id, x, z, y, rot, foot, host}                      */
export function planRoom({ room, programId, style, rng, door, blocked = [], budget = 1, profile = null,
                           daylight = 0, openings = null, glazed = null, climate = "temperate" }) {
  const program = PROGRAMS[programId] || PROGRAMS.living;
  const ctx = contextual({ profile, programId, climate });
  const g = makeGrid(room.w, room.d);
  const placed = [];
  const walls = [];      // wall runs already used by wallHigh pieces

  // What the building owns is unavailable before anything is offered a cell.
  for (const b of blocked) fill(g, aabb(b.x, b.z, b.w, b.d, 0), TAKEN);

  /* The ways in, and the floor in front of each. Reserved as PATH rather than
     TAKEN: furniture may not stand here, but a chest's clearance may overlap
     it, because standing room and walking room are the same floor.

     ALL of them, not just the one this room is entered BY. A zone in the
     middle of a plan has a doorway on its route back to the street and
     another one onward into the room behind it, and only the first was ever
     reserved — so the onward door was furniture's for the taking, and a
     building could be navigable room by room and impassable end to end. The
     first is still the one the flood starts from, because that is the route
     everything else is measured along.

     All four walls, not two: once a floor is divided into rooms, most doors
     are internal ones and an internal door lands on whichever wall the two
     rooms share. Planning an east door as though it were a north one put the
     approach on the wrong side of the room and the furniture in the way. */
  /* WIDER THAN THE DOOR. A doorway is 1.15 m clear (partition.js DOOR_W) and
     reserving 1.6 m of wall for it left 0.22 m of slack a side — which is
     less than the half-body the walk grid erodes by before it floods, so a
     chest standing 0.81 m off the centre line satisfied the reservation and
     pinched the opening shut anyway. Measured over 72 furnished floors, that
     was the ONE remaining case of a room the building could not reach: a
     plan that was correct, a doorway that was clear, and nobody able to get
     through it. The door's own width plus a person either side. */
  const doorSpan = 2.0;
  const ways = openings?.length ? openings : [door];
  const cellFor = (way) => {
    const sideways = way.side === "east" || way.side === "west";
    const inward = way.side === "south" || way.side === "east" ? -1 : 1;
    if (sideways) {
      const dx = (way.side === "east" ? room.w / 2 : -room.w / 2);
      fill(g, { x: dx + inward * 0.75, z: way.x, w: 1.5, d: doorSpan }, PATH);
      return { i: cx(g, dx + inward * 0.5), j: cz(g, way.x) };
    }
    const dz = (way.side === "south" ? room.d / 2 : -room.d / 2);
    fill(g, { x: way.x, z: dz + inward * 0.75, w: doorSpan, d: 1.5 }, PATH);
    return { i: cx(g, way.x), j: cz(g, dz + inward * 0.5) };
  };
  const doorCell = cellFor(door);
  /* EVERY way out has to stay connected to the way IN, and that is a
     different claim from every way out having floor reserved in front of it.
     A piece standing BETWEEN two of a room's doorways satisfies both
     reservations and still cuts the room in half — which is how a plan whose
     graph is connected produces a building whose back rooms cannot be
     reached. Measured over 200 furnished floors, this was the whole of the
     remaining failure. */
  const wayCells = ways.filter((w) => w !== door).map(cellFor);

  /* ── the walls that are mostly glass ──
     `glazed` names the sides of this room the building put windows in, and a
     window is not decoration: it is the reason the room is habitable in
     daylight and it is the one wall element a person actually looks through.
     Standing a wardrobe across it is the interior equivalent of bricking it
     up — legal, cheap, and the first thing anybody notices.

     Enforced as a HEIGHT rule rather than a ban, because that is the real
     one: a chest under a window is a window seat and a bench under one is
     furniture. What may not go there is anything that reaches the sill. */
  const glazedSides = new Set(glazed || []);
  /* A HAIR STRICTER THAN THE CHECK. The validator draws the same two lines at
     1.05 m and half a metre; this refuses at a centimetre lower and six
     centimetres further out, so a piece that lands exactly on the boundary is
     refused HERE — where the answer is "try the next slot" — rather than
     there, where the answer is "delete it". Enforcement should always be the
     stricter of the two, or the difference between them is measured in
     pruned furniture. */
  const SILL = 1.04;
  const acrossGlass = (body, height) => {
    if (!glazedSides.size || height < SILL) return false;
    const band = 0.56;   // how close to the wall counts as being against it
    if (glazedSides.has("north") && body.z - body.d / 2 < -room.d / 2 + band) return true;
    if (glazedSides.has("south") && body.z + body.d / 2 > room.d / 2 - band) return true;
    if (glazedSides.has("west") && body.x - body.w / 2 < -room.w / 2 + band) return true;
    if (glazedSides.has("east") && body.x + body.w / 2 > room.w / 2 - band) return true;
    return false;
  };

  /* ── commit ──
     The single place a placement becomes real. Refuses on footprint, on
     clearance, on reachability, and — last — on whether the room is still
     connected afterwards, rolling the grid back if it is not. */
  function commit(id, at, f, host = null) {
    const spec = CATALOGUE[id];
    const body = aabb(at.x, at.z, f.w, f.d, at.rot);
    if (Math.abs(body.x) + body.w / 2 > room.w / 2 + 1e-6) return false;
    if (Math.abs(body.z) + body.d / 2 > room.d / 2 + 1e-6) return false;
    if (!isFree(g, body)) return false;
    if (acrossGlass(body, f.h)) return false;

    // The floor this piece needs in front of it to be worth having.
    const clr = spec.clear || 0;
    let front = null;
    if (clr > 0) {
      const fx = Math.sin(at.rot), fz = Math.cos(at.rot);   // local +z, turned
      front = aabb(at.x + fx * (f.d / 2 + clr / 2), at.z + fz * (f.d / 2 + clr / 2),
        f.w, clr, at.rot);
      if (!isWalkOver(g, front)) return false;
    }

    /* THE CHEAP HALF OF THE USABILITY TEST, BEFORE THE EXPENSIVE ONE.
       Whether somebody can stand where the verb happens needs the walk flood,
       and the flood is the costliest thing in this file — it runs once per
       candidate slot, and a wall run offers forty. But most of the candidates
       that will fail can be refused without it: a spot outside the room, or
       inside something already standing, is not a spot however the flood
       comes out. Asking that first is worth about a third of the pass. */
    const spots = useSpots({ id, x: at.x, z: at.z, rot: at.rot, foot: f });
    if (spots.length && !spots.some((sp) => onFloorPlan(g, sp))) return false;

    // The rollback copy, into the grid's own buffer rather than a fresh one:
    // this runs on every candidate that gets this far.
    const before = g.undo;
    before.set(g.cells);
    /* A RUG IS FLOOR. Flat pieces used to reserve their footprint as TAKEN
       like everything else, which made the mat in the middle of a room a
       hole in the middle of the room: nothing could stand on it and — worse
       — the walkability flood could not cross it, so a large rug quietly
       split a parlour in two. The validator never agreed; it excludes flat
       pieces from the solid set, which is why the disagreement survived. A
       path, then: you may walk on it and a table may stand on it, and it
       still cannot be laid where something already stands. */
    fill(g, body, spec.flat ? PATH : TAKEN);
    if (front) fill(g, front, PATH);

    /* What "reachable" means for a piece is that a person can stand AT it,
       not that they can stand IN it. The body is occupied by definition —
       probing it asks whether you can walk through the wardrobe, and the
       answer is always no, which rejected almost every placement after the
       first and left rooms with four things in them. So each piece keeps the
       approach it was committed with: its clearance where it has one, and a
       halo the width of a person where it does not. */
    const probe = front || aabb(at.x, at.z, f.w + WALK, f.d + WALK, at.rot);

    const walk = walkable(g, doorCell);
    if (walk.reached === 0 || !reachable(g, walk, probe)) { g.cells.set(before); return false; }
    for (const cell of wayCells) {
      if (!mouthOpen(g, walk, cell)) { g.cells.set(before); return false; }
    }

    /* ── and it has to be USABLE ──
       Reachable says a person can get to the piece. Usable says they can get
       to the side of it that the thing it offers actually happens on, and the
       two are different questions the moment a piece has a front: a chair
       whose back is jammed against a chest is a chair you can walk up to and
       cannot sit in. This is the brief's "chairs cannot be used because
       nearby geometry blocks them", enforced where it can still be answered
       by choosing somewhere else rather than by deleting the chair. */
    if (spots.length && !spots.some((sp) => standable(g, walk, sp))) {
      g.cells.set(before); return false;
    }

    // …and nothing already standing may have been cut off by this one, or had
    // the floor it is used from taken away.
    for (const p of placed) {
      if (p.spec.flat || p.host) continue;
      if (!reachable(g, walk, p.probe)) { g.cells.set(before); return false; }
      if (p.spots && !p.spots.some((sp) => standable(g, walk, sp))) { g.cells.set(before); return false; }
    }

    placed.push({ id, spec, x: r3(at.x), z: r3(at.z), y: 0, rot: r3(at.rot), foot: f, host, probe,
      spots: spots.length ? spots : null });
    return true;
  }

  // Try a piece against every candidate its anchor allows, in order.
  // Anchors that another pass owns are refused here rather than quietly
  // treated as floor pieces — that is how a wall hanging ended up standing
  // on the floorboards leaning against the plaster.
  const FLOOR_ANCHORS = new Set(["wall", "corner", "floor", "rug"]);
  function tryPlace(id) {
    const spec = CATALOGUE[id];
    if (!FLOOR_ANCHORS.has(spec.anchor)) return null;
    const f = footprintOf(id, rng, room);
    let slots;
    if (spec.anchor === "corner") slots = cornerSlots(room, f).concat(wallSlots(room, f, rng));
    else if (spec.anchor === "floor") slots = floorSlots(room, f, rng);
    else if (spec.anchor === "rug") slots = floorSlots(room, f, rng, 0.12);
    else slots = wallSlots(room, f, rng);
    for (const at of slots) if (commit(id, at, f)) return placed[placed.length - 1];
    return null;
  }

  /* ── 1. what the room is for ──
     …IN THE CENTURY IT WAS BUILT IN. A room's anchor is the one object that
     is not optional, and for two of these rooms that object was invented: a
     fitted run of base units under a timber worktop is a modern kitchen, and
     the same room three hundred years earlier is a fire and a table. The
     must-list stays a list of ids — an `era` map beside it says what each one
     was before it existed, so a period-0 cottage gets a hearth in the room
     the programme calls a kitchen rather than an anachronism. */
  /* A must-list entry that belongs to the WALL pass is not skipped, it is
     promoted: a schoolroom's board is the object the room is arranged
     around and it hangs above head height, so requiring it here and drawing
     it there is the only way `must` can mean what it says for every anchor.
     Without this the must pass silently dropped it — the floor pass refuses
     an anchor another pass owns — and a classroom was an office with too
     many desks in it. */
  const mustHigh = [];
  for (const raw of program.must) {
    const id = inPeriod(program, raw, profile?.period);
    if (CATALOGUE[id].anchor === "wallHigh") mustHigh.push(id);
    else tryPlace(id);
  }

  /* ── 2. seating, placed against the thing it seats ──
     A chair belongs to a table. Generating chairs from the room and hoping
     they land near one is how you get a chair in a corner facing a wall. */
  const [seatMin, seatMax] = program.seatsPerTable;
  for (const host of placed.filter((p) => p.spec.seats)) {
    const want = seatMin + Math.floor(rng() * (seatMax - seatMin + 1));
    let seated = 0;
    // Long sides first, then the ends: how people actually sit at a table.
    const edges = [];
    const hw = host.foot.w / 2, hd = host.foot.d / 2;
    const per = Math.max(1, Math.round(host.foot.w / 0.62));
    for (const sz of [1, -1]) {
      for (let k = 0; k < per; k++) {
        const t = per === 1 ? 0 : -hw + 0.31 + k * ((host.foot.w - 0.62) / (per - 1));
        edges.push({ ox: t, oz: sz * (hd + 0.3), face: sz > 0 ? Math.PI : 0 });
      }
    }
    for (const sx of [1, -1]) edges.push({ ox: sx * (hw + 0.3), oz: 0, face: sx > 0 ? -Math.PI / 2 : Math.PI / 2 });
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }
    for (const e of edges) {
      if (seated >= want) break;
      // Host-local offset, turned into room space by the host's own rotation.
      const c = Math.cos(host.rot), s = Math.sin(host.rot);
      const x = host.x + e.ox * c + e.oz * s;
      const z = host.z - e.ox * s + e.oz * c;
      const id = rng() < 0.7 ? "chair" : "stool";
      const f = footprintOf(id, rng, room);
      if (commit(id, { x, z, rot: host.rot + e.face }, f, host.id)) seated++;
    }
  }

  /* ── 3. what else the household owns ──
     Budgeted by floor area, so a big room gets more things rather than the
     same things further apart, and a small one does not get stuffed. */
  /* Counted in pieces ADDED, not in pieces present: the must-list and the
     seating are not optional and must not eat the allowance for everything
     else, or a room with a big table ends up with nothing but a table. */
  const target = Math.max(2, Math.round(room.area * program.density * ctx.density * budget));
  /* Keep offering until the room is as full as its programme wants OR it
     genuinely stops accepting. The stopping condition is consecutive misses,
     not a fixed number of turns: a turn is lost both when the dice say no and
     when the floor says no, and counting turns meant a run of unlucky rolls
     left a room with a bed and a chest in it. Running until the FLOOR refuses
     is also what makes available space a real driver of how full a room is,
     rather than a cap nobody reaches. */
  /* The household's own offers ride alongside the programme's. Anything whose
     anchor another pass owns is dropped here rather than offered and refused:
     a wall hanging is not a candidate for a patch of floor, and counting it as
     a miss spent the room's patience on a piece that was never eligible. */
  /* A piece may state the smallest room it belongs in (`minArea`): a rose
     window is a castle-hall object, and in a study's seven-metre reading
     room the same panel is set dressing from another building. Filtered at
     the pool, so a skipped piece costs no patience. */
  const roomy = ([id]) => !(CATALOGUE[id].minArea > room.area);
  /* …and a piece has to belong to this building's century and its weather.
     Dropped at the POOL rather than rolled and refused, for the same reason
     `minArea` is: a piece that cannot be here should cost the room none of
     its patience. A multiplier of zero is a hearth in the tropics — the one
     case where the answer is never rather than rarely. */
  const inPlace = ([id]) => ctx.scale(id) > 0.03;
  /* ── SEALED ROOMS ──
     `contextual()` is what turns a correct room into an inhabited one: the
     household's trade, its money and what it was doing an hour ago all reach
     into the furniture. That is right for the room somebody lives in and
     wrong for the four rooms these worlds are actually about.

     Measured before this existed: a throne hall came out holding a hearth, a
     tool rack, crates and crocks, because the keep's steward is a trade and
     trades bring their tools; the beach house held a loom because somebody
     rolled weaver; the research study held eight cabinets and four barrels.
     None of those rooms belongs to a household — a throne room belongs to a
     kingdom and a study belongs to a discipline — so a programme may say it
     takes no offers, and then what is in it is what it named. */
  const offers = program.sealed ? ctx.may : ctx.may.concat(ctx.work);
  const pool = program.may.concat(offers)
    .filter(([id]) => FLOOR_ANCHORS.has(CATALOGUE[id].anchor))
    .filter(roomy).filter(inPlace)
    // The odds themselves bend: a settee in a new house is likelier than one
    // in an old house that has not quite stopped having them.
    .map(([id, chance]) => [id, Math.min(1, chance * ctx.scale(id))]);
  let optional = pool.slice();
  let added = 0, misses = 0;
  while (added < target && misses < 24 && pool.length) {
    if (!optional.length) optional = pool.slice();
    const idx = Math.floor(rng() * optional.length);
    const [id, chance] = optional[idx];
    optional.splice(idx, 1);
    /* SOME THINGS THERE IS ONLY ONE OF. The pool refills when it empties, so
       a room big enough keeps being offered the same list again — which is
       right for a chair and absurd for a refrigerator. Measured: the beach
       house came out with three screens on three stands in one room. A spec
       says so itself, because it is a property of the object rather than of
       the room it is in. */
    if (CATALOGUE[id].once && placed.some((p) => p.id === id)) continue;
    // The odds decide whether the household owns one; the solver decides
    // whether it fits.
    if (rng() >= chance) { misses++; continue; }
    if (tryPlace(id)) { added++; misses = 0; } else misses++;
  }

  /* ── 4. the walls above head height ──
     No floor cost, so these are placed on wall RUNS rather than on the grid,
     and only where they will not sit inside something tall. */
  const offered = program.may.concat(offers).filter(roomy).filter(inPlace);
  /* ONE OF EACH WAS THE BUG. This used to reduce the offers to a Set, so a
     programme could ask for a banner four times and get exactly one — and a
     ceremonial hall whose reference has fourteen of them down two walls came
     out with a single banner on an otherwise blank forty metres of ashlar.
     The rows ARE the room. So a repeated offer is a repeated placement, each
     one drawn and sited independently; `once` still holds for the pieces
     there is genuinely only one of. */
  const wallHigh = [["sconce", 0.75, 3], ["wallShelf", 0.45, 1]].concat(
    offered.filter(([id]) => CATALOGUE[id].anchor === "wallHigh"));
  /* A third number is HOW MANY, and it is what a ceremonial hall is made of:
     the reference throne room hangs fourteen banners down two walls in a
     repeating rhythm, and one banner on forty metres of ashlar is not a
     smaller version of that, it is a different room. Each repeat is drawn and
     sited on its own, so a row thins out rather than stopping dead — and the
     wall runs out long before the count does in any room too small for it. */
  const queue = [];
  for (const [id, chance, count] of wallHigh) {
    const era = ctx.scale(id);
    if (era <= 0.03) continue;
    for (let k = 0; k < (count ?? 1); k++) queue.push([id, Math.min(1, chance * era) * (1 - k * 0.04)]);
  }
  // The promoted must-entries go first and are not rolled for. A required
  // piece competing for wall space with a sconce is a required piece that
  // sometimes does not exist.
  for (const id of mustHigh) queue.unshift([id, 1]);
  /* The floor as it finally stands. A wall fitting reserves nothing, so this
     never changes again — one flood serves the whole pass, and it is what
     lets a sconce be asked the same question a chest was. */
  const settled = walkable(g, doorCell);
  for (const [id, chance] of queue) {
    if (CATALOGUE[id].once && placed.some((p) => p.id === id)) continue;
    if (rng() > chance) continue;
    const f = footprintOf(id, rng, room);
    const spec = CATALOGUE[id];
    // The real depth, not a token one: a wall fitting sits with its back on
    // the wall and its body in the ROOM, and positioning it as though it
    // were paper-thin buries half of it in the masonry.
    const slots = wallSlots(room, f, rng, 0.02);
    for (const at of slots) {
      // Clear of anything standing tall enough to be in the way.
      const shadow = aabb(at.x, at.z, f.w + 0.2, 0.6, at.rot);
      const tall = placed.some((p) => !p.spec.small && (p.foot.h || 0) > (spec.mountH || 1.4) - 0.25
        && overlaps(aabb(p.x, p.z, p.foot.w, p.foot.d, p.rot), shadow));
      if (tall) continue;
      const key = `${at.rot.toFixed(2)}:${Math.round(at.x / 0.7)}:${Math.round(at.z / 0.7)}`;
      if (walls.includes(key)) continue;
      /* AND YOU HAVE TO BE ABLE TO GET AT IT. A sconce is lit, a peg rail is
         hung on, a wall shelf is searched, and every one of those needs
         somewhere to stand — behind a chest is not somewhere to stand. This
         pass reserves no floor, so it never noticed what the floor pass had
         already put under the wall it was choosing: measured over 280 rooms,
         235 sconces went up on walls with furniture parked against them. */
      const spots = useSpots({ id, x: at.x, z: at.z, rot: at.rot, foot: f });
      if (spots.length && !spots.some((sp) => standable(g, settled, sp))) continue;
      walls.push(key);
      placed.push({ id, spec, x: r3(at.x), z: r3(at.z), y: r3(spec.mountH), rot: r3(at.rot), foot: f, host: "wall" });
      break;
    }
  }

  /* ── 5. light ──
     Measured, not sprinkled. Sum what the placed pieces already light, find
     the usable floor still in the dark, and answer it: a pendant over open
     floor, a lamp on a surface, a standing lamp against a wall. */
  const lightPass = () => {
    const walk = walkable(g, doorCell);
    let dark = 0, total = 0, dx = 0, dz = 0;
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        if (!walk.seen[j * g.nx + i]) continue;
        const x = -room.w / 2 + (i + 0.5) * CELL, z = -room.d / 2 + (j + 0.5) * CELL;
        total++;
        const lit = placed.some((p) => p.spec.lights
          && Math.hypot(p.x - x, p.z - z) < p.spec.lights);
        if (!lit) { dark++; dx += x; dz += z; }
      }
    }
    return { dark, total, at: dark ? { x: dx / dark, z: dz / dark } : null };
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const { dark, total, at } = lightPass();
    /* A ROOM THE SUN IS ALREADY IN NEEDS FEWER CANDLES. `daylight` is 0..1 for
       how well lit the room already is before a single lamp is placed
       (interiors.js emits the room's own daylight before this runs), and
       without it every one of the four reference rooms — every one of them
       sunlit in its own plate — was given a hearth, a standing lamp and a
       scatter of candles to cover a floor that was never dark. The bar rises
       rather than the pass being skipped: a sunlit room still wants a lamp in
       the corner the sun does not reach. */
    const bar = 0.28 + Math.min(0.46, daylight * 0.6);
    if (!total || dark / total < bar || !at) break;
    /* A ceiling lamp needs nothing but headroom, so it is tried first — and
       WHICH one hangs there is the programme's to say. A hall's light is a
       chandelier and a kitchen's is a pendant on a flex, and hard-coding the
       pendant here is what put a workshop lamp in the middle of both castle
       plates' one memorable ceiling. `minArea` still has the last word: in a
       room too small for a chandelier the pendant is the honest answer. */
    const hangId = program.hang && !(CATALOGUE[program.hang].minArea > room.w * room.d)
      ? program.hang : "pendant";
    /* …AND WHETHER IT HAD BEEN INVENTED. A pendant on a flex is a lamp with a
       date on it, and this pass reached past the era filter to hang one in
       every medieval cottage in the project — the one branch in the file that
       chose a piece without asking whether it belonged here. A chandelier
       names no date and a hall keeps it. */
    if (room.h > 2.4 && attempt === 0 && ctx.scale(hangId) > 0.3) {
      const f = footprintOf(hangId, rng, room);
      placed.push({ id: hangId, spec: CATALOGUE[hangId], x: r3(at.x), z: r3(at.z),
        y: r3(room.h - 0.05), rot: 0, foot: f, host: "ceiling" });
      continue;
    }
    // Otherwise a surface near the dark, or failing that a standing lamp.
    const surf = placed
      .filter((p) => surfaceTop(p) !== null && !p.host)
      .sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
    // An oil lamp is no more timeless than a pendant; a room too old for one
    // answers its dark corner with a standing light or a candle instead.
    if (surf && ctx.scale("lampTable") > 0.3 && placeOnSurface("lampTable", surf)) continue;
    /* …and failing that, something standing on the floor that burns. WHICH
       one is the century's, exactly as the hung lamp is: a standing oil lamp
       is a nineteenth-century object and this pass used to put one in a
       twelfth-century hall because it was the only floor light the branch
       knew about. Ordered newest first, so a room takes the best light it
       could have had. */
    const stood = ["lampFloor", "brazier", "hearth"].find((id) =>
      ctx.scale(id) > 0.3 && !(CATALOGUE[id].minArea > room.area));
    if (!stood || !tryPlace(stood)) {
      // Nothing stands: a candle on whatever surface is nearest the dark is
      // what a room without a lamp actually did.
      if (!(surf && ctx.scale("candle") > 0.1 && placeOnSurface("candle", surf))) break;
    }
  }

  /* ── 6. the small things, on the surfaces that can hold them ──
     Last, because they need to know what they are standing on. Heavy pieces
     are refused: a chest does not go on a table. */
  for (const host of placed.slice()) {
    const top = surfaceTop(host);
    if (top === null || host.host === "ceiling") continue;
    const kit = SURFACE_KIT[host.id];
    if (!kit) continue;
    const room4 = Math.max(0, host.foot.w * host.foot.d);
    let slotsLeft = Math.max(1, Math.min(5, Math.round(room4 * 3 * ctx.kit * budget)));
    for (const [id, chance] of kit) {
      if (slotsLeft <= 0) break;
      // The tabletops date a room as surely as the furniture under them, so
      // the century and the weather reach here too. This was the last pass
      // that drew from the catalogue without asking.
      if (rng() > chance * ctx.scale(id)) continue;
      if (placeOnSurface(id, host)) slotsLeft--;
    }
  }

  /* Shelving is a stack of surfaces, not one — so its small things ride at
     several heights rather than all sitting on the top board. */
  function placeOnSurface(id, host) {
    const spec = CATALOGUE[id];
    if (spec.heavy) return false;                       // heavy stays on the floor
    const top = surfaceTop(host);
    if (top === null) return false;
    const f = footprintOf(id, rng, room);
    if (f.w > host.foot.w - 0.06 || f.d > host.foot.d - 0.06) return false;
    // Somewhere on the top that is not the very edge.
    const ox = (rng() - 0.5) * Math.max(0, host.foot.w - f.w - 0.1);
    const oz = (rng() - 0.5) * Math.max(0, host.foot.d - f.d - 0.1);
    const c = Math.cos(host.rot), s = Math.sin(host.rot);
    let y = top;
    if (host.id === "shelfUnit") {
      const boards = Math.max(1, Math.floor((host.foot.h - 0.2) / 0.4));
      y = 0.06 + Math.floor(rng() * boards) * ((host.foot.h - 0.2) / boards);
    }
    placed.push({
      id, spec, x: r3(host.x + ox * c + oz * s), z: r3(host.z - ox * s + oz * c),
      y: r3(y), rot: r3(host.rot + (rng() - 0.5) * 0.8), foot: f, host: host.id,
    });
    return true;
  }

  /* `extras` names the pieces this household brought that the programme alone
     would not have offered. The validator is handed it so a weaver's loom in a
     weaver's parlour is not reported as an object with no reason to be there —
     the reason is the weaver. Everything else it still re-derives on its own. */
  return { program: program.label, programId, placed, grid: g, doorCell, extras: ctx.ids };
}

// The height a piece offers to whatever stands on it, or null if nothing can.
function surfaceTop(p) {
  if (p.host && p.host !== "wall") return null;         // no stacking on stacks
  if (p.id === "wallShelf") return p.y;
  if (!p.spec.surface && !p.spec.seats) return null;
  if (p.spec.anchor === "companion" || p.spec.flat) return null;
  return p.foot.h;
}

function overlaps(a, b) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;
}

export { CELL };
