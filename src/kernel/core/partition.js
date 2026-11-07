/* interior-zones.js — dividing a floor into rooms.
 *
 * Stages 3 and 4 of the pipeline. Until this existed, a building's floor was
 * ONE room however big it was: a 14 × 12 hall got a single programme and a
 * cottage got the same treatment as a warehouse. That is the difference
 * between a furnished space and a plan.
 *
 * The subdivision is a slice partition rather than a free-form one, because
 * buildings are built that way. A floor is cut by straight walls that run
 * from one external wall to another; rooms are rectangles; and the cuts stop
 * when the smallest useful room is reached. What varies is where the cuts
 * fall and how many there are, which is exactly what varies in real plans.
 *
 * Three rules shape the result, and each one is a thing builders actually do:
 *
 *   ROOMS ARE BIG ENOUGH TO USE. A cut that would leave a space too small to
 *   stand a bed in and walk past it is refused. Minimum useful dimension is
 *   a bed's length plus a person's width.
 *
 *   PUBLIC AT THE DOOR, PRIVATE AT THE BACK. Zones are ranked by how far they
 *   are from the entrance and the programme is laid onto that order by
 *   publicness. A taproom is at the street and the family sleeps behind it.
 *
 *   EVERY ROOM HAS A WAY IN. The adjacency graph is built from shared wall
 *   runs, a spanning tree back to the entrance zone is taken, and a doorway
 *   is cut on each edge of that tree. A room the tree cannot reach does not
 *   get furnished — it gets a doorway instead.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

// A room narrower than this cannot be used: a bed is 1.95 m and you have to
// be able to get past it.
const MIN_SIDE = 2.4;
const MIN_AREA = 7.5;
const DOOR_W = 1.15;          // a clear opening a person carrying something fits
const WALL_T = 0.18;          // internal partition thickness
/* A corridor: two people passing, which is the only dimension a corridor has
   ever been designed to. Narrower and it is a passage nobody would build;
   wider and it is a room that happens to be long. */
const CORRIDOR_W = 1.5;

const r3 = (v) => Math.round(v * 1000) / 1000;

/* ── stage 3 · divide ───────────────────────────────────────────────────
   Slice the envelope until every piece is a usable room and no piece is
   bigger than the archetype wants a single room to be. `grain` is that
   ceiling — a warehouse leaves its floor open, a house does not. */
export function subdivide({ w, d, grain = 40, rng, maxZones = 4, keepOut = null }) {
  const reserved = keepOut ? (Array.isArray(keepOut) ? keepOut : [keepOut]) : [];
  let zones = [{ x: 0, z: 0, w, d }];
  const unsplittable = new Set();
  let guard = 24;
  while (zones.length < maxZones && guard-- > 0) {
    // Always cut the biggest room left: that is what makes the result a plan
    // rather than one big space with a cupboard bitten out of it.
    zones.sort((a, b) => b.w * b.d - a.w * a.d);
    const at = zones.findIndex((z) => !unsplittable.has(z) && z.w * z.d > grain);
    if (at < 0) break;
    const z = zones[at];
    const cut = sliceOne(z, rng, reserved);
    // A room that refuses one cut may not refuse the next-biggest's, so this
    // marks the room rather than abandoning the whole plan.
    if (!cut) { unsplittable.add(z); continue; }
    zones.splice(at, 1, ...cut);
  }
  return zones.map((z, i) => ({ ...z, index: i, x: r3(z.x), z: r3(z.z), w: r3(z.w), d: r3(z.d) }));
}

/* One cut across the longer axis, at a ratio that is never the middle —
   identical halves read as a diagram, not as a building.

   `reserved` is what the building itself owns on this floor: the stair or the
   shaft, and the floor inside the front door. A partition through a staircase
   is not a plan, and a partition meeting the entrance edge-on is a door that
   opens onto a wall — so a cut landing in either is retried elsewhere and,
   failing that, refused. */
