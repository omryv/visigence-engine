/* shelter.js — the volume a building encloses, as a thing the world can ask.
 *
 * A house was decoration standing on the world. Rain fell through its roof.
 * Every surface inside it got wet in a storm because wetness was ONE global
 * number multiplied into every material in the scene. Snow settled on the
 * kitchen table. The hearth burned exactly as brightly in a downpour as on a
 * still night, and the room was lit by as much open sky as the field outside
 * it, which is why interiors read flat.
 *
 * All of those are the same missing fact: nothing in the engine knew that a
 * roof is between a point and the sky. This module supplies it, once, and
 * everything physical reads it:
 *
 *   rain and snow particles   culled where a roof is over them
 *   surface wetness           a field now, not a global scalar
 *   snow cover                the same
 *   indirect light            sky ambient is what the sky can reach
 *   fire                      damped by the weather that actually gets to it
 *
 * THE SHAPE OF THE DATA. Rain is a camera-local volume — forty metres — so
 * shelter only has to be known near the viewer, and that is what makes this
 * affordable. A world-scale raster fine enough to resolve a doorway would be
 * millions of texels; a window that FOLLOWS the camera, 160 metres across at
 * two-thirds of a metre a texel, is 65k and resolves a doorway. It is rebuilt
 * when the camera leaves the cell it was built for, not per frame.
 *
 * Beyond that window everything reads as open sky, which is correct to look
 * at: at eighty metres you cannot see whether the inside of a barn is dry.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

/* A room envelope is measured INSIDE the walls, and walls here are 0.34 m,
   so the sheltered volume has to reach past it — but only far enough to cover
   the inner face. Reaching a FULL wall thickness put the outside face of
   every exterior wall inside the volume, and since shelter also cuts sky
   light, that painted every building in the world dark from the street. The
   inside of the wall is indoors; the outside of it is not. */
const WALL = 0.1;
// A roof is over you until you are above its underside. The slack keeps a
// person standing on the floor from being counted as outdoors.
const HEAD = 0.05;

/* Every enclosed volume a placement owns, in world space. One per declared
   room: that is precisely the space the shell wraps, and a block that
   declares no room encloses nothing anybody can stand in. */
export function shelterVolumes(record, toWorld) {
  const rooms = record?.proc?.rooms;
  if (!rooms?.length) return [];
  const s = record.scale ?? 1;
  const rot = record.rotationY || 0;
  return rooms.map((rm) => {
    const [x, y, z] = toWorld(record, [rm.x, rm.y, rm.z]);
    return {
      uid: record.uid, x, z, rot,
      w: (rm.w + WALL * 2) * s, d: (rm.d + WALL * 2) * s,
      floorY: y, roofY: y + rm.h * s,
    };
  });
}

// Is this point inside that volume? Rotated-rect test, done exactly — the
// raster is an approximation of this, not the other way round.
export function inVolume(v, x, y, z) {
  if (y > v.roofY || y < v.floorY - HEAD) return false;
  const dx = x - v.x, dz = z - v.z;
  const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
  const u = dx * c + dz * sn, w = -dx * sn + dz * c;
  return Math.abs(u) <= v.w / 2 && Math.abs(w) <= v.d / 2;
}

/* The exact query, for the handful of callers that want truth rather than a
   texture: fire, gameplay, tests. Returns 1 under a roof, 0 under the sky. */
export function shelterAt(volumes, x, y, z) {
  for (const v of volumes) if (inVolume(v, x, y, z)) return 1;
  return 0;
}

/* ── the raster ─────────────────────────────────────────────────────────
   A window on the world that follows the viewer. Each texel carries the
   underside of the lowest roof over that column and the floor under it, so a
   shader can answer "is this fragment indoors" from its own world position
   with one lookup and two compares.

   Encoded as RGBA bytes because that is what an ordinary texture upload
   wants and because a metre of precision either way is invisible: heights
   are stored relative to the window's own base, in 8-bit, over a 64 m range
   (0.25 m a step), with a second byte of low bits for the roof so the plane
   a person stands under is accurate to a centimetre. */
