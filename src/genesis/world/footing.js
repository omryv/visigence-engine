/* footing.js — a building brings its own ground.
 *
 * The bug this exists to kill: you stand in a house and the hillside is
 * inside it with you. Grass through the floorboards, and on a shore the sea.
 *
 * It happened because a placement is seated by sampling the terrain at ONE
 * point — the record's centre — and a building is nine to thirteen metres
 * across. Level ground under the middle says nothing about the corners, and
 * the corners are where you look. Across the world builds of the time that put
 * terrain up to 0.89 m ABOVE the floor of the room it was supposed to be
 * under.
 *
 * Sculpting cannot fix it. The sculpt grid is 257 cells over the whole world
 * — at a three-kilometre size that is eleven metres a cell, wider than the
 * house — so a flatten stroke under one building cannot even be drawn. The
 * settlement pads work at settlement scale and leave tens of centimetres of
 * undulation across any single plot, which is exactly the range that ruins
 * a room.
 *
 * So the fix is the one a builder uses. Sample the ground the building
 * actually covers; stand its floor on the HIGHEST point, so no ground can
 * ever be above it; and fill the gap down to the LOWEST point with masonry,
 * so it is standing on something rather than floating over a slope. On level
 * ground the footing is nothing and costs nothing. On a hillside you get the
 * stepped foundation such a house would really have.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

const r2 = (v) => Math.round(v * 1000) / 1000;

// How far the footing is allowed to reach down before it is a retaining wall
// rather than a foundation. Past this the site is wrong, not the building.
export const MAX_DROP = 4.0;
// Ground this close under the floor needs no masonry to hide it.
export const SLACK = 0.05;

/* The plan extent of a proc, in local metres. Only pieces big enough to BE
   the building count — a chimney pot must not decide where the walls are —
   and the room envelopes count too, since a block that declares one is
   telling you what it encloses. */
export function planExtent(proc) {
  let w = 0, d = 0;
  for (const p of proc?.parts || []) {
    const dims = p.dims;
    if (!dims || p.shape !== "box") continue;
    if (dims[0] < 1.5 || dims[2] < 1.5) continue;
    w = Math.max(w, Math.abs(p.pos?.[0] ?? 0) * 2 + dims[0]);
    d = Math.max(d, Math.abs(p.pos?.[2] ?? 0) * 2 + dims[2]);
  }
  for (const r of proc?.rooms || []) {
    w = Math.max(w, Math.abs(r.x) * 2 + r.w);
    d = Math.max(d, Math.abs(r.z) * 2 + r.d);
  }
  return { w: w || 6, d: d || 6 };
}

/* The ground a placement actually stands on. Samples a grid over the rotated
   footprint rather than the one point under its centre, which is the whole
   point of this module. */
export function groundUnder({ record, sampler, steps = 5 }) {
  const proc = record.proc;
  const s = record.scale ?? 1;
  const { w, d } = planExtent(proc);
  const rot = record.rotationY || 0;
  const ax = Math.cos(rot), az = -Math.sin(rot);
  const bx = Math.sin(rot), bz = Math.cos(rot);
  const [ox, , oz] = record.position;
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const u = (i / steps - 0.5) * w * s, v = (j / steps - 0.5) * d * s;
      const h = sampler(ox + ax * u + bx * v, oz + az * u + bz * v);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  return { hi, lo, w: w * s, d: d * s };
}

/* A plinth of the right depth, as an ordinary editable placement. Emitted
   only when there is a gap worth filling: on the flat this returns null and
   the world pays nothing.

   Stepped rather than one tall box, because a four-metre wall of plaster
   under a cottage reads as a bug and a stepped foundation reads as a
   building on a hill. Each course is inset from the one above it. */