function sliceOne(z, rng, reserved = []) {
  /* The longer axis first — that is the cut a builder makes — and then the
     other one, because the preferred cut can be refused by what the floor
     already owns. A square cottage with its door in the middle of the front
     cannot be split down the middle without splitting the doorway; split
     across instead and it is a front room and a back room, which is what such
     a cottage actually is. Without the second axis it stayed one room. */
  const wide = z.w >= z.d;
  return sliceAxis(z, rng, reserved, wide) || sliceAxis(z, rng, reserved, !wide);
}

function sliceAxis(z, rng, reserved, alongW) {
  const span = alongW ? z.w : z.d;
  const other = alongW ? z.d : z.w;
  if (other < MIN_SIDE) return null;
  const usable = span - WALL_T;
  const minFrac = Math.max(MIN_SIDE / usable, MIN_AREA / (usable * other));
  if (minFrac > 0.48) return null;                 // no cut leaves two usable rooms
  const lo = z[alongW ? "x" : "z"] - span / 2;

  for (let attempt = 0; attempt < 6; attempt++) {
    const frac = minFrac + rng() * (1 - 2 * minFrac);
    const a = usable * frac, b = usable - a;
    if (a < MIN_SIDE || b < MIN_SIDE || a * other < MIN_AREA || b * other < MIN_AREA) continue;
    if (reserved.some((k) => crosses(lo + a + WALL_T / 2, alongW, k, z))) continue;
    return alongW
      ? [{ x: z.x - z.w / 2 + a / 2, z: z.z, w: a, d: z.d },
         { x: z.x - z.w / 2 + a + WALL_T + b / 2, z: z.z, w: b, d: z.d }]
      : [{ x: z.x, z: z.z - z.d / 2 + a / 2, w: z.w, d: a },
         { x: z.x, z: z.z - z.d / 2 + a + WALL_T + b / 2, w: z.w, d: b }];
  }
  return null;
}

// Would a wall at `at` (on the x axis when alongW, else on z) run through the
// reserved rectangle, given the cut spans the whole of `z` on the other axis?
function crosses(at, alongW, keep, z) {
  const c = alongW ? keep.x : keep.z, half = (alongW ? keep.w : keep.d) / 2;
  if (Math.abs(at - c) > half + WALL_T) return false;
  // It only matters if the reserved rect is actually inside this zone's span
  // on the other axis — a stair in a different room is not in the way.
  const oc = alongW ? keep.z : keep.x, ohalf = (alongW ? keep.d : keep.w) / 2;
  const zc = alongW ? z.z : z.x, zhalf = (alongW ? z.d : z.w) / 2;
  return Math.abs(oc - zc) < ohalf + zhalf;
}

/* ── the spine ──────────────────────────────────────────────────────────
   A corridor, and it is a different idea from a room rather than a thin one.

   Slice partitioning alone can only ever produce a plan where you walk
   through one room to reach the next, because that is what a slice is. That
   is a cottage and it is honest for a cottage — but it is not a lodging
   house, an office floor, a ward block or the private storey of a palace,
   and every one of those was coming out as a chain of rooms you had to walk
   through somebody's bedroom to cross. A building with more than two or
   three private rooms on a floor has a route past them, and the route is a
   piece of the plan rather than the absence of one.

   It runs PERPENDICULAR TO THE WAY IN and the full depth of the floor, which
   is what a spine is: you come through the door, you are in the corridor, and
   every room opens off it. The offset is drawn rather than centred, and both
   sides have to be wide enough to hold a real room or there is no corridor —
   a spine down a floor too narrow for it is a floor cut into two passages.

   Returns null where it will not fit, and the caller falls back to slicing.  */