export const SPAN = 160;          // metres across the window
export const RES = 256;           // texels — 0.625 m each
export const RANGE = 64;          // metres of height the encoding covers

export class ShelterField {
  constructor({ span = SPAN, res = RES } = {}) {
    this.span = span;
    this.res = res;
    this.cell = span / res;
    this.data = new Uint8Array(res * res * 4);
    this.volumes = [];
    this.originX = NaN;
    this.originZ = NaN;
    this.baseY = 0;
    this.version = 0;
  }

  // The building set changes rarely — a world build, a placement, a delete.
  setVolumes(volumes) {
    this.volumes = volumes || [];
    this.originX = NaN;                 // force the next update to redraw
    return this;
  }

  // Has the viewer left the cell this was drawn for?
  needsUpdate(x, z) {
    return !(Math.abs(x - this.originX) < this.span * 0.15
          && Math.abs(z - this.originZ) < this.span * 0.15);
  }

  /* Redraw around a point. Only the volumes that actually overlap the window
     are touched, so a world of two hundred buildings costs whatever is on
     screen rather than two hundred rasterisations. */
  update(cx, cz, force = false) {
    if (!force && !this.needsUpdate(cx, cz)) return false;
    this.originX = cx;
    this.originZ = cz;
    const { res, span, cell, data } = this;
    data.fill(0);
    const x0 = cx - span / 2, z0 = cz - span / 2;
    // Heights are stored against a base near the ground here, so the 64 m
    // encoding range is spent where the buildings are.
    let base = Infinity;
    const near = [];
    for (const v of this.volumes) {
      const reach = Math.hypot(v.w, v.d) / 2;
      if (Math.abs(v.x - cx) > span / 2 + reach) continue;
      if (Math.abs(v.z - cz) > span / 2 + reach) continue;
      near.push(v);
      if (v.floorY < base) base = v.floorY;
    }
    this.baseY = Number.isFinite(base) ? base - 2 : 0;
    this.version++;
    if (!near.length) return true;

    const enc = (y) => Math.max(0, Math.min(65535,
      Math.round(((y - this.baseY) / RANGE) * 65535)));

    for (const v of near) {
      // Loop the texels of this volume's own bounding box, not the window's.
      const reach = Math.hypot(v.w, v.d) / 2;
      const i0 = Math.max(0, Math.floor((v.x - reach - x0) / cell));
      const i1 = Math.min(res - 1, Math.ceil((v.x + reach - x0) / cell));
      const j0 = Math.max(0, Math.floor((v.z - reach - z0) / cell));
      const j1 = Math.min(res - 1, Math.ceil((v.z + reach - z0) / cell));
      const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
      const roof = enc(v.roofY), floor = enc(v.floorY);
      for (let j = j0; j <= j1; j++) {
        const wz = z0 + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const wx = x0 + (i + 0.5) * cell;
          const dx = wx - v.x, dz = wz - v.z;
          const u = dx * c + dz * sn, ww = -dx * sn + dz * c;
          if (Math.abs(u) > v.w / 2 || Math.abs(ww) > v.d / 2) continue;
          const k = (j * res + i) * 4;
          // Lowest roof wins: standing on the ground floor of a tower, the
          // thing between you and the sky is the ceiling, not the parapet.
          const had = data[k + 3] !== 0;
          const cur = (data[k] << 8) | data[k + 1];
          if (had && cur <= roof) continue;
          data[k] = roof >> 8; data[k + 1] = roof & 255;
          data[k + 2] = Math.min(255, floor >> 8);
          data[k + 3] = 255;
        }
      }
    }
    return true;
  }

  // What the shader is told, so the two cannot drift apart.
  uniforms() {
    return {
      origin: [this.originX - this.span / 2, this.originZ - this.span / 2],
      scale: 1 / this.span,
      baseY: this.baseY,
      range: RANGE,
    };
  }

  /* Read the raster back the way the shader does. Exists so the tests can
     check the encoded field against the exact volume test rather than
     against itself. */
  sample(x, y, z) {
    const { res, span, data } = this;
    const u = (x - (this.originX - span / 2)) / span;
    const w = (z - (this.originZ - span / 2)) / span;
    if (u < 0 || w < 0 || u >= 1 || w >= 1) return 0;
    const i = Math.min(res - 1, Math.floor(u * res));
    const j = Math.min(res - 1, Math.floor(w * res));
    const k = (j * res + i) * 4;
    if (!data[k + 3]) return 0;
    const roofY = this.baseY + (((data[k] << 8) | data[k + 1]) / 65535) * RANGE;
    const floorY = this.baseY + ((data[k + 2] << 8) / 65535) * RANGE;
    return y <= roofY && y >= floorY - 2.5 ? 1 : 0;
  }
}