export function footingParts({ w, d, drop, color = 0x8f8b82 }) {
  /* Every course within one step of the one below it. A footing is the thing
     between the street and the door on a slope, so if its courses are taller
     than a stride it is a wall around the house rather than the way up to it
     — and walk mode steps over 0.55 m. */
  const courses = Math.max(1, Math.min(9, Math.ceil(drop / 0.5)));
  const parts = [];
  /* Built UPWARD from the origin, and the record is placed at the bottom of
     the drop rather than the top. That is not a stylistic choice: a
     seat:"point" placement is seated by its LOWEST point, not its origin
     (Props._groundY adds the origin-to-base lift even when a height is
     supplied), so a proc whose geometry hangs below its origin gets pushed up
     by exactly its own depth. Building upward makes the lift zero and the two
     agree. It cost one render to find and would have cost a hundred to
     explain — the footings floated a metre over the hillside. */
  const h = drop / courses;
  for (let i = 0; i < courses; i++) {
    // The lowest course is the widest: a footing spreads its load as it goes
    // down, and stepping is what makes a building on a hill read as built
    // into it rather than dropped on it.
    const grow = (courses - 1 - i) * 0.14;
    // Height and centre are rounded TOGETHER, so a course's underside lands
    // exactly on the one below it and the bottom one exactly on the origin.
    const hh = r2(h);
    parts.push({
      shape: "box", dims: [r2(w + grow), hh, r2(d + grow)],
      pos: [0, r2(hh * i + hh / 2), 0],
      bevel: 0.03, color, tex: "concrete",
    });
  }
  return { grime: 1.2, parts };
}

/* ── the pass ────────────────────────────────────────────────────────────
   Re-seat every building on the highest ground it covers and give it the
   footing that gap implies. Returns the seated records (new objects — the
   caller decides whether to keep them) and the footings to place with them.

   `seat: "point"` on the way out, because the whole point is that the height
   has already been decided and Props must not re-derive it from the centre
   sample that caused the problem. */
export function groundBuildings({ records, sampler, uidAt, index = 0, ref = "site/footing" }) {
  const seated = [];
  const footings = [];
  let n = index;
  for (const rec of records) {
    /* Buildings only, and a building is a thing that declares a room. A
       barrel does not need a foundation, and giving it one would seat it on
       the high point of a footprint it does not have. */
    if (!rec?.proc?.rooms?.length) { seated.push(rec); continue; }
    const g = groundUnder({ record: rec, sampler });
    if (!Number.isFinite(g.hi)) { seated.push(rec); continue; }
    // Stand on the high point: from here no ground under the building can be
    // above its floor, which is the invariant the room depends on.
    const y = g.hi;
    const stood = { ...rec, position: [rec.position[0], r2(y), rec.position[2]], seat: "point" };
    seated.push(stood);

    /* ── the way up to the door ──
       Standing on the high point is what keeps the hillside out of the room,
       and it is also what puts the front door up a cliff: on a slope the door
       is very often on the DOWNHILL face, and the floor then sits a metre or
       three above the ground you would walk up to it from. Nothing was ever
       built to bridge that. A walk of the four worlds could not get into one
       building in eight for this reason alone — the door was there, the room
       was furnished, and the threshold was a wall.

       The footing's own courses do not help: they are inset by 7 cm a side,
       which is a ledge, not a tread. So a building whose door stands proud of
       the ground gets a flight of real steps at it — risers inside a stride,
       treads wider than the player is, running out until they meet the hill.
       On the flat this emits nothing at all. */
    const steps = doorSteps({ record: stood, floorY: y, sampler });
    if (steps) {
      footings.push({
        uid: uidAt ? uidAt(n++) : `${rec.uid}-steps`,
        ref: "site/steps", url: null, label: "Steps",
        proc: steps.proc,
        position: [steps.x, r2(steps.baseY), steps.z],
        rotationY: r2(steps.rot), scale: 1, autoFit: false, seat: "point",
      });
    }

    const drop = Math.min(MAX_DROP, y - g.lo);
    if (drop <= SLACK) continue;
    footings.push({
      uid: uidAt ? uidAt(n++) : `${rec.uid}-footing`,
      ref, url: null, label: "Footing",
      proc: footingParts({ w: g.w, d: g.d, drop }),
      // At the BOTTOM of the drop: the courses rise from there to meet the
      // floor, and a point-seated placement is seated by its lowest point.
      position: [rec.position[0], r2(y - drop), rec.position[2]],
      rotationY: rec.rotationY || 0, scale: 1, autoFit: false, seat: "point",
    });
  }
  return { records: seated, footings, next: n };
}

