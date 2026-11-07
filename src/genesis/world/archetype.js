/* archetype.js — what kind of building is this, and who is in it.
 *
 * Stages 1 and 2 of the interior pipeline: read the geometry, then decide
 * what the building IS. Everything downstream hangs off the answer, because
 * a room's purpose is not a property of the room — it is a property of the
 * building's function, and a 6 × 8 space is a parlour in a cottage, a taproom
 * in a tavern and a stock room in a warehouse.
 *
 * The classification is EVIDENCE-BASED rather than looked up. The catalogue
 * id a block was placed from is the strongest single signal and is used as
 * such, but it is not the only one and it is not always available: a builder
 * can place a bare `house` shell as a shrine or a barn, and a generated
 * street can put a three-storey block where a workshop belongs. So the
 * classifier scores every archetype against what it can measure —
 *
 *     footprint and aspect        a long narrow plan on a street is a shop;
 *                                 a wide square one is a hall or a barn
 *     floor area per storey       a warehouse is one big floor, a lodging
 *                                 house is several small ones
 *     storeys                     nobody sleeps above a forge, and nobody
 *                                 builds four floors to store hay
 *     window density              light is expensive. A room that was given
 *                                 windows was meant to be occupied; a blind
 *                                 wall means storage
 *     entrances                   a wide opening takes carts, a single leaf
 *                                 takes people
 *     ceiling height              headroom is bought for a reason
 *
 * — and takes the best score. Where the evidence is thin the result leans on
 * the catalogue id, which is what it should do.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

import { mulberry32, seedChannel } from "../../kernel/seed.js";

/* ── the archetypes ─────────────────────────────────────────────────────
   `wants` is the evidence each one expects, scored as a distance from the
   measured value. `rooms` is its programme grammar: the room purposes it
   needs, in the order a builder would lay them out from the entrance, with
   how public each is (0 = the street may walk in, 1 = family only).
   `ceiling` is what is over your head in it — see ceilingParts in
   interiors.js. A building is the only thing that knows whether its rooms
   have rafters or a vault, and it is most of the difference between the
   inside of a cottage and the inside of a keep. */
