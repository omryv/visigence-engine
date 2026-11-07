/* furniture.js — the things that live inside a building.
 *
 * A catalogue, not a scene. Each entry is two halves that must agree:
 *
 *   the SPEC   what the layout solver reasons about — footprint, height, how
 *              the piece meets the room (against a wall, hung from the
 *              ceiling, standing on another piece), how much floor it needs
 *              in front of it to be usable, and what it wants nearby.
 *   the BUILD  the geometry, emitted in the same part vocabulary the block
 *              catalogue uses, so an interior piece is an ordinary editable
 *              placement and themes.js re-dresses it with the building.
 *
 * Nothing here decides WHERE anything goes; that is interior-plan.js. Keeping
 * the two apart is what lets the solver guarantee its constraints, because a
 * piece that describes its own footprint honestly cannot be placed through a
 * wall by a solver that respects footprints.
 *
 * On the numbers. Furniture dimensions are not free parameters — a chair seat
 * is 0.45 m off the floor because that is the height of a human knee, a
 * worktop is 0.9 m because that is a comfortable standing reach, a doorway is
 * 2.0 m because people are shorter than that. Those constants are
 * anthropometry and are written here as such. What varies from house to house
 * is everything else: which pieces, how many, how big within a plausible
 * range, what they are made of, how worn they are, and where they stand.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

/* ── anthropometry ──────────────────────────────────────────────────────
   The handful of dimensions that come from bodies rather than from taste.
   Everything else in this file is expressed against them. */
export const SEAT_H = 0.45;      // knee height: chairs, stools, bench tops
export const TABLE_H = 0.75;     // dining/desk surface, elbow at rest
export const WORKTOP_H = 0.92;   // standing work surface
export const REACH_H = 1.85;     // top of a comfortable overhead reach
export const WALK = 0.62;        // shoulder width plus sleeves: a usable path
export const CLEAR = 0.72;       // floor a person needs in front of a piece

/* ── material ───────────────────────────────────────────────────────────
   One palette per building, derived from what the building IS rather than
   rolled fresh per object: a poor old cottage should be poor and old in every
   room, not poor in one and lacquered in the next. */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mixHex = (a, b, f) => {
  f = clamp01(f);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * f) << 16)
       | (Math.round(ag + (bg - ag) * f) << 8)
       |  Math.round(ab + (bb - ab) * f);
};
const shade = (hex, f) => mixHex(hex, f < 0 ? 0x000000 : 0xffffff, Math.abs(f));

// The timbers a joiner would actually have had, poorest first. Wealth picks
// how far up this list the house can afford to reach.
const TIMBERS = [0x6d5a44, 0x7b6448, 0x8a6a44, 0x6a4a30, 0x4e3423, 0x3a2418];
// Cloth: undyed, then the dyes that were cheap, then the ones that were not.
const CLOTHS = [0xa89e8a, 0x8f9a86, 0x7d8a9c, 0x9a7f6a, 0x6f5a78, 0x7a3f42];

/* wealth 0..1 — what the household could afford
   age    0..1 — how long the fabric has been standing
   wear   0..1 — how little it has been looked after
   All three arrive from the building, not from a die roll here. */
export function interiorStyle({ wealth = 0.5, age = 0.5, wear = 0.5, rng }) {
  const pick = (list, bias) => list[Math.min(list.length - 1,
    Math.floor(clamp01(bias * 0.75 + rng() * 0.35) * list.length))];
  const wood = pick(TIMBERS, wealth);
  const cloth = pick(CLOTHS, wealth);
  // Age greys timber and dust dulls everything; wear does the rest.
  const weather = clamp01(age * 0.55 + wear * 0.3);
  return {
    wealth: clamp01(wealth), age: clamp01(age), wear: clamp01(wear),
    wood: mixHex(wood, 0x8e8779, weather * 0.45),
    woodDark: shade(mixHex(wood, 0x8e8779, weather * 0.3), -0.28),
    woodPale: shade(mixHex(wood, 0xb6a98f, weather * 0.5), 0.16),

    /* ── the room's own three surfaces ──
       Everything above is a thing standing IN the room. These are the room:
       what you are enclosed by, what you walk on, and what is over your head
       — and they are most of what tells you which of two rooms you are
       standing in, long before you have read a single piece of furniture.
       They were baked constants until now, which is why every interior in
       every world had the same grey-beige plaster on it.

       Derived, so a house that names none of them still gets a coherent
       room: limewash that greys with age, floorboards a shade paler than the
       furniture (they are scrubbed), roof timbers a shade darker (they are
       not). `paint` is the joinery colour and defaults to bare timber,
       which is exactly what a cabinet did before it existed. */
    wall: mixHex(0xcfc6b4, 0x8e8779, weather * 0.55),
    floor: shade(mixHex(wood, 0x8e8779, weather * 0.5), 0.07),
    beam: shade(mixHex(wood, 0x8e8779, weather * 0.28), -0.18),
    // The boarding BETWEEN the beams, which is most of a ceiling by area and
    // is almost never the same colour as the timber on it: the reference
    // rooms are white boards under dark rafters, and white boards under white
    // ones. Limewash by default — a ceiling is the cheapest thing in a house
    // to paint and the first thing anybody paints.
    board: mixHex(0xe8e2d4, 0x8e8779, weather * 0.4),
    paint: mixHex(wood, 0x8e8779, weather * 0.45),
    cloth: mixHex(cloth, 0x8b8478, weather * 0.4),
    clothAlt: mixHex(shade(cloth, -0.2), 0x8b8478, weather * 0.4),
    metal: mixHex(0x8a9099, 0x5d4c3c, clamp01(age * 0.7)),   // bright iron → rust
    stone: mixHex(0x8c8880, 0x5f5a52, weather * 0.6),
    clay: mixHex(0xa9765a, 0x7a6355, weather * 0.5),
    paper: mixHex(0xd8cdb4, 0x9a9080, weather * 0.6),
    // Firelight is warmer and dimmer in a poor house; a rich one burns
    // whiter candles and more of them.
    glow: mixHex(0xff9d4a, 0xffd9a8, clamp01(wealth)),
    glowPower: 0.7 + wealth * 0.9,
    grime: clamp01(0.25 + wear * 0.9 + age * 0.35),
  };
}

/* ── part helpers ───────────────────────────────────────────────────────
   Thin, on purpose: they exist so an item's build function reads as a list of
   its actual components rather than as a wall of object literals. */
const r3 = (v) => Math.round(v * 1000) / 1000;
const box = (dims, pos, color, tex = "wood", extra = null) => ({
  shape: "box", dims: dims.map(r3), pos: pos.map(r3), color, tex, bevel: 0.012, ...(extra || {}),
});
const cyl = (r, h, pos, color, tex = "wood", extra = null) => ({
  shape: "cylinder", dims: [r3(r), r3(h)], pos: pos.map(r3), color, tex, seg: 12, ...(extra || {}),
});
/* A burning thing. `reach` is the metres it actually LIGHTS, and passing it
   asks the engine for a real point light rather than a glowing ball — the
   difference between a candle you can see and a candle you can read by.
   Exactly one part per catalogue entry carries it, and it must equal that
   entry's `lights`, which is the reach the layout solver plans around. Every
   other flame in a piece (the second ember in a hearth) stays a pure glow,
   because lights are the one thing here that is not free. */
const lamp = (r, pos, style, power = 1, reach = 0) => ({
  shape: "sphere", dims: [r3(r)], pos: pos.map(r3), tex: "none", color: shade(style.glow, 0.5),
  emissive: style.glow, emissiveIntensity: r3(style.glowPower * power), noCollide: true,
  ...(reach > 0 ? { light: r3(reach) } : null),
});
/* ── the leaf ───────────────────────────────────────────────────────────
   A part carrying this hangs off the placement's hinge group instead of its
   body, and the engine already knows what to do with that: Props.js builds
   the pivot from `proc.door`, engine/props/doors.js registers it, and E
   swings it (engine/Engine.js). Collision drops out while it is open,
   because the collider is taken from the built object.

   THIS IS WHY A CUPBOARD OPENS FOR FREE. A building shell has declared a
   swinging front door since the catalogue existed; nothing said a wardrobe
   was allowed to use the same machinery, so every piece of casework in every
   interior had its doors painted on. One flag and a hinge position per piece
   is the entire cost, and the alternative — a second door system that knows
   about furniture — is a second thing to keep in step with the first.

   ONE leaf per piece, never two. `proc.door` is a single pivot, so a
   double-fronted wardrobe opens its left-hand door and leaves the right one
   shut, which is what people do anyway. */
const LEAF = { door: true };

// Four legs under a rectangular top. Every table, desk, bench and stool in
// here stands on this, which is why they all read as the same workshop's work.
function legs(w, d, h, thick, color, inset = 0.09) {
  const out = [];
  const ox = w / 2 - inset - thick / 2, oz = d / 2 - inset - thick / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(box([thick, h, thick], [sx * ox, h / 2, sz * oz], color));
  }
  return out;
}

/* ── the catalogue ──────────────────────────────────────────────────────
   anchor tells the solver how the piece meets the room:
     wall      back flat against a wall, facing in
     corner    prefers a corner, still wall-backed
     floor     free-standing, wants clearance all round
     wallHigh  fixed to the wall above head height
     ceiling   hangs from the ceiling
     surface   stands on top of another piece
   `clear` is the depth of floor in front that must stay walkable.
   `size(rng, room)` returns the footprint, so the same id is a different
   object in a different house. */
