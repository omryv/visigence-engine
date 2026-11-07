/* reach.js — can a player actually get there?
 *
 * The single most expensive question in this project to answer by looking.
 * A generated interior can be correct on every count a graph can check —
 * every room has a door, every door has a route, nothing is orphaned — and
 * still be a building where the player stands in the hall and cannot leave
 * it, because the graph is a claim about intent and the geometry is what
 * exists. A headless walk of the horror mode found 0 of 138 rooms enterable
 * while every graph check in the mode passed.
 *
 * So this walks it. Given placements and the rooms they declare, it floods a
 * grid from a starting point using THE ENGINE'S OWN collision rules and
 * reports which declared rooms a player can stand in.
 *
 * ── the coupling, stated rather than hidden
 *
 * Two things here must agree with the renderer or the answer is fiction:
 *
 *   1. the box a part occupies. Props builds meshes and takes a Box3; this
 *      derives the same box analytically, because a check that needs a GPU
 *      is a check nobody runs. The shapes it knows have to be ALL the shapes
 *      Props.partGeometry makes — it knew four of the eight, and the four it
 *      did not know are the ones the editor's own buildings are made of. A
 *      wall is an `extrude`, and an extrude carries no `dims`, so the first
 *      thing this module was asked about a house was a TypeError. Four of
 *      the four worlds were therefore unwalkable by the only checker that
 *      can say whether a world is walkable.
 *   2. the seating. `seat: "point"` places a record by its LOWEST point, not
 *      its origin — Props._groundY adds the origin-to-base lift even when a
 *      height is supplied — and a checker that assumed otherwise would walk
 *      a building standing somewhere the real one is not.
 *
 * STEP_UP, HEAD and the radius are the walk controller's, and `indoors` is
 * its rule that inside a declared interior the terrain is not a floor.
 *
 * Pure JS. No three.js, no DOM, no randomness.
 */

import { shelterVolumes, shelterAt } from "./shelter.js";
import { toWorld } from "./ports.js";

// engine/player/collide.js and controllers.js. Kept as named constants so a
// change there is a one-line change here rather than a silent divergence.
export const STEP_UP = 0.55;
export const HEAD = 1.9;
export const RADIUS = 0.42;

/* The extent of one part's GEOMETRY about its own origin, before the part is
   posed. Half-extents plus the centre offset, because three of these shapes
   are not built symmetrically about the origin: a wedge rises from y = 0, a
   lathe follows whatever y its profile declares, and an extruded outline sits
   wherever its points are. Treating those as centred was the bug that made an
   extruded wall a box straddling the ground it stands on.

   Every case here mirrors one case of Props.partGeometry. Where the mesh is
   not a primitive the bound is the tightest one the SPEC can state:
     bevel      a rounded box has the same extents as a plain one — ignored
     blob       an icosphere displaced by seeded noise, so the bound is the
                largest radius the displacement can reach, squashed in y
                exactly as the geometry squashes it
     extrude    the outline's own bounds, grown by the bevel that is laid
                round it, and half the depth either side of the plane */