export const ARCHETYPES = {
  residence: {
    label: "House",
    wants: { areaPerFloor: [25, 90], storeys: [1, 3], windows: [0.6, 1], aspect: [1, 1.8], height: [2.4, 3.4] },
    rooms: {
      /* The tail is a STORE on purpose. Rooms past the named ones repeat
         the last entry, so a grammar that ends on a fixture room fills a big
         floor with copies of it — and "kitchen" as a filler is three stoves
         in one cottage. A house's repeatable room is a back room. */
      ground: [["living", 1.0, 0.35], ["kitchen", 0.9, 0.45], ["store", 0.3, 0.75]],
      upper: [["bedroom", 1.0, 0.9], ["bedroom", 0.55, 0.95], ["store", 0.4, 0.7]],
    },
    trades: ["labourer", "carter", "weaver", "clerk", "widow", "fisher"],
    // Downstairs you walk from the parlour into the kitchen; upstairs, past
    // three bedroom doors. A cottage with a hall downstairs is a cottage
    // that has spent a quarter of its ground floor on getting about.
    corridor: "upper",
    // PITCHED. A house is the one building whose roof you can see the shape of
    // from inside it — rafters climbing to a ridge, a collar across them — and
    // it is the whole upper half of the beach-house reference.
    ceiling: "pitched",
  },
  workshop: {
    label: "Workshop",
    wants: { areaPerFloor: [30, 140], storeys: [1, 2], windows: [0.4, 0.9], aspect: [1, 2.2], height: [2.8, 4.5] },
    rooms: {
      ground: [["workshop", 1.0, 0.2], ["store", 0.7, 0.6]],
      upper: [["bedroom", 0.8, 0.9], ["store", 0.7, 0.6]],
    },
    trades: ["joiner", "smith", "cooper", "potter", "tanner", "wheelwright"],
    ceiling: "beams",
  },
  tavern: {
    label: "Tavern",
    wants: { areaPerFloor: [45, 160], storeys: [1, 3], windows: [0.5, 1], aspect: [1, 2.4], height: [2.6, 3.8] },
    rooms: {
      ground: [["hall", 1.0, 0.0], ["kitchen", 0.95, 0.5]],
      upper: [["bedroom", 1.0, 0.7], ["bedroom", 0.7, 0.75], ["store", 0.5, 0.6]],
    },
    trades: ["innkeeper"],
    // The lodging floor. Rooms let by the night open onto a landing, not
    // onto each other.
    corridor: "upper",
    ceiling: "beams",
  },
  shop: {
    label: "Shop",
    wants: { areaPerFloor: [20, 90], storeys: [1, 3], windows: [0.7, 1], aspect: [1.1, 2.6], height: [2.6, 3.6] },
    rooms: {
      ground: [["shopfloor", 1.0, 0.0], ["store", 0.8, 0.7]],
      upper: [["living", 0.8, 0.6], ["bedroom", 0.9, 0.9], ["store", 0.4, 0.7]],
    },
    trades: ["grocer", "draper", "baker", "chandler", "apothecary"],
    ceiling: "beams",
  },
  warehouse: {
    label: "Warehouse",
    wants: { areaPerFloor: [70, 400], storeys: [1, 2], windows: [0, 0.3], aspect: [1, 2.6], height: [3.2, 6] },
    rooms: { ground: [["store", 1.0, 0.3], ["office", 0.4, 0.6]], upper: [["store", 1.0, 0.5]] },
    trades: ["merchant", "carter"],
    ceiling: "beams",
  },
  farm: {
    label: "Farm building",
    wants: { areaPerFloor: [40, 220], storeys: [1, 2], windows: [0, 0.4], aspect: [1.2, 3], height: [3, 6] },
    rooms: { ground: [["store", 1.0, 0.35], ["workshop", 0.6, 0.4]], upper: [["store", 1.0, 0.6]] },
    trades: ["farmer", "herder"],
    ceiling: "beams",
  },
  guardpost: {
    label: "Guard post",
    wants: { areaPerFloor: [8, 45], storeys: [1, 4], windows: [0.1, 0.6], aspect: [1, 1.4], height: [2.4, 3.6] },
    rooms: { ground: [["guardroom", 1.0, 0.2], ["store", 0.5, 0.6]], upper: [["bedroom", 0.8, 0.8], ["store", 0.6, 0.6]] },
    trades: ["watchman"],
    ceiling: "vault",
  },
  admin: {
    label: "Administrative building",
    wants: { areaPerFloor: [50, 250], storeys: [1, 6], windows: [0.7, 1], aspect: [1, 1.9], height: [3, 5] },
    rooms: { ground: [["hall", 1.0, 0.0], ["office", 0.9, 0.5]], upper: [["office", 1.0, 0.6], ["store", 0.5, 0.7]] },
    trades: ["clerk", "reeve", "steward"],
    // An office floor IS a corridor with doors off it.
    corridor: true,
    ceiling: "vault",
  },
  temple: {
    label: "Religious building",
    wants: { areaPerFloor: [40, 300], storeys: [1, 2], windows: [0.5, 1], aspect: [1.3, 3], height: [4, 9] },
    rooms: { ground: [["sanctuary", 1.0, 0.0], ["store", 0.5, 0.8]], upper: [["office", 0.7, 0.8]] },
    trades: ["priest"],
    ceiling: "vault",
  },
  infirmary: {
    label: "Medical building",
    wants: { areaPerFloor: [35, 160], storeys: [1, 2], windows: [0.7, 1], aspect: [1, 2], height: [2.8, 4] },
    rooms: { ground: [["ward", 1.0, 0.15], ["office", 0.7, 0.6]], upper: [["ward", 0.8, 0.7], ["store", 0.6, 0.7]] },
    trades: ["physician", "herbalist"],
    // A ward block without a passage is a ward you cross by walking
    // between the beds of the ward in front of it.
    corridor: true,
    ceiling: "beams",
  },

  /* ── the two the landmarks needed ──
     Both of these existed as `admin` until now, and `admin` is a
     counting-house: its ground grammar is a hall and then offices, and its
     furniture is desks, cabinets and strongboxes. Measured, a castle keep
     furnished from it came out with eight desks and six strongboxes in it,
     and the field study came out as a tax office with a view. Both are
     correct answers to the wrong question.

     They are archetypes rather than a branch somewhere for a reason: a keep
     and a counting-house genuinely ARE different buildings, the classifier
     already has the machinery to say which is which, and every world can now
     put either one anywhere. */
  palace: {
    label: "Palace",
    /* Deliberately wide and tall. A keep is one enormous room with a
       ceremonial purpose and a few service rooms behind it — the geometry
       that would score as a warehouse anywhere else. */
    wants: { areaPerFloor: [90, 420], storeys: [1, 5], windows: [0.5, 1], aspect: [1, 1.9], height: [3.6, 10] },
    rooms: {
      ground: [["throneroom", 1.0, 0.0], ["hall", 0.7, 0.3]],
      upper: [["hall", 0.7, 0.45], ["office", 0.6, 0.7], ["store", 0.4, 0.85]],
    },
    trades: ["steward", "reeve", "herald"],
    // The ceremonial floor is one room; everything above it is private and
    // reached along a gallery.
    corridor: "upper",
    ceiling: "vault",
  },
  /* The other kind of castle interior, and the plates are emphatic that
     there are two. One is a THRONE HALL — symmetrical, severe, composed
     around a seat at the far end that nobody may sit in. The other is a
     LOBBY: the room you arrive in, a carpeted stair going up and splitting,
     flowers, pictures, glass, and no throne anywhere. Same masonry, same
     vault, same gold; opposite purpose. Without this the two castle worlds
     furnish byte-identically, which is the exact failure the four-grammar
     rewrite exists to prevent — at that point they are a palette swap. */
  court: {
    label: "Court",
    wants: { areaPerFloor: [90, 420], storeys: [1, 5], windows: [0.6, 1], aspect: [1, 1.9], height: [3.6, 10] },
    rooms: {
      ground: [["lobby", 1.0, 0.0], ["hall", 0.6, 0.35]],
      upper: [["hall", 0.6, 0.5], ["office", 0.5, 0.7], ["store", 0.4, 0.85]],
    },
    trades: ["steward", "herald", "draper"],
    corridor: "upper",
    ceiling: "vault",
  },
  /* ── the seven the brief named and the table did not have ──
     Every one of these was already being CLASSIFIED as something — a mill as
     a warehouse, a museum as an administrative building, a school as an
     office block — and the classification was not wrong so much as coarse.
     They earn their place here for the same reason `palace` and `court` did:
     the classifier already has the machinery to tell them apart, the
     evidence genuinely differs, and the interiors they produce share almost
     nothing. A building that measures like a warehouse and has a chimney and
     a row of tall windows is a mill, and a mill is not a shed with stock in
     it. */
  industrial: {
    label: "Mill",
    /* Tall, deep, and lit along one flank rather than all round: a working
       floor is bought its light for the machines' sake and for nothing
       else. The headroom is the giveaway — a shaft has to run over the
       heads of the people under it. */
    wants: { areaPerFloor: [60, 340], storeys: [1, 3], windows: [0.35, 0.8], aspect: [1.2, 3], height: [4, 8] },
    rooms: {
      ground: [["workfloor", 1.0, 0.25], ["store", 0.8, 0.6], ["office", 0.5, 0.7]],
      upper: [["workfloor", 0.7, 0.5], ["store", 0.8, 0.6]],
    },
    trades: ["smith", "cooper", "wheelwright", "merchant", "labourer"],
    ceiling: "beams",
  },
  museum: {
    label: "Museum",
    // Glazed, tall, and squarer than a hall: a gallery is lit from above and
    // from the sides at once, and its proportions are a route rather than a
    // room somebody eats in.
    wants: { areaPerFloor: [60, 320], storeys: [1, 3], windows: [0.6, 1], aspect: [1, 2.2], height: [4, 9] },
    rooms: {
      ground: [["gallery", 1.0, 0.0], ["gallery", 0.8, 0.1], ["office", 0.5, 0.7]],
      upper: [["gallery", 0.9, 0.3], ["store", 0.6, 0.8], ["office", 0.5, 0.75]],
    },
    trades: ["cartographer", "naturalist", "steward", "herald"],
    corridor: "upper",
    ceiling: "vault",
  },
  library: {
    label: "Library",
    // The one building type whose whole plan is two rooms with opposite
    // requirements: the reading room wants every window it can get, the
    // stacks want none. Scored on the average, which is why it sits between
    // a study and an administrative floor.
    wants: { areaPerFloor: [50, 280], storeys: [1, 3], windows: [0.5, 0.95], aspect: [1, 2.2], height: [3.4, 7] },
    rooms: {
      ground: [["readingroom", 1.0, 0.1], ["stacks", 0.85, 0.5], ["office", 0.5, 0.7]],
      upper: [["stacks", 1.0, 0.5], ["readingroom", 0.6, 0.4], ["store", 0.5, 0.8]],
    },
    trades: ["clerk", "cartographer", "naturalist", "priest"],
    corridor: "upper",
    ceiling: "vault",
  },
  school: {
    label: "School",
    // Repeated rooms of the same size along a passage, every one of them
    // glazed: a schoolroom that cannot be read in is a schoolroom nobody
    // built. That regularity is what separates it from a house of the same
    // area.
    wants: { areaPerFloor: [45, 220], storeys: [1, 3], windows: [0.7, 1], aspect: [1.2, 2.6], height: [3.2, 5] },
    rooms: {
      ground: [["classroom", 1.0, 0.2], ["classroom", 0.8, 0.3], ["office", 0.6, 0.7]],
      upper: [["classroom", 1.0, 0.4], ["store", 0.5, 0.8]],
    },
    trades: ["clerk", "naturalist", "priest", "cartographer"],
    corridor: true,
    ceiling: "beams",
  },
  barracks: {
    label: "Barracks",
    // Long, plain and barely glazed, with more floor than a lodging house
    // and fewer windows than anything anybody chose to live in.
    wants: { areaPerFloor: [50, 260], storeys: [1, 4], windows: [0.2, 0.6], aspect: [1.4, 3.4], height: [2.8, 4.2] },
    rooms: {
      ground: [["guardroom", 1.0, 0.15], ["dormitory", 0.8, 0.6], ["store", 0.6, 0.7]],
      upper: [["dormitory", 1.0, 0.7], ["store", 0.5, 0.8]],
    },
    trades: ["watchman", "labourer", "carter"],
    corridor: true,
    ceiling: "beams",
  },
  stable: {
    // Wide, low, blind and long. Measures almost exactly like a farm
    // building, and the tie-break is the doorway: a stable is entered by
    // something that has to be led in, so the height band starts higher.
    label: "Stable",
    wants: { areaPerFloor: [40, 200], storeys: [1, 2], windows: [0, 0.3], aspect: [1.6, 3.6], height: [3.2, 5] },
    rooms: {
      ground: [["stables", 1.0, 0.25], ["store", 0.7, 0.6]],
      upper: [["store", 1.0, 0.6]],
    },
    trades: ["herder", "carter", "farmer", "wheelwright"],
    ceiling: "beams",
  },
  bathhouse: {
    label: "Bath house",
    // Tall, square, and lit from high up — the proportions of a temple and
    // none of its length. What separates the two on the evidence alone is
    // the aspect: a sanctuary is a nave and a bath hall is a hall.
    wants: { areaPerFloor: [40, 200], storeys: [1, 2], windows: [0.4, 0.9], aspect: [1, 1.6], height: [4, 8] },
    rooms: {
      ground: [["bathhall", 1.0, 0.1], ["store", 0.5, 0.7]],
      upper: [["store", 0.7, 0.8], ["office", 0.4, 0.8]],
    },
    trades: ["physician", "herbalist", "innkeeper", "widow"],
    ceiling: "vault",
  },

  study: {
    label: "Field study",
    /* Light is the evidence. A research room is bought its windows — the
       reference study is three-quarters glass along the seaward wall — and
       that is what separates it from the store it otherwise measures as. */
    wants: { areaPerFloor: [35, 220], storeys: [1, 3], windows: [0.7, 1], aspect: [1, 2.4], height: [2.8, 4.6] },
    rooms: {
      /* An office, not a store. The reference studio's second half is more
         desks and more shelves — "shelves with binders and supplies, a clean
         organised worktable" — and `store` is a must-list of shelving with a
         may-list of crates and barrels, which furnishes a cooperage. */
      ground: [["study", 1.0, 0.2], ["office", 0.6, 0.6]],
      upper: [["study", 0.7, 0.5], ["office", 0.6, 0.7], ["store", 0.5, 0.8]],
    },
    trades: ["naturalist", "cartographer", "surveyor"],
    ceiling: "beams",
  },
};

