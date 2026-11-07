// block-shapes.js — parametric part emitters for the block catalog.
//
// props-packs.js is a catalog of DECLARATIVE parts specs, and hand-writing one
// is fine for a well, a fence, a campfire. It stops being fine at city scale:
// a six-storey block with a window rhythm is a hundred hand-placed boxes that
// nobody can read or keep consistent, and every extra storey is a rewrite.
// These functions emit the same parts arrays from a handful of numbers.
//
// Three rules they all obey:
//
//   PART COUNT MUST NOT GROW WITH SIZE. Every placement costs its own draw
//   call per part, so a tall building that spends a mesh per window is a
//   building you can only afford six of. A facade's windows are real openings
//   punched into ONE extrude, lit by ONE emissive slab behind the whole face
//   — so a twelve-storey tower costs the same ~16 meshes as a three-storey
//   one, and a street of them is affordable.
//
//   MODULES TILE. Anything meant to stand shoulder-to-shoulder — row units,
//   road tiles — is exactly MODULE metres along its run axis with nothing
//   overhanging that axis, so two of them abut with no seam and no overlap.
//   That is the whole difference between a row of houses and a street.
//
//   RUNS GO ALONG X. Walls, fences and roads are laid by the composer with
//   alongTo(), which rotates a piece's local +x onto the run direction. New
//   run pieces follow the same convention or they lay sideways.
//
// Pure data in, pure data out — no three.js — so this runs under the
// JavaScriptCore tests with the rest of the catalog.

// The grid every tiling piece shares: wall, floor, doorway and door are all
// 6 m, and the maze pitch is 6 m. Roads and row units join that grid.
export const MODULE = 6;

const HPI = Math.PI / 2;
const r2 = (v) => Math.round(v * 1000) / 1000;

/* ── buildings ──
   A shell: plinth, four walls with a real window rhythm, one glow slab per
   face, a roof, and the trim that makes it read as built rather than extruded.

   floors  TOTAL storeys — height and window rows only, never part count
   tiers   stacked masses. Each one is a full shell, so cost scales with
           tiers (keep it small) and NEVER with floors: a 24-storey single
           mass costs exactly what a 2-storey one does, which is the rule
           that makes a district affordable. Setbacks between tiers are what
           turn a cuboid into a skyline.
   setback fraction of the plan each tier above the first gives up
   shift   how far an upper tier slides off centre, 0..1 of its own setback,
           so it can never overhang the mass it stands on
   w, d    footprint in metres (w is the frontage, d the depth)
   bays    window bays across the frontage; the depth faces scale from it
   roof    "flat" (parapet + clutter) · "gable" (ridge along X) · "hip"
   sides   "free" stands alone · "party" is a row unit: flush at ±w/2, blind
           side walls, and no roof overhang across the run, so units abut  */