/* ── apertures ──────────────────────────────────────────────────────────
   Where the shelter leaks. A doorway and an unglazed window are holes in the
   envelope, and a hole is what makes the rest of this system visible: the
   rain that gets in, the draught that reaches the fire, the strip of floor
   inside a window that is dark with wet while the rest of the room is dry.

   Derived from what the shell already declares rather than authored twice —
   an extruded wall with holes in it IS the list of openings, and that is the
   one place the truth lives. */
export function aperturesOf(record, toWorld) {
  const out = [];
  const proc = record?.proc;
  if (!proc?.parts) return out;
  const s = record.scale ?? 1;
  const rot = record.rotationY || 0;
  // The rooms this building encloses, so an opening can say which floor it
  // looks onto — the wet lands on boards, not at the height of the sill.
  const vols = shelterVolumes(record, toWorld);
  for (const p of proc.parts) {
    if (p.shape !== "extrude" || !p.holes?.length) continue;
    for (const hole of p.holes) {
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const [hx, hy] of hole) {
        lo = [Math.min(lo[0], hx), Math.min(lo[1], hy)];
        hi = [Math.max(hi[0], hx), Math.max(hi[1], hy)];
      }
      const w = (hi[0] - lo[0]) * s, h = (hi[1] - lo[1]) * s;
      // An opening is something a person fits through or looks out of.
      // Bigger than that is structure — a colonnade, an open front, a gap the
      // shell leaves for the whole entrance face — and reading those as
      // windows produced a ten-metre "door" on every block in the world.
      if (w < 0.3 || h < 0.3 || w > 3.2 || h > 3.0) continue;
      // Hole coordinates are in the extrusion's own plane: x along the wall,
      // y up it. The part's pos puts that plane in the building.
      const cu = (lo[0] + hi[0]) / 2, cv = (lo[1] + hi[1]) / 2;
      const pc = Math.cos(p.rotY || 0), ps = Math.sin(p.rotY || 0);
      const local = [
        (p.pos?.[0] ?? 0) + cu * pc,
        (p.pos?.[1] ?? 0) + cv,
        (p.pos?.[2] ?? 0) - cu * ps,
      ];
      const [x, y, z] = toWorld(record, local);
      /* Inward is toward the middle of the plan. Taking it from the wall's
         own rotation looks tidier and is wrong: these walls are placed slabs,
         so a part's +z faces out on the front of a building and in on the
         back. Which side of the centre the opening sits on is the fact that
         does not depend on how the slab happened to be authored. */
      const len = Math.hypot(local[0], local[2]) || 1;
      const iu = -local[0] / len, iv = -local[2] / len;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const nx = iu * cr + iv * sr, nz = -iu * sr + iv * cr;
      /* Is anything IN it? A window with a pane and a doorway with a leaf in
         it are drawn as a hole in the wall plus a slab filling the hole, so
         the hole alone is not an opening — spray was coming through glazed
         windows. A part sitting in the gap, of about its size, is what is
         stopping the weather; a door leaf says so itself. */
      /* Is anything IN it? A hole in a wall is not an opening if a pane or
         a leaf fills it — spray was coming through glazed windows. The wall
         lies in a plane; a filling part is one in that plane that COVERS the
         gap. Containment, not proximity: this catalogue glazes a whole face
         with one lit slab, so a centre test saw only the middle window of a
         row as glazed and let the rain through the rest. */
      const sideOn = Math.abs(Math.sin(p.rotY || 0)) > 0.5;
      const along = sideOn ? 2 : 0;              // the in-plane horizontal axis
      const normal = sideOn ? 0 : 2;
      const span = (q, ax) => (ax === 0 ? q.dims[0] : q.dims[2]);
      const fill = proc.parts.find((q) => q !== p && q.shape === "box" && q.dims
        && Math.abs((q.pos?.[normal] ?? 0) - local[normal]) < 0.75
        && Math.abs((q.pos?.[along] ?? 0) - local[along]) + w / 2 <= span(q, along) / 2 + 0.06
        && Math.abs((q.pos?.[1] ?? 0) - local[1]) + h / 2 <= q.dims[1] / 2 + 0.06);

      // A step inward lands in the room it opens onto; that room's floor is
      // what the weather coming through it falls on.
      const inside = vols.find((v) => inVolume(v, x + nx * 1.0, y, z + nz * 1.0))
                  || vols.find((v) => inVolume(v, x + nx * 1.0, v.floorY + 0.3, z + nz * 1.0));
      out.push({
        uid: record.uid, x, y, z, w, h, nx, nz,
        floorY: inside ? inside.floorY : y - h / 2,
        /* Shut unless something opens it. A hinged leaf can be opened — the
           engine's door system knows which — and an unfilled gap was never
           shut in the first place. This is what makes the weather coming in
           an EVENT rather than a decoration: leave the door open in a storm
           and the floor inside it goes dark. */
        blocked: !!fill,
        hinged: !!fill?.door,
        // A doorway reaches the floor; a window does not, and what comes
        // through one lands further in and higher up.
        kind: lo[1] < 0.4 ? "door" : "window",
      });
    }
  }
  return out;
}