/* What is over your head in one. Split out rather than read off the table
   directly so an archetype that declares nothing gets rafters instead of
   nothing at all — an unfinished room is worse than a plain one. */
export function ceilingOf(archetype) {
  return (ARCHETYPES[archetype] || ARCHETYPES.residence).ceiling || "beams";
}

/* ── the weather the building was built against ─────────────────────────
   Climate is a real input to what is inside a house and it was missing
   entirely, which is why `living` had to be SEALED to keep a hearth out of a
   house on a tropical beach. Sealing a room is a heavy instrument: it also
   locked the household's trade, its money and its children out of the one
   room where all three should show. Naming the climate instead lets the
   programme stay open and the fire stay out.

   And it needs no new parameter, which is the point of deriving it here: a
   world already declares its biome, a biome already implies its weather, and
   a number invented beside them is a number that can disagree with both.

   Three, not ten. What actually changes inside a building is whether it is
   built around keeping heat in or letting it out — a hearth and hangings at
   one end, shade and water at the other — and a finer scale would be a scale
   nothing downstream could use. */
const BIOME_CLIMATE = {
  tundra: "cold",
  weald: "cold",
  badlands: "hot", oasis: "hot", atoll: "hot", volcanic: "hot",
  verdant: "temperate", meadow: "temperate", shoreland: "temperate", parkland: "temperate",
};
export const CLIMATES = ["cold", "temperate", "hot"];
export function climateOf(biome) {
  return BIOME_CLIMATE[biome] || "temperate";
}

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