export function buildingParts({
  floors = 3,
  tiers = 1,
  setback = 0.16,
  shift = 0,
  w = 9,
  d = 9,
  floorH = 3.2,
  bays = 3,
  roof = "flat",
  sides = "free",
  door = true,
  wallColor = 0xb0a89a,
  wallTex = "plaster",
  trimColor = 0x8f959c,
  roofColor = 0x8a5f4e,
  roofTex = "rooftile",
  glow = 0xffb45c,
  glowIntensity = 1.25,
  /* THE COLOUR OF THE LIGHT INSIDE, which is not the colour of the light a
     passer-by sees in the window. `glow` is the second one — a lamp burning
     behind glass at dusk, and warm for that reason. It was doing both jobs,
     so the soffit that lights every furnished ground-floor room was an ORANGE
     panel: measured, every interior in every world came out at hue 31–39
     whatever colour its walls were authored, and the four reference rooms are
     all DAYLIT through windows. A room with openings in it is lit by the sky.
     Default is a neutral daylight; a block with no windows can pass its own. */
  daylight = 0xf2f0ea,
  dayIntensity = 1.55,
  /* HOW GLAZED THIS BUILDING IS, as a multiple of a cottage. A window here
     is points on an outline rather than a mesh, so a big one costs exactly
     what a small one costs — and yet every block in the catalogue was getting
     the same 1.3 × 1.5 m punch-out, because the size was two literals. The
     reference study is most of a wall of glass looking down at the town it
     studies; the houses below it are not. One number says which. */
  glazing = 1,
} = {}) {
  const party = sides === "party";
  const T = 0.34;                     // wall thickness
  const base = 0.34;                  // plinth height
  // A row unit is exactly w wide with nothing proud of the party faces; a
  // free-standing one gets a plinth lip and eaves.
  const lip = party ? 0 : 0.26;
  const parts = [];
  const ports = [];
  // Interior envelopes the composer may furnish. Declared by the block that
  // owns them, filled by whoever places it — the same split as ports.
  const rooms = [];
  let doorDecl = null;

  const nT = Math.max(1, Math.round(tiers));
  const perTier = splitFloors(Math.max(1, Math.round(floors)), nT);

  parts.push({ shape: "box", dims: [w + lip, base, d + lip], pos: [0, base / 2, 0], bevel: 0.03,
    color: trimColor, tex: "concrete" });

  const glowSlab = (dims, pos) => ({
    shape: "box", dims, pos, tex: "none", color: 0x35281c,
    emissive: glow, emissiveIntensity: glowIntensity,
  });

  let y0 = base;          // where the current tier's body starts
  let tw = w, td = d;     // its plan
  let ox = 0, oz = 0;     // and its offset from the building's centre

  for (let k = 0; k < nT; k++) {
    const isTop = k === nT - 1;
    const fl = perTier[k];
    const H = fl * floorH;
    const top = y0 + H;

    if (k > 0) {
      // Shrink, then slide within what the shrink freed — never further, or
      // the tier overhangs the mass it stands on. A row unit keeps its
      // frontage and its centre line, or the terrace breaks the party line.
      const pw = tw, pd = td;
      td = r2(pd * (1 - setback));
      tw = party ? tw : r2(pw * (1 - setback));
      const dir = TIER_SHIFTS[k % TIER_SHIFTS.length];
      ox = party ? ox : r2(ox + dir[0] * shift * (pw - tw) / 2);
      oz = r2(oz + dir[1] * shift * (pd - td) / 2);
    }

    /* ── one face ──
       `len` is the face's length, `n` its bays. Returns the extrudes that
       make up the face — normally ONE, with every window as a hole in it.

       The entrance face is the exception, and it is three: two piers and a
       lintel over them. That is not a cosmetic choice. Collision is one
       axis-aligned box per MESH (props/Props.js), so a doorway punched as a
       hole in a single wall is solid to the player — the box spans the hole.
       Splitting the mesh is the only way the gap is real, and the lintel then
       clears the head because blocked() ducks under anything above it.     */
    const face = (len, n, { entrance = false, peak = 0, blind = false } = {}) => {
      const half = len / 2;
      const outline = peak > 0
        ? [[-half, 0], [half, 0], [half, H], [0, H + peak], [-half, H]]
        : [[-half, 0], [half, 0], [half, H], [-half, H]];
      const holes = [];
      if (!blind) {
        const pitch = len / n;
        /* Scaled, then held off the jambs AND off the eaves. A hole must lie
           strictly inside the outline it is punched into or the triangulator
           emits garbage, and the top storey's sill plus a glazed head is
           exactly where a tall window walks out through the top of the wall:
           the last term is the one that keeps it in. */
        const ww = Math.min(1.3 * glazing, pitch * 0.8);
        const topSill = (fl - 1) * floorH + floorH * 0.34;
        const wh = Math.min(1.5 * glazing, floorH * 0.72, H - topSill - 0.3);
        for (let f = 0; f < fl; f++) {
          const sill = f * floorH + floorH * 0.34;
          for (let i = 0; i < n; i++) {
            const cx = -half + pitch * (i + 0.5);
            // The entrance takes the middle bay of the ground floor.
            if (entrance && f === 0 && n % 2 === 1 && i === (n - 1) / 2) continue;
            holes.push([[cx - ww / 2, sill], [cx + ww / 2, sill],
                        [cx + ww / 2, sill + wh], [cx - ww / 2, sill + wh]]);
          }
        }
      }
      const fix = (o) => o.map(([a, b]) => [r2(a), r2(b)]);
      const split = entrance && half > DOOR_HALF + 0.5 && H > DOOR_HEAD + 0.4;
      if (!split) {
        // No room to split: keep one mesh and punch the opening, which still
        // READS as a doorway even though it will not let anyone through.
        if (entrance) holes.push([[-0.72, 0.04], [0.72, 0.04], [0.72, 2.32], [-0.72, 2.32]]);
        return [{ outline: fix(outline), holes }];
      }
      // A window belongs to whichever piece wholly contains it; one that would
      // straddle the opening is dropped rather than clipped.
      const within = (hole, x0, x1, y0v) => {
        const xs = hole.map(([x]) => x), ys = hole.map(([, y]) => y);
        return Math.min(...xs) > x0 && Math.max(...xs) < x1 && Math.min(...ys) > y0v;
      };
      const pier = (x0, x1) => ({
        outline: fix([[x0, 0], [x1, 0], [x1, H], [x0, H]]),
        holes: holes.filter((h) => within(h, x0, x1, -1)),
      });
      return [
        pier(-half, -DOOR_HALF),
        pier(DOOR_HALF, half),
        { outline: fix([[-DOOR_HALF, DOOR_HEAD], [DOOR_HALF, DOOR_HEAD], [DOOR_HALF, H], [-DOOR_HALF, H]]),
          holes: holes.filter((h) => within(h, -DOOR_HALF, DOOR_HALF, DOOR_HEAD)) },
      ];
    };

    // Gable ends sit on the ±X faces, so the ridge runs along X and a terrace
    // of row units carries one continuous roofline. Only the top tier is
    // roofed, so only it can be gabled.
    const gable = roof === "gable" && isTop;
    const rise = gable ? Math.min(tw, td) * 0.24 : 0;
    const sideBays = Math.max(1, Math.round(bays * (td / tw)));
    const entrance = door && k === 0;
    // A way in means a room behind it. Only the ground floor of the bottom
    // tier: everything above stays a shell, because nothing can reach it.
    const room = entrance;

    const wallOf = (o, pos, rotY = 0) => ({
      shape: "extrude", depth: T, pos, rotY, color: wallColor, tex: wallTex,
      outline: o.outline, holes: o.holes,
    });
    const pushFace = (pieces, pos, rotY = 0) => { for (const f of pieces) parts.push(wallOf(f, pos, rotY)); };
    pushFace(face(tw, bays, { entrance }), [ox, y0, r2(oz + td / 2 - T / 2)]);
    pushFace(face(tw, bays), [ox, y0, r2(oz - (td / 2 - T / 2))]);
    pushFace(face(td, sideBays, { peak: rise, blind: party }), [r2(ox + tw / 2 - T / 2), y0, oz], HPI);
    pushFace(face(td, sideBays, { peak: rise, blind: party }), [r2(ox - (tw / 2 - T / 2)), y0, oz], HPI);

    /* ── the lit interior ──
       ONE slab per face rather than a pane per window. The openings are real
       holes through 0.34 m of wall, so from outside each reads as its own lit
       window; the saving is the whole reason a tall building stays cheap. */
    const inset = T + 0.06;
    const frontZ = r2(oz + td / 2 - inset);
    /* The slab sits 3 cm behind the wall's inner face — it is the wall's own
       lit skin, not a panel standing in the room. So the back and side ones
       ARE the room's warm walls and stay full height: lifting them was what
       turned a street-level window from lit into a dark hole.

       Only the FRONT one moves. It is the one you look through from outside
       and the one the door opens onto, so above a room it starts at that
       room's ceiling and the room itself shows through. Where there is no
       headroom to lift into, it keeps the notch around the doorway instead. */
    const gTop = r2(H - 0.15);
    const fBot = r2(room && H - floorH > 0.6 ? floorH : 0.15);
    const fh = r2(gTop - fBot);
    const notch = entrance && fBot < DOOR_HEAD && (tw - T * 2) / 2 > DOOR_HALF + 0.6 && gTop > DOOR_HEAD + 0.2;
    if (notch) {
      const hw = r2((tw - T * 2) / 2);
      parts.push({ shape: "extrude", depth: 0.06, pos: [ox, y0, frontZ],
        tex: "none", color: 0x35281c, emissive: glow, emissiveIntensity: glowIntensity,
        outline: [[-hw, fBot], [-DOOR_HALF, fBot], [-DOOR_HALF, DOOR_HEAD], [DOOR_HALF, DOOR_HEAD],
                  [DOOR_HALF, fBot], [hw, fBot], [hw, gTop], [-hw, gTop]] });
    } else {
      parts.push(glowSlab([r2(tw - T * 2), fh, 0.06], [ox, r2(y0 + (fBot + gTop) / 2), frontZ]));
    }
    const bh = r2(gTop - 0.15), by = r2(y0 + (0.15 + gTop) / 2);
    parts.push(glowSlab([r2(tw - T * 2), bh, 0.06], [ox, by, r2(oz - (td / 2 - inset))]));
    if (!party) {
      parts.push(glowSlab([0.06, bh, r2(td - T * 2)], [r2(ox + tw / 2 - inset), by, oz]));
      parts.push(glowSlab([0.06, bh, r2(td - T * 2)], [r2(ox - (tw / 2 - inset)), by, oz]));
    }

    /* ── the room's own light ──
       A soffit under the ground-floor ceiling. Emissive, so Props marks it
       noCollide and it can never be the thing you walk into; it lights the
       room from inside AND is what a passer-by sees through a street-level
       window, which is the job the slab used to fake at this level. */
    const soffit = (ceilY) => parts.push({
      shape: "box", dims: [r2(tw - T * 2 - 0.5), 0.08, r2(td - T * 2 - 0.5)],
      pos: [ox, r2(ceilY - 0.26), oz], tex: "none", color: 0x2a2118,
      emissive: daylight, emissiveIntensity: r2(dayIntensity * 0.75) });
    const envelope = (level, at, floorY) => rooms.push({
      level, at, y: r2(floorY), h: r2(floorH), x: ox, z: oz,
      w: r2(tw - T * 2), d: r2(td - T * 2) });

    if (room) { soffit(y0 + floorH); envelope(k, "ground", y0); }
    // The head room, unless this tier is one storey tall and that storey is
    // already the ground room — then they are the same floor, declared once.
    if (!(room && fl === 1)) { soffit(top); envelope(k, "head", top - floorH); }

    /* ── the entrance ──
       The leaf hangs off a pivot (proc.door), so E swings it and the blocker
       it contributes drops out while it is open — the same machinery the
       catalog's `door` block uses. Without the declaration the leaf is just a
       board bolted across the opening, which is what it used to be. */
    if (entrance) {
      const leafZ = r2(oz + td / 2 - 0.06);
      doorDecl = { hinge: [r2(ox - 0.72), r2(y0), leafZ], swing: 1.9 };
      parts.push({ shape: "box", dims: [1.44, 2.26, 0.09], pos: [ox, r2(y0 + 1.13), leafZ],
        color: 0x6f5236, tex: "board", door: true });
      parts.push({ shape: "box", dims: [2.0, 0.12, 0.72], pos: [ox, r2(y0 + 0.06), r2(oz + td / 2 + 0.14)],
        bevel: 0.02, color: trimColor, tex: "concrete" });
      ports.push({ kind: "door", pos: [ox, r2(y0), r2(oz + td / 2 + 0.5)], normal: [0, 1], width: 1.4 });
    }

    // Trim: a band at the ground-floor line (bottom tier only — the window
    // rhythm already reads the floors) and a cornice under every tier's head.
    // Both stand proud of the facade, which a row unit may only do on the
    // faces that stay open: a cornice that oversails the party line by even
    // 12 cm makes two abutting units interpenetrate instead of meeting.
    if (k === 0) {
      parts.push({ shape: "box", dims: [r2(tw + (party ? 0 : 0.1)), 0.16, r2(td + 0.1)],
        pos: [ox, r2(y0 + floorH), oz], color: trimColor, tex: "concrete", grime: false });
    }
    parts.push({ shape: "box", dims: [r2(tw + (party ? 0 : 0.24)), 0.22, r2(td + 0.24)],
      pos: [ox, r2(top - 0.11), oz], bevel: 0.03, color: trimColor, tex: "concrete", grime: false });

    if (isTop) {
      pushRoof(parts, { roof, gable, rise, tw, td, top, party, trimColor, roofColor, roofTex, ox, oz });
      // A roof landing: how many walkways may terminate up here scales with
      // the deck, not with the building's height.
      ports.push({ kind: "roof", pos: [ox, r2(top + 0.2), oz], normal: [0, 1],
        capacity: Math.max(1, Math.round((tw * td) / 40)) });
    } else {
      // The setback leaves a terrace. It is a real deck you can stand on, and
      // it is exactly where a walkway between towers wants to land.
      parts.push({ shape: "box", dims: [r2(tw - 0.3), 0.14, r2(td - 0.3)], pos: [ox, r2(top + 0.07), oz],
        color: 0x6f7378, tex: "concrete", grime: false });
    }

    /* One walkway port per SETBACK TERRACE, on the open faces, looking out.
       `level` is the tier index, so a matcher can prefer links that stay on
       one storey.

       Not on the top tier, and that exclusion is the whole rule rather than
       an optimisation: the top of a mass is its ROOF — pitched, on a cottage —
       and a deck arriving there is a bridge onto a gable. Every mass used to
       offer one, which meant two abutting terraced houses in a street grid
       could be joined by a footbridge over their own party wall, and meant
       the matcher was scoring a quarter of a million pairs it could never
       legally use. A terrace exists exactly where a tier is set back from the
       one above it, which is exactly where this now emits. */
    if (!isTop) {
      for (const [nx, nz] of party ? [[0, 1], [0, -1]] : [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const ex = nx === 0 ? ox : r2(ox + nx * (tw / 2 + 0.3));
        const ez = nz === 0 ? oz : r2(oz + nz * (td / 2 + 0.3));
        ports.push({ kind: "walkway", pos: [ex, r2(top + 0.2), ez], normal: [nx, nz], width: 2.0, level: k });
      }
    }

    y0 = top;
  }

  // A service spine down one flank. One port, not one per storey.
  ports.push({ kind: "pipe", pos: [r2(-(w / 2 + 0.3)), r2(base + floorH), 0], normal: [-1, 0], radius: 0.25 });

  const spec = { grime: 1.3, parts, ports };
  if (doorDecl) spec.door = doorDecl;
  if (rooms.length) spec.rooms = rooms;
  // Stated, not inferred: interiors.js needs the storey count to choose a
  // stair or a shaft, and measuring it off the tallest part counts the roof.
  spec.storeys = Math.max(1, Math.round(floors));
  return spec;
}

// The doorway, shared by the wall opening, the leaf and the glow notch — the
// three have to agree or the door stops lining up with the hole it fills.
const DOOR_HALF = 0.8;   // half-width of the notch, a little wider than the leaf
const DOOR_HEAD = 2.4;   // its head, just above the 2.32 m opening

// Which way each tier slides when `shift` is on. Deterministic by index —
// no rng in here, because the same numbers must give the same building.
const TIER_SHIFTS = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]];