function partExtent(p) {
  const d = p.dims;
  switch (p.shape) {
    case "cylinder": {
      // A taper may be WIDER at the top than at the base (rTop), and a bound
      // taken from the base alone is then inside the mesh.
      const r = Math.max(d[0], p.rTop ?? d[0]);
      return { cx: 0, cy: 0, cz: 0, hx: r, hy: d[1] / 2, hz: r };
    }
    case "cone":
      return { cx: 0, cy: 0, cz: 0, hx: d[0], hy: d[1] / 2, hz: d[0] };
    case "sphere":
      return { cx: 0, cy: 0, cz: 0, hx: d[0], hy: d[0], hz: d[0] };
    case "blob": {
      // partGeometry: rr = r * (1 + wob * n * 0.66) with |n| ≤ 1.5, then y is
      // scaled by `squash`. Same three numbers, read off the same spec.
      const r = d[0] * (1 + Math.abs(p.wob ?? 0.24) * 0.66 * 1.5);
      return { cx: 0, cy: 0, cz: 0, hx: r, hy: r * (p.squash ?? 0.86), hz: r };
    }
    case "lathe": {
      let rMax = 0, yMin = Infinity, yMax = -Infinity;
      for (const [r, y] of p.profile || []) {
        rMax = Math.max(rMax, Math.abs(r));
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      }
      if (!Number.isFinite(yMin)) { yMin = yMax = 0; }
      return { cx: 0, cy: (yMin + yMax) / 2, cz: 0, hx: rMax, hy: (yMax - yMin) / 2, hz: rMax };
    }
    case "wedge":
      // Built from y = 0 upward, width along x, slope along z.
      return { cx: 0, cy: d[1] / 2, cz: 0, hx: d[0] / 2, hy: d[1] / 2, hz: d[2] / 2 };
    case "extrude": {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of p.outline || []) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!Number.isFinite(x0)) { x0 = x1 = y0 = y1 = 0; }
      const bev = p.bevel || 0;
      return {
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: 0,
        hx: (x1 - x0) / 2 + bev, hy: (y1 - y0) / 2 + bev, hz: (p.depth || 0) / 2 + bev,
      };
    }
    default:
      return { cx: 0, cy: 0, cz: 0, hx: d[0] / 2, hy: d[1] / 2, hz: d[2] / 2 };
  }
}

/* The axis-aligned box one proc part occupies, in its record's frame.

   The pose is the same Euler (XYZ) Props._applyTransform sets on the part
   mesh, applied about the part's ORIGIN — which is not the middle of its
   geometry for a wedge, a lathe or an extrusion. So the eight corners are
   transformed and bounded, rather than the half-extents being swollen in
   place: swelling is only equivalent when the box is centred on the pivot,
   and it silently was not for half the catalogue. */
export function partBox(p) {
  const [px, py, pz] = p.pos || [0, 0, 0];
  const e = partExtent(p);
  const rx = p.rotX || 0, ry = p.rotY || 0, rz = p.rotZ || 0;
  if (!rx && !ry && !rz) {
    return {
      minX: px + e.cx - e.hx, maxX: px + e.cx + e.hx,
      minY: py + e.cy - e.hy, maxY: py + e.cy + e.hy,
      minZ: pz + e.cz - e.hz, maxZ: pz + e.cz + e.hz,
    };
  }
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // THREE.Euler default order, "XYZ": R = Rx · Ry · Rz applied to the vector.
  const m = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ux of [-1, 1]) {
    for (const uy of [-1, 1]) {
      for (const uz of [-1, 1]) {
        const lx = e.cx + ux * e.hx, ly = e.cy + uy * e.hy, lz = e.cz + uz * e.hz;
        const wx = m[0][0] * lx + m[0][1] * ly + m[0][2] * lz;
        const wy = m[1][0] * lx + m[1][1] * ly + m[1][2] * lz;
        const wz = m[2][0] * lx + m[2][1] * ly + m[2][2] * lz;
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    }
  }
  return {
    minX: px + minX, maxX: px + maxX,
    minY: py + minY, maxY: py + maxY,
    minZ: pz + minZ, maxZ: pz + maxZ,
  };
}

/* Every colliding box a placement contributes, in world space.
   `openDoors` walks the building as a player who opens what they come to,
   which is the honest reading of "can they get there" — a shut door is a
   decision, not a wall.

   WHAT AN OPEN DOOR TAKES OUT OF THE WORLD IS THE LEAF, NOT THE BUILDING.
   This used to skip the whole placement whenever it declared a hinge, which
   is right for exactly one shape of record — the horror mode's door leaf,
   where every part IS the door — and catastrophic for the two other kinds
   this project ships. A block-shapes building declares its hinge on the
   BUILDING (js/block-shapes.js), so every house with a front door had no
   walls at all: a walk floated through the masonry and reported the room
   reachable whatever stood in the way. The catalogue's own `door` block is
   a leaf between two stone piers and a lintel, and those went with it. So
   the parts flagged `door` are what swings aside; everything else stays as
   solid as it looks. */