/* What the catalogue id already tells us. This is prior belief, not a verdict:
   it is added to the geometric score rather than replacing it, so a `house`
   shell with a warehouse's proportions can still come out a warehouse. */
const PRIOR = {
  house:        { residence: 3.0, workshop: 0.7, farm: 0.5, shop: 0.4 },
  "row-house":  { residence: 3.0, shop: 0.8, workshop: 0.6 },
  "row-shop":   { shop: 3.0, tavern: 1.4, workshop: 0.9 },
  tower:        { guardpost: 3.0, warehouse: 0.4 },
  platform:     { warehouse: 2.0, farm: 1.4 },
  block:        { residence: 1.6, admin: 1.6, shop: 1.0, warehouse: 0.8 },
  /* The landmarks. A castle's ground room is a THRONE HALL and never a
     farmhouse, however its geometry scores; the study on the height is a
     research room and not the parish office it measures as. Declared here
     because the classifier's evidence is all interior measurements, and a
     castle keep measured from inside is just a very good warehouse.
     `admin` is kept as the runner-up on both: a keep with a keep's
     proportions is a palace, and one that has been built as a tower block
     can still fall back to being an administrative building. */
  /* The two castles part company here, and it is the only place they do.
     A spired keep is a throne hall; a round pavilion castle over a parterre
     is the court you walk into. Identical priors on both would have made
     the two castle worlds furnish the same room. */
  "castle-spires": { palace: 4.2, court: 1.8, admin: 1.6, temple: 1.2 },
  "castle-round":  { court: 4.2, palace: 1.8, admin: 1.6, temple: 1.2 },
  villa:           { residence: 3.5 },
  study:           { study: 3.6, admin: 1.4, workshop: 0.8 },
  cottage:         { residence: 3.2, workshop: 0.6, farm: 0.5 },
  "cottage-slate": { residence: 3.2, shop: 0.7, tavern: 0.6 },
  "castle-citadel": { palace: 3.0, court: 2.4, barracks: 2.0, admin: 1.4 },
  /* ── the civic spread ──
     `civic` is the one id a generated town places for anything that is not a
     house, a shop or a shed, and it used to name a single archetype. That
     made every public building in every world the same building: measured
     across nine catalogue ids and 3 360 shells, `infirmary` was reachable
     from NOTHING — it lost on geometry to `admin` everywhere and had no
     prior to fall back on, so a whole archetype, its ward programme and its
     cots were dead code that shipped.

     So the id votes for a spread and lets the geometry pick. A tall glazed
     square block is still an administrative floor; a wide vaulted one is a
     museum or a bath hall; a long low glazed one is a school; a squat
     well-lit one is an infirmary. One id, several answers, chosen on the
     evidence — which is what this classifier is for. */
  civic:           { admin: 2.0, temple: 2.0, infirmary: 2.0, museum: 2.0,
                     library: 2.0, school: 2.0, bathhouse: 2.0 },
};