// Split total storeys across tiers, remainder into the podium so the base
// mass is the tallest — which is what makes a setback read as a setback.
function splitFloors(total, n) {
  const each = Math.max(1, Math.floor(total / n));
  const out = new Array(n).fill(each);
  out[0] += Math.max(0, total - each * n);
  return out;
}

function pushRoof(parts, { roof, gable, rise, tw, td, top, party, trimColor, roofColor, roofTex, ox, oz }) {
  if (gable) {
    const hd = td / 2;
    const ang = Math.atan2(rise, hd);
    const slope = Math.hypot(hd, rise) + 0.34;   // + the eave
    const wide = party ? tw : tw + 0.5;          // a row unit may not overhang
    for (const s of [1, -1]) {
      // Sign matters and is easy to get backwards: a slab on the +z side must
      // fall AWAY from the ridge, and local +z maps to (0, -sin θ, cos θ), so
      // that needs a positive rotX. Negate it and the roof becomes a valley.
      parts.push({ shape: "box", dims: [r2(wide), 0.17, r2(slope)],
        pos: [ox, r2(top + rise / 2 - 0.04), r2(oz + (s * hd) / 2)], rotX: r2(s * ang),
        color: roofColor, tex: roofTex, grime: false });
    }
    parts.push({ shape: "cylinder", dims: [0.1, r2(wide)], pos: [ox, r2(top + rise + 0.03), oz], rotZ: HPI,
      color: roofColor, tex: roofTex, grime: false });
  } else if (roof === "hip") {
    // A four-sided cone IS a pyramid — one mesh for a whole hipped roof. Its
    // corners sit at 45°, so this only lands on the building's own corners
    // when the footprint is square; keep w and d close or it overhangs the
    // short axis. Turned an eighth so the FACES front the walls.
    const rr = r2(Math.hypot(tw, td) / 2 + 0.2);
    parts.push({ shape: "cone", dims: [rr, r2(Math.min(tw, td) * 0.3), 4], rotY: r2(Math.PI / 4),
      pos: [ox, r2(top + Math.min(tw, td) * 0.15), oz], color: roofColor, tex: roofTex, grime: false });
  } else {
    // Flat roof: the parapet is an extrude with a hole — a ring in one mesh,
    // where four boxes would be four. Laid flat by rotX, so its own extrusion
    // axis becomes the world's up.
    const a = r2(tw / 2 + (party ? 0 : 0.12)), b = r2(td / 2 + 0.12);
    const ia = r2(a - 0.34), ib = r2(b - 0.34);
    parts.push({ shape: "extrude", depth: 0.62, rotX: r2(-HPI), pos: [ox, r2(top + 0.31), oz],
      color: trimColor, tex: "concrete", grime: false,
      outline: [[-a, -b], [a, -b], [a, b], [-a, b]],
      holes: [[[-ia, -ib], [-ia, ib], [ia, ib], [ia, -ib]]] });
    parts.push({ shape: "box", dims: [r2(tw - 0.3), 0.14, r2(td - 0.3)], pos: [ox, r2(top + 0.07), oz],
      color: 0x6f7378, tex: "concrete", grime: false });
    // Roof clutter. The default camera looks DOWN at the world, so from the
    // framing orbit these read as more of the city than any facade does.
    parts.push({ shape: "box", dims: [1.5, 0.85, 1.2], pos: [r2(ox + tw * 0.22), r2(top + 0.56), r2(oz - td * 0.2)],
      bevel: 0.03, color: 0x9aa0a8, tex: "metal", metalness: 0.5, roughness: 0.55, grime: false });
    parts.push({ shape: "cylinder", dims: [0.62, 1.1], seg: 14, pos: [r2(ox - tw * 0.24), r2(top + 0.69), r2(oz + td * 0.18)],
      color: 0x8d9299, tex: "metal", metalness: 0.55, roughness: 0.5, grime: false });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CASTLES — the one emitter the worlds are recognised by.

   A world grammar is mostly geography, but the thing a person names when they
   look at the picture is the LANDMARK, and three of the four worlds are
   organised around a castle. They are not three models. They are three sets of
   numbers through this function: a slender thing with a forest of blue spires,
   a squat symmetrical one with red cones, and a black-shouldered citadel with
   a curtain wall round it — same code, same parts vocabulary, same materials.

   THE PART BUDGET IS DELIBERATELY BROKEN HERE, and only here. Everything else
   in this file obeys "part count must not grow with size", because there are
   two hundred of everything else. There is ONE castle in a world. Fifty
   meshes for the thing the whole map points at is the correct trade, and it is
   the only placement in the engine that gets it.

   ROOFS COME IN TWO MATERIALS and that is what makes the emitter reusable:
   spires and cones are `shingle`, the keep's own roof and any lower range is
   `rooftile`. A theme (engine/props/themes.js) colours those two roles
   separately, so one castle is blue-over-indigo and another is red-over-
   terracotta with no geometry difference at all.
   ══════════════════════════════════════════════════════════════════════════ */
export function castleParts({
  w = 26, d = 22,              // the keep's plan, metres
  floors = 5,
  floorH = 4.6,
  bays = 4,
  plinth = 1.4,
  terraces = 1,                // stepped aprons under the plinth
  terraceStep = 3.4,           // how far each apron stands proud, per side
  towers = 4,                  // towers standing at the keep's corners
  towerR = 3.2,
  towerTop = 1.3,              // tower head height, × the keep's own top
  spire = 2.9,                 // cone height, × towerR (0 = flat-capped)
  spireSeg = 12,
  centre = 1.85,               // the middle spire, × the keep's top (0 = none)
  centreR = 4.4,
  hall = true,                 // declare a ground-floor room, so it furnishes
  curtain = null,              // { r, h, towers, gate } — the outer ring
  wallColor = 0xb4aea0,
  wallTex = "stone",
  trimColor = 0x9aa0a8,
  roofColor = 0x6f4a4a,
  roofTex = "shingle",
  rangeRoofTex = "rooftile",
  glow = 0xffc678,
  glowIntensity = 1.3,
  // The hall's own light, and it is DAYLIGHT — see buildingParts. The
  // reference throne hall is a room the sun performs in; lighting it with the
  // same amber the windows show the street was most of why every interior in
  // every world rendered the same yellow whatever its stone was authored.
  daylight = 0xeef2f8,
  dayIntensity = 1.9,
  finial = 0xb8a25f,
} = {}) {
  const parts = [];
  const rooms = [];
  const T = 0.5;                              // wall thickness
  const H = Math.max(1, Math.round(floors)) * floorH;
  let y = 0;

  /* The aprons. A castle standing straight on the turf reads as a model on a
     table; two steps of masonry under it is what says the ground was cut for
     it. They are also where the composer's stairs land. */
  for (let k = terraces; k > 0; k--) {
    const grow = terraceStep * k;
    const th = k === terraces ? 1.6 : 1.2;
    parts.push({ shape: "box", dims: [r2(w + grow * 2), th, r2(d + grow * 2)],
      pos: [0, r2(y + th / 2), 0], bevel: 0.05, color: trimColor, tex: "concrete" });
    y = r2(y + th);
  }
  parts.push({ shape: "box", dims: [r2(w + 0.9), plinth, r2(d + 0.9)],
    pos: [0, r2(y + plinth / 2), 0], bevel: 0.05, color: trimColor, tex: "concrete" });
  const body = r2(y + plinth);
  const top = r2(body + H);

  /* ── the keep ──
     Four faces, windows punched as holes in one extrude each, and a tall
     arched opening in the front — the same discipline buildingParts uses, so
     a castle costs what a tower block costs per face rather than per window. */
  const lancet = (half, hgt, n, rows) => {
    const holes = [];
    const pitch = (half * 2) / n;
    const ww = Math.min(1.5, pitch * 0.3);
    for (let f = 0; f < rows; f++) {
      const sill = plinth * 0.4 + f * floorH + floorH * 0.3;
      if (sill + 2.2 > hgt) break;
      for (let i = 0; i < n; i++) {
        const cx = -half + pitch * (i + 0.5);
        /* A LANCET HAS A HEAD ON IT. These were rectangles — the one thing a
           castle window is not — while `arcPts`, four lines below, sat there
           serving the great door and nothing else. A hole is points on an
           outline, so an arched head costs five points and no mesh, and it
           is most of what the reference halls read as from inside: the
           windows are the only vertical the eye follows all the way up.
           Wound the same way as the rectangle it replaces (up one jamb, over
           the head, down the other) — reversed, a hole is a bow-tie. */
        const springs = sill + 2.0 - ww / 2;
        holes.push([
          [r2(cx - ww / 2), r2(sill)], [r2(cx + ww / 2), r2(sill)],
          [r2(cx + ww / 2), r2(springs)],
          ...arcPts(cx, springs, ww / 2, 0, Math.PI, 5),
          [r2(cx - ww / 2), r2(springs)],
        ]);
      }
    }
    return holes;
  };
  /* The great door: a round-headed arch, and the arithmetic that keeps it from
     colliding with the window rhythm. A hole punched into an extrude must be a
     simple closed loop that no other hole touches, or the triangulator emits
     garbage — so the lancets whose bay the arch stands in are DROPPED rather
     than clipped, exactly as buildingParts drops the window that would straddle
     its own doorway. The point order matches the catalogue's `doorway`
     (up one jamb, over the head, down the other): reversed, it is a bow-tie. */
  const ARCH_W = 2.1, ARCH_SPRING = 3.4;
  const ARCH_TOP = ARCH_SPRING + ARCH_W;
  const face = (len, n, pos, rotY, { entrance = false } = {}) => {
    const half = len / 2;
    let holes = lancet(half, H, n, floors);
    if (entrance && H > ARCH_TOP + 1) {
      holes = holes.filter((hl) => {
        const b = { x0: Math.min(...hl.map(([x]) => x)), x1: Math.max(...hl.map(([x]) => x)),
                    y0: Math.min(...hl.map(([, y]) => y)) };
        return b.x0 > ARCH_W + 0.5 || b.x1 < -(ARCH_W + 0.5) || b.y0 > ARCH_TOP + 0.5;
      });
      holes.push([[ARCH_W, 0.05], ...arcPts(0, ARCH_SPRING, ARCH_W, 0, Math.PI, 10), [-ARCH_W, 0.05]]);
    }
    parts.push({ shape: "extrude", depth: T, pos, rotY, color: wallColor, tex: wallTex,
      outline: [[r2(-half), 0], [r2(half), 0], [r2(half), r2(H)], [r2(-half), r2(H)]], holes });
  };
  face(w, bays, [0, body, r2(d / 2 - T / 2)], 0, { entrance: true });
  face(w, bays, [0, body, r2(-(d / 2 - T / 2))], 0);
  face(d, Math.max(2, Math.round(bays * (d / w))), [r2(w / 2 - T / 2), body, 0], HPI);
  face(d, Math.max(2, Math.round(bays * (d / w))), [r2(-(w / 2 - T / 2)), body, 0], HPI);

  // One lit slab per long face, exactly as a block gets: the openings are real
  // holes through half a metre of stone, so each reads as its own lit window.
  for (const s of [1, -1]) {
    parts.push({ shape: "box", dims: [r2(w - T * 2), r2(H - 0.6), 0.06],
      pos: [0, r2(body + H / 2), r2(s * (d / 2 - T - 0.06))],
      tex: "none", color: 0x2e2418, emissive: glow, emissiveIntensity: glowIntensity });
  }

  // A machicolated head, then the keep's own roof — the low mass the spires
  // rise out of. Wearing `rooftile`, so a theme can part it from the spires.
  parts.push({ shape: "box", dims: [r2(w + 1.5), 0.9, r2(d + 1.5)], pos: [0, r2(top - 0.45), 0],
    bevel: 0.06, color: trimColor, tex: "concrete", grime: false });
  parts.push({ shape: "cone", dims: [r2(Math.hypot(w, d) / 2 + 0.3), r2(Math.min(w, d) * 0.34), 4],
    rotY: r2(Math.PI / 4), pos: [0, r2(top + Math.min(w, d) * 0.17), 0],
    color: roofColor, tex: rangeRoofTex, grime: false });

  /* ── the towers ──
     Four on the corners, or a ring of them for a many-spired silhouette. Each
     is four meshes and no more: shaft, corbel, cone, finial. Reach is what
     makes a fairytale castle read at two kilometres — the tallest thing in the
     world has to be a needle, not a box. */
  const ring = Math.max(0, Math.round(towers));
  const corner = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const towerAt = (tx, tz, rr, headMul, spireMul) => {
    const head = r2(body + H * headMul);
    parts.push({ shape: "cylinder", dims: [r2(rr), r2(head - y)], rTop: r2(rr * 0.9), seg: 14,
      pos: [r2(tx), r2(y + (head - y) / 2), r2(tz)], color: wallColor, tex: wallTex });
    parts.push({ shape: "lathe", seg: 14, pos: [r2(tx), head, r2(tz)], color: trimColor, tex: "concrete",
      profile: [[r2(rr * 0.9), 0], [r2(rr * 1.22), r2(rr * 0.32)], [r2(rr * 1.26), r2(rr * 0.5)]],
      grime: false });
    if (spireMul > 0) {
      const sh = r2(rr * spireMul);
      parts.push({ shape: "cone", dims: [r2(rr * 1.3), sh, spireSeg],
        pos: [r2(tx), r2(head + rr * 0.5 + sh / 2), r2(tz)],
        color: roofColor, tex: roofTex, grime: false });
      if (finial) {
        parts.push({ shape: "sphere", dims: [r2(Math.max(0.22, rr * 0.16))],
          pos: [r2(tx), r2(head + rr * 0.5 + sh + rr * 0.14), r2(tz)],
          color: finial, tex: "none", metalness: 0.8, roughness: 0.32, grime: false });
      }
    }
  };
  for (let i = 0; i < ring; i++) {
    let tx, tz, rr = towerR, hm = towerTop, sm = spire;
    if (ring <= 4) {
      const [sx, sz] = corner[i % 4];
      tx = sx * (w / 2 - towerR * 0.35); tz = sz * (d / 2 - towerR * 0.35);
    } else {
      // Beyond four, the towers ring the keep and alternate in height, which
      // is what turns a silhouette from a comb into a skyline.
      const a = (i / ring) * TAU_ + Math.PI / ring;
      tx = Math.cos(a) * (w / 2 + towerR * 0.15);
      tz = Math.sin(a) * (d / 2 + towerR * 0.15);
      const odd = i % 2 === 1;
      rr = towerR * (odd ? 0.76 : 1);
      hm = towerTop * (odd ? 0.82 : 1);
      sm = spire * (odd ? 1.15 : 1);
    }
    towerAt(tx, tz, rr, hm, sm);
  }
  if (centre > 0) towerAt(0, 0, centreR, centre, spire * 1.25);

  /* ── the curtain ──
     One crenellated ring, drum towers on its corners, and a gatehouse on the
     front. The ring is a single extrude laid flat with a hole in it — the same
     trick a parapet uses — so an enclosure the size of a village costs two
     meshes rather than sixty. */
  if (curtain) {
    const cr = curtain.r ?? Math.max(w, d) * 1.5;
    const ch = curtain.h ?? 7;
    const th = curtain.thickness ?? 1.6;
    const gap = curtain.gate === false ? 0 : (curtain.gateWidth ?? 9);
    parts.push({ shape: "extrude", depth: r2(ch), rotX: r2(-HPI), pos: [0, r2(ch / 2), 0],
      color: wallColor, tex: wallTex,
      outline: ringOutline(cr, gap, 26),
      holes: [ringOutline(cr - th, gap, 26).reverse()] });
    parts.push({ shape: "extrude", depth: 0.7, rotX: r2(-HPI), pos: [0, r2(ch + 0.35), 0],
      color: trimColor, tex: "concrete", grime: false,
      outline: ringOutline(cr + 0.35, gap, 26),
      holes: [ringOutline(cr - th - 0.35, gap, 26).reverse()] });
    const ct = Math.max(0, Math.round(curtain.towers ?? 4));
    for (let i = 0; i < ct; i++) {
      const a = (i / ct) * TAU_ + Math.PI / 2 + Math.PI / ct;
      const rr = curtain.towerR ?? th * 2.1;
      const hh = r2(ch * 1.5);
      parts.push({ shape: "cylinder", dims: [r2(rr), hh], seg: 12,
        pos: [r2(Math.cos(a) * cr), r2(hh / 2), r2(Math.sin(a) * cr)], color: wallColor, tex: wallTex });
      parts.push({ shape: "cone", dims: [r2(rr * 1.24), r2(rr * 2.1), 10],
        pos: [r2(Math.cos(a) * cr), r2(hh + rr * 1.05), r2(Math.sin(a) * cr)],
        color: roofColor, tex: roofTex, grime: false });
    }
    if (gap > 0) {
      // The gatehouse straddles the gap the ring left on the +z side.
      for (const s of [1, -1]) {
        parts.push({ shape: "box", dims: [r2(th * 2.4), r2(ch * 1.45), r2(th * 2.6)],
          pos: [r2(s * (gap / 2 + th * 1.1)), r2(ch * 0.725), r2(cr)],
          bevel: 0.05, color: wallColor, tex: wallTex });
      }
      parts.push({ shape: "box", dims: [r2(gap + th * 2), r2(ch * 0.5), r2(th * 2.6)],
        pos: [0, r2(ch * 1.2), r2(cr)], bevel: 0.05, color: trimColor, tex: "concrete", grime: false });
    }
  }

  if (hall) {
    /* A SOFFIT OVER THE HALL, which the keep has never had. buildingParts
       gives one to every furnished ground room it declares; the keep declared
       a room and lit it with nothing but the amber slabs its outward-facing
       windows wear, so the one interior the whole world is an argument for was
       the dimmest and the yellowest room in the catalogue. */
    const hallH = Math.min(floorH * 1.7, floors * floorH * 0.55, 9);
    parts.push({
      shape: "box", dims: [r2(Math.min(w - T * 2, w * 0.84, 22) - 1.2), 0.1,
                           r2(Math.min(d - T * 2, d * 0.84, 19) - 1.2)],
      pos: [0, r2(body + hallH - 0.3), 0], tex: "none", color: 0x2a2620,
      emissive: daylight, emissiveIntensity: r2(dayIntensity * 0.8) });
    /* THE HALL IS THE SIZE OF THE KEEP IT IS IN.
       This was a flat 16 × 14 × 4.2 with the caps below the smallest keep in
       the catalogue, so every castle in every world declared the identical
       room — a twenty-four-metre spired keep and a thirty-metre pavilion had
       the same interior, four metres to the ceiling, inside masses rising to
       seventy-nine and forty-nine metres. Two castle worlds whose plates are
       set side by side furnished the same box.

       So the plan follows the footprint and the ceiling follows the storey.
       A great hall is a storey and a half by construction — it is the room a
       keep spends its height on — and the caps stay only to keep the volume
       inside the mass on a block nobody has proportioned yet. */
    const hallW = Math.min(w - T * 2, w * 0.84, 22);
    const hallD = Math.min(d - T * 2, d * 0.84, 19);
    rooms.push({ level: 0, at: "ground", y: r2(body), h: r2(hallH),
      x: 0, z: 0, w: r2(hallW), d: r2(hallD) });
  }

  const spec = { grime: 1.4, parts, storeys: Math.max(1, Math.round(floors)) };
  if (rooms.length) spec.rooms = rooms;
  return spec;
}

const TAU_ = Math.PI * 2;

// Points on a circle, optionally leaving a gap centred on +z (the approach).
function ringOutline(r, gap = 0, seg = 26) {
  const pts = [];
  const half = gap > 0 ? Math.asin(Math.min(1, gap / 2 / Math.max(r, 0.1))) : 0;
  const a0 = HPI + half, a1 = HPI + TAU_ - half;
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pts.push([r2(Math.cos(a) * r), r2(Math.sin(a) * r)]);
  }
  return pts;
}

// Arc points for a lancet/arch hole. Local to this module so castleParts does
// not have to reach into the catalogue's own helper.
function arcPts(cx, cy, r, a0, a1, n) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [r2(cx + Math.cos(a) * r), r2(cy + Math.sin(a) * r)];
  });
}