export function blockersOf(records, { openDoors = true } = {}) {
  const out = [];
  for (const rec of records) {
    const parts = rec.proc?.parts;
    if (!parts?.length) continue;
    const hinged = openDoors && !!rec.proc.door;
    if (hinged && parts.every((p) => p.door)) continue;   // a leaf, whole
    let minY = Infinity;
    for (const p of parts) minY = Math.min(minY, partBox(p).minY);
    const sc = rec.scale ?? 1;
    const oy = rec.seat === "point" ? rec.position[1] - minY * sc : rec.position[1];
    /* Boxes stay in the PLACEMENT'S OWN AXES and carry the frame, exactly as
       Blockers does. Flattening them to world-axis rectangles here would
       reproduce the bug this checker exists to catch: a wall at an angle
       becomes a slab of solid air two metres thick, and an angled building
       reads as impassable when it is not. */
    const frame = { x: rec.position[0], z: rec.position[2], rot: rec.rotationY || 0 };
    for (const p of parts) {
      if (p.noCollide || p.emissive != null) continue;
      if (hinged && p.door) continue;             // swung aside
      const b = partBox(p);
      out.push({
        minX: b.minX * sc, maxX: b.maxX * sc,
        minZ: b.minZ * sc, maxZ: b.maxZ * sc,
        minY: oy + b.minY * sc, maxY: oy + b.maxY * sc,
        frame, uid: rec.uid, ref: rec.ref,
      });
    }
  }
  return out;
}

// A circle is the same circle however the box is turned, so only the centre
// moves into the box's frame.
const overlaps = (b, x, z, r) => {
  let lx = x, lz = z;
  if (b.frame && b.frame.rot) {
    const dx = x - b.frame.x, dz = z - b.frame.z;
    const c = Math.cos(b.frame.rot), s = Math.sin(b.frame.rot);
    lx = dx * c - dz * s; lz = dx * s + dz * c;
  } else if (b.frame) { lx = x - b.frame.x; lz = z - b.frame.z; }
  const nx = Math.max(b.minX, Math.min(lx, b.maxX));
  const nz = Math.max(b.minZ, Math.min(lz, b.maxZ));
  return (nx - lx) * (nx - lx) + (nz - lz) * (nz - lz) < r * r;
};

// Would a player standing with feet here overlap something solid?
export const blocked = (boxes, x, z, feetY, r = RADIUS) =>
  near(boxes, x, z).some((b) => b.maxY >= feetY + STEP_UP && b.minY <= feetY + HEAD && overlaps(b, x, z, r));

// The highest thing they could be standing on.
export function surfaceAt(boxes, x, z, feetY, r = RADIUS) {
  let best = -Infinity;
  for (const b of near(boxes, x, z)) {
    if (b.maxY > feetY + STEP_UP || b.maxY <= best) continue;
    if (overlaps(b, x, z, r)) best = b.maxY;
  }
  return best;
}

/* ── the index ──
   A flood asks tens of thousands of questions of a building with hundreds of
   boxes in it, and asking all of them every time is a hundred million tests
   for one house. The same 8 m spatial hash the renderer's blockers use, built
   once and hung off the array, cuts it to the handful actually nearby. */
const CELL = 4;
const bucket = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function near(boxes, x, z) {
  let index = boxes._index;
  if (!index) {
    index = new Map();
    for (const b of boxes) {
      const [x0, x1, z0, z1] = worldSpan(b);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const k = `${cx},${cz}`;
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(b);
        }
      }
    }
    Object.defineProperty(boxes, "_index", { value: index, enumerable: false });
  }
  return index.get(bucket(x, z)) || EMPTY;
}
const EMPTY = [];