// How far a measurement sits outside the band an archetype expects, as a
// penalty. Inside the band costs nothing; outside it costs proportionally.
function miss(value, [lo, hi]) {
  if (value >= lo && value <= hi) return 0;
  const span = Math.max(hi - lo, 1e-6);
  return (value < lo ? lo - value : value - hi) / span;
}

/* ── stage 1 · read the geometry ────────────────────────────────────────
   Everything the classifier is allowed to know, measured off the block's own
   parts and room envelopes rather than passed in by whoever placed it. */
export function surveyBuilding(proc) {
  const rooms = proc?.rooms || [];
  const parts = proc?.parts || [];
  let w = 0, d = 0, top = 0;
  for (const p of parts) {
    const dims = p.dims || [];
    // Only the big structural pieces describe the envelope; a chimney pot
    // must not be allowed to set the plan.
    if (p.shape === "box" && dims[0] > 2 && dims[2] > 2) { w = Math.max(w, dims[0]); d = Math.max(d, dims[2]); }
    top = Math.max(top, (p.pos?.[1] ?? 0) + (dims[1] ?? 0) / 2);
  }
  // Rooms are the honest measure where they exist.
  for (const r of rooms) { w = Math.max(w, r.w); d = Math.max(d, r.d); }
  if (!w || !d) { w = w || 6; d = d || 6; }

  const storeys = Number.isFinite(proc?.storeys)
    ? Math.max(1, proc.storeys)
    : Math.max(1, new Set(rooms.map((r) => r.level ?? 0)).size);
  const height = rooms[0]?.h || 3.0;
  // A window here is any emissive slab: that is exactly how this catalogue
  // draws a lit opening, so counting them counts windows.
  const lit = parts.filter((p) => p.emissive && p.shape === "box");
  const glazed = lit.length;
  const perimeter = 2 * (w + d);
  return {
    w, d, top, storeys, height,
    area: w * d,
    areaPerFloor: (w * d) / Math.max(1, storeys),
    aspect: Math.max(w, d) / Math.max(1e-6, Math.min(w, d)),
    // Windows per five metres of wall, clamped: a fully glazed frontage and
    // a blind gable are the two ends that matter.
    windows: Math.min(1, glazed / Math.max(1, perimeter / 5)),
    // …and WHICH WALLS they are in, which is a different fact and a more
    // useful one. A density says how bright the building is; a side says
    // which wall the wardrobe may not go against.
    glazing: glazedSides(lit),
    doors: proc?.door ? 1 : (rooms.some((r) => r.at === "ground") ? 1 : 0),
    rooms: rooms.length,
  };
}