export const CATALOGUE = {

  /* ─────────── sleeping ─────────── */
  bed: {
    label: "Bed", anchor: "wall", clear: CLEAR, tags: ["sleep"], heavy: true,
    size: (rng, room) => {
      // A double only where there is room to walk round one side of it.
      const dbl = room.area > 17 && rng() < 0.55;
      return { w: dbl ? 1.42 + rng() * 0.16 : 0.92 + rng() * 0.1, d: 1.95 + rng() * 0.12, h: 0.62 };
    },
    build: ({ s, f, rng }) => {
      const frame = 0.14, mat = 0.19, deck = 0.34;
      const p = [
        ...legs(f.w, f.d, deck, 0.09, s.woodDark, 0.04),
        box([f.w, frame, f.d], [0, deck + frame / 2, 0], s.wood),
        // headboard against the wall (local −z is the wall side)
        box([f.w, 0.62 + rng() * 0.22, 0.07], [0, deck + 0.42, -f.d / 2 + 0.035], s.wood),
        box([f.w - 0.1, mat, f.d - 0.14], [0, deck + frame + mat / 2, 0], s.clothAlt, "none",
          { bevel: 0.05, roughness: 0.95 }),
      ];
      // A blanket turned back, and a pillow at the head.
      p.push(box([f.w - 0.08, 0.06, f.d * 0.62], [0, deck + frame + mat + 0.03, f.d * 0.16], s.cloth, "none",
        { bevel: 0.04, roughness: 0.95 }));
      const pillows = f.w > 1.2 ? 2 : 1;
      for (let i = 0; i < pillows; i++) {
        const ox = pillows === 1 ? 0 : (i === 0 ? -1 : 1) * f.w * 0.24;
        p.push(box([0.5, 0.11, 0.32], [ox, deck + frame + mat + 0.055, -f.d / 2 + 0.28], s.woodPale, "none",
          { bevel: 0.05, roughness: 0.95 }));
      }
      return p;
    },
  },

  cradle: {
    label: "Cradle", anchor: "wall", clear: 0.5, tags: ["sleep", "child"],
    size: () => ({ w: 0.52, d: 0.94, h: 0.66 }),
    build: ({ s }) => [
      // Rockers, not legs: the one piece of furniture that is not meant to
      // stand still.
      box([0.07, 0.2, 0.86], [-0.2, 0.1, 0], s.woodDark),
      box([0.07, 0.2, 0.86], [0.2, 0.1, 0], s.woodDark),
      box([0.5, 0.28, 0.9], [0, 0.36, 0], s.wood),
      box([0.42, 0.08, 0.78], [0, 0.52, 0], s.cloth, "none", { bevel: 0.03 }),
    ],
  },

  /* ─────────── sitting and working ─────────── */
  table: {
    /* No clearance of its own. A piece you STAND at reserves the floor in
       front of it; a piece you SIT at reserves chairs, and they are placed
       explicitly a moment later. Declaring both meant the table's clearance
       ring refused the very chairs meant to fill it, and every dining table
       in every house came out with nobody able to sit at it. */
    label: "Table", anchor: "floor", clear: 0, tags: ["eat", "host"], heavy: true,
    seats: true,
    size: (rng, room) => {
      const long = Math.min(2.4, Math.max(1.05, room.area * 0.075)) + rng() * 0.3;
      return { w: r3(long), d: r3(0.72 + rng() * 0.24), h: TABLE_H };
    },
    build: ({ s, f }) => [
      ...legs(f.w, f.d, TABLE_H - 0.05, 0.085, s.woodDark),
      box([f.w, 0.05, f.d], [0, TABLE_H - 0.025, 0], s.wood),
      // A stretcher between the legs: what stops a four-legged table racking.
      box([f.w - 0.34, 0.05, 0.05], [0, 0.22, 0], s.woodDark),
    ],
  },

  desk: {
    // As with the table: its approach is the chair pulled up to it.
    label: "Desk", anchor: "wall", clear: 0, tags: ["work", "study"], heavy: true,
    seats: true,
    size: (rng) => ({ w: 1.05 + rng() * 0.35, d: 0.6 + rng() * 0.1, h: TABLE_H }),
    build: ({ s, f }) => [
      ...legs(f.w, f.d, TABLE_H - 0.05, 0.075, s.woodDark),
      box([f.w, 0.045, f.d], [0, TABLE_H - 0.022, 0], s.wood),
      // A drawer box under one end — the thing that makes a desk a desk.
      box([f.w * 0.42, 0.2, f.d - 0.1], [f.w * 0.24, TABLE_H - 0.16, 0], s.wood),
      box([f.w * 0.36, 0.03, 0.03], [f.w * 0.24, TABLE_H - 0.16, f.d / 2 - 0.05], s.metal, "metal"),
    ],
  },

  chair: {
    /* No clearance. A chair is pushed UP TO the thing it serves, so the floor
       "in front" of it is the table — testing it as clearance asks whether
       the table is empty, the answer is no, and not one chair in the world
       was ever placed. Reachability still applies: the solver checks a
       person can get to the chair, which is the constraint that matters. */
    label: "Chair", anchor: "companion", clear: 0, tags: ["sit"],
    size: () => ({ w: 0.44, d: 0.46, h: 0.92 }),
    build: ({ s, rng }) => {
      const back = 0.86 + rng() * 0.12;
      return [
        ...legs(0.42, 0.42, SEAT_H, 0.05, s.woodDark, 0.02),
        box([0.44, 0.045, 0.44], [0, SEAT_H, 0], s.wood),
        box([0.05, back - SEAT_H, 0.05], [-0.18, (back + SEAT_H) / 2, -0.19], s.woodDark),
        box([0.05, back - SEAT_H, 0.05], [0.18, (back + SEAT_H) / 2, -0.19], s.woodDark),
        box([0.4, 0.07, 0.04], [0, back - 0.06, -0.19], s.wood),
        box([0.4, 0.05, 0.04], [0, back - 0.22, -0.19], s.wood),
      ];
    },
  },

  stool: {
    /* A chair belongs to a table; a STOOL belongs to the room. It is dragged
       to wherever the work is, which is why the reference study has three of
       them standing loose round a worktable and why eleven programmes list
       one — and all eleven of those listings were dead, because the anchor
       said "companion" and the floor pass refuses an anchor another pass
       owns. The seating pass places it from a host's edges by name rather
       than by anchor, so it is still the thing that gets pulled up to a
       table; it can now also simply be in the room.
       Clearance stays 0: a stool pushed up to a bench must not ask whether
       the bench is empty floor. */
    label: "Stool", anchor: "floor", clear: 0, tags: ["sit"],
    size: () => ({ w: 0.34, d: 0.34, h: SEAT_H }),
    build: ({ s }) => [
      ...legs(0.32, 0.32, SEAT_H - 0.04, 0.045, s.woodDark, 0.015),
      cyl(0.18, 0.04, [0, SEAT_H - 0.02, 0], s.wood),
    ],
  },

  bench: {
    label: "Bench", anchor: "wall", clear: 0.5, tags: ["sit"],
    size: (rng) => ({ w: 1.3 + rng() * 0.6, d: 0.36, h: SEAT_H }),
    build: ({ s, f }) => [
      box([0.07, SEAT_H - 0.04, f.d - 0.04], [-f.w / 2 + 0.12, (SEAT_H - 0.04) / 2, 0], s.woodDark),
      box([0.07, SEAT_H - 0.04, f.d - 0.04], [f.w / 2 - 0.12, (SEAT_H - 0.04) / 2, 0], s.woodDark),
      box([f.w, 0.05, f.d], [0, SEAT_H - 0.025, 0], s.wood),
    ],
  },

  /* The soft seat. A bench is where you wait; a settee is where you LIVE,
     and the reference room this exists for — a beach house with an ocean
     through the door — is entirely about that difference. Cloth over a
     timber frame, arms in the second cloth, so a world's dressing decides
     whether it is coral over jute or velvet over oak. */
  settee: {
    label: "Settee", anchor: "wall", clear: CLEAR, tags: ["sit", "soft"], heavy: true,
    size: (rng, room) => ({ w: room.area > 14 ? 1.8 + rng() * 0.4 : 1.5 + rng() * 0.2, d: 0.8, h: 0.8 }),
    build: ({ s, f }) => [
      box([f.w, 0.24, f.d], [0, 0.2, 0], s.woodDark),
      box([f.w - 0.3, 0.17, f.d - 0.14], [0, 0.41, 0.05], s.cloth, "none", { roughness: 1 }),
      box([f.w - 0.3, 0.46, 0.17], [0, 0.55, -f.d / 2 + 0.1], s.cloth, "none", { roughness: 1 }),
      box([0.17, 0.36, f.d - 0.08], [-f.w / 2 + 0.09, 0.5, 0.02], s.clothAlt, "none", { roughness: 1 }),
      box([0.17, 0.36, f.d - 0.08], [f.w / 2 - 0.09, 0.5, 0.02], s.clothAlt, "none", { roughness: 1 }),
      box([0.5, 0.14, 0.34], [-f.w * 0.18, 0.53, -f.d / 2 + 0.22], mixHex(s.clothAlt, 0xf0ead8, 0.55), "none",
        { roughness: 1, rotZ: 0.12 }),
    ],
  },

  /* The one you sink into, as opposed to the one you perch on. A settee is
     for two and stands against a wall; this stands wherever the light is,
     which is exactly where the reference beach house puts it — turned away
     from the wall, facing the open door. Same cloth-over-frame construction
     as the settee so the two read as a set. */
  armchair: {
    label: "Armchair", anchor: "floor", clear: 0.55, tags: ["sit", "soft"],
    size: (rng) => ({ w: 0.86 + rng() * 0.14, d: 0.84, h: 0.82 }),
    build: ({ s, f }) => [
      ...legs(f.w - 0.14, f.d - 0.14, 0.18, 0.07, s.woodDark, 0.02),
      box([f.w - 0.06, 0.2, f.d - 0.06], [0, 0.28, 0], s.clothAlt, "none", { roughness: 1 }),
      box([f.w - 0.28, 0.16, f.d - 0.2], [0, 0.46, 0.04], s.cloth, "none", { bevel: 0.05, roughness: 1 }),
      box([f.w - 0.28, 0.44, 0.18], [0, 0.6, -f.d / 2 + 0.11], s.cloth, "none", { bevel: 0.05, roughness: 1 }),
      box([0.15, 0.3, f.d - 0.12], [-f.w / 2 + 0.08, 0.5, 0.01], s.clothAlt, "none", { bevel: 0.05, roughness: 1 }),
      box([0.15, 0.3, f.d - 0.12], [f.w / 2 - 0.08, 0.5, 0.01], s.clothAlt, "none", { bevel: 0.05, roughness: 1 }),
    ],
  },

  /* Low, wide, and in the middle of the floor rather than against anything.
     Every other table in here is TABLE_H because you sit AT it; this one is
     knee height because you sit AROUND it, and that single dimension is what
     turns a room with chairs in it into a room people live in. */
  lowTable: {
    label: "Low table", anchor: "floor", clear: 0.4, tags: ["host", "soft"], surface: true,
    size: (rng, room) => ({
      w: Math.min(1.5, Math.max(0.8, room.area * 0.05)) + rng() * 0.2,
      d: 0.56 + rng() * 0.14, h: 0.42,
    }),
    build: ({ s, f }) => [
      ...legs(f.w, f.d, f.h - 0.06, 0.075, s.woodDark, 0.07),
      box([f.w, 0.06, f.d], [0, f.h - 0.03, 0], s.woodPale),
      // A shelf slung under the top: where the books that are not being read
      // actually live.
      box([f.w - 0.24, 0.03, f.d - 0.16], [0, 0.16, 0], s.wood),
    ],
  },

  /* ─────────── storage ─────────── */
  wardrobe: {
    label: "Wardrobe", anchor: "wall", clear: CLEAR, tags: ["store", "cloth"], heavy: true,
    // The left leaf is the one that opens; see `opens` below and LEAF above.
    opens: (f) => ({ hinge: [-f.w / 2 + 0.02, 0, f.d / 2], swing: -1.55 }),
    size: (rng) => ({ w: 0.95 + rng() * 0.35, d: 0.55, h: 1.9 + rng() * 0.16 }),
    build: ({ s, f }) => [
      box([f.w, f.h, f.d], [0, f.h / 2, 0], s.wood),
      // Two doors with a stile between them, and handles you could grip.
      box([f.w / 2 - 0.05, f.h - 0.16, 0.03], [-f.w / 4, f.h / 2, f.d / 2 + 0.015], s.woodDark, "wood", LEAF),
      box([f.w / 2 - 0.05, f.h - 0.16, 0.03], [f.w / 4, f.h / 2, f.d / 2 + 0.015], s.woodDark),
      cyl(0.02, 0.09, [-0.05, f.h * 0.5, f.d / 2 + 0.05], s.metal, "metal", { rotX: Math.PI / 2, ...LEAF }),
      cyl(0.02, 0.09, [0.05, f.h * 0.5, f.d / 2 + 0.05], s.metal, "metal", { rotX: Math.PI / 2 }),
      box([f.w + 0.06, 0.07, f.d + 0.05], [0, f.h + 0.03, 0], s.woodDark),   // cornice
    ],
  },

  cabinet: {
    /* The one piece of casework a household PAINTS. Everything else in here
       is the timber it was cut from; a cabinet is joinery, joinery gets a
       coat, and `paint` is the colour of that coat — mint against pink
       boarding in the beach house, gilt cream in a keep. It defaults to bare
       wood, which is what this was before the key existed. */
    label: "Cabinet", anchor: "wall", clear: CLEAR, tags: ["store"], heavy: true, surface: true,
    /* A CUPBOARD ON ONE SIDE, DRAWERS ON THE OTHER — which is what a dresser
       base is, and which is also the only way this piece could honestly carry
       the "Open" it offers. Its whole front used to be drawer fronts, and a
       drawer does not swing: the affordance would have been a prompt attached
       to a face that could not move. */
    opens: (f) => ({ hinge: [-f.w / 2 + 0.02, 0, f.d / 2], swing: -1.5 }),
    size: (rng) => ({ w: 0.9 + rng() * 0.4, d: 0.45, h: 0.88 + rng() * 0.12 }),
    build: ({ s, f }) => {
      const p = [box([f.w, f.h, f.d], [0, f.h / 2, 0], s.paint ?? s.wood)];
      const face = shade(s.paint ?? s.wood, -0.1);
      // The left half: one door, hinged on the outer stile.
      const dw = f.w / 2 - 0.06;
      p.push(box([dw, f.h - 0.2, 0.025], [-f.w / 4, f.h / 2 + 0.02, f.d / 2 + 0.012], face, "wood", LEAF));
      p.push(cyl(0.018, 0.11, [r3(-0.09), f.h / 2 + 0.02, f.d / 2 + 0.04], s.metal, "metal",
        { rotZ: Math.PI / 2, ...LEAF }));
      // The right half: drawers, as many as the carcass is tall enough for.
      const drawers = 2 + Math.round(f.h * 1.4) % 2;
      for (let i = 0; i < drawers; i++) {
        const y = 0.12 + (i + 0.5) * ((f.h - 0.18) / drawers);
        p.push(box([dw, (f.h - 0.24) / drawers, 0.025], [f.w / 4, y, f.d / 2 + 0.012], face));
        p.push(cyl(0.018, 0.09, [f.w / 4, y, f.d / 2 + 0.04], s.metal, "metal", { rotZ: Math.PI / 2 }));
      }
      // The top is the one part that stays timber: a painted carcass with a
      // scrubbed wooden worktop on it is what a kitchen dresser actually is.
      p.push(box([f.w + 0.04, 0.04, f.d + 0.04], [0, f.h + 0.02, 0], s.woodDark));
      return p;
    },
  },

  shelfUnit: {
    label: "Shelving", anchor: "wall", clear: 0.55, tags: ["store", "book"], surface: true,
    size: (rng, room) => ({ w: 0.8 + rng() * 0.5, d: 0.32, h: Math.min(REACH_H, room.h - 0.5) }),
    build: ({ s, f, rng }) => {
      const p = [
        box([0.06, f.h, f.d], [-f.w / 2 + 0.03, f.h / 2, 0], s.woodDark),
        box([0.06, f.h, f.d], [f.w / 2 - 0.03, f.h / 2, 0], s.woodDark),
        box([f.w, 0.03, f.d], [0, f.h - 0.015, 0], s.wood),
        box([f.w - 0.12, 0.02, f.d - 0.04], [0, 0.04, 0], s.wood),
      ];
      // Shelf pitch follows what people store, not a fixed count: books want
      // ~0.34 m, crocks want more.
      const pitch = 0.32 + rng() * 0.14;
      for (let y = pitch; y < f.h - 0.1; y += pitch) {
        p.push(box([f.w - 0.12, 0.025, f.d - 0.03], [0, y, 0], s.wood));
      }
      return p;
    },
  },

  chest: {
    label: "Chest", anchor: "wall", clear: 0.5, tags: ["store"], heavy: true, surface: true,
    size: (rng) => ({ w: 0.86 + rng() * 0.24, d: 0.46, h: 0.5 }),
    build: ({ s, f }) => [
      box([f.w, f.h - 0.08, f.d], [0, (f.h - 0.08) / 2, 0], s.wood),
      box([f.w + 0.03, 0.09, f.d + 0.03], [0, f.h - 0.045, 0], s.woodDark),
      box([0.06, f.h, 0.03], [-f.w * 0.3, f.h / 2, f.d / 2 + 0.015], s.metal, "metal"),
      box([0.06, f.h, 0.03], [f.w * 0.3, f.h / 2, f.d / 2 + 0.015], s.metal, "metal"),
      box([0.09, 0.08, 0.03], [0, f.h - 0.14, f.d / 2 + 0.015], s.metal, "metal"),
    ],
  },

  crate: {
    label: "Crate", anchor: "corner", clear: 0.35, tags: ["store", "rough"], surface: true,
    size: (rng) => { const w = 0.42 + rng() * 0.16; return { w, d: w * (0.85 + rng() * 0.3), h: w * 0.8 }; },
    build: ({ s, f }) => [
      box([f.w, f.h, f.d], [0, f.h / 2, 0], s.woodPale),
      box([f.w + 0.02, 0.035, 0.035], [0, f.h * 0.22, f.d / 2], s.woodDark),
      box([f.w + 0.02, 0.035, 0.035], [0, f.h * 0.78, f.d / 2], s.woodDark),
    ],
  },

  barrel: {
    label: "Barrel", anchor: "corner", clear: 0.35, tags: ["store", "rough"], surface: true,
    size: (rng) => { const r = 0.26 + rng() * 0.06; return { w: r * 2, d: r * 2, h: 0.78 }; },
    build: ({ s, f }) => {
      const r = f.w / 2;
      return [
        // Belly: staves bow out, so the middle is wider than the ends.
        cyl(r * 0.88, 0.14, [0, 0.07, 0], s.wood, "wood", { rTop: r }),
        cyl(r, f.h - 0.28, [0, f.h / 2, 0], s.wood),
        cyl(r, 0.14, [0, f.h - 0.07, 0], s.wood, "wood", { rTop: r * 0.88 }),
        cyl(r * 1.02, 0.045, [0, f.h * 0.26, 0], s.metal, "metal"),
        cyl(r * 1.02, 0.045, [0, f.h * 0.74, 0], s.metal, "metal"),
      ];
    },
  },

  basket: {
    label: "Basket", anchor: "corner", clear: 0.25, tags: ["store"], small: true,
    size: (rng) => { const r = 0.19 + rng() * 0.07; return { w: r * 2, d: r * 2, h: 0.3 }; },
    build: ({ s, f }) => [{
      shape: "lathe", seg: 14, color: mixHex(s.woodPale, 0x9c8256, 0.5), tex: "wood",
      pos: [0, 0, 0],
      profile: [[0, 0], [f.w * 0.42, 0.02], [f.w * 0.5, f.h * 0.6], [f.w * 0.46, f.h],
                [f.w * 0.42, f.h], [f.w * 0.44, f.h * 0.6], [f.w * 0.36, 0.03], [0, 0.03]],
    }],
  },

  /* ─────────── the hearth and the kitchen ─────────── */
  hearth: {
    label: "Hearth", anchor: "wall", clear: 1.0, tags: ["heat", "cook", "light"], heavy: true, once: true,
    lights: 4.5,
    // Depth includes the HEARTHSTONE, which is a third of a metre proud of
    // the breast and is the part of a fireplace people actually trip on.
    size: (rng) => ({ w: 1.25 + rng() * 0.4, d: 0.95, h: 2.0 }),
    build: ({ s, f, rng }) => {
      /* The BREAST is 0.6 deep; the declared footprint is deeper than that
         because the hearthstone lies out in front of it, and the floor a
         hearthstone is on is floor you do not walk over. Everything is
         measured off `breast` and set back inside the reservation. */
      const breast = 0.6, back = -(f.d / 2) + breast / 2;
      const op = f.w * 0.52, oh = 0.95;
      const p = [
        // Jambs and lintel around the opening, then the breast above it.
        box([(f.w - op) / 2, oh, breast], [-(op + (f.w - op) / 2) / 2, oh / 2, back], s.stone, "concrete"),
        box([(f.w - op) / 2, oh, breast], [(op + (f.w - op) / 2) / 2, oh / 2, back], s.stone, "concrete"),
        box([f.w, 0.18, breast], [0, oh + 0.09, back], s.stone, "concrete"),
        box([f.w * 0.78, f.h - oh - 0.18, breast * 0.8], [0, (f.h + oh + 0.18) / 2, back - breast * 0.1],
          s.stone, "concrete"),
        box([f.w - 0.06, 0.06, 0.5], [0, oh + 0.21, back + breast * 0.3], s.wood),   // mantel
        // The hearthstone, lying inside the depth the piece reserved.
        box([f.w * 0.9, 0.04, f.d - 0.08], [0, 0.02, 0], s.stone, "concrete"),
      ];
      // The fire itself, when the house is keeping one in.
      if (rng() < 0.72) {
        p.push(box([op * 0.6, 0.1, 0.3], [0, 0.09, back], shade(s.woodDark, -0.4)));
        p.push(lamp(0.2, [0, 0.16, back], s, 2.4, 4.5));
        p.push(lamp(0.11, [op * 0.18, 0.24, back - 0.06], s, 1.5));
      } else {
        /* Banked, not out. A hearth is the light of the room it is in, and a
           household that has let theirs die is a household that has left; the
           embers under the ash still carry the room, dimmer and redder. The
           reach is unchanged because the SOLVER planned the room around it —
           a hearth that quietly stopped lighting would leave a room planned
           lit and rendered black. */
        p.push(box([op * 0.55, 0.06, 0.26], [0, 0.05, back], shade(s.stone, -0.45), "concrete"));
        p.push(lamp(0.09, [0, 0.08, back], s, 0.45, 4.5));
      }
      return p;
    },
  },

  stove: {
    label: "Stove", anchor: "wall", clear: CLEAR, tags: ["cook", "heat", "light"], heavy: true, once: true,
    lights: 2.2,
    size: (rng) => ({ w: 0.8 + rng() * 0.2, d: 0.6, h: WORKTOP_H }),
    build: ({ s, f }) => [
      box([f.w, f.h - 0.12, f.d], [0, (f.h - 0.12) / 2 + 0.12, 0], shade(s.metal, -0.3), "metal"),
      ...legs(f.w, f.d, 0.14, 0.06, shade(s.metal, -0.4), 0.05),
      box([f.w + 0.05, 0.04, f.d + 0.04], [0, f.h, 0], shade(s.metal, -0.15), "metal"),
      cyl(0.11, 0.02, [-f.w * 0.2, f.h + 0.02, 0], shade(s.metal, -0.45), "metal"),
      cyl(0.11, 0.02, [f.w * 0.2, f.h + 0.02, 0], shade(s.metal, -0.45), "metal"),
      // Firebox door, and the light behind it.
      box([f.w * 0.5, 0.3, 0.03], [0, 0.42, f.d / 2 + 0.015], shade(s.metal, -0.5), "metal"),
      lamp(0.1, [0, 0.42, f.d / 2 - 0.05], s, 1.1, 2.2),
      cyl(0.07, 1.0, [0, f.h + 0.5, -f.d * 0.3], shade(s.metal, -0.35), "metal"),   // flue
    ],
  },

  worktop: {
    label: "Worktop", anchor: "wall", clear: CLEAR, tags: ["cook", "work"], heavy: true, surface: true,
    size: (rng, room) => ({ w: Math.min(2.2, 1.1 + room.area * 0.04) + rng() * 0.2, d: 0.6, h: WORKTOP_H }),
    build: ({ s, f }) => [
      // Scrubbed timber top over a painted run of doors — the reference
      // kitchen in one object, and the reason `paint` exists.
      box([f.w, 0.06, f.d], [0, f.h - 0.03, 0], s.wood),
      box([f.w - 0.06, f.h - 0.16, f.d - 0.08], [0, (f.h - 0.16) / 2 + 0.1, -0.02], s.paint ?? s.woodDark),
      box([f.w, 0.1, f.d], [0, 0.05, 0], shade(s.paint ?? s.woodDark, -0.2)),
      box([f.w - 0.2, 0.02, f.d - 0.14], [0, 0.42, 0], s.woodPale),   // under-shelf
    ],
  },

  basin: {
    label: "Basin", anchor: "wall", clear: CLEAR, tags: ["cook", "wash"], heavy: true, once: true,
    size: () => ({ w: 0.66, d: 0.5, h: WORKTOP_H }),
    build: ({ s, f }) => [
      box([f.w, 0.66, f.d], [0, 0.33, 0], s.stone, "concrete"),
      box([f.w - 0.1, 0.22, f.d - 0.1], [0, 0.78, 0], shade(s.stone, -0.25), "concrete"),
      box([f.w - 0.2, 0.06, f.d - 0.2], [0, 0.7, 0], shade(s.stone, -0.5), "concrete"),
      cyl(0.025, 0.3, [0, 1.02, -f.d / 2 + 0.08], s.metal, "metal"),
    ],
  },

  /* ── the kitchen run ──
     A worktop is a table you stand at. A RUN is the fitted length of painted
     base units the whole back wall of the reference kitchen is made of —
     doors, handles, a plinth, and a scrubbed timber top over the lot — and it
     is the object that makes a kitchen read as a kitchen from the far side of
     the room. Painted in the world's joinery colour, which is how the mint
     comes out mint. */
  counterRun: {
    label: "Counter run", anchor: "wall", clear: CLEAR, tags: ["cook", "store"], once: true,
    heavy: true, surface: true,
    /* Capped at a bit under half the wall it stands on. A run that takes the
       whole wall leaves a kitchen with nowhere to put the table its own
       programme requires, and the table is what the chairs hang off — so the
       reference kitchen's round table and four chairs simply never appeared. */
    size: (rng, room) => ({ w: Math.min(3.0, Math.max(1.8, room.w * 0.44)) + rng() * 0.25,
                            d: 0.62, h: WORKTOP_H }),
    // The leftmost door in the run is the one that opens. Its hinge is the
    // outer stile of the carcass rather than the middle of the run, because a
    // door hung in the middle of a counter is a door hung on a cupboard side.
    opens: (f) => ({ hinge: [-f.w / 2 + 0.04, 0, f.d / 2], swing: -1.45 }),
    build: ({ s, f }) => {
      const paint = s.paint ?? s.wood;
      const p = [
        // Plinth, carcass, timber top.
        box([f.w - 0.08, 0.11, f.d - 0.08], [0, 0.055, 0], shade(paint, -0.3)),
        box([f.w, f.h - 0.18, f.d], [0, (f.h - 0.18) / 2 + 0.11, 0], paint),
        box([f.w + 0.04, 0.07, f.d + 0.04], [0, r3(f.h - 0.035), 0], s.wood),
      ];
      // Doors: one per ~0.6 m, which is the module a joiner actually builds to.
      const n = Math.max(2, Math.round(f.w / 0.62));
      const dw = (f.w - 0.08) / n;
      for (let i = 0; i < n; i++) {
        const x = -f.w / 2 + 0.04 + dw * (i + 0.5);
        const swings = i === 0 ? LEAF : null;
        p.push(box([dw - 0.035, f.h - 0.3, 0.025], [x, f.h / 2 + 0.04, f.d / 2 + 0.014],
          shade(paint, 0.06), "wood", swings));
        p.push(cyl(0.014, 0.1, [x, r3(f.h - 0.2), f.d / 2 + 0.04], s.metal, "metal",
          { rotZ: Math.PI / 2, metalness: 0.5, roughness: 0.4, ...(swings || null) }));
      }
      return p;
    },
  },

  /* The tall cold store. Every kitchen the references show has one white box
     standing at the end of the run, taller than the counter and the only
     thing in the room at that height — which is most of what makes the
     silhouette of a kitchen read. Authored near-white and DECLINING the theme
     tint, because a larder that came out the world's joinery colour would be
     a cupboard. */
  coldStore: {
    label: "Cold store", anchor: "wall", clear: CLEAR, tags: ["cook", "store"], heavy: true, once: true,
    size: (rng) => ({ w: 0.74 + rng() * 0.08, d: 0.8, h: 1.72 + rng() * 0.12 }),
    // The tall lower door, hung on the left stile. This is the piece the
    // brief names — walk up to the cold store, press E, and the door swings.
    opens: (f) => ({ hinge: [-f.w / 2 + 0.03, 0, f.d / 2], swing: -1.6 }),
    build: ({ s, f }) => {
      const white = 0xf2efe8, seam = 0xe4dfd6;
      const pull = { metalness: 0.6, roughness: 0.35 };
      return [
        box([f.w, f.h, f.d], [0, f.h / 2, 0], white, "paint", { tint: false, bevel: 0.03 }),
        // The two doors, the seam between them, and a long pull on each.
        box([f.w - 0.05, f.h * 0.32 - 0.02, 0.03], [0, r3(f.h * 0.82), f.d / 2 + 0.016],
          seam, "paint", { tint: false }),
        box([f.w - 0.05, f.h * 0.64 - 0.02, 0.03], [0, r3(f.h * 0.32), f.d / 2 + 0.016],
          seam, "paint", { tint: false, ...LEAF }),
        cyl(0.016, r3(f.h * 0.24), [r3(f.w * 0.32), r3(f.h * 0.55), f.d / 2 + 0.05],
          shade(s.metal, 0.2), "metal", { ...pull, ...LEAF }),
        cyl(0.016, 0.16, [r3(f.w * 0.32), r3(f.h * 0.86), f.d / 2 + 0.05],
          shade(s.metal, 0.2), "metal", pull),
        // Feet, so it stands off the floor like the real thing.
        box([f.w - 0.1, 0.04, f.d - 0.1], [0, 0.02, 0], shade(white, -0.4), "paint", { tint: false }),
      ];
    },
  },

  /* A low stand with a dark panel on it. Deliberately generic — it is a
     screen on a cabinet, which is what the reference living room has, and
     naming it after any particular decade would date a catalogue that has to
     furnish a castle out of the same table. */
  mediaStand: {
    label: "Stand", anchor: "wall", clear: CLEAR, tags: ["show", "store"], heavy: true, surface: true, once: true,
    size: (rng) => ({ w: 1.35 + rng() * 0.35, d: 0.44, h: 0.58 }),
    build: ({ s, f }) => {
      const p = [
        ...legs(f.w, f.d, 0.16, 0.06, s.woodDark, 0.05),
        box([f.w, f.h - 0.18, f.d], [0, (f.h - 0.18) / 2 + 0.16, 0], s.wood),
        box([f.w + 0.05, 0.05, f.d + 0.04], [0, r3(f.h - 0.02), 0], s.woodPale),
      ];
      // Two drawers and an open bay between them.
      for (const sx of [-1, 1]) {
        p.push(box([f.w * 0.3, f.h * 0.28, 0.022], [r3(sx * f.w * 0.32), r3(f.h * 0.55), f.d / 2 + 0.012], s.woodPale));
        p.push(cyl(0.014, 0.09, [r3(sx * f.w * 0.32), r3(f.h * 0.55), f.d / 2 + 0.04], s.metal, "metal",
          { rotZ: Math.PI / 2 }));
      }
      // The panel: a dark face on a slim foot, standing on the top.
      const pw = f.w * 0.78, ph = pw * 0.56;
      p.push(box([r3(pw * 0.24), 0.04, 0.2], [0, r3(f.h + 0.02), 0], 0x2a2c30, "paint", { tint: false }));
      p.push(box([0.06, 0.12, 0.06], [0, r3(f.h + 0.1), 0], 0x2a2c30, "paint", { tint: false }));
      p.push(box([r3(pw), r3(ph), 0.05], [0, r3(f.h + 0.18 + ph / 2), 0], 0x17181b, "paint",
        { tint: false, roughness: 0.25, bevel: 0.01 }));
      return p;
    },
  },

  /* A rail of pegs with what was hung on it. Two hooks, a hat and a cloth —
     the smallest object in the catalogue that says somebody came in through
     that door, and the reference beach house puts it beside its own. */
  pegRail: {
    label: "Peg rail", anchor: "wallHigh", mountH: 1.62, clear: 0, tags: ["store"], small: true,
    size: (rng) => ({ w: 0.5 + rng() * 0.26, d: 0.16, h: 0.12 }),
    build: ({ s, f, rng }) => {
      const p = [box([f.w, 0.1, 0.05], [0, 0, 0], s.woodDark)];
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const x = (n === 1 ? 0 : i / (n - 1) - 0.5) * (f.w - 0.14);
        p.push(cyl(0.018, 0.11, [x, -0.02, 0.055], s.wood, "wood", { rotX: Math.PI / 2.3 }));
      }
      // A straw hat on one peg, a cloth on another — flat discs and a hanging
      // panel, which at arm's length is exactly what those two things are.
      p.push({ shape: "cylinder", dims: [0.14, 0.03], seg: 14,
        pos: [r3(-(f.w - 0.14) * 0.3), -0.06, 0.11], rotX: r3(Math.PI / 2.6),
        color: mixHex(s.woodPale, 0xe4cf94, 0.6), tex: "none", noCollide: true });
      p.push({ shape: "cylinder", dims: [0.07, 0.07], seg: 12,
        pos: [r3(-(f.w - 0.14) * 0.3), -0.02, 0.09], rotX: r3(Math.PI / 2.6),
        color: mixHex(s.woodPale, 0xe4cf94, 0.45), tex: "none", noCollide: true });
      p.push(box([0.2, 0.46, 0.05], [r3((f.w - 0.14) * 0.3), -0.26, 0.07], s.cloth, "none",
        { roughness: 1, noCollide: true }));
      return p;
    },
  },

  /* ─────────── work ─────────── */
  workbench: {
    label: "Workbench", anchor: "wall", clear: CLEAR, tags: ["work", "trade"], heavy: true, surface: true,
    size: (rng) => ({ w: 1.5 + rng() * 0.6, d: 0.66, h: WORKTOP_H }),
    build: ({ s, f }) => [
      ...legs(f.w, f.d, f.h - 0.08, 0.11, s.woodDark, 0.06),
      box([f.w, 0.08, f.d], [0, f.h - 0.04, 0], shade(s.wood, -0.1)),
      box([f.w - 0.3, 0.04, 0.06], [0, 0.3, 0], s.woodDark),
      // A vice on one end. Nothing says "this bench is used" like a vice.
      box([0.16, 0.13, 0.2], [-f.w / 2 + 0.16, f.h + 0.06, f.d / 2 - 0.12], shade(s.metal, -0.2), "metal"),
      cyl(0.022, 0.24, [-f.w / 2 + 0.16, f.h + 0.06, f.d / 2 + 0.02], s.metal, "metal", { rotX: Math.PI / 2 }),
    ],
  },

  /* The instrument. A study is a room that LOOKS at things, and nothing in
     the catalogue said so: desk plus shelves reads as a clerk's office. One
     brass tube on a stand is the whole difference between administration
     and research. The tube is authored brass rather than styled — brass is
     brass in every world that can afford the instrument at all.

     ANCHOR "floor", not "free". It shipped as "free", which is not an anchor
     — the planner offers cells for wall, corner, floor and rug, and refuses
     everything else before it ever reaches a slot generator. So the one piece
     added to make Farshore's study read as research was, measured over four
     seeds of every landmark in every world, placed exactly zero times. */
  instrument: {
    label: "Instrument", anchor: "floor", clear: 0.6, tags: ["work", "show"], once: true,
    size: () => ({ w: 0.7, d: 0.7, h: 1.65 }),
    build: ({ s }) => [
      cyl(0.24, 0.06, [0, 0.03, 0], s.woodDark),
      cyl(0.05, 1.0, [0, 0.56, 0], s.woodDark),
      { shape: "sphere", dims: [0.09], pos: [0, 1.08, 0], color: 0x8a6a34, tex: "metal" },
      cyl(0.075, 1.05, [0, 1.32, -0.18], 0xb08a42, "metal",
        { rotX: Math.PI / 2.85, metalness: 0.6, roughness: 0.35 }),
      cyl(0.05, 0.16, [0, 0.98, 0.28], 0x8a6a34, "metal", { rotX: Math.PI / 2.85 }),
    ],
  },

  loom: {
    label: "Loom", anchor: "wall", clear: 0.9, tags: ["work", "trade", "cloth"], heavy: true,
    size: () => ({ w: 1.15, d: 0.95, h: 1.7 }),
    build: ({ s, f }) => {
      const p = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        p.push(box([0.09, f.h, 0.09], [sx * (f.w / 2 - 0.06), f.h / 2, sz * (f.d / 2 - 0.06)], s.woodDark));
      }
      p.push(box([f.w, 0.08, 0.09], [0, f.h - 0.04, -f.d / 2 + 0.05], s.wood));
      p.push(box([f.w, 0.08, 0.09], [0, f.h - 0.04, f.d / 2 - 0.05], s.wood));
      p.push(box([f.w - 0.14, 0.06, f.d - 0.3], [0, 0.85, 0], s.wood));
      // Warp: a sheet of thread under tension, which is the whole machine.
      p.push(box([f.w - 0.2, 0.02, f.d - 0.4], [0, 1.3, 0], s.paper, "none", { roughness: 1 }));
      return p;
    },
  },

  toolRack: {
    label: "Tool rack", anchor: "wallHigh", mountH: 1.5, clear: 0, tags: ["work", "trade"], small: true,
    size: () => ({ w: 0.9, d: 0.12, h: 0.55 }),
    build: ({ s, f, rng }) => {
      const p = [box([f.w, 0.05, 0.06], [0, f.h - 0.02, 0], s.woodDark)];
      const n = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1) - 0.5) * (f.w - 0.16);
        const len = 0.24 + rng() * 0.24;
        p.push(cyl(0.014, len, [x, f.h - 0.05 - len / 2, 0.01], s.woodDark));
        p.push(box([0.05, 0.1, 0.03], [x, f.h - 0.05 - len, 0.01], shade(s.metal, -0.1), "metal"));
      }
      return p;
    },
  },

  /* ─────────── light ─────────── */
  lampTable: {
    label: "Lamp", anchor: "surface", clear: 0, tags: ["light"], small: true, lights: 3.0,
    size: () => ({ w: 0.2, d: 0.2, h: 0.36 }),
    build: ({ s }) => [
      cyl(0.075, 0.03, [0, 0.015, 0], shade(s.metal, -0.2), "metal"),
      cyl(0.02, 0.15, [0, 0.1, 0], s.metal, "metal"),
      { shape: "lathe", seg: 12, color: s.paper, tex: "none", pos: [0, 0.17, 0],
        emissive: s.glow, emissiveIntensity: r3(s.glowPower * 0.5),
        profile: [[0.05, 0], [0.11, 0.16], [0.105, 0.165], [0.045, 0.008]] },
      lamp(0.045, [0, 0.22, 0], s, 1.6, 3.0),
    ],
  },

  lampFloor: {
    label: "Standing lamp", anchor: "wall", clear: 0.3, tags: ["light"], lights: 3.6,
    size: () => ({ w: 0.34, d: 0.34, h: 1.58 }),
    build: ({ s, f }) => [
      cyl(0.16, 0.035, [0, 0.017, 0], shade(s.metal, -0.25), "metal"),
      cyl(0.022, f.h - 0.3, [0, (f.h - 0.3) / 2 + 0.03, 0], s.metal, "metal"),
      { shape: "lathe", seg: 14, color: s.paper, tex: "none", pos: [0, f.h - 0.3, 0],
        emissive: s.glow, emissiveIntensity: r3(s.glowPower * 0.45),
        profile: [[0.07, 0], [0.16, 0.24], [0.155, 0.245], [0.065, 0.01]] },
      lamp(0.06, [0, f.h - 0.16, 0], s, 1.8, 3.6),
    ],
  },

  pendant: {
    label: "Ceiling lamp", anchor: "ceiling", clear: 0, tags: ["light"], lights: 4.2,
    size: () => ({ w: 0.36, d: 0.36, h: 0.7 }),
    build: ({ s, f }) => [
      cyl(0.016, f.h - 0.2, [0, -(f.h - 0.2) / 2, 0], shade(s.metal, -0.3), "metal"),
      { shape: "lathe", seg: 14, color: shade(s.metal, -0.1), tex: "metal", pos: [0, -f.h + 0.2, 0],
        profile: [[0.03, 0.2], [0.18, 0.02], [0.175, 0], [0.028, 0.19]] },
      lamp(0.065, [0, -f.h + 0.24, 0], s, 2.0, 4.2),
    ],
  },

  /* The pendant's ceremonial cousin, and the object both castle plates hang
     their light on. A ring of candles on chains under a boss — the shape is
     the point, because a hall lit by one bulb on a flex is a warehouse with
     good windows. Gated by `minArea`, the same way the rose window is: in a
     seven-metre parlour a five-arm chandelier is another building's light
     fitting. The arms are authored brass; everything else takes the style,
     so a world's candlelight is its own. */
  chandelier: {
    label: "Chandelier", anchor: "ceiling", clear: 0, tags: ["light", "show"], lights: 6.5,
    minArea: 48,
    size: (rng) => { const r = 0.5 + rng() * 0.22; return { w: r * 2, d: r * 2, h: 1.35 }; },
    build: ({ s, f }) => {
      const r = f.w / 2, drop = f.h - 0.45;
      const brass = 0xb08a42;
      const p = [
        cyl(0.02, drop, [0, -drop / 2, 0], brass, "metal", { metalness: 0.7, roughness: 0.3 }),
        { shape: "lathe", seg: 16, color: brass, tex: "metal", pos: [0, -drop - 0.06, 0],
          metalness: 0.7, roughness: 0.3,
          profile: [[0.04, 0.14], [r * 0.55, 0.02], [r * 0.54, 0], [0.035, 0.13]] },
      ];
      // The ring, and a candle standing on it at each arm.
      const arms = 6;
      for (let i = 0; i < arms; i++) {
        const a = (i / arms) * Math.PI * 2;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        p.push(cyl(0.018, r, [cx / 2, r3(-drop - 0.02), cz / 2], brass, "metal",
          { rotZ: Math.PI / 2, rotY: r3(-a), metalness: 0.7, roughness: 0.3 }));
        p.push(cyl(0.05, 0.05, [cx, r3(-drop + 0.02), cz], brass, "metal", { metalness: 0.7, roughness: 0.3 }));
        p.push(cyl(0.022, 0.2, [cx, r3(-drop + 0.14), cz], s.paper, "none"));
        // One arm carries the room's light; the other five are its reflection.
        p.push(lamp(0.045, [cx, r3(-drop + 0.26), cz], s, 1.5, i === 0 ? 6.5 : 0));
      }
      return p;
    },
  },

  sconce: {
    label: "Sconce", anchor: "wallHigh", mountH: 1.75, clear: 0, tags: ["light"], small: true, lights: 3.2,
    size: () => ({ w: 0.18, d: 0.2, h: 0.3 }),
    build: ({ s }) => [
      box([0.1, 0.2, 0.03], [0, 0, -0.015], shade(s.metal, -0.2), "metal"),
      cyl(0.014, 0.16, [0, 0.02, 0.07], s.metal, "metal", { rotX: Math.PI / 2.6 }),
      cyl(0.05, 0.05, [0, 0.09, 0.13], shade(s.metal, -0.1), "metal"),
      cyl(0.022, 0.1, [0, 0.16, 0.13], s.paper, "none"),
      lamp(0.05, [0, 0.23, 0.13], s, 1.7, 3.2),
    ],
  },

  candle: {
    label: "Candle", anchor: "surface", clear: 0, tags: ["light"], small: true, lights: 1.8,
    size: () => ({ w: 0.12, d: 0.12, h: 0.26 }),
    build: ({ s, rng }) => {
      const h = 0.12 + rng() * 0.1;
      return [
        cyl(0.055, 0.015, [0, 0.007, 0], shade(s.metal, -0.15), "metal"),
        cyl(0.018, h, [0, 0.015 + h / 2, 0], s.paper, "none"),
        lamp(0.03, [0, 0.03 + h, 0], s, 1.3, 1.8),
      ];
    },
  },

  /* ─────────── surfaces, softening, and the small things ─────────── */
  rug: {
    label: "Rug", anchor: "rug", clear: 0, tags: ["soft"], flat: true,
    size: (rng, room) => ({
      w: Math.min(2.6, Math.max(1.1, room.w * 0.42)) + rng() * 0.2,
      d: Math.min(1.9, Math.max(0.8, room.d * 0.34)) + rng() * 0.2, h: 0.02,
    }),
    build: ({ s, f }) => [
      box([f.w, 0.018, f.d], [0, 0.009, 0], s.cloth, "none", { bevel: 0, roughness: 1, noCollide: true }),
      box([f.w - 0.22, 0.02, f.d - 0.22], [0, 0.011, 0], s.clothAlt, "none", { bevel: 0, roughness: 1, noCollide: true }),
    ],
  },

  /* A rug is square and sits under the furniture. A RUNNER is long, narrow
     and runs the length of the room toward whatever is at the end of it —
     which makes it the only object in the catalogue that states an AXIS, and
     an axis is what both castle plates are actually built out of. Red up the
     stair in the lobby, deep blue down the middle of the throne hall, and in
     both cases the world's own first cloth with its second as the border. */
  runner: {
    label: "Runner", anchor: "rug", clear: 0, tags: ["soft", "show"], flat: true, once: true,
    minArea: 34,
    size: (rng, room) => ({
      w: Math.min(2.2, Math.max(1.1, room.w * 0.24)) + rng() * 0.2,
      d: Math.max(2.6, room.d * 0.72), h: 0.02,
    }),
    build: ({ s, f }) => {
      const p = [
        box([f.w, 0.018, f.d], [0, 0.009, 0], s.clothAlt, "none", { bevel: 0, roughness: 1, noCollide: true }),
        box([f.w - 0.26, 0.02, f.d - 0.12], [0, 0.011, 0], s.cloth, "none",
          { bevel: 0, roughness: 1, noCollide: true }),
      ];
      // A metal stripe down each side, which is what stops a long red
      // rectangle reading as a corridor carpet.
      for (const sx of [-1, 1]) {
        p.push(box([0.05, 0.022, f.d - 0.12], [sx * (f.w / 2 - 0.16), 0.012, 0], shade(s.metal, 0.35), "none",
          { bevel: 0, roughness: 0.6, noCollide: true }));
      }
      return p;
    },
  },

  wallShelf: {
    label: "Wall shelf", anchor: "wallHigh", mountH: 1.42, clear: 0, tags: ["store", "book"], small: true,
    size: (rng) => ({ w: 0.7 + rng() * 0.4, d: 0.22, h: 0.1 }),
    build: ({ s, f }) => [
      box([f.w, 0.03, f.d], [0, 0, 0], s.wood),
      box([0.04, 0.16, f.d - 0.05], [-f.w / 2 + 0.08, -0.09, -0.01], s.woodDark),
      box([0.04, 0.16, f.d - 0.05], [f.w / 2 - 0.08, -0.09, -0.01], s.woodDark),
    ],
  },

  hanging: {
    label: "Hanging", anchor: "wallHigh", mountH: 1.6, clear: 0, tags: ["soft", "show"], small: true,
    size: (rng) => ({ w: 0.6 + rng() * 0.5, d: 0.04, h: 0.5 + rng() * 0.4 }),
    build: ({ s, f }) => [
      box([f.w, f.h, 0.02], [0, 0, 0], s.clothAlt, "none", { roughness: 1 }),
      box([f.w + 0.06, 0.03, 0.03], [0, f.h / 2 + 0.02, 0], s.woodDark),
    ],
  },

  /* A hanging is a rug on a wall. A BANNER is a statement: narrow, twice as
     tall as a person, gold-edged, and repeated down both sides of a hall so
     the eye is walked to the far end. Both castle plates are half made of
     them — royal blue in one, rose in the other — and both times they are the
     world's own cloth, which is the whole reason the dress exists. Tall
     enough to need the headroom, so `minArea` keeps them out of parlours. */
  banner: {
    label: "Banner", anchor: "wallHigh", mountH: 1.98, clear: 0, tags: ["show", "soft"], small: true,
    // Hall-scale, on the rose window's argument: a two-metre drape in a
    // parlour is a curtain that has come off its rail.
    minArea: 55,
    size: (rng) => ({ w: 0.62 + rng() * 0.2, d: 0.06, h: 1.72 + rng() * 0.44 }),
    build: ({ s, f }) => {
      const gold = shade(s.metal, 0.35);
      const p = [
        box([f.w, f.h, 0.025], [0, 0, 0.01], s.cloth, "none", { roughness: 1 }),
        // The two gold edges, and a rail with finials to hang it from.
        box([0.05, f.h, 0.03], [-f.w / 2 + 0.03, 0, 0.025], gold, "metal", { metalness: 0.5, roughness: 0.4 }),
        box([0.05, f.h, 0.03], [f.w / 2 - 0.03, 0, 0.025], gold, "metal", { metalness: 0.5, roughness: 0.4 }),
        cyl(0.028, f.w + 0.22, [0, f.h / 2 + 0.06, 0.02], gold, "metal",
          { rotZ: Math.PI / 2, metalness: 0.5, roughness: 0.4 }),
      ];
      for (const sx of [-1, 1]) {
        p.push({ shape: "sphere", dims: [0.05], pos: [r3(sx * (f.w / 2 + 0.11)), r3(f.h / 2 + 0.06), 0.02],
          color: gold, tex: "metal", metalness: 0.5, roughness: 0.4 });
      }
      // The pointed tail every heraldic banner ends in.
      p.push({ shape: "cone", dims: [r3(f.w * 0.5), 0.26], seg: 3, pos: [0, r3(-f.h / 2 - 0.1), 0.01],
        rotX: Math.PI / 2, rotZ: Math.PI, color: s.cloth, tex: "none", roughness: 1 });
      return p;
    },
  },

  /* A framed view of somewhere else. Named on three of the four interior
     plates — landscapes up the stair in the castle lobby, a beach painting
     over the sofa, survey plates in the study — and it is the cheapest
     object in the catalogue that tells you a room is looked after rather
     than merely used. The canvas is the world's paper warmed toward its own
     greens, so a kingdom's pictures are of that kingdom. */
  painting: {
    label: "Painting", anchor: "wallHigh", mountH: 1.62, clear: 0, tags: ["show"], small: true,
    size: (rng) => ({ w: 0.44 + rng() * 0.36, d: 0.05, h: 0.36 + rng() * 0.3 }),
    build: ({ s, f, rng }) => {
      const frame = shade(s.woodDark, rng() < 0.5 ? -0.1 : 0.3);
      const sky = mixHex(s.paper, 0x8fb6d8, 0.45 + rng() * 0.2);
      const land = mixHex(0x6f8f4e, s.wood, 0.3);
      return [
        box([f.w, f.h, 0.03], [0, 0, 0], frame),
        box([f.w - 0.09, f.h - 0.09, 0.015], [0, 0, 0.018], sky, "none", { roughness: 0.85 }),
        // One horizon and one mass under it: at wall distance that is a
        // landscape, and anything more is detail nobody will stand close
        // enough to read.
        box([f.w - 0.09, (f.h - 0.09) * 0.36, 0.008], [0, r3(-(f.h - 0.09) * 0.32), 0.024], land, "none",
          { roughness: 0.9 }),
      ];
    },
  },

  /* The chart on the wall. A study is a room that has been somewhere, and a
     coastline pinned up over the desks is how it says so — the difference
     between a room with books in it and a room with an expedition behind it.
     Paper, not cloth: it curls at the batten rather than hanging in folds. */
  wallMap: {
    label: "Map", anchor: "wallHigh", mountH: 1.66, clear: 0, tags: ["show", "study", "work"], small: true,
    size: (rng) => ({ w: 0.85 + rng() * 0.4, d: 0.04, h: 0.6 + rng() * 0.22 }),
    build: ({ s, f, rng }) => {
      const p = [
        box([f.w, f.h, 0.012], [0, 0, 0], s.paper, "none", { roughness: 0.9 }),
        box([f.w + 0.05, 0.035, 0.035], [0, f.h / 2 + 0.02, 0], s.woodDark),
        box([f.w + 0.05, 0.035, 0.035], [0, -f.h / 2 - 0.02, 0], s.woodDark),
      ];
      // Land on it: two or three soft masses and a coast between them. Same
      // argument as the painting — readable at the distance it is read from.
      const ink = mixHex(0x5f7a52, s.woodDark, 0.4);
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const w = f.w * (0.2 + rng() * 0.3), h = f.h * (0.2 + rng() * 0.35);
        p.push(box([r3(w), r3(h), 0.006],
          [r3((rng() - 0.5) * (f.w - w)), r3((rng() - 0.5) * (f.h - h)), 0.01], ink, "none",
          { bevel: 0, roughness: 0.9 }));
      }
      p.push(box([f.w - 0.06, 0.012, 0.006], [0, r3(-f.h * 0.18), 0.011],
        mixHex(0x7f96a8, s.paper, 0.3), "none", { bevel: 0, roughness: 0.9 }));
      return p;
    },
  },

  /* Something alive. Named on ALL FOUR interior plates — greenery by the
     castle columns, flowers up the lobby stair, herbs on the study sill, a
     pot by the beach-house door — and the catalogue had nothing green in it
     at all, which is most of why every finished room read as a museum
     display of furniture.

     The leaves are AUTHORED green rather than styled, for the same reason
     the instrument's tube is authored brass: a leaf is not a soft furnishing
     a household chose the colour of. The pot takes the world's clay, so the
     container is local even where the plant is not. */
  plant: {
    label: "Potted plant", anchor: "corner", clear: 0.3, tags: ["soft", "green"], small: true,
    size: (rng) => { const r = 0.16 + rng() * 0.08; return { w: r * 2, d: r * 2, h: 0.44 + rng() * 0.5 }; },
    build: ({ s, f, rng }) => {
      const r = f.w / 2, potH = Math.min(0.3, f.h * 0.36);
      const leaf = mixHex(0x4f7f3a, 0x86b45c, rng());
      const p = [{
        shape: "lathe", seg: 14, color: s.clay, tex: "none", pos: [0, 0, 0],
        profile: [[0, 0], [r * 0.62, 0.01], [r, potH], [r * 0.94, potH], [r * 0.56, 0.02], [0, 0.02]],
      }];
      // Soil, so the pot is not an empty cup with a stick in it.
      p.push(cyl(r * 0.9, 0.03, [0, r3(potH - 0.015), 0], shade(s.clay, -0.55), "none"));
      const stem = f.h - potH;
      p.push(cyl(0.022, stem, [0, r3(potH + stem / 2), 0], shade(leaf, -0.35), "none"));
      // Fronds: flattened spheres on short stalks, thrown round the stem.
      const n = 4 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng() * 0.5;
        const up = potH + stem * (0.5 + rng() * 0.5);
        const reach = r * (1.1 + rng() * 0.9);
        p.push({ shape: "sphere", dims: [r3(0.1 + rng() * 0.07)],
          pos: [r3(Math.cos(a) * reach), r3(up), r3(Math.sin(a) * reach)],
          color: mixHex(leaf, 0x2f5a28, rng() * 0.4), tex: "none",
          roughness: 0.85, noCollide: true });
      }
      return p;
    },
  },

  /* The rose window. A hall is a room the light is allowed to perform in,
     and the reference halls both stake their identity on one glass panel —
     blue in the ceremonial kingdom, pink in the playful one. It is a PANEL,
     not a hole: openings belong to the shell (block-shapes), so this hangs
     glass and tracery on the wall and lets emissive do the sun's half of the
     work. The colours are the world's own cloths, which is exactly how a
     king's glazier worked too. */
  roseWindow: {
    label: "Rose window", anchor: "wallHigh", mountH: 2.1, clear: 0, tags: ["show"], small: true,
    minArea: 60,   // a castle-hall object: below this it is another building's window
    /* Under 2.6 m tall, and that ceiling is not arbitrary: a wallHigh piece
       hangs centred on its mount, so a 2.8 m panel at 2.1 m puts its head
       through a 3.2 m room's ceiling. The old range topped out at 2.8 and
       only ever escaped the check because the suite's shared draw never
       happened to land there. */
    size: (rng) => ({ w: 1.5 + rng() * 0.5, d: 0.09, h: 2.15 + rng() * 0.38 }),
    build: ({ s, f }) => {
      const p = [
        box([f.w + 0.18, f.h + 0.18, 0.05], [0, 0, -0.02], s.stone, "stone"),
        box([f.w, f.h, 0.035], [0, 0, 0.015], mixHex(s.clothAlt, 0x86a8d8, 0.3), "none",
          { roughness: 0.4, emissive: mixHex(s.clothAlt, 0xffffff, 0.25), emissiveIntensity: 0.5, noCollide: true }),
        { shape: "cylinder", dims: [r3(f.w * 0.3), 0.04], seg: 18, pos: [0, r3(f.h * 0.18), 0.035],
          rotX: Math.PI / 2, color: s.cloth, tex: "none", roughness: 0.4,
          emissive: mixHex(s.cloth, 0xffffff, 0.3), emissiveIntensity: 0.7, noCollide: true },
      ];
      // Tracery: three mullions and a transom, gilt in a wealthy world's
      // metal and plain iron in a poor one.
      for (const t of [-0.25, 0, 0.25]) {
        p.push(box([0.045, f.h, 0.02], [r3(f.w * t * 1.4), 0, 0.045], shade(s.metal, 0.1), "metal"));
      }
      p.push(box([f.w, 0.045, 0.02], [0, r3(-f.h * 0.18), 0.045], shade(s.metal, 0.1), "metal"));
      return p;
    },
  },

  books: {
    label: "Books", anchor: "surface", clear: 0, tags: ["book"], small: true,
    size: (rng) => ({ w: 0.16 + rng() * 0.12, d: 0.2, h: 0.22 }),
    build: ({ s, f, rng }) => {
      const p = [];
      let y = 0;
      const n = 2 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const t = 0.03 + rng() * 0.03;
        p.push(box([f.w - rng() * 0.03, t, f.d - rng() * 0.04], [(rng() - 0.5) * 0.02, y + t / 2, (rng() - 0.5) * 0.02],
          mixHex(s.clothAlt, s.paper, rng() * 0.6), "none"));
        y += t;
      }
      return p;
    },
  },

  crock: {
    label: "Crock", anchor: "surface", clear: 0, tags: ["cook"], small: true,
    size: (rng) => { const r = 0.09 + rng() * 0.05; return { w: r * 2, d: r * 2, h: r * 2.1 }; },
    build: ({ s, f }) => [{
      shape: "lathe", seg: 14, color: s.clay, tex: "none", pos: [0, 0, 0],
      profile: [[0, 0], [f.w * 0.38, 0.01], [f.w * 0.5, f.h * 0.45], [f.w * 0.34, f.h * 0.9],
                [f.w * 0.4, f.h], [f.w * 0.36, f.h], [f.w * 0.3, f.h * 0.9], [f.w * 0.44, f.h * 0.45],
                [f.w * 0.32, 0.02], [0, 0.02]],
    }],
  },

  bowl: {
    label: "Bowl", anchor: "surface", clear: 0, tags: ["cook", "eat"], small: true,
    size: (rng) => { const r = 0.08 + rng() * 0.04; return { w: r * 2, d: r * 2, h: r * 0.8 }; },
    build: ({ s, f }) => [{
      shape: "lathe", seg: 14, color: s.clay, tex: "none", pos: [0, 0, 0],
      profile: [[0, 0], [f.w * 0.3, 0.005], [f.w * 0.5, f.h], [f.w * 0.46, f.h], [f.w * 0.26, 0.02], [0, 0.02]],
    }],
  },

  bottle: {
    label: "Bottle", anchor: "surface", clear: 0, tags: ["eat"], small: true,
    size: () => ({ w: 0.09, d: 0.09, h: 0.28 }),
    build: ({ s, f }) => [{
      shape: "lathe", seg: 12, color: mixHex(0x3f5a46, s.clay, 0.35), tex: "none", pos: [0, 0, 0],
      profile: [[0, 0], [0.043, 0.005], [0.045, f.h * 0.55], [0.02, f.h * 0.75], [0.019, f.h],
                [0.014, f.h], [0, f.h]],
    }],
  },

  /* What a study keeps on its benches. Two objects, and between them they
     are the difference between a room where paperwork happens and a room
     where the world is being taken apart to see how it works.

     A jar is glass, and the vocabulary has no transparency — so it is built
     the way a painter would paint one instead: a very pale, very smooth
     cylinder with a bright rim, a brass lid, and something darker suspended
     in it. At the distance anyone reads a tabletop from, that is glass. */
  specimenJar: {
    label: "Specimen jar", anchor: "surface", clear: 0, tags: ["study", "show"], small: true,
    size: (rng) => { const r = 0.055 + rng() * 0.025; return { w: r * 2, d: r * 2, h: 0.2 + rng() * 0.1 }; },
    build: ({ s, f, rng }) => {
      const r = f.w / 2, glass = 0xd6e4e2;
      return [
        cyl(r, f.h - 0.03, [0, r3((f.h - 0.03) / 2), 0], glass, "none",
          { roughness: 0.08, metalness: 0.05 }),
        cyl(r * 1.06, 0.02, [0, r3(f.h - 0.02), 0], shade(0xb08a42, 0.1), "metal",
          { metalness: 0.65, roughness: 0.35 }),
        // The specimen. Off-centre, because nothing settles in the middle.
        { shape: "blob", dims: [r3(r * 0.55)],
          pos: [r3((rng() - 0.5) * r * 0.5), r3(f.h * 0.36), r3((rng() - 0.5) * r * 0.5)],
          color: mixHex(0x7f6a4a, s.clay, rng() * 0.6), tex: "none", roughness: 0.7, noCollide: true },
      ];
    },
  },

  /* A mineral, on the bench it was brought back to. Faceted rather than
     round — a `blob` at low segment count is a lump, and a lump is a
     potato. The colours are authored: quartz, malachite, amethyst and
     ironstone are the same colours in every world, which is the entire point
     of a specimen. */
  mineral: {
    label: "Mineral", anchor: "surface", clear: 0, tags: ["study", "show"], small: true,
    size: (rng) => { const r = 0.05 + rng() * 0.045; return { w: r * 2, d: r * 1.7, h: r * 1.7 }; },
    build: ({ f, rng }) => {
      // quartz · malachite · amethyst · ironstone · sulphur
      const ORES = [0xd8d2c8, 0x3f8f70, 0x8f6fb0, 0x5f5a55, 0xc8a83c];
      const ore = ORES[Math.floor(rng() * ORES.length)];
      const r = f.w / 2;
      // A crystal is a squat prism with a point on it. Six sides at this
      // scale, tilted, so no two specimens on a bench sit the same way up.
      return [
        cyl(r, f.h * 0.62, [0, r3(f.h * 0.31), 0], ore, "stone",
          { seg: 6, rotZ: r3((rng() - 0.5) * 0.3), roughness: 0.42, metalness: 0.12 }),
        { shape: "cone", dims: [r3(r), r3(f.h * 0.42)], seg: 6, pos: [0, r3(f.h * 0.8), 0],
          color: shade(ore, 0.14), tex: "stone", roughness: 0.35, metalness: 0.12 },
        // The matrix it was cut out of.
        box([r3(r * 2.1), r3(f.h * 0.16), r3(r * 1.8)], [0, r3(f.h * 0.08), 0],
          mixHex(ore, 0x6a6259, 0.7), "stone", { bevel: 0.006 }),
      ];
    },
  },

  pot: {
    label: "Pot", anchor: "surface", clear: 0, tags: ["cook"], small: true,
    size: (rng) => { const r = 0.11 + rng() * 0.04; return { w: r * 2, d: r * 2, h: r * 1.5 }; },
    build: ({ s, f }) => [
      cyl(f.w * 0.5, f.h, [0, f.h / 2, 0], shade(s.metal, -0.35), "metal"),
      cyl(f.w * 0.52, 0.02, [0, f.h, 0], shade(s.metal, -0.15), "metal"),
      box([0.03, 0.02, 0.07], [f.w * 0.53, f.h * 0.8, 0], shade(s.metal, -0.2), "metal"),
      box([0.03, 0.02, 0.07], [-f.w * 0.53, f.h * 0.8, 0], shade(s.metal, -0.2), "metal"),
    ],
  },

  /* ─────────── assembly, ceremony, care and the watch ───────────
     A house is not the only thing people build. These are the pieces the
     non-domestic archetypes are furnished from — a room with a bed and a
     dresser in it is a bedroom whatever sign hangs outside, and a guard post
     furnished from the domestic catalogue is a bedroom with a sign. */

  /* The one seat a whole world is composed around. Both castle plates are
     symmetrical about it, and it is the only object in the catalogue whose
     job is to be LOOKED AT rather than used: a dais with three steps up to
     it, a high back in the world's cloth, gold on every edge, and a lamp
     each side so it is never the dark end of the room.

     Wall-anchored, because a throne stands with its back to the far wall by
     definition — put it in the middle of the floor and you have a chair. */
  throne: {
    label: "Throne", anchor: "wall", clear: 1.4, tags: ["sit", "show", "assembly", "light"], once: true,
    heavy: true, lights: 4.0, minArea: 34,
    /* THE FOOTPRINT IS THE DAIS. It used to be the chair, and the three steps
       were built almost a metre outside it on every side — so the solver
       reserved a seat's worth of floor, called the rest walkable, and left a
       stone step in the middle of it. A piece that builds outside what it
       reserved is a piece you walk into on floor that was declared clear. */
    size: (rng) => ({ w: 2.5 + rng() * 0.4, d: 2.3, h: 2.5 }),
    build: ({ s, f }) => {
      const gold = shade(s.metal, 0.35);
      const met = { metalness: 0.55, roughness: 0.35 };
      const seat = SEAT_H + 0.42;          // three steps up, then a chair on top
      const p = [];
      // The chair itself sits inside the dais rather than defining it.
      const cw = f.w - 1.0, cd = f.d - 0.8;
      // The dais. Three treads, each narrower than the last, so the eye
      // climbs it — which is the whole reason the reference hall works.
      for (let i = 0; i < 3; i++) {
        const t = 0.14, w = f.w - i * 0.3, d = f.d - i * 0.24;
        p.push(box([w, t, d], [0, t * (i + 0.5), (f.d - d) / 2 - 0.1], s.stone, "concrete"));
      }
      const base = 0.42;
      p.push(box([cw, base + 0.1, cd - 0.3], [0, base / 2 + 0.42, -0.1], s.woodDark));
      p.push(box([cw - 0.14, 0.1, cd - 0.42], [0, seat, -0.1], s.cloth, "none", { roughness: 1 }));
      // The back, which is most of a throne's height and all of its silhouette.
      p.push(box([cw - 0.12, 1.5, 0.14], [0, seat + 0.78, -cd / 2 + 0.02], s.woodDark));
      p.push(box([cw - 0.34, 1.28, 0.05], [0, seat + 0.76, -cd / 2 + 0.1], s.cloth, "none", { roughness: 1 }));
      p.push(box([cw - 0.12, 0.09, 0.18], [0, seat + 1.56, -cd / 2 + 0.02], gold, "metal", met));
      // Arms, a finial on each, and a standing light either side — all inside
      // the dais, which is what the footprint now describes.
      for (const sx of [-1, 1]) {
        p.push(box([0.13, 0.13, cd - 0.42], [sx * (cw / 2 - 0.07), seat + 0.28, -0.1], s.woodDark));
        p.push(cyl(0.07, 0.34, [sx * (cw / 2 - 0.07), seat + 0.5, -cd / 2 + 0.12], gold, "metal", met));
        p.push({ shape: "sphere", dims: [0.075],
          pos: [r3(sx * (cw / 2 - 0.07)), r3(seat + 0.7), r3(-cd / 2 + 0.12)],
          color: gold, tex: "metal", ...met });
        p.push(cyl(0.06, 0.9, [sx * (f.w / 2 - 0.22), 0.87, 0.1], gold, "metal", met));
        p.push(cyl(0.03, 0.22, [sx * (f.w / 2 - 0.22), 1.43, 0.1], s.paper, "none"));
        p.push(lamp(0.05, [sx * (f.w / 2 - 0.22), 1.58, 0.1], s, 1.8, sx < 0 ? 4.0 : 0));
      }
      return p;
    },
  },

  pew: {
    // Fixed rows facing one way. Free-standing rather than wall-backed
    // because a congregation sits in the middle of the floor, not round the
    // edges of it — which is exactly what makes a sanctuary read as one.
    label: "Pew", anchor: "floor", clear: 0.45, tags: ["sit", "assembly"], heavy: true,
    size: (rng, room) => ({
      w: Math.min(2.8, Math.max(1.3, room.w * 0.55)) + rng() * 0.18, d: 0.52, h: 1.02,
    }),
    build: ({ s, f }) => [
      box([0.08, SEAT_H - 0.04, f.d - 0.06], [-f.w / 2 + 0.1, (SEAT_H - 0.04) / 2, 0], s.woodDark),
      box([0.08, SEAT_H - 0.04, f.d - 0.06], [f.w / 2 - 0.1, (SEAT_H - 0.04) / 2, 0], s.woodDark),
      box([f.w, 0.055, f.d], [0, SEAT_H - 0.027, 0], s.wood),
      box([f.w, 0.46, 0.05], [0, SEAT_H + 0.28, -f.d / 2 + 0.03], s.wood),
      box([f.w, 0.05, 0.05], [0, SEAT_H + 0.53, -f.d / 2 + 0.03], s.woodDark),
    ],
  },

  altar: {
    label: "Altar", anchor: "wall", clear: 1.1, tags: ["show", "light", "assembly"],
    heavy: true, surface: true, lights: 3.0,
    size: (rng) => ({ w: 1.3 + rng() * 0.45, d: 0.66, h: 1.02 }),
    build: ({ s, f }) => {
      const p = [
        box([f.w, f.h - 0.1, f.d], [0, (f.h - 0.1) / 2, 0], s.stone, "concrete"),
        box([f.w + 0.12, 0.1, f.d + 0.1], [0, f.h - 0.05, 0], shade(s.stone, 0.12), "concrete"),
        // The cloth is what tells you it is dressed rather than derelict.
        box([f.w - 0.28, 0.02, f.d - 0.16], [0, f.h + 0.01, 0.02], s.clothAlt, "none", { roughness: 1 }),
      ];
      // Two lights kept burning: the reason this room is never dark.
      for (const sx of [-1, 1]) {
        p.push(cyl(0.05, 0.03, [sx * f.w * 0.32, f.h + 0.025, 0], shade(s.metal, -0.1), "metal"));
        p.push(cyl(0.02, 0.2, [sx * f.w * 0.32, f.h + 0.14, 0], s.paper, "none"));
        // One of the two carries the room's light; the other is its reflection.
        p.push(lamp(0.04, [sx * f.w * 0.32, f.h + 0.26, 0], s, 1.6, sx < 0 ? 3.0 : 0));
      }
      return p;
    },
  },

  lectern: {
    label: "Lectern", anchor: "floor", clear: 0.7, tags: ["book", "show", "study"],
    size: () => ({ w: 0.52, d: 0.44, h: 1.18 }),
    build: ({ s, f }) => [
      box([0.36, 0.05, 0.34], [0, 0.025, 0], s.woodDark),
      cyl(0.055, f.h - 0.26, [0, (f.h - 0.26) / 2 + 0.05, 0], s.woodDark),
      // The sloped top, which is the entire point of a lectern.
      box([f.w, 0.05, f.d], [0, f.h - 0.08, 0], s.wood, "wood", { rotX: -0.34 }),
      box([f.w, 0.035, 0.05], [0, f.h - 0.16, f.d / 2 - 0.05], s.woodDark),
    ],
  },

  armsRack: {
    label: "Arms rack", anchor: "wall", clear: 0.55, tags: ["arms", "store", "trade"],
    size: (rng) => ({ w: 1.05 + rng() * 0.45, d: 0.3, h: 1.9 }),
    build: ({ s, f, rng }) => {
      const p = [
        box([f.w, 0.07, f.d], [0, 0.035, 0], s.woodDark),
        box([0.08, f.h, 0.08], [-f.w / 2 + 0.05, f.h / 2, -f.d / 2 + 0.05], s.woodDark),
        box([0.08, f.h, 0.08], [f.w / 2 - 0.05, f.h / 2, -f.d / 2 + 0.05], s.woodDark),
        box([f.w, 0.07, 0.07], [0, f.h - 0.04, -f.d / 2 + 0.05], s.wood),
        box([f.w, 0.05, 0.05], [0, 1.02, -f.d / 2 + 0.05], s.wood),
      ];
      // Hafts standing in it, leaning back on the rail. A rack with nothing
      // in it is a shelf.
      const n = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const x = (n === 1 ? 0 : i / (n - 1) - 0.5) * (f.w - 0.24);
        const len = 1.34 + rng() * 0.24;
        p.push(cyl(0.021, len, [x, len / 2 + 0.07, -f.d / 2 + 0.12], s.wood));
        p.push(box([0.07, 0.2, 0.03], [x, len + 0.16, -f.d / 2 + 0.12], shade(s.metal, 0.05), "metal"));
      }
      return p;
    },
  },

  cot: {
    // Narrower than a bed and made to be one of several: what a ward, a
    // barracks and a dormitory are furnished from.
    label: "Cot", anchor: "wall", clear: CLEAR, tags: ["sleep", "care"], heavy: true,
    size: (rng) => ({ w: 0.8 + rng() * 0.1, d: 1.86 + rng() * 0.1, h: 0.56 }),
    build: ({ s, f }) => [
      ...legs(f.w, f.d, 0.3, 0.07, s.woodDark, 0.03),
      box([f.w, 0.09, f.d], [0, 0.345, 0], s.wood),
      box([f.w - 0.06, 0.13, f.d - 0.1], [0, 0.455, 0], s.woodPale, "none", { bevel: 0.05, roughness: 0.95 }),
      box([f.w - 0.08, 0.05, f.d * 0.5], [0, 0.545, f.d * 0.18], s.cloth, "none", { bevel: 0.04, roughness: 0.95 }),
      box([f.w, 0.34, 0.06], [0, 0.47, -f.d / 2 + 0.03], s.woodDark),
    ],
  },

  screen: {
    label: "Screen", anchor: "floor", clear: 0.4, tags: ["soft", "care"],
    size: (rng) => ({ w: 1.1 + rng() * 0.35, d: 0.3, h: 1.62 }),
    build: ({ s, f }) => {
      // Two leaves folded at an angle to each other — the only reason a thing
      // this thin stands up at all.
      const leaf = f.w / 2 - 0.03;
      return [
        box([leaf, f.h, 0.035], [-f.w / 4, f.h / 2, -0.07], s.cloth, "none", { rotY: 0.26, roughness: 1 }),
        box([leaf, f.h, 0.035], [f.w / 4, f.h / 2, -0.07], s.cloth, "none", { rotY: -0.26, roughness: 1 }),
        box([0.05, f.h, 0.05], [0, f.h / 2, -0.07], s.woodDark),
        box([0.05, 0.06, 0.26], [-f.w / 2 + 0.07, 0.03, 0], s.woodDark),
        box([0.05, 0.06, 0.26], [f.w / 2 - 0.07, 0.03, 0], s.woodDark),
      ];
    },
  },

  washstand: {
    label: "Washstand", anchor: "wall", clear: CLEAR, tags: ["wash", "care"], surface: true,
    size: (rng) => ({ w: 0.56 + rng() * 0.12, d: 0.42, h: 0.86 }),
    build: ({ s, f }) => [
      ...legs(f.w, f.d, f.h - 0.05, 0.055, s.woodDark, 0.04),
      box([f.w, 0.05, f.d], [0, f.h - 0.025, 0], s.wood),
      box([f.w - 0.1, 0.02, f.d - 0.08], [0, 0.32, 0], s.woodPale),
      box([f.w, 0.24, 0.04], [0, f.h + 0.12, -f.d / 2 + 0.02], s.wood),   // splashback
      { shape: "lathe", seg: 14, color: shade(s.stone, 0.2), tex: "none", pos: [0, f.h, 0],
        profile: [[0, 0], [0.1, 0.005], [0.17, 0.09], [0.155, 0.095], [0.09, 0.02], [0, 0.02]] },
    ],
  },

  brazier: {
    label: "Brazier", anchor: "floor", clear: 0.7, tags: ["heat", "light"], heavy: true, lights: 3.4,
    size: (rng) => { const r = 0.29 + rng() * 0.07; return { w: r * 2, d: r * 2, h: 0.88 }; },
    build: ({ s, f }) => {
      const r = f.w / 2, leg = f.h - 0.26;
      return [
        cyl(0.045, leg, [-r * 0.5, leg / 2, r * 0.3], shade(s.metal, -0.3), "metal", { rotZ: 0.13 }),
        cyl(0.045, leg, [r * 0.5, leg / 2, r * 0.3], shade(s.metal, -0.3), "metal", { rotZ: -0.13 }),
        cyl(0.045, leg, [0, leg / 2, -r * 0.6], shade(s.metal, -0.3), "metal", { rotX: -0.13 }),
        { shape: "lathe", seg: 14, color: shade(s.metal, -0.15), tex: "metal", pos: [0, leg, 0],
          profile: [[0, 0], [r * 0.55, 0.02], [r, 0.22], [r * 0.94, 0.225], [r * 0.5, 0.045], [0, 0.04]] },
        box([r * 1.05, 0.09, r * 1.05], [0, leg + 0.12, 0], shade(s.woodDark, -0.45)),
        lamp(0.16, [0, leg + 0.2, 0], s, 2.6, 3.4),
      ];
    },
  },

  /* ─────────── the rooms the landmarks needed ───────────
     Seven pieces, and each one exists because a whole KIND of building could
     not be told apart without it. A mill furnished from the workshop table is
     a large workshop; a museum furnished from the hall table is a hall with
     pictures in it; a schoolroom furnished from the office table is an office
     with too many desks. One object each is what separates them, and it is
     always the object the room is arranged around. */

  /* A driven machine: a frame, a bed, a wheel and a shaft. Deliberately not
     any particular trade's machine — a mill, a press and a loom-shop all
     read from the same silhouette at arm's length, and naming it would date
     a catalogue that has to furnish a granary out of the same table. */
  machine: {
    label: "Machine", anchor: "floor", clear: 0.8, tags: ["work", "trade"], heavy: true, minArea: 16,
    size: (rng) => ({ w: 1.9 + rng() * 0.6, d: 0.9 + rng() * 0.2, h: 1.7 }),
    build: ({ s, f, rng }) => {
      const iron = shade(s.metal, -0.12), met = { metalness: 0.55, roughness: 0.42 };
      /* THE FLYWHEEL IS INSIDE THE FOOTPRINT, and the body gives up the room
         for it rather than the reservation being stretched round it. A piece
         that builds outside what it reserved is a piece you walk into on
         floor the solver declared clear — measured, this one's wheel stood
         0.64 m proud of the machine on both sides. */
      const drive = Math.min(0.4, f.d * 0.42);
      const bodyW = f.w - drive * 2 - 0.06;
      const cx = -drive - 0.03;                  // the bed's own centre
      const p = [
        // The bed it all stands on, and the frame over it.
        box([bodyW, 0.24, f.d], [r3(cx), 0.12, 0], iron, "metal", met),
        ...legs(bodyW, f.d - 0.2, f.h - 0.5, 0.11, iron, 0.02).map((b) =>
          ({ ...b, pos: [r3(b.pos[0] + cx), r3(b.pos[1] + 0.24), b.pos[2]], tex: "metal", ...met })),
        box([r3(bodyW - 0.1), 0.18, r3(f.d - 0.16)], [r3(cx), r3(f.h - 0.12), 0], iron, "metal", met),
        // The working surface, in timber: the one part of a machine that wears
        // out and gets replaced, so it is never the same age as the frame.
        box([r3(bodyW - 0.3), 0.09, r3(f.d - 0.3)], [r3(cx), r3(WORKTOP_H), 0], s.wood),
      ];
      // The wheel on one flank and the shaft it turns. The wheel is what makes
      // the thing read as driven rather than as a bench with legs.
      const wx = f.w / 2 - drive;
      p.push(cyl(drive, 0.08, [r3(wx), 0.9, 0], iron, "metal", { rotZ: Math.PI / 2, ...met }));
      p.push(cyl(0.05, r3(bodyW), [r3(cx), 0.9, 0], shade(iron, 0.15), "metal",
        { rotZ: Math.PI / 2, ...met }));
      for (let i = 0; i < 3; i++) {
        p.push(cyl(0.022, r3(drive * 1.7), [r3(wx), 0.9, 0], shade(iron, 0.2), "metal",
          { rotZ: Math.PI / 2, rotX: r3((i / 3) * Math.PI), ...met }));
      }
      // Whatever it is making, stacked at the outfeed end.
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        p.push(box([0.26, 0.07, 0.2], [r3(cx - bodyW / 2 + 0.2), r3(WORKTOP_H + 0.09 + i * 0.075),
          r3(f.d * 0.2)], s.paper, "none"));
      }
      return p;
    },
  },

  /* A furnace: the fire an industrial building is built around, and the
     reason its roof is where it is. Taller and hotter than a hearth, with a
     flue rather than a chimney breast, and it lights further because that is
     what it is doing when nobody is working. */
  furnace: {
    label: "Furnace", anchor: "wall", clear: 1.0, tags: ["heat", "work", "light"],
    heavy: true, once: true, lights: 5.0, minArea: 18,
    size: (rng) => ({ w: 1.2 + rng() * 0.3, d: 0.85, h: 2.4 }),
    build: ({ s, f }) => {
      const brick = mixHex(s.clay, 0x6a4a3a, 0.35), iron = shade(s.metal, -0.25);
      const met = { metalness: 0.5, roughness: 0.5 };
      const p = [
        box([f.w, 1.35, f.d], [0, 0.675, 0], brick, "concrete"),
        box([f.w + 0.1, 0.14, f.d + 0.1], [0, 1.42, 0], shade(brick, -0.12), "concrete"),
        // The flue, taken up out of sight rather than stopped at the ceiling.
        cyl(0.24, f.h - 1.5, [0, r3(1.5 + (f.h - 1.5) / 2), r3(-f.d * 0.18)], iron, "metal", met),
        // The mouth, its iron surround, and the hinges the door hangs on.
        box([r3(f.w * 0.5), 0.5, 0.12], [0, 0.72, r3(f.d / 2 - 0.02)], shade(iron, -0.15), "metal", met),
        box([r3(f.w * 0.62), 0.62, 0.05], [0, 0.72, r3(f.d / 2 + 0.01)], iron, "metal", met),
        box([0.06, 0.1, 0.06], [r3(f.w * 0.3), 0.94, r3(f.d / 2 + 0.03)], shade(iron, 0.1), "metal", met),
        box([0.06, 0.1, 0.06], [r3(f.w * 0.3), 0.5, r3(f.d / 2 + 0.03)], shade(iron, 0.1), "metal", met),
      ];
      // The fire in it, and the bar you rake it with leaning on the wall.
      p.push(lamp(0.2, [0, 0.7, r3(f.d / 2 - 0.14)], s, 2.4, 5.0));
      p.push(cyl(0.022, 1.3, [r3(-f.w / 2 + 0.1), 0.62, r3(f.d / 2 - 0.06)], iron, "metal",
        { rotZ: 0.2, ...met }));
      return p;
    },
  },

  /* A glazed case on a stand. The object that makes a room a museum: nothing
     else in the catalogue says "this is here to be looked at and not
     touched", and a gallery furnished without one is a corridor with
     paintings. */
  displayCase: {
    label: "Display case", anchor: "floor", clear: 0.7, tags: ["show", "store"],
    heavy: true, surface: true, minArea: 14,
    size: (rng) => ({ w: 1.1 + rng() * 0.5, d: 0.6, h: 1.25 }),
    build: ({ s, f, rng }) => {
      const glass = 0xdfe8ea;
      const p = [
        ...legs(f.w, f.d, 0.72, 0.06, s.woodDark, 0.05),
        box([f.w, 0.08, f.d], [0, 0.76, 0], s.wood),
        // The case: four thin panes and a lid, declining the theme tint so a
        // world's joinery colour cannot turn the glass into a cupboard.
        box([f.w - 0.06, 0.42, 0.02], [0, 1.01, r3(f.d / 2 - 0.03)], glass, "none",
          { tint: false, roughness: 0.1, noCollide: true }),
        box([f.w - 0.06, 0.42, 0.02], [0, 1.01, r3(-f.d / 2 + 0.03)], glass, "none",
          { tint: false, roughness: 0.1, noCollide: true }),
        box([0.02, 0.42, f.d - 0.06], [r3(f.w / 2 - 0.03), 1.01, 0], glass, "none",
          { tint: false, roughness: 0.1, noCollide: true }),
        box([0.02, 0.42, f.d - 0.06], [r3(-f.w / 2 + 0.03), 1.01, 0], glass, "none",
          { tint: false, roughness: 0.1, noCollide: true }),
        box([f.w, 0.05, f.d], [0, r3(f.h - 0.02), 0], s.woodDark),
        // The felt it all sits on, which is most of what you see through glass.
        box([f.w - 0.12, 0.015, f.d - 0.12], [0, 0.808, 0], s.cloth, "none", { roughness: 1 }),
      ];
      // What is IN it: two or three small things, and a card beside each.
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const x = (n === 1 ? 0 : i / (n - 1) - 0.5) * (f.w - 0.4);
        p.push({ shape: "sphere", dims: [r3(0.05 + rng() * 0.04)],
          pos: [r3(x), r3(0.86), r3(-0.04)], color: shade(s.stone, 0.12), tex: "none", noCollide: true });
        p.push(box([0.11, 0.004, 0.06], [r3(x), 0.818, r3(f.d * 0.28)], s.paper, "none", { noCollide: true }));
      }
      return p;
    },
  },

  /* A plinth with one thing on it. A case says "small and fragile"; a plinth
     says "big enough to stand on its own", and a gallery wants both — a room
     of nothing but cases is a shop. */
  plinth: {
    label: "Plinth", anchor: "floor", clear: 0.75, tags: ["show"], heavy: true, minArea: 14,
    size: (rng) => { const w = 0.5 + rng() * 0.16; return { w, d: w, h: 1.05 }; },
    build: ({ s, f, rng }) => {
      const stone = shade(s.stone, 0.1);
      const body = f.h - 0.28;
      return [
        box([f.w + 0.08, 0.09, f.d + 0.08], [0, 0.045, 0], shade(stone, -0.1), "concrete"),
        box([f.w, body, f.d], [0, r3(0.09 + body / 2), 0], stone, "concrete"),
        box([f.w + 0.06, 0.06, f.d + 0.06], [0, r3(f.h - 0.19), 0], shade(stone, -0.08), "concrete"),
        // The thing itself: a turned form, so it reads as carved rather than
        // as another box.
        { shape: "lathe", seg: 14, color: shade(s.metal, 0.22), tex: "metal",
          metalness: 0.5, roughness: 0.4, pos: [0, r3(f.h - 0.16), 0],
          profile: [[0, 0], [0.13, 0.02], [0.1, 0.12], [0.15, 0.24], [0.08, 0.36],
                    [0.1, r3(0.44 + rng() * 0.1)], [0, r3(0.5 + rng() * 0.1)]] },
      ];
    },
  },

  /* A board on the wall with the day's work still on it. The one object that
     turns a room of desks into a room where somebody is TAUGHT, which is the
     whole difference between a schoolroom and an office. */
  blackboard: {
    label: "Board", anchor: "wallHigh", mountH: 1.5, clear: 0, tags: ["study", "show"], once: true,
    size: (rng) => ({ w: 1.8 + rng() * 0.8, d: 0.09, h: 1.1 }),
    build: ({ s, f, rng }) => {
      const slate = 0x2c3330;
      const p = [
        box([f.w + 0.1, f.h + 0.1, 0.05], [0, 0, 0], s.woodDark),
        box([f.w, f.h, 0.02], [0, 0, 0.035], slate, "none", { tint: false, roughness: 0.85 }),
        // The chalk tray, and the chalk on it.
        box([f.w, 0.05, 0.1], [0, r3(-f.h / 2 - 0.04), 0.06], s.woodDark),
      ];
      // What was written, as pale marks. Rows rather than words: at arm's
      // length that is what writing on a board is.
      const rows = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < rows; i++) {
        const y = f.h / 2 - 0.18 - i * (f.h - 0.3) / rows;
        const len = (0.35 + rng() * 0.5) * f.w;
        p.push(box([r3(len), 0.018, 0.008], [r3(-f.w / 2 + 0.12 + len / 2), r3(y), 0.05],
          0xd9d6cc, "none", { tint: false, noCollide: true }));
      }
      return p;
    },
  },

  /* A stall: the partition, the manger and the bedding. A stable is a
     building made almost entirely of one repeated object, exactly as a
     sanctuary is made of pews, and without it a stable is a shed. */
  stall: {
    label: "Stall", anchor: "wall", clear: 0.9, tags: ["stock", "store"], heavy: true, minArea: 14,
    size: (rng) => ({ w: 1.5 + rng() * 0.4, d: 1.9, h: 1.5 }),
    build: ({ s, f }) => {
      const p = [
        // The two flanking boards and the post between them.
        box([0.07, f.h, f.d], [r3(-f.w / 2 + 0.04), r3(f.h / 2), 0], s.woodDark),
        box([0.07, f.h, f.d], [r3(f.w / 2 - 0.04), r3(f.h / 2), 0], s.woodDark),
        box([f.w, 0.1, 0.1], [0, r3(f.h - 0.05), r3(f.d / 2 - 0.05)], s.woodDark),
        // The manger, across the head of it.
        box([f.w - 0.2, 0.34, 0.4], [0, 0.72, r3(-f.d / 2 + 0.22)], s.wood),
        box([f.w - 0.28, 0.06, 0.3], [0, 0.9, r3(-f.d / 2 + 0.22)],
          mixHex(s.woodPale, 0xd8c88a, 0.6), "none", { roughness: 1 }),
        // Straw on the floor. Flat, and the reason a stable smells the way it
        // does even when nothing is standing in it.
        box([f.w - 0.2, 0.07, f.d - 0.6], [0, 0.035, r3(f.d * 0.12)],
          mixHex(s.woodPale, 0xcbb473, 0.75), "none", { roughness: 1, bevel: 0.03 }),
      ];
      return p;
    },
  },

  /* A sunken tub with water in it. A bathhouse is the one building type whose
     whole purpose is a thing you get INTO, and nothing else in the catalogue
     holds water. */
  tub: {
    label: "Bath", anchor: "floor", clear: 0.85, tags: ["wash", "care"], heavy: true, minArea: 14,
    size: (rng) => ({ w: 1.7 + rng() * 0.5, d: 1.1, h: 0.62 }),
    build: ({ s, f }) => {
      const stone = shade(s.stone, 0.14), lip = shade(s.stone, 0.24);
      const wall = 0.17;
      const p = [];
      // Four sides and a floor, rather than a solid block with a lid: the
      // point of a bath is that it is hollow.
      for (const sz of [1, -1]) {
        p.push(box([f.w, f.h, wall], [0, r3(f.h / 2), r3(sz * (f.d / 2 - wall / 2))], stone, "concrete"));
      }
      for (const sx of [1, -1]) {
        p.push(box([wall, f.h, f.d - wall * 2], [r3(sx * (f.w / 2 - wall / 2)), r3(f.h / 2), 0],
          stone, "concrete"));
      }
      p.push(box([f.w - wall * 2, 0.12, f.d - wall * 2], [0, 0.06, 0], shade(stone, -0.1), "concrete"));
      p.push(box([f.w + 0.06, 0.07, f.d + 0.06], [0, r3(f.h + 0.02), 0], lip, "concrete"));
      // The water: a pale plane just under the lip, and it is what the whole
      // room is for.
      p.push(box([f.w - wall * 2 - 0.02, 0.03, f.d - wall * 2 - 0.02], [0, r3(f.h - 0.14), 0],
        0x8fb6c2, "none", { tint: false, roughness: 0.08, metalness: 0.15, noCollide: true }));
      return p;
    },
  },

  strongbox: {
    label: "Strongbox", anchor: "corner", clear: 0.5, tags: ["store", "secure"],
    heavy: true, surface: true,
    size: (rng) => ({ w: 0.64 + rng() * 0.14, d: 0.5, h: 0.58 }),
    build: ({ s, f }) => [
      box([f.w, f.h - 0.07, f.d], [0, (f.h - 0.07) / 2, 0], shade(s.woodDark, -0.15)),
      box([f.w + 0.02, 0.08, f.d + 0.02], [0, f.h - 0.04, 0], shade(s.metal, -0.25), "metal"),
      // Banding, corner to corner: what makes a box a strongbox.
      box([0.05, f.h, f.d + 0.03], [-f.w * 0.32, f.h / 2, 0], shade(s.metal, -0.1), "metal"),
      box([0.05, f.h, f.d + 0.03], [f.w * 0.32, f.h / 2, 0], shade(s.metal, -0.1), "metal"),
      box([0.14, 0.12, 0.04], [0, f.h - 0.17, f.d / 2 + 0.02], s.metal, "metal"),
      cyl(0.02, 0.05, [0, f.h - 0.2, f.d / 2 + 0.05], shade(s.metal, -0.3), "metal", { rotX: Math.PI / 2 }),
    ],
  },
};