// The world rectangle a placement-local box could occupy. Bucketing only.
function worldSpan(b) {
  const f = b.frame;
  if (!f) return [b.minX, b.maxX, b.minZ, b.maxZ];
  const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0);
  const xs = [], zs = [];
  for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]]) {
    xs.push(f.x + x * c + z * s);
    zs.push(f.z - x * s + z * c);
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

/* Flood a building and report which of its rooms a player reaches.
 *
 *   records   the placements, exactly as they would be added to the scene
 *   rooms     the declared rooms, in building-local metres, with `level`
 *   origin    where local (0,0,0) is in the world — the SEATED position
 *   from      where the walk starts, in building-local metres
 *   ground    the terrain height around the building
 *
 * Returns the set of reachable room indices, and the highest and lowest the
 * walk got, which is what tells you a stair worked. */
export function reachableRooms({
  records, rooms, origin, rotationY = 0, from, ground = 0,
  cell = 0.25, storeyH = 3.0, bound = 3.0, openDoors = true, guard = 300000,
}) {
  const boxes = blockersOf(records, { openDoors });
  const vols = records.flatMap((r) => (r.proc?.rooms?.length ? shelterVolumes(r, toWorld) : []));
  const indoors = (x, y, z) => shelterAt(vols, x, y, z) === 1;
  const c = Math.cos(rotationY), s = Math.sin(rotationY);
  const world = (lx, lz) => [origin[0] + lx * c + lz * s, origin[2] - lx * s + lz * c];
  const extent = rooms.reduce((m, r) => ({
    w: Math.max(m.w, Math.abs(r.x) + r.w / 2), d: Math.max(m.d, Math.abs(r.z) + r.d / 2),
  }), { w: 0, d: 0 });

  /* THE GRID RUNS IN THE BUILDING'S OWN AXES, not the world's.
     Everything in a building is axis-aligned in its own frame — walls,
     doorways, treads — so a world-aligned grid meets a rotated doorway
     diagonally and has to thread a 1.3 m opening with a 0.84 m circle on
     0.25 m steps. It misses. Three of sixteen buildings reported as
     impossible to enter were upright buildings at an angle, with an entrance
     the discretisation could not find and a player would walk straight
     through. A local grid removes the question. */
  const start = { u: from[0], v: from[1], y: ground };
  // The height bucket has to be finer than a stair tread, or two points in
  // one column collapse and a flight is walked once and never again.
  const key = (u, v, y) => `${Math.round(u / cell)},${Math.round(v / cell)},${Math.round(y / 0.6)}`;
  const seen = new Set([key(start.u, start.v, start.y)]);
  /* A read pointer, not `shift()`. A flood of a school visits twenty-five
     thousand cells, and shifting a twenty-five-thousand element array once
     per cell is six hundred million element moves for one building — the
     whole check went from milliseconds to most of a second, which is the
     difference between running it on every plan draw and not running it. */
  const queue = [start];
  const stood = [];
  let head = 0, n = 0;
  while (head < queue.length && n++ < guard) {
    const at = queue[head++];
    stood.push(at);
    for (const [du, dv] of [[cell, 0], [-cell, 0], [0, cell], [0, -cell]]) {
      const nu = at.u + du, nv = at.v + dv;
      if (Math.abs(nu) > extent.w + bound || Math.abs(nv) > extent.d + bound) continue;
      const [nx, nz] = world(nu, nv);
      if (blocked(boxes, nx, nz, at.y)) continue;
      const surf = surfaceAt(boxes, nx, nz, at.y);
      // Inside a declared interior the land is not a floor — see the walk
      // controller. Without this no basement is ever reachable.
      let ny = Math.max(surf, indoors(nx, at.y, nz) ? -Infinity : ground);
      if (!Number.isFinite(ny)) ny = ground;
      if (ny > at.y + STEP_UP) continue;
      const k = key(nu, nv, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ u: nu, v: nv, y: ny });
    }
  }

  const got = new Set();
  let top = -Infinity, bottom = Infinity;
  for (const p of stood) {
    const lx = p.u, lz = p.v;
    const ly = p.y - origin[1];
    top = Math.max(top, ly); bottom = Math.min(bottom, ly);
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      const fy = r.level * storeyH;
      if (ly < fy - 0.3 || ly > fy + 1.2) continue;
      // Inset, so brushing a wall from the next room does not count as being
      // in this one.
      if (Math.abs(lx - r.x) > r.w / 2 - 0.3 || Math.abs(lz - r.z) > r.d / 2 - 0.3) continue;
      got.add(i);
    }
  }
  return { reached: got, top, bottom, cells: stood.length };
}