/* ── curtain wall, as a run piece ──
   Six metres of crenellated wall that abuts its neighbour, for the enclosures
   the composer lays by hand rather than the ring a castle carries.

   THE CRENELLATIONS ARE ONE MESH. The merlon band is an extrude whose OUTLINE
   is the battlement profile, so teeth cost points rather than boxes — which is
   the difference between a wall you can run sixty metres of and one you can
   afford eight tiles of. Half a gap at each end, so two modules meeting make
   one whole gap and the run reads as continuous.

   `ruin` steps the top down and drops teeth, which is a broken wall rather
   than a wall with a texture on it.                                        */
export function curtainWallParts({
  h = 5.2, thickness = 1.1, merlons = 3, merlonH = 1.1,
  color = 0x9aa0a8, tex = "stone", ruin = 0, seed = 3,
} = {}) {
  const half = MODULE / 2;
  const pitch = MODULE / merlons;
  const mw = pitch * 0.6;
  const H0 = r2(h);
  const pts = [[r2(-half), 0], [r2(half), 0]];
  // A tiny deterministic stream: a broken wall must break the same way every
  // time it is placed, or two copies of the same block disagree.
  let s = (seed * 2654435761) >>> 0;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const drop = ruin > 0 ? ruin : 0;
  const topAt = (t) => (drop ? r2(H0 * (1 - drop * (0.25 + 0.55 * next()))) : H0);
  const rightTop = topAt(1);
  pts.push([r2(half), rightTop]);
  for (let k = merlons - 1; k >= 0; k--) {
    const xa = r2(-half + k * pitch + (pitch - mw) / 2);
    const xb = r2(xa + mw);
    const base = drop ? r2(Math.min(rightTop, H0 * (1 - drop * (0.2 + 0.5 * next())))) : H0;
    const gone = drop && next() < drop * 0.7;
    pts.push([xb, base]);
    if (!gone) pts.push([xb, r2(base + merlonH)], [xa, r2(base + merlonH)]);
    pts.push([xa, base]);
  }
  pts.push([r2(-half), rightTop]);
  return { grime: ruin ? 2.2 : 1.1, parts: [
    { shape: "extrude", depth: r2(thickness), pos: [0, 0, 0], color, tex, outline: pts },
    { shape: "box", dims: [MODULE, 0.34, r2(thickness + 0.5)], pos: [0, 0.17, 0], bevel: 0.03,
      color, tex: "concrete" },
  ] };
}

