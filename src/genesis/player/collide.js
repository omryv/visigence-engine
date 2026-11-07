// Walk-mode collision against placed blocks. Without it a maze wall is a
// picture of a wall.
//
// Deliberately 2.5D and cheap: every solid mesh contributes an axis-aligned
// box, bucketed into an 8 m spatial hash. The player is a circle that slides
// along surfaces (each axis is resolved separately, which is what makes
// running along a wall feel right rather than sticking).
//
// Only knee-to-head boxes block: a floor slab or a threshold is walked over,
// not into. Standing ON blocks is out of scope — the walker seats on terrain.

const CELL = 8;

/* The world rectangle a placement-local box could occupy, for bucketing
   only. Turning the four corners is exact; nothing downstream depends on it
   being tight. */
function worldSpan(b, f) {
  if (!f) return [b.minX, b.maxX, b.minZ, b.maxZ];
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  const xs = [], zs = [];
  for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]]) {
    xs.push(f.x + x * c + z * s);
    zs.push(f.z - x * s + z * c);
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}
const STEP_UP = 0.55;   // anything lower than this is stepped over
const HEAD = 1.9;       // anything starting above this is ducked under

export class Blockers {
  constructor() {
    this.cells = new Map();   // "cx,cz" → [box]
    this.byUid = new Map();   // uid → [box]
  }

  _key(cx, cz) { return cx + "," + cz; }

  /* boxes: { minX, maxX, minZ, maxZ, minY, maxY, door } in the PLACEMENT's
     own axes; `frame` is where that placement stands and how far it is
     turned. Keeping the two apart is what makes an angled building solid
     only where it is solid — see Props._registerPhysical. A frame-less call
     still works and means "already in world axes", which is what an
     un-rotated placement effectively is. */
  set(uid, boxes, frame = null) {
    this.remove(uid);
    if (!boxes.length) return;
    /* The frame is kept whenever there IS one, not only when it turns.
       Dropping it for `rot === 0` looks like an optimisation and is a
       catastrophe: the boxes are in the placement's own axes, so without the
       frame they are read as world coordinates and the entire building's
       collision is displaced to the world origin. Every UNROTATED building
       became something you walked straight through — visible, solid-looking,
       and no more physical than the sky. It was the rotated ones that still
       worked, which is the exact opposite of the bug it replaced, and it took
       a real browser to see it: the analytic checker always carries the
       frame, so it reported the buildings as fine. */
    const f = frame ? { x: frame.x || 0, z: frame.z || 0, rot: frame.rot || 0 } : null;
    this.byUid.set(uid, boxes);
    for (const b of boxes) {
      b.uid = uid;
      b.frame = f;
      b.keys = [];
      // Bucketed by the world rectangle the box could touch — conservative
      // on purpose, because a bucket miss is a wall you walk through and a
      // bucket that is too big only costs a few extra tests.
      const [wx0, wx1, wz0, wz1] = worldSpan(b, f);
      for (let cx = Math.floor(wx0 / CELL); cx <= Math.floor(wx1 / CELL); cx++) {
        for (let cz = Math.floor(wz0 / CELL); cz <= Math.floor(wz1 / CELL); cz++) {
          const k = this._key(cx, cz);
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(b);
          b.keys.push(k);
        }
      }
    }
  }