function spine({ w, d, entrance, rng }) {
  const side = entrance?.side || "south";
  // Along z for a door in a north or south wall; along x for the other two.
  const alongZ = side === "south" || side === "north";
  const across = alongZ ? w : d;
  const usable = across - CORRIDOR_W - WALL_T * 2;
  if (usable < MIN_SIDE * 2) return null;

  /* Where across the floor it runs. Near the doorway, because a corridor you
     enter halfway down its length is a corridor with a room in front of the
     door — and nudged off it by up to a metre so two identical buildings do
     not put their passage in the same place. */
  const at = clampTo(
    (alongZ ? entrance.x : entrance.z) + (rng() - 0.5) * 1.6,
    (across - CORRIDOR_W) / 2 - MIN_SIDE - WALL_T);
  /* A WHOLE wall thickness each side, not half of one. The rooms either side
     of a passage are separated from it by a wall exactly as two rooms are, and
     leaving half a wall there put the gap outside the tolerance `adjacency`
     recognises — so the spine shared no edge with anything, the spanning tree
     reached nothing, and every room off the corridor came out walled in with
     a doorway to nowhere. The plan was right and the graph was empty. */
  const lo = at - CORRIDOR_W / 2 - WALL_T;
  const hi = at + CORRIDOR_W / 2 + WALL_T;
  const half = across / 2;
  const slab = (a, b) => {
    const mid = (a + b) / 2, span = b - a;
    return span >= MIN_SIDE - 1e-6
      ? (alongZ ? { x: mid, z: 0, w: span, d } : { x: 0, z: mid, w, d: span })
      : null;
  };
  return {
    corridor: alongZ
      ? { x: at, z: 0, w: CORRIDOR_W, d }
      : { x: 0, z: at, w, d: CORRIDOR_W },
    slabs: [slab(-half, lo), slab(hi, half)].filter(Boolean),
  };
}
const clampTo = (v, lim) => Math.max(-lim, Math.min(lim, v));

/* ── adjacency ──────────────────────────────────────────────────────────
   Two zones are neighbours when they share a wall run wide enough to cut a
   door in. The overlap is returned with the edge because that is where the
   doorway has to go.

   `gap` is how far apart two rectangles must be to count as facing across a
   partition. It defaults to this module's own wall thickness, because that
   is what `subdivide` leaves between the zones it makes — but not every
   caller's rectangles come from `subdivide`. Rooms carved either side of a
   corridor, or cut around a reserved shaft, ABUT: their gap is zero, and
   with the default tolerance such a floor reports no neighbours at all,
   which reads downstream as a building where every room is sealed. */
export function adjacency(zones, { gap = WALL_T, tol = 0.06 } = {}) {
  const edges = [];
  const facing = (g) => g >= gap - tol && g <= gap + tol;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], b = zones[j];
      const gapX = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
      const gapZ = Math.abs(a.z - b.z) - (a.d + b.d) / 2;
      // Facing across a partition on one axis, overlapping on the other.
      if (facing(gapX) && gapZ < -MIN_SIDE * 0.5) {
        const lo = Math.max(a.z - a.d / 2, b.z - b.d / 2);
        const hi = Math.min(a.z + a.d / 2, b.z + b.d / 2);
        if (hi - lo >= DOOR_W) edges.push({ a: i, b: j, axis: "x", at: between(a, b, "x", "w"), lo, hi });
      } else if (facing(gapZ) && gapX < -MIN_SIDE * 0.5) {
        const lo = Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const hi = Math.min(a.x + a.w / 2, b.x + b.w / 2);
        if (hi - lo >= DOOR_W) edges.push({ a: i, b: j, axis: "z", at: between(a, b, "z", "d"), lo, hi });
      }
    }
  }
  return edges;
}

/* The plane the wall between two rooms actually stands on: halfway between
   the FACES that look at each other.

   It used to be halfway between the two rooms' CENTRES, which is the same
   number only when the rooms are the same size — and the whole point of this
   partitioner is that they are not. A six-metre room beside a four-metre one
   put the wall half a metre inside the larger of the two: partitionRuns takes
   its position from here, so the wall was BUILT there, standing in the middle
   of a room with the doorway it was supposed to hold hanging in mid-air
   beside it. Every plan with rooms of different depths had one. */
function between(a, b, axis, span) {
  return a[axis] < b[axis]
    ? (a[axis] + a[span] / 2 + b[axis] - b[span] / 2) / 2
    : (b[axis] + b[span] / 2 + a[axis] - a[span] / 2) / 2;
}