/* The way in, as an opening that can be OPEN. A hinged leaf is not a hole in
   a wall — it is a hole with a door in it — so it never shows up in the pass
   above, which is exactly right until somebody opens it. A block declares its
   pivot (proc.door), and that is enough to say where the weather comes in
   when the leaf swings.

   This is what makes the whole shelter system something you can watch happen
   rather than something you have to be told about: stand in a hall in a
   storm, push the door open, and the rain comes in and the floor inside it
   goes dark. */
export function doorApertureOf(record, toWorld) {
  const d = record?.proc?.door;
  if (!d?.hinge) return null;
  const s = record.scale ?? 1;
  const rot = record.rotationY || 0;
  const vols = shelterVolumes(record, toWorld);
  // The leaf is the part flagged `door`; the hinge is at its swinging edge.
  const leaf = (record.proc.parts || []).find((p) => p.door && p.dims);
  const w = (leaf ? leaf.dims[0] : 1.4) * s;
  const h = (leaf ? leaf.dims[1] : 2.2) * s;
  const local = leaf ? leaf.pos : [d.hinge[0], d.hinge[1] + h / 2, d.hinge[2]];
  const [x, y, z] = toWorld(record, [local[0], local[1], local[2]]);
  const len = Math.hypot(local[0], local[2]) || 1;
  const iu = -local[0] / len, iv = -local[2] / len;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const nx = iu * cr + iv * sr, nz = -iu * sr + iv * cr;
  const inside = vols.find((v) => inVolume(v, x + nx * 1.0, v.floorY + 0.5, z + nz * 1.0));
  return {
    uid: record.uid, x, y, z, w, h, nx, nz,
    floorY: inside ? inside.floorY : y - h / 2,
    blocked: true, hinged: true, kind: "door",
  };
}