/* ── surfaced ways ──
   Not every world has streets. A dirt track through a coastal village, a
   ceremonial avenue two hundred metres wide at the eye, and the old roads of a
   kingdom nobody maintains are the same piece with different numbers: one slab
   on the 6 m module, optional verges, optional centre inlay.

   The street pack's `road` is a modern carriageway — asphalt, kerbs, painted
   centre line — and using it for a country lane is the single fastest way to
   make a fairytale kingdom look like a business park.                     */
export function pathParts({
  width = 4.4, color = 0xa8916a, tex = "concrete", roughness = 0.98,
  rise = 0.1, verge = 0, vergeColor = 0x8f8a72, vergeTex = "concrete",
  inlay = 0, inlayColor = 0xc8c2ae,
} = {}) {
  const parts = [
    { shape: "box", dims: [MODULE, rise, r2(width)], pos: [0, r2(rise / 2), 0], color, tex, roughness },
  ];
  if (verge > 0) {
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [MODULE, r2(rise * 1.9), r2(verge)],
        pos: [0, r2(rise * 0.95), r2(s * (width / 2 + verge / 2))], bevel: 0.02,
        color: vergeColor, tex: vergeTex, grime: false });
    }
  }
  if (inlay > 0) {
    parts.push({ shape: "box", dims: [MODULE, 0.03, r2(inlay)], pos: [0, r2(rise + 0.015), 0],
      color: inlayColor, tex, roughness: 0.9, grime: false });
  }
  return { grime: 0.3, parts };
}