/* ── stage 4 · assign purposes, and cut the doors ───────────────────────
   Rank the zones by how far they are from the entrance, lay the programme
   onto that order by publicness, then take a spanning tree back to the
   entrance and cut a doorway on every edge of it.

   The spanning tree is what guarantees the building is navigable: every room
   has a route to the front door through doorways that were actually cut, not
   through walls that happen not to have been drawn. */
export function planFloor({ w, d, entrance, programme, rng, grain = 40, maxZones = 4, keepOut = null,
                            corridor = false, affinity = null }) {
  const entrySide = entrance.side || "south";
  /* The floor just inside the way in is reserved along with whatever the
     building already owns. A partition that meets the entrance wall at the
     doorway leaves a front door that opens onto the edge of a wall — legal
     geometry, and nobody has ever built one. */
  const reserved = (keepOut ? (Array.isArray(keepOut) ? keepOut : [keepOut]) : []).concat([{
    x: entrance.x + (entrySide === "east" ? -0.7 : entrySide === "west" ? 0.7 : 0),
    z: entrance.z + (entrySide === "south" ? -0.7 : entrySide === "north" ? 0.7 : 0),
    w: 1.7, d: 1.7,
  }]);

  /* ── the spine, if the building is the kind that has one ──
     Cut FIRST and then the rooms out of what is left, because that is the
     order it is designed in: a corridor is not the space between the rooms,
     it is the thing the rooms are hung off. Asking for one is the
     archetype's business — a cottage does not have a passage and a ward
     block cannot work without one. */
  const spined = corridor && maxZones >= 3 ? spine({ w, d, entrance, rng }) : null;
  let zones, corridorIndex = -1;
  if (spined?.slabs.length >= 2) {
    /* Each flank divided on its own, with the floor's room allowance shared
       between them BY AREA rather than evenly — a spine drawn near one wall
       leaves a thin flank and a broad one, and cutting both into the same
       number of rooms is how the broad side ends up with a ballroom next to
       three cupboards. */
    const total = spined.slabs.reduce((sum, s) => sum + s.w * s.d, 0) || 1;
    const budget = Math.max(2, maxZones - 1);
    const cut = [];
    for (const s of spined.slabs) {
      const want = Math.max(1, Math.round((budget * s.w * s.d) / total));
      const local = subdivide({ w: s.w, d: s.d, grain, rng, maxZones: want, keepOut: shift(reserved, s) });
      for (const z of local) cut.push({ x: r3(s.x + z.x), z: r3(s.z + z.z), w: z.w, d: z.d });
    }
    corridorIndex = 0;
    zones = [spined.corridor, ...cut].map((z, i) => ({ ...z, index: i }));
  } else {
    zones = subdivide({ w, d, grain, rng, maxZones, keepOut: reserved });
  }
  const edges = adjacency(zones);

  /* Which zone the way in opens into. Nearest to the entrance, but only among
     the zones that actually TOUCH the wall it is in: on a floor cut across the
     depth, the zone at the back can be the nearest by centre distance and
     still have no front door in it. */
  const onWall = (z) => {
    if (entrySide === "south") return z.z + z.d / 2 >= d / 2 - 0.05;
    if (entrySide === "north") return z.z - z.d / 2 <= -d / 2 + 0.05;
    if (entrySide === "east") return z.x + z.w / 2 >= w / 2 - 0.05;
    return z.x - z.w / 2 <= -w / 2 + 0.05;
  };
  // …and, before distance, the zone whose frontage actually SPANS the
  // opening. Two rooms can both front the street with the nearer centre
  // belonging to the one the door is not in.
  const spans = (z) => (entrySide === "east" || entrySide === "west"
    ? Math.abs(entrance.z - z.z) <= z.d / 2 - DOOR_W / 2
    : Math.abs(entrance.x - z.x) <= z.w / 2 - DOOR_W / 2);
  const dist = zones.map((z) => Math.hypot(z.x - entrance.x, z.z - entrance.z));
  let entryZone = -1;
  // A spine is entered by definition: it was cut from the doorway outward,
  // so nothing else is a candidate and asking would only find a room that
  // happens to sit nearer the middle of the frontage.
  if (corridorIndex >= 0) entryZone = corridorIndex;
  for (const want of [true, false]) {
    if (entryZone >= 0) break;
    for (let i = 0; i < zones.length; i++) {
      if (!onWall(zones[i]) || spans(zones[i]) !== want) continue;
      if (entryZone < 0 || dist[i] < dist[entryZone]) entryZone = i;
    }
    if (entryZone >= 0) break;
  }
  // An upper floor arrives at a stair head rather than through a wall, so
  // nothing may touch the nominal entry wall. Nearest wins.
  if (entryZone < 0) {
    entryZone = 0;
    for (let i = 1; i < zones.length; i++) if (dist[i] < dist[entryZone]) entryZone = i;
  }

  /* Spanning tree from the entry zone. Breadth-first, so every room is as
     few doors from the street as the plan allows — which is how a plan is
     laid out and also what keeps the walk short. */
  const order = [entryZone];
  const seen = new Set([entryZone]);
  const doors = [];
  const depth = new Array(zones.length).fill(Infinity);
  depth[entryZone] = 0;
  for (let head = 0; head < order.length; head++) {
    const cur = order[head];
    for (const e of edges) {
      const other = e.a === cur ? e.b : e.b === cur ? e.a : -1;
      if (other < 0 || seen.has(other)) continue;
      seen.add(other);
      depth[other] = depth[cur] + 1;
      order.push(other);
      // The opening goes in the middle of the shared run, nudged off centre.
      const mid = (e.lo + e.hi) / 2 + (rng() - 0.5) * Math.max(0, (e.hi - e.lo) - DOOR_W) * 0.6;
      doors.push({ a: e.a, b: e.b, axis: e.axis, at: e.at, along: mid, width: DOOR_W });
    }
  }

  /* A zone the tree never reached is walled off. Rather than furnish a room
     nobody can enter, give it a door: any shared edge back to a reached zone
     will do, and the plan is better for it. */
  for (let i = 0; i < zones.length; i++) {
    if (seen.has(i)) continue;
    const e = edges.find((x) => (x.a === i && seen.has(x.b)) || (x.b === i && seen.has(x.a)));
    if (!e) continue;
    seen.add(i);
    depth[i] = 1 + depth[e.a === i ? e.b : e.a];
    doors.push({ a: e.a, b: e.b, axis: e.axis, at: e.at, along: (e.lo + e.hi) / 2, width: DOOR_W });
  }

  /* Purposes. Zones sorted by depth from the street take the programme
     sorted by publicness: the most public room lands where the public
     arrives. Ties break on area, so the bigger room gets the bigger job. */
  const byDepth = zones.map((z, i) => i)
    .filter((i) => i !== corridorIndex)
    .sort((p, q) => (depth[p] - depth[q]) || (zones[q].w * zones[q].d - zones[p].w * zones[p].d));
  const out = zones.map((z) => ({ ...z }));
  byDepth.forEach((zi, rank) => {
    const spec = programme[Math.min(rank, programme.length - 1)];
    out[zi].purpose = spec.purpose;
    out[zi].publicness = spec.publicness;
    out[zi].depth = depth[zi] === Infinity ? 99 : depth[zi];
    out[zi].isEntry = zi === entryZone;
  });
  if (corridorIndex >= 0) {
    // The corridor is not one of the programme's rooms and never takes one of
    // its purposes: a passage is circulation, and a floor that spends a
    // bedroom on it is a floor with one fewer bedroom.
    const c = out[corridorIndex];
    c.purpose = "corridor";
    c.publicness = 0;
    c.depth = depth[corridorIndex] === Infinity ? 99 : depth[corridorIndex];
    c.isEntry = corridorIndex === entryZone;
  }

  /* ── stage 4b · who should be next to whom ──────────────────────────
     Depth and publicness say how far from the street a room sits. They say
     nothing about which room it sits BESIDE, and that is half of what a plan
     is: a kitchen belongs next to the room people eat in, a stock room
     belongs behind the shop it serves, a bedroom does not open onto a
     workshop. Assigned by rank alone, all three of those came out as
     coincidence.

     Swaps rather than a solver, and only between zones at the SAME DEPTH —
     which is what makes this safe rather than clever. Two rooms equally far
     from the door can exchange purposes without changing any room's distance
     from the street, so the publicness ordering the previous pass
     established survives untouched, by construction rather than by
     re-checking. Everything else is left alone.

     Deterministic: the pass is a fixed sweep taking the first strict
     improvement, so the same floor and the same programme rearrange the same
     way every time. */
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < out.length && !moved; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (i === corridorIndex || j === corridorIndex) continue;
        if (out[i].depth !== out[j].depth) continue;
        if (out[i].purpose === out[j].purpose) continue;
        const before = fitness(out, edges, affinity);
        swapPurpose(out[i], out[j]);
        if (fitness(out, edges, affinity) > before) { moved = true; break; }
        swapPurpose(out[i], out[j]);
      }
    }
    if (!moved) break;
  }

  /* Each room's own way in, in its local frame: the entry zone's is the
     building's front door, everything else's is the first doorway on its
     route back to it. The planner needs this to know which floor to keep
     clear.

     …AND EVERY OTHER DOORWAY IN ITS WALLS. `door` is the route BACK to the
     street and is one opening; `openings` is all of them, both sides of every
     cut. The difference is the difference between a room you can get into and
     a room you can get THROUGH, and only the first was ever handed
     downstream — so a middle room could be furnished with its onward doorway
     behind a dresser and every per-room check would still pass, while the
     building beyond it became unreachable. */
  for (const z of out) { z.door = null; z.openings = []; }
  const localOf = (dr, self) => (dr.axis === "x"
    ? { x: clamp(dr.along - out[self].z, out[self].d), side: dr.at > out[self].x ? "east" : "west" }
    : { x: clamp(dr.along - out[self].x, out[self].w), side: dr.at > out[self].z ? "south" : "north" });
  const ez = out[entryZone];
  ez.door = entrySide === "east" || entrySide === "west"
    ? { x: clamp(entrance.z - ez.z, ez.d), side: entrySide }
    : { x: clamp(entrance.x - ez.x, ez.w), side: entrySide };
  ez.openings.push(ez.door);
  for (const dr of doors) {
    for (const [self, other] of [[dr.a, dr.b], [dr.b, dr.a]]) {
      const local = localOf(dr, self);
      out[self].openings.push(local);
      if (out[self].door || depth[self] <= depth[other]) continue;
      out[self].door = local;
    }
  }
  // A zone with no route at all still needs somewhere to plan around.
  for (const z of out) {
    if (!z.door) z.door = z.openings[0] || { x: 0, side: "south" };
    // The room's own door is the one the flood starts from, so it has to BE
    // one of the openings rather than a fifth thing beside them.
    if (!z.openings.includes(z.door)) z.openings.unshift(z.door);
  }

  return { zones: out, doors, edges, entryZone };
}