/* How tall a step may be and still be a step. The walk controller climbs
   0.55 m (engine/player/collide.js) and the player is a 0.42 m circle, so a
   tread it can stand on has to be wider than that circle with room to spare —
   otherwise the next riser is inside the circle and the walk is stopped on a
   staircase it can see. */
export const RISER = 0.42;
export const TREAD = 1.1;
const MAX_FLIGHT = 12;      // steps; past this the site is wrong, not the door

/* Where a building says you come in, in its own metres, and how wide. */
function entranceOf(proc) {
  for (const p of proc?.ports || []) {
    if (p.kind === "door") return { x: p.pos[0], z: p.pos[2], w: p.width || 1.4 };
  }
  const leaf = (proc?.parts || []).find((p) => p.door && p.dims);
  if (proc?.door?.hinge) {
    const at = leaf ? leaf.pos : proc.door.hinge;
    return { x: at[0], z: at[2], w: leaf ? leaf.dims[0] : 1.4 };
  }
  return null;
}

/* A flight from the door down to the ground, or null where the ground is
   already at the door. Walks OUTWARD from the threshold a tread at a time,
   dropping a riser each time, and stops when the hill comes up to meet it —
   so a doorstep on gently falling ground is two steps and a house perched on
   a bank gets the stair it always needed. */
export function doorSteps({ record, floorY, sampler, riser = RISER, tread = TREAD }) {
  const proc = record.proc;
  const door = entranceOf(proc);
  if (!door) return null;
  const s = record.scale ?? 1;
  const rot = record.rotationY || 0;
  const c = Math.cos(rot), sn = Math.sin(rot);
  // The floor the door opens onto, and the direction "out" from it.
  const room = (proc.rooms || []).find((r) => r.at === "ground" && r.level === 0) || proc.rooms?.[0];
  const sill = floorY + (room?.y ?? 0) * s;
  const len = Math.hypot(door.x, door.z) || 1;
  const ux = door.x / len, uz = door.z / len;

  const groundAt = (out) => {
    const u = (door.x + ux * out) * s, v = (door.z + uz * out) * s;
    return sampler(record.position[0] + u * c + v * sn, record.position[2] - u * sn + v * c);
  };
  // Nothing to do when you can already step in.
  if (sill - groundAt(tread * 0.5) <= riser + SLACK) return null;

  const treads = [];
  let top = sill;
  for (let i = 0; i < MAX_FLIGHT; i++) {
    const out = (i + 1) * tread;
    top -= riser;
    treads.push({ out, top });
    if (top - groundAt(out + tread * 0.5) <= riser + SLACK) break;
  }
  const lowest = treads[treads.length - 1].top;
  const base = lowest - riser;               // local y = 0 sits here
  const width = Math.max(1.6, door.w * s + 0.6);
  const parts = treads.map((t, i) => {
    const h = t.top - base;
    return {
      shape: "box",
      // Each tread runs back UNDER the one above it, so the flight is one
      // solid stair rather than a row of slabs floating over a hillside.
      dims: [r2(width), r2(h), r2(tread * (i === 0 ? 1.4 : 1))],
      pos: [0, r2(h / 2), r2(t.out - tread / 2)],
      bevel: 0.02, color: 0x8f8b82, tex: "concrete",
    };
  });
  /* The record stands at the FOOT of the flight, on the door's own axis:
     local +z is "out through the door", so the placement's rotation is the
     building's own plus wherever in it the door faces. */
  const u0 = door.x * s, v0 = door.z * s;
  return {
    x: r2(record.position[0] + u0 * c + v0 * sn),
    z: r2(record.position[2] - u0 * sn + v0 * c),
    baseY: base,
    rot: Math.atan2(ux, uz) + rot,
    proc: { grime: 1.2, parts },
  };
}