/* Which of the four faces carry glass, counted off the slabs themselves.

   A glazed slab is a THIN box standing in a wall, so the face it belongs to
   is the axis it is thin on and the side is the sign of its position. That
   rules out the one emissive part that is not a window — the ceiling soffit
   every shell hangs to light its own ground room, which is thin on Y and
   would otherwise have voted for all four walls at once.

   The names are the room's, not the compass's: +z is `south` throughout this
   pipeline because that is the face the catalogue puts the front door in. */
function glazedSides(lit) {
  const n = { north: 0, south: 0, east: 0, west: 0 };
  for (const p of lit) {
    const d = p.dims;
    if (!d || d.length < 3) continue;
    const z = p.pos?.[2] ?? 0, x = p.pos?.[0] ?? 0;
    if (d[2] < 0.2 && d[0] > 0.3) n[z >= 0 ? "south" : "north"]++;
    else if (d[0] < 0.2 && d[2] > 0.3) n[x >= 0 ? "east" : "west"]++;
  }
  return n;
}

/* The sides a room should treat as windows: the ones with enough glass on
   them to be worth keeping clear. One pane is a slit and does not stop a
   dresser going somewhere; a run of them is the wall the room is lit by.

   `share` is what fraction of the building's glass has to be on a face
   before that face counts — a tenth, so a four-sided block with an even
   rhythm reports all four and a shed with one window over the door reports
   only that one. */
export function glazedFaces(evidence, share = 0.12) {
  const g = evidence?.glazing;
  if (!g) return [];
  const total = g.north + g.south + g.east + g.west;
  if (!total) return [];
  return Object.keys(g).filter((side) => g[side] / total >= share);
}

/* ── stage 2 · classify ─────────────────────────────────────────────────
   Score every archetype against the evidence and take the best. Returns the
   runners-up too: a caller that wants to know how confident this was — or a
   test that wants to know the classifier is discriminating rather than
   always answering "residence" — can look. */
export function classify({ proc, kind, seed = "", uid = "" }) {
  const ev = surveyBuilding(proc);
  const prior = PRIOR[kind] || {};
  const scored = ARCHETYPE_IDS.map((id) => {
    const a = ARCHETYPES[id];
    const penalty =
        miss(ev.areaPerFloor, a.wants.areaPerFloor) * 1.0
      + miss(ev.storeys, a.wants.storeys) * 1.3
      + miss(ev.windows, a.wants.windows) * 1.1
      + miss(ev.aspect, a.wants.aspect) * 0.8
      + miss(ev.height, a.wants.height) * 0.7;
    return { id, score: (prior[id] || 0) - penalty };
  }).sort((x, y) => y.score - x.score);

  const best = scored[0];
  return {
    archetype: best.id,
    label: ARCHETYPES[best.id].label,
    evidence: ev,
    // The gap to the runner-up: small means the building genuinely could be
    // either, which is worth knowing and worth varying on.
    confidence: Math.max(0, best.score - scored[1].score),
    ranked: scored.slice(0, 3),
    rng: mulberry32(seedChannel(seed || uid, `archetype:${uid}`)),
  };
}