const clamp = (v, span) => Math.max(-span / 2 + 0.7, Math.min(span / 2 - 0.7, v));

/* How well a whole floor's purposes sit beside each other: the affinity of
   every pair of rooms that actually share a doorway, summed. `affinity` is
   handed in — which purposes want to be neighbours is a fact about ROOMS and
   this module knows only about rectangles (js/archetype.js ADJACENCY owns the
   table). A caller that supplies none gets the old behaviour, because every
   arrangement then scores zero and no swap is ever an improvement. */
function fitness(zones, edges, affinity) {
  if (!affinity) return 0;
  let total = 0;
  for (const e of edges) total += affinity(zones[e.a].purpose, zones[e.b].purpose);
  return total;
}
function swapPurpose(a, b) {
  const p = a.purpose, q = a.publicness;
  a.purpose = b.purpose; a.publicness = b.publicness;
  b.purpose = p; b.publicness = q;
}

/* Reserved rectangles, moved into a slab's own frame. A stairwell stated in
   floor coordinates is still a stairwell when the flank it lands in is
   subdivided on its own, and handing it over unshifted put it in the wrong
   half of the building. */
function shift(rects, slab) {
  return rects.map((r) => ({ ...r, x: r.x - slab.x, z: r.z - slab.z }));
}

/* ── the walls themselves ───────────────────────────────────────────────
   The partitions the cuts imply, as geometry, with the doorways left out of
   them. Emitted as runs rather than as one wall per cut because a wall with
   an opening in it is two pieces of wall — collision in this engine is one
   box per mesh, so a doorway has to be an ABSENCE of geometry, exactly as
   the building shells already do it. */