  // Only the buckets a box was filed under are touched — a maze re-seats
  // hundreds of blocks at once, so sweeping every cell here would show.
  remove(uid) {
    const boxes = this.byUid.get(uid);
    if (!boxes) return;
    this.byUid.delete(uid);
    for (const b of boxes) {
      for (const k of b.keys || []) {
        const list = this.cells.get(k);
        if (!list) continue;
        const i = list.indexOf(b);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) this.cells.delete(k);
      }
    }
  }

  clear() { this.cells.clear(); this.byUid.clear(); }

  // Boxes possibly touching a circle at (x, z).
  near(x, z, r) {
    const out = [];
    const seen = new Set();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        for (const b of this.cells.get(this._key(cx, cz)) || []) {
          if (seen.has(b)) continue;
          seen.add(b);
          out.push(b);
        }
      }
    }
    return out;
  }

  /* Where a point falls in a box's own axes. A circle is the same circle
     however the box is turned, so the radius needs no adjustment — only the
     centre moves. */
  static localOf(b, x, z) {
    if (!b.frame) return [x, z];
    const dx = x - b.frame.x, dz = z - b.frame.z;
    const c = Math.cos(b.frame.rot), s = Math.sin(b.frame.rot);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  /* The highest thing you could be standing ON here.
     Walk mode used to seat the player on the TERRAIN and nothing else — the
     comment above said so — which meant every floor, plinth, bridge deck,
     stair tread and doorstep in the world was scenery you walked through at
     ground level. A building's own floor was not a floor. That is most of
     what "generated walkable paths are not walkable" means: the paths were
     there, and the player was underneath them.

     A box counts when its top is within a step of the feet (higher than that
     is a wall, and `blocked` already stops you at it) and when the player's
     circle actually overlaps it. Returns -Infinity where there is nothing,
     so the caller falls back to the ground and gravity does the rest. */
  surfaceAt(x, z, feetY, radius, isOpen) {
    let best = -Infinity;
    for (const b of this.near(x, z, radius)) {
      if (b.maxY > feetY + STEP_UP) continue;      // a step too high is a wall
      if (b.maxY <= best) continue;
      if (b.door && isOpen && isOpen(b.uid)) continue;
      const [lx, lz] = Blockers.localOf(b, x, z);
      const nx = Math.max(b.minX, Math.min(lx, b.maxX));
      const nz = Math.max(b.minZ, Math.min(lz, b.maxZ));
      if ((nx - lx) * (nx - lx) + (nz - lz) * (nz - lz) < radius * radius) best = b.maxY;
    }
    return best;
  }

  // Would a player of `radius` standing with feet at `feetY` overlap here?
  // `isOpen(uid)` lets a swung-away door leaf stop blocking its own doorway.
  blocked(x, z, feetY, radius, isOpen) {
    for (const b of this.near(x, z, radius)) {
      if (b.maxY < feetY + STEP_UP) continue;   // step over it
      if (b.minY > feetY + HEAD) continue;      // duck under it
      if (b.door && isOpen && isOpen(b.uid)) continue; // the door swung aside
      const [lx, lz] = Blockers.localOf(b, x, z);
      const nx = Math.max(b.minX, Math.min(lx, b.maxX));
      const nz = Math.max(b.minZ, Math.min(lz, b.maxZ));
      if ((nx - lx) * (nx - lx) + (nz - lz) * (nz - lz) < radius * radius) return true;
    }
    return false;
  }

  // Swept, axis-separated slide. Testing only the destination would let a
  // sprint (or one long frame) step clean over a 0.35 m wall, so the move is
  // walked in sub-steps no longer than the player's radius; at each one,
  // whichever axis is legal survives, which is what slides you along a wall.
  resolve(fromX, fromZ, toX, toZ, feetY, radius, isOpen) {
    if (!this.cells.size) return { x: toX, z: toZ };
    const dx = toX - fromX, dz = toZ - fromZ;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (radius * 0.8)));
    let x = fromX, z = fromZ;
    // Once an axis is stopped it stays stopped for the rest of the move —
    // otherwise a later sub-step lands clear on the far side of a thin wall
    // and the sweep hops straight over it.
    let stopX = false, stopZ = false;
    for (let i = 1; i <= steps && !(stopX && stopZ); i++) {
      const nx = stopX ? x : fromX + (dx * i) / steps;
      const nz = stopZ ? z : fromZ + (dz * i) / steps;
      if (!this.blocked(nx, nz, feetY, radius, isOpen)) { x = nx; z = nz; continue; }
      if (!stopX && !this.blocked(nx, z, feetY, radius, isOpen)) x = nx; else stopX = true;
      if (!stopZ && !this.blocked(x, nz, feetY, radius, isOpen)) z = nz; else stopZ = true;
    }
    return { x, z };
  }
}