/* ── the field study ──
   The research building a starting town is organised under: a wide white
   two-storey hall with a red roof, a porch on columns, and an instrument
   drum on the ridge. The drum is the whole identity — a house says someone
   lives here, a drum on the roof says someone is LOOKING at something, and
   at village distance it is the only difference the eye can read. Built on
   buildingParts so it keeps the window/room/door machinery (the interior is
   this block's second job), with the porch and drum appended as parts. */
export function studyParts() {
  const spec = buildingParts({
    floors: 2, w: 18, d: 10.5, bays: 5, roof: "gable", floorH: 3.5,
    // The one block in the catalogue whose whole purpose is the view out of
    // it: the reference interior is composed on the town and the sea seen
    // through this wall, and it cannot be if the wall is cottage windows.
    glazing: 1.75,
    /* Authored just under the theme's ceiling rather than at white. The
       village and the study share one `plaster` tint, tuned to lift the
       cottages' mid-grey render to white — and at 1.66 an already-near-white
       wall goes over on all three channels, so the study rendered as a flat
       cut-out with no lit face and no shaded one. It is the same white in
       frame; it can now be lit. */
    wallColor: 0xc6c0b2, wallTex: "plaster", trimColor: 0xd9d2c2,
    roofColor: 0xa63a30, roofTex: "rooftile",
  });
  const top = 0.34 + 2 * 3.5;                  // plinth + two storeys
  const ridge = top + 10.5 * 0.24;             // over the gable line
  // The drum: one cylinder and a domed cap, sat astride the ridge. Blue on
  // purpose — the town's roofs are blue and the study's own roof is red, so
  // the drum ties the building to the town it studies rather than to itself.
  spec.parts.push(
    { shape: "cylinder", dims: [2.1, 2.3], seg: 18, pos: [r2(-18 * 0.22), r2(ridge + 0.7), 0],
      color: 0x3e5eb8, tex: "paint", grime: false },
    { shape: "sphere", dims: [2.06], pos: [r2(-18 * 0.22), r2(ridge + 1.9), 0],
      color: 0xe8e4d8, tex: "paint", grime: false },
  );
  // The porch: a slab on two columns over the door, and a step below it.
  spec.parts.push(
    { shape: "box", dims: [5.4, 0.34, 2.6], pos: [0, r2(0.34 + 3.1), r2(10.5 / 2 + 1.15)],
      bevel: 0.03, color: 0xd9d2c2, tex: "concrete", grime: false },
    { shape: "cylinder", dims: [0.24, 3.1], seg: 10, pos: [-2.2, r2(0.34 + 1.55), r2(10.5 / 2 + 1.9)],
      color: 0xe6e0d2, tex: "plaster" },
    { shape: "cylinder", dims: [0.24, 3.1], seg: 10, pos: [2.2, r2(0.34 + 1.55), r2(10.5 / 2 + 1.9)],
      color: 0xe6e0d2, tex: "plaster" },
    { shape: "box", dims: [6.2, 0.3, 3.4], pos: [0, 0.15, r2(10.5 / 2 + 1.4)],
      bevel: 0.03, color: 0xcfc7b4, tex: "concrete" },
  );
  return spec;
}

/* ── a timber jetty ──
   A run piece that stands in water rather than on ground. The composer seats
   it at the waterline and the piles reach down past it; anything buried is
   hidden by the sea it is buried in. */
export function jettyParts({ width = 2.6, deck = 0.16, drop = 4.2 } = {}) {
  const parts = [
    { shape: "box", dims: [MODULE, deck, r2(width)], pos: [0, 0, 0], bevel: 0.02,
      color: 0x8f6d48, tex: "wood", grime: false },
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ shape: "cylinder", dims: [0.17, r2(drop)], seg: 8,
        pos: [r2(sx * (MODULE / 2 - 0.6)), r2(-drop / 2), r2(sz * (width / 2 - 0.3))],
        color: 0x6f5138, tex: "board" });
    }
  }
  return { grime: 1.6, parts };
}

/* ── a worked plot ──
   Crops, on the same module as everything else. Four rows and a soil bed: at
   the distance these are read from, the ROWS are the whole signal — a green
   rectangle says lawn, a striped one says somebody farms here. */
export function cropParts({ rows = 4, len = MODULE, wide = 4.6, leaf = 0x6f9450 } = {}) {
  const parts = [
    { shape: "box", dims: [r2(len), 0.16, r2(wide)], pos: [0, 0.08, 0], color: 0x6b5236, tex: "concrete",
      roughness: 1 },
  ];
  const pitch = wide / rows;
  for (let i = 0; i < rows; i++) {
    parts.push({ shape: "box", dims: [r2(len - 0.5), 0.42, r2(pitch * 0.5)], bevel: 0.08,
      pos: [0, 0.37, r2(-wide / 2 + pitch * (i + 0.5))], color: leaf, tex: "foliage", roughness: 0.96 });
  }
  return { grime: 0.2, parts };
}

/* A fountain: the one ornament the parade world is allowed, standing where a
   symmetrical approach needs something to be symmetrical about. */
export function fountainParts({ r = 3.2 } = {}) {
  return { grime: 0.5, parts: [
    { shape: "lathe", seg: 24, pos: [0, 0, 0], color: 0x9aa0a8, tex: "stone",
      profile: [[r2(r), 0], [r2(r), 0.72], [r2(r - 0.42), 0.86], [r2(r - 0.42), 0.24]] },
    { shape: "cylinder", dims: [r2(r - 0.45), 0.08], seg: 24, pos: [0, 0.6, 0],
      color: 0x2a5c6e, tex: "none", roughness: 0.12, metalness: 0.1, grime: false },
    { shape: "lathe", seg: 18, pos: [0, 0.6, 0], color: 0x9aa0a8, tex: "stone",
      profile: [[0.62, 0], [0.4, 0.5], [0.28, 1.1], [0.9, 1.35], [0.86, 1.5], [0.2, 1.6]] },
    { shape: "sphere", dims: [0.34], pos: [0, r2(2.4), 0], color: 0xa8c4cc, tex: "none",
      roughness: 0.2, metalness: 0.1, grime: false },
  ] };
}