export function partitionRuns({ zones, doors, edges = null, h }) {
  const runs = [];
  const head = 2.05;                    // clear height of the opening
  const key = (axis, at, a, b) => `${axis}:${at.toFixed(2)}:${Math.min(a, b)}-${Math.max(a, b)}`;

  /* EVERY SHARED WALL, not only the ones with a door in them.

     This used to walk `doors` alone, which was invisible while a floor was a
     chain of rooms — a slice partition connects each room to the next, so
     every shared run had a doorway on it and every shared run therefore got
     built. A spine plan breaks that assumption completely: two rooms on the
     same flank of a corridor are each connected to the CORRIDOR and never to
     each other, so the wall between them was never emitted and a ward ran
     straight into the office beside it with nothing in between.

     So the runs come from the adjacency graph, and the doors punch holes in
     them. A caller that passes no graph gets exactly the old behaviour. */
  const byWall = new Map();
  for (const e of edges || doors) {
    const k = key(e.axis, e.at, e.a, e.b);
    if (byWall.has(k)) continue;
    const a = zones[e.a], b = zones[e.b];
    byWall.set(k, {
      axis: e.axis, at: e.at, a: e.a, b: e.b,
      lo: e.axis === "x" ? Math.max(a.z - a.d / 2, b.z - b.d / 2)
                         : Math.max(a.x - a.w / 2, b.x - b.w / 2),
      hi: e.axis === "x" ? Math.min(a.z + a.d / 2, b.z + b.d / 2)
                         : Math.min(a.x + a.w / 2, b.x + b.w / 2),
      cut: [],
    });
  }
  for (const dr of doors) {
    const wall = byWall.get(key(dr.axis, dr.at, dr.a, dr.b));
    if (wall) wall.cut.push(dr);
  }

  for (const wall of byWall.values()) {
    if (!wall.cut.length) { pushRun(runs, wall.axis, wall.at, wall.lo, wall.hi, h, 0); continue; }
    // Solid between the openings, in order along the wall, and a lintel over
    // each — which is wall too, just out of reach.
    const cuts = wall.cut.slice().sort((p, q) => p.along - q.along);
    let edge = wall.lo;
    for (const dr of cuts) {
      pushRun(runs, wall.axis, wall.at, edge, dr.along - dr.width / 2, h, 0);
      if (h > head + 0.1) {
        pushRun(runs, wall.axis, wall.at, dr.along - dr.width / 2, dr.along + dr.width / 2, h - head, head);
      }
      edge = dr.along + dr.width / 2;
    }
    pushRun(runs, wall.axis, wall.at, edge, wall.hi, h, 0);
  }
  return runs;
}
// `y` is the bottom of the run: 0 for the wall itself, head height for the
// piece over a doorway.
function pushRun(runs, axis, at, lo, hi, h, y) {
  if (hi - lo > 0.06 && h > 0.05) {
    runs.push({ axis, at: r3(at), lo: r3(lo), hi: r3(hi), h: r3(h), y: r3(y), lintel: y > 0 });
  }
}

export { MIN_SIDE, MIN_AREA, DOOR_W, WALL_T, CORRIDOR_W };