/* ── stage 7 · who is in it ─────────────────────────────────────────────
   The profile every later decision reads. Nothing here is a free die roll:
   household size follows floor area and archetype, the trade follows the
   archetype, and maintenance follows money and years the way it does in
   life — the difference between a well-kept poor house and a neglected rich
   one is upkeep, and upkeep is what wealth buys. */
export function occupantsOf({ archetype, evidence, rng }) {
  const a = ARCHETYPES[archetype] || ARCHETYPES.residence;
  const wealthBase = {
    residence: 0.4, workshop: 0.42, tavern: 0.5, shop: 0.55, warehouse: 0.5,
    farm: 0.35, guardpost: 0.45, admin: 0.8, temple: 0.7, infirmary: 0.6,
    /* The seven that came with the brief's other building types. A museum
       and a library are endowed and it shows in the joinery; a mill and a
       barracks are equipped rather than furnished, which is a different
       thing and a cheaper one. */
    industrial: 0.5, museum: 0.85, library: 0.78, school: 0.55,
    barracks: 0.4, stable: 0.34, bathhouse: 0.6,
    // A palace is the richest thing in its world by construction — the whole
    // exterior is an argument for it — and a study is comfortable rather than
    // grand. Wealth buys the gold on the chandelier and the lacquer on the
    // desk, so this is not a cosmetic number.
    palace: 0.94, court: 0.94, study: 0.62,
  }[archetype] ?? 0.45;

  const wealth = clamp01(wealthBase + (rng() - 0.5) * 0.44);
  const age = clamp01(rng() * 0.9 + 0.08);
  // Money buys upkeep; years spend it.
  const wear = clamp01(age * 0.6 + (1 - wealth) * 0.45 + (rng() - 0.5) * 0.28);

  // A household fills the space it has, up to what an archetype supports.
  const cap = { residence: 7, tavern: 9, shop: 5, workshop: 4, guardpost: 6,
                admin: 3, temple: 2, infirmary: 4, warehouse: 1, farm: 3,
                palace: 6, court: 6, study: 3,
                // A barracks is the most crowded building in the table by
                // design; a stable holds one person and a great many animals.
                industrial: 8, museum: 3, library: 3, school: 5,
                barracks: 12, stable: 1, bathhouse: 4 }[archetype] ?? 4;
  const occupants = Math.max(1, Math.min(cap, Math.round(evidence.area / 22 + rng() * 2)));
  const children = archetype === "residence" || archetype === "shop"
    ? Math.max(0, Math.min(occupants - 1, Math.floor(rng() * (occupants * 0.6)))) : 0;

  return {
    archetype, wealth, age, wear, occupants, children,
    trade: a.trades[Math.floor(rng() * a.trades.length)],
    /* Period shifts what a household owns and what it is made of. One value
       per building rather than per world, because a street is not built in a
       year: an old cottage stands next to a new one and they should not be
       furnished out of the same catalogue. */
    period: clamp01(1 - age * 0.7 + (rng() - 0.5) * 0.3),
    /* What was happening here recently. This is what turns a correct room
       into an inhabited one: a meal left out, a workday interrupted, a
       building shut up for the season. */
    activity: pickWeighted([
      ["settled", archetype === "palace" || archetype === "court" ? 8 : 4],
      ["meal", archetype === "residence" || archetype === "tavern" ? 3 : 1],
      ["working", archetype === "workshop" || archetype === "shop" || archetype === "study"
        || archetype === "industrial" || archetype === "school" ? 4 : 1],
      ["packing", archetype === "warehouse" || archetype === "farm" ? 3 : 1],
      // A throne hall is never shut up for the season. Everywhere else,
      // neglect is allowed to show — it is half of what makes a street read
      // as inhabited rather than as a set.
      ["shut", archetype === "palace" || archetype === "court" ? 0 : wear > 0.7 ? 3 : 0.5],
    ], rng),
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function pickWeighted(list, rng) {
  let total = 0;
  for (const [, w] of list) total += w;
  let r = rng() * total;
  for (const [id, w] of list) { r -= w; if (r <= 0) return id; }
  return list[0][0];
}

/* ── which room belongs beside which ────────────────────────────────────
   Publicness says how far from the street a room sits. It says nothing about
   what it sits BESIDE, and that is the other half of a plan: a kitchen
   belongs next to the room people eat in, a stock room belongs behind the
   shop it serves, and a bedroom does not open onto a workshop. Ranked by
   publicness alone, every one of those was a coincidence — and on most seeds
   it was the wrong coincidence, because there is only one arrangement that is
   right and several that are legal.

   Read as PULLS AND PUSHES rather than as rules. A positive number is two
   rooms that want a door between them, a negative one is two rooms that
   should have a wall and something else in between, and zero — most pairs —
   is indifference, which is honest: a store and a guard room have no opinion
   about each other. The zoner sums these over the doorways it actually cut
   and swaps purposes between rooms at the same depth to improve the total,
   which is a rearrangement it can make without disturbing anything the
   publicness pass decided.

   Symmetric by construction, because a stated pair is added in both
   directions when it is read — declaring both halves twice is how a table
   like this drifts into disagreeing with itself. */
const ADJACENT = {
  kitchen: { living: 3, hall: 3, store: 2, shopfloor: 1, corridor: 1, bedroom: -1 },
  living: { bedroom: 1, corridor: 2, hall: 1, workshop: -1 },
  bedroom: { corridor: 3, bedroom: 2, ward: 1, workshop: -3, shopfloor: -3, guardroom: -2 },
  store: { shopfloor: 3, workshop: 3, office: 1, hall: -1 },
  shopfloor: { office: 2, corridor: 1 },
  workshop: { office: 1, corridor: 1, sanctuary: -2 },
  office: { hall: 2, corridor: 2, study: 2, throneroom: 1, lobby: 1 },
  hall: { corridor: 2, throneroom: 3, lobby: 3, sanctuary: 2, guardroom: 1 },
  ward: { corridor: 3, office: 2, store: 1 },
  sanctuary: { corridor: 1, store: 1 },
  guardroom: { corridor: 1, store: 1, lobby: 2 },
  study: { store: 1, corridor: 1 },
  lobby: { corridor: 2, throneroom: 2 },
  corridor: { throneroom: -1 },
};
const AFFINITY = (() => {
  const m = {};
  const set = (a, b, v) => { (m[a] || (m[a] = {}))[b] = v; };
  for (const [a, row] of Object.entries(ADJACENT)) {
    for (const [b, v] of Object.entries(row)) { set(a, b, v); set(b, a, v); }
  }
  return m;
})();

/* How much two purposes want a door between them. Handed to planFloor, which
   knows about rectangles and deliberately not about rooms. */
export function affinityOf(a, b) {
  if (!a || !b) return 0;
  return AFFINITY[a]?.[b] ?? 0;
}

/* Does this building have a passage on this floor? A cottage does not — you
   walk from the parlour into the kitchen, and a corridor between them would
   be a corridor nobody would have paid for. A ward block, a lodging floor, an
   office storey and the private half of a palace cannot work without one: the
   alternative is a chain of rooms where the way to the last is through
   somebody's bed. Declared per archetype and per level, because the same
   building is often both — a shop downstairs is one room and the family
   upstairs is three off a landing. */
export function corridorOn({ archetype, at, level }) {
  const a = ARCHETYPES[archetype] || ARCHETYPES.residence;
  const where = a.corridor;
  if (!where) return false;
  return where === true || (where === "upper" && !(at === "ground" && level === 0));
}

/* ── the room grammar ───────────────────────────────────────────────────
   Which purposes an archetype puts on a floor, and how public each is. The
   zoner uses publicness to decide what sits by the door and what is pushed
   to the back, which is the single rule that stops a bedroom opening onto a
   taproom. Returns as many as the floor can hold, most important first. */
export function roomProgramme({ archetype, level, at, zones, rng }) {
  const a = ARCHETYPES[archetype] || ARCHETYPES.residence;
  const list = (at === "ground" && level === 0 ? a.rooms.ground : a.rooms.upper) || a.rooms.ground;
  const out = [];
  for (const [purpose, chance, publicness] of list) {
    if (out.length >= zones) break;
    if (out.length && rng() > chance) continue;
    out.push({ purpose, publicness });
  }
  // A floor with more zones than the grammar named fills the rest with the
  // archetype's most repeatable room rather than inventing a new function.
  const filler = list[list.length - 1];
  while (out.length < zones) out.push({ purpose: filler[0], publicness: filler[2] });
  return out.sort((x, y) => x.publicness - y.publicness);
}