/* ── palms ──
   Fronds are thin boxes wearing the leaf map, not blobs: from above a palm IS
   a star of blades, and a displaced sphere reads as an oak wherever you put
   it. Eleven meshes, and the island has six of them. */
export function palmParts({ h = 8, lean = 0.2, fronds = 10, seed = 5,
                            trunk = 0x9a8060, leaf = 0x54993f } = {}) {
  const parts = [];
  const segs = 4;
  let x = 0, y = 0;
  for (let i = 0; i < segs; i++) {
    const sh = h / segs;
    // The lean accumulates up the trunk, so the curve is a curve rather than
    // a straight pole at an angle — which is most of what says "palm".
    const tilt = lean * (i + 0.6) / segs;
    parts.push({ shape: "cylinder", dims: [r2(0.44 - i * 0.07), r2(sh * 1.08)], rTop: r2(0.38 - i * 0.07),
      seg: 8, rotZ: r2(tilt), pos: [r2(x + Math.sin(tilt) * sh / 2), r2(y + sh / 2), 0],
      color: trunk, tex: "wood" });
    x = r2(x + Math.sin(tilt) * sh); y = r2(y + sh);
  }
  /* Fronds droop hard and reach out past the trunk. A blade that leaves the
     crown horizontally reads as a flat green star from every angle; one that
     starts out and falls turns the crown into a shuttlecock, which is what a
     palm looks like from the ground and from the air both. */
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * TAU_ + seed * 0.37;
    const droop = 0.5 + ((i * 7 + seed) % 5) * 0.15;   // two tiers of blade, not one fan
    const reach = h * 0.5;
    parts.push({ shape: "box", dims: [r2(reach), 0.11, r2(h * 0.115)], bevel: 0.05,
      pos: [r2(x + Math.cos(a) * reach * 0.42), r2(y - Math.sin(droop) * reach * 0.34),
            r2(Math.sin(a) * reach * 0.42)],
      rotY: r2(-a), rotZ: r2(droop), tex: "foliage", color: leaf, roughness: 0.96, grime: false });
  }
  // The nuts sit in the crown, under the fronds.
  for (const [dx, dz] of [[0.34, 0.22], [-0.28, -0.3]]) {
    parts.push({ shape: "sphere", dims: [0.26], pos: [r2(x + dx), r2(y - 0.42), r2(dz)],
      color: 0x7a6440, tex: "none", roughness: 0.85, grime: false });
  }
  return { grime: 0.3, parts };
}

/* ── bridges ──
   What a matched pair of walkway ports turns into. Runs along X like every
   other run piece, so the composer lays it with the same alongTo().

   `rise` tilts the deck about Z, which is what lets one end meet a first
   floor and the other a second. Supports are dropped by span rather than
   authored: a short hop gets none, a long one gets legs, and the count is
   capped so a bridge can never cost more than a building.                  */
const MAX_UNSUPPORTED = 14;   // metres of deck that may stand on nothing
const MAX_SUPPORTS = 4;

export function bridgeParts({
  span = 12,          // the PLAN run, measured flat
  width = 2.2,
  rise = 0,           // how much higher the +x end lands
  drop = 6,           // how far the legs reach below the deck's midpoint
  rails = true,
  deckColor = 0x6f7378,
  railColor = 0x8d9299,
} = {}) {
  const run = Math.max(2, span);
  const len = r2(Math.hypot(run, rise));   // the deck is longer than its run
  const pitch = r2(Math.atan2(rise, run));
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  // "Up" in the deck's own tilted frame — rails and anything else riding the
  // deck offset along this, not along world up, or they drift off a slope.
  const up = (h) => [r2(-sp * h), r2(cp * h)];

  const parts = [
    { shape: "box", dims: [len, 0.22, r2(width)], pos: [0, 0, 0], rotZ: pitch,
      bevel: 0.02, color: deckColor, tex: "concrete" },
  ];

  if (rails) {
    const [rx, ry] = up(0.42);
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [len, 0.62, 0.09],
        pos: [rx, ry, r2(s * width / 2)], rotZ: pitch,
        color: railColor, tex: "metal", metalness: 0.5, roughness: 0.55, grime: false });
    }
  }

  // Legs stand under the deck and run down past it. The composer seats the
  // whole piece from its midpoint, so a leg only has to be long enough to
  // reach the ground — anything buried is hidden by the ground it is in.
  const n = Math.min(MAX_SUPPORTS, Math.floor(run / MAX_UNSUPPORTED));
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1) - 0.5;       // -0.5..0.5 along the run
    const lx = r2(t * run);
    const ly = t * rise;                     // the deck's height at that point
    const h = r2(ly + drop);
    if (h <= 0.2) continue;                  // the deck is already at the ground
    parts.push({ shape: "cylinder", dims: [0.26, h], seg: 10,
      pos: [lx, r2(ly - h / 2), 0], color: railColor, tex: "metal",
      metalness: 0.4, roughness: 0.6 });
  }

  return { grime: 0.7, parts };
}

/* ── roads ──
   A street is a carriageway between two kerbs, and the kerb is the part that
   makes it read as a street rather than a grey stripe. Pieces run along X on
   the 6 m module, so a run lays with the same alongTo() the walls use.

   The cross piece is square and 9 m — the road's own full width — so a run
   meeting another run at right angles joins flush.                        */
const ROAD_W = 9;          // kerb to kerb, including both footways
const LANE = 5.4;          // carriageway between the kerbs
const KERB = 0.32;
const WALK = (ROAD_W - LANE) / 2 - KERB;

const asphalt = { color: 0x4a4d52, tex: "concrete", roughness: 0.95 };
const paving = { color: 0x9298a0, tex: "concrete" };
// A carriageway that is not tarmac. Same cross-section, same module, same
// kerb line — a fairytale kingdom needs a STREET, and what it must not have
// is asphalt with a painted centre line down it.
const setts = { color: 0x8f8a78, tex: "stone", roughness: 0.92 };
const flags = { color: 0xa09a88, tex: "stone" };

export function roadParts({ markings = "centre", surface = asphalt, kerb = paving } = {}) {
  const parts = [
    { shape: "box", dims: [MODULE, 0.12, LANE], pos: [0, 0.06, 0], ...surface },
  ];
  for (const s of [1, -1]) {
    parts.push({ shape: "box", dims: [MODULE, 0.3, KERB], pos: [0, 0.15, r2(s * (LANE / 2 + KERB / 2))],
      bevel: 0.02, ...kerb, grime: false });
    parts.push({ shape: "box", dims: [MODULE, 0.26, WALK], pos: [0, 0.13, r2(s * (LANE / 2 + KERB + WALK / 2))],
      ...kerb });
  }
  if (markings === "centre") {
    for (const s of [1, -1]) {
      parts.push({ shape: "box", dims: [2.0, 0.02, 0.16], pos: [r2(s * 1.5), 0.13, 0],
        tex: "none", color: 0xd8d4c6, roughness: 0.8, grime: false });
    }
  } else if (markings === "zebra") {
    for (let i = 0; i < 5; i++) {
      parts.push({ shape: "box", dims: [0.62, 0.02, r2(LANE - 0.5)], pos: [r2(-2.2 + i * 1.1), 0.13, 0],
        tex: "none", color: 0xd8d4c6, roughness: 0.8, grime: false });
    }
  }
  return { grime: 0.25, parts };
}

// A four-way junction: one carriageway square with a footway at each corner,
// so both approaches keep their kerb line right up to the crossing.
export function junctionParts({ surface = asphalt, kerb = paving } = {}) {
  const h = ROAD_W / 2, c = WALK + KERB;
  const parts = [{ shape: "box", dims: [ROAD_W, 0.12, ROAD_W], pos: [0, 0.06, 0], ...surface }];
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      parts.push({ shape: "box", dims: [r2(c), 0.3, r2(c)],
        pos: [r2(sx * (h - c / 2)), 0.15, r2(sz * (h - c / 2))], bevel: 0.02, ...kerb });
    }
  }
  return { grime: 0.25, parts };
}

export const STREET_SURFACES = { asphalt, paving, setts, flags };