export const ITEM_IDS = Object.keys(CATALOGUE);

/* ── build ──────────────────────────────────────────────────────────────
   Resolve one catalogue entry into a placement-ready proc, with a footprint
   the solver has already agreed to. `foot` is passed back in rather than
   re-rolled, so what the solver reserved is exactly what gets built. */
export function buildPiece(id, { style, rng, room, foot }) {
  const spec = CATALOGUE[id];
  if (!spec) throw new Error(`unknown furniture: ${id}`);
  const f = foot || footprintOf(id, rng, room);
  const parts = spec.build({ s: style, f, rng });
  const proc = { grime: r3(style.grime), parts };
  /* A piece that declares a leaf declares the pivot it hangs on, in exactly
     the form a building shell already uses — so Props builds the group,
     doors.js registers it and E swings it, with nothing in the engine having
     learned that furniture exists. The hinge depends on the footprint, which
     is why it is a function of `f` rather than a constant. */
  if (spec.opens) proc.door = hingeOf(spec.opens(f));
  return { id, label: spec.label, foot: f, spec, proc };
}

// Rounded, because everything else in a proc is: a hinge that carries fifteen
// decimal places is a hinge that makes two identical placements compare
// unequal after a serialize/parse round trip.
function hingeOf({ hinge, swing }) {
  return { hinge: hinge.map(r3), swing: r3(swing) };
}

// The footprint alone, without building geometry — what the solver reserves
// before it commits to a placement.
export function footprintOf(id, rng, room) {
  const spec = CATALOGUE[id];
  if (!spec) throw new Error(`unknown furniture: ${id}`);
  const f = spec.size(rng, room);
  return { w: r3(f.w), d: r3(f.d), h: r3(f.h ?? spec.mountH ?? 0.5) };
}

export { mixHex, shade };