// A paving tile for squares and forecourts, on the same 6 m grid as `floor`.
export function plazaParts() {
  return { grime: 0.3, parts: [
    { shape: "box", dims: [MODULE, 0.22, MODULE], pos: [0, 0.11, 0], bevel: 0.02, ...paving },
    { shape: "box", dims: [r2(MODULE - 0.5), 0.03, r2(MODULE - 0.5)], pos: [0, 0.235, 0],
      color: 0x9ba1a9, tex: "concrete", grime: false },
  ] };
}

/* ── planting ──
   Unity-quality vegetation from the same declarative parts system. Canopies
   are "blob" lobes — icospheres with seeded radial displacement (built in
   Props.partGeometry) — wearing the "foliage" texture kind (massed-leaf
   albedo + Sobel relief). The foliage role is themed like every other kind
   (themes.js), so a horror world still greys its trees. Colors are bright on
   purpose: the leaf map multiplies at ~0.6 luminance.

   Crown lobes overlap on purpose — a real canopy is one connected mass of
   leaves, and the displaced silhouettes hide the intersections.          */
export function treeParts({ h = 7, spread = 2.7, trunk = 0x6b5138,
                            leaf = 0x86ac58, leafDark = 0x5d8140, seed = 3 } = {}) {
  const th = h * 0.4; // where the crown takes over from the trunk
  const lobe = (rr, x, y, z, tone, sd) => ({
    shape: "blob", dims: [r2(rr)], pos: [r2(x), r2(y), r2(z)], seed: sd,
    wob: 0.26, freq: 1.9, tex: "foliage", color: tone, roughness: 0.95, grime: false });
  return { grime: 0.4, parts: [
    // Trunk: root flare, taper, and a short reach into the crown.
    { shape: "lathe", seg: 12, pos: [0, 0, 0], color: trunk, tex: "wood",
      profile: [[r2(h * 0.11), 0], [r2(h * 0.055), r2(h * 0.045)], [r2(h * 0.042), r2(h * 0.16)],
                [r2(h * 0.034), r2(th)], [r2(h * 0.024), r2(th + h * 0.14)]] },
    // Two limbs reaching into the side lobes.
    { shape: "cylinder", dims: [r2(h * 0.02), r2(h * 0.34)], rTop: r2(h * 0.011),
      pos: [r2(spread * 0.3), r2(th * 1.12), r2(spread * 0.1)], rotZ: -0.72, rotY: 0.4,
      color: trunk, tex: "wood" },
    { shape: "cylinder", dims: [r2(h * 0.018), r2(h * 0.3)], rTop: r2(h * 0.01),
      pos: [r2(-spread * 0.26), r2(th * 1.18), r2(spread * 0.14)], rotZ: 0.78, rotY: 2.5,
      color: trunk, tex: "wood" },
    // The crown: one master lobe and three satellites, two leaf tones.
    lobe(spread, 0, th + spread * 0.8, 0, leaf, seed * 7 + 1),
    lobe(spread * 0.62, spread * 0.58, th + spread * 1.12, -spread * 0.3, leafDark, seed * 7 + 2),
    lobe(spread * 0.56, -spread * 0.52, th + spread * 1.02, spread * 0.34, leafDark, seed * 7 + 3),
    lobe(spread * 0.5, spread * 0.06, th + spread * 1.52, spread * 0.3, leaf, seed * 7 + 4),
  ] };
}

/* Conifer: staggered foliage skirts (cones wear the leaf map too), jittered
   off-axis so the silhouette stops being a perfect stack, topped by a blob
   crown knot. */
export function pineParts({ h = 8.5, spread = 2.0, trunk = 0x5b4630,
                            leaf = 0x6d9459, leafDark = 0x527549, seed = 5 } = {}) {
  const th = h * 0.2;
  const tier = (y, r, hh, dx, dz, tone) => ({
    shape: "cone", dims: [r2(r), r2(hh), 11], pos: [r2(dx), r2(y), r2(dz)],
    tex: "foliage", color: tone, roughness: 0.95, grime: false });
  return { grime: 0.4, parts: [
    { shape: "cylinder", dims: [r2(h * 0.05), r2(th * 2.2)], rTop: r2(h * 0.028),
      pos: [0, r2(th), 0], color: trunk, tex: "wood" },
    tier(th + h * 0.16, spread, h * 0.34, spread * 0.05, -spread * 0.04, leafDark),
    tier(th + h * 0.34, spread * 0.82, h * 0.32, -spread * 0.06, spread * 0.03, leaf),
    tier(th + h * 0.51, spread * 0.62, h * 0.3, spread * 0.04, spread * 0.05, leafDark),
    tier(th + h * 0.67, spread * 0.42, h * 0.26, -spread * 0.03, -spread * 0.04, leaf),
    { shape: "blob", dims: [r2(spread * 0.22)], pos: [0, r2(th + h * 0.87), 0], seed: seed * 7 + 1,
      wob: 0.3, freq: 2.3, squash: 1.25, tex: "foliage", color: leaf, roughness: 0.95, grime: false },
  ] };
}

// Slim white-barked birch: airy crown, high and light.
export function birchParts({ h = 7.5, spread = 1.7, trunk = 0xd8d2c2,
                             leaf = 0x9db85e, leafDark = 0x7a9a4c, seed = 9 } = {}) {
  const th = h * 0.52;
  const lobe = (rr, x, y, z, tone, sd) => ({
    shape: "blob", dims: [r2(rr)], pos: [r2(x), r2(y), r2(z)], seed: sd,
    wob: 0.3, freq: 2.2, tex: "foliage", color: tone, roughness: 0.95, grime: false });
  return { grime: 0.3, parts: [
    { shape: "lathe", seg: 10, pos: [0, 0, 0], color: trunk, tex: "board",
      profile: [[r2(h * 0.05), 0], [r2(h * 0.03), r2(h * 0.06)], [r2(h * 0.024), r2(th)],
                [r2(h * 0.016), r2(th + h * 0.2)]] },
    { shape: "cylinder", dims: [r2(h * 0.012), r2(h * 0.26)], rTop: r2(h * 0.007),
      pos: [r2(spread * 0.3), r2(th * 1.1), r2(-spread * 0.08)], rotZ: -0.65, rotY: 1.1,
      color: trunk, tex: "board" },
    lobe(spread * 0.85, 0, th + spread * 0.95, 0, leaf, seed * 7 + 1),
    lobe(spread * 0.55, spread * 0.52, th + spread * 0.72, -spread * 0.24, leafDark, seed * 7 + 2),
    lobe(spread * 0.48, -spread * 0.42, th + spread * 1.28, spread * 0.2, leafDark, seed * 7 + 3),
  ] };
}

// A squat shrub: three displaced lobes straight on the ground.
export function bushParts({ spread = 1.1, leaf = 0x6f9450, leafDark = 0x4e7038, seed = 11 } = {}) {
  const lobe = (rr, x, y, z, tone, sd) => ({
    shape: "blob", dims: [r2(rr)], pos: [r2(x), r2(y), r2(z)], seed: sd,
    wob: 0.3, freq: 2.1, squash: 0.78, tex: "foliage", color: tone, roughness: 0.96, grime: false });
  return { grime: 0.35, parts: [
    lobe(spread, 0, spread * 0.62, 0, leaf, seed * 7 + 1),
    lobe(spread * 0.7, spread * 0.62, spread * 0.5, spread * 0.18, leafDark, seed * 7 + 2),
    lobe(spread * 0.6, -spread * 0.55, spread * 0.46, -spread * 0.2, leafDark, seed * 7 + 3),
  ] };
}

// A hedge run on the fence module, so it drops straight into a perimeter.
export function hedgeParts({ len = 3, h = 1.35, leaf = 0x5e7d48 } = {}) {
  return { grime: 0.4, parts: [
    { shape: "box", dims: [len, r2(h - 0.18), 0.9], pos: [0, r2((h - 0.18) / 2), 0], bevel: 0.06,
      tex: "foliage", color: leaf, roughness: 0.96 },
    { shape: "box", dims: [r2(len - 0.12), 0.26, 0.76], pos: [0, r2(h - 0.16), 0], bevel: 0.08,
      tex: "foliage", color: 0x6d8f54, roughness: 0.96, grime: false },
  ] };
}
