/* interior-validate.js — stage 8, and the only honest way to claim any of it.
 *
 * The solver enforces its constraints as it places, which is the right design:
 * refusing a bad position is better than detecting one afterwards. But a
 * system that only enforces has no way to be WRONG out loud. This module is
 * the independent check — it re-derives every rule from the finished layout,
 * knowing nothing about how the layout was reached, and names what it finds.
 *
 * That separation is the point. The planner and the validator can only agree
 * by both being right; if the planner develops a blind spot, the validator
 * does not inherit it, because it does not share a line of code with it.
 * Every violation code below corresponds to a failure the tests then assert
 * cannot occur across hundreds of generated buildings.
 *
 * Pure JS — no three.js — so it runs under the JavaScriptCore tests.
 */

import { CATALOGUE, WALK } from "./furniture.js";
import { PROGRAMS } from "./interior-plan.js";
import { AFFORD, USES, useSpots } from "./affordance.js";

export const CODES = {
  INTERSECT: "two objects occupy the same floor",
  OUT_OF_BOUNDS: "an object crosses a wall",
  BLOCKS_DOOR: "the way in is obstructed",
  UNREACHABLE: "an object cannot be walked to",
  FLOATING: "an object rests on nothing",
  WALL_DETACHED: "a wall fitting is not on a wall",
  HEAVY_UNSUPPORTED: "a heavy object is off the floor",
  SEAT_UNUSABLE: "seating with nothing to sit at",
  DARK: "usable floor with no light reaching it",
  OUT_OF_PROGRAM: "an object with no reason to be in this room",
  CLUTTER: "too little floor left to move",
  EMPTY: "a room that was not furnished",
  // ── what the affordance layer made checkable ──
  UNUSABLE: "an object offers an action with nowhere to stand and do it",
  BLOCKS_WINDOW: "a window is built out by what stands in front of it",
  BLOCKS_FIXTURE: "an object stands in what the building itself owns",
  DEAD_LIGHT: "a light that falls on no floor anybody can stand on",
  UNLIT_TASK: "a surface people work at, with nothing to see by",
};

const CELL = 0.25;
const boxOf = (p) => {
  const c = Math.abs(Math.cos(p.rot)), s = Math.abs(Math.sin(p.rot));
  return { x: p.x, z: p.z, w: p.foot.w * c + p.foot.d * s, d: p.foot.w * s + p.foot.d * c };
};
const overlap = (a, b) => Math.min(
  (a.w + b.w) / 2 - Math.abs(a.x - b.x),
  (a.d + b.d) / 2 - Math.abs(a.z - b.z));

/* Which tags a room has any use for. A bed in a warehouse and a forge in a
   bedroom are the same failure: an object with no functional reason to be
   where it is. Derived from the programme's own lists rather than declared
   twice, so the two cannot drift. */
function programTags(programId) {
  const p = PROGRAMS[programId];
  if (!p) return null;
  const ids = new Set([...p.must, ...p.may.map(([id]) => id)]);
  const tags = new Set();
  for (const id of ids) for (const t of CATALOGUE[id]?.tags || []) tags.add(t);
  // Seating, light and small surface things belong in any room that has a
  // surface or a seat to put them on — they are not programme-specific.
  for (const t of ["sit", "light", "eat", "book", "soft", "show"]) tags.add(t);
  return { ids, tags };
}

/**
 * @param room     {w, d, h} local metres, origin at the centre
 * @param placed   the planner's output
 * @param door     {x, side}
 * @param programId  which programme the room was planned to
 * @param blocked  rectangles the building owns (stair, chimney)
 * @param extraIds  ids the household itself justifies (a weaver's loom), which
 *                  the programme would not have offered. Everything else is
 *                  re-derived here; this is the one thing the planner is
 *                  allowed to tell the validator, because the reason lives in
 *                  the occupant profile rather than in the room.
 * @param openings  every doorway on this room's perimeter, not only the one it
 *                  is entered by. A room can be enterable and still be a dead
 *                  end for the room behind it.
 * @param glazed    which of this room's four sides the building put windows in
 * @returns {ok, violations:[{code, id, detail}], stats}
 */
export function validateRoom({ room, placed, door, programId, blocked = [], extraIds = null,
                               openings = null, glazed = null }) {
  const v = [];
  const add = (code, id, detail) => v.push({ code, id, detail });
  const floor = placed.filter((p) => !p.host && !CATALOGUE[p.id]?.flat);
  const prog = programTags(programId);
  const ways = openings?.length ? openings : [door];

  /* ── bounds and intersection ── */
  for (let i = 0; i < floor.length; i++) {
    const a = boxOf(floor[i]);
    if (Math.abs(a.x) + a.w / 2 > room.w / 2 + 0.02 || Math.abs(a.z) + a.d / 2 > room.d / 2 + 0.02) {
      add("OUT_OF_BOUNDS", floor[i].id,
        `${(Math.abs(a.x) + a.w / 2 - room.w / 2).toFixed(2)}m past the wall`);
    }
    for (let j = i + 1; j < floor.length; j++) {
      const ov = overlap(a, boxOf(floor[j]));
      if (ov > 0.02) add("INTERSECT", `${floor[i].id}/${floor[j].id}`, `${ov.toFixed(2)}m`);
    }
    /* ── what the building itself owns ──
       A stairwell, a shaft, a chimney breast. The navigation pass below marks
       these solid so nothing has to walk through them, which is not the same
       as noticing that something is STANDING in one — and a chest inside the
       staircase is invisible to a check that only asks whether the floor is
       crossable. */
    for (const b of blocked) {
      const ov = overlap(a, { x: b.x, z: b.z, w: b.w, d: b.d });
      if (ov > 0.02) add("BLOCKS_FIXTURE", floor[i].id, `${ov.toFixed(2)}m into the stair or shaft`);
    }
    /* ── the windows ──
       Anything reaching the sill, standing against a wall the building glazed.
       A height rule rather than a ban: a chest under a window is a window
       seat, and a wardrobe across one is a bricked-up window with a wardrobe
       in front of it. */
    const tall = (floor[i].foot?.h ?? 0) >= SILL;
    if (tall) {
      for (const side of glazed || []) {
        if (!againstSide(a, room, side)) continue;
        add("BLOCKS_WINDOW", floor[i].id, `${(floor[i].foot.h).toFixed(2)}m tall against the ${side} glazing`);
      }
    }
  }

  /* ── support ──
     Anything off the floor has to be standing on something that is really
     there, at really that height. */
  for (const p of placed) {
    const spec = CATALOGUE[p.id];
    if (!spec) { add("OUT_OF_PROGRAM", p.id, "not in the catalogue"); continue; }
    if (spec.heavy && p.y > 0.02) add("HEAVY_UNSUPPORTED", p.id, `at ${p.y}m`);
    if (spec.anchor === "surface") {
      if (!(p.y > 0.02)) add("FLOATING", p.id, "on a surface but at floor level");
      /* Which piece it is standing on is asked of the GEOMETRY, not taken on
         the planner's word. A room with two worktops in it has two candidates
         for the same name, and believing the first one found reported crockery
         on the near counter as floating over the far one. */
      /* A candidate host is anything standing on the floor or fixed to the
         wall — a wall shelf holds a candle exactly as a table does. What it
         may not be is something already standing on something else. */
      const holds = (h) => h.id === p.host && (!h.host || h.host === "wall");
      const over = placed.filter(holds)
        .map((h) => boxOf(h))
        .filter((b) => Math.abs(p.x - b.x) <= b.w / 2 + 0.05 && Math.abs(p.z - b.z) <= b.d / 2 + 0.05);
      if (!over.length) {
        const any = placed.some(holds);
        add("FLOATING", p.id, any ? `stands off the edge of every ${p.host} in the room`
                                  : `host ${p.host} is not in the room`);
      }
    }
    if (spec.anchor === "wallHigh") {
      const toWall = Math.min(room.w / 2 - Math.abs(p.x), room.d / 2 - Math.abs(p.z));
      if (toWall > 0.3) add("WALL_DETACHED", p.id, `${toWall.toFixed(2)}m off the wall`);
      if (!(p.y > 1.0)) add("WALL_DETACHED", p.id, `mounted at ${p.y}m`);
    }
    if (spec.anchor === "companion") {
      // Likewise: the nearest table of that name, not the first one in the
      // list, because a hall has several and a chair belongs to one of them.
      let gap = Infinity;
      for (const h of placed) {
        if (h.id !== p.host || !CATALOGUE[h.id]?.seats) continue;
        gap = Math.min(gap, Math.hypot(p.x - h.x, p.z - h.z)
          - Math.max(h.foot.w, h.foot.d) / 2 - Math.max(p.foot.w, p.foot.d) / 2);
      }
      if (!Number.isFinite(gap)) add("SEAT_UNUSABLE", p.id, "nothing to sit at");
      else if (gap > 0.7) add("SEAT_UNUSABLE", p.id, `${gap.toFixed(2)}m from the nearest ${p.host}`);
    }
    if (prog && !p.host && !prog.ids.has(p.id) && !extraIds?.has(p.id)) {
      const tags = spec.tags || [];
      if (!tags.some((t) => prog.tags.has(t))) {
        add("OUT_OF_PROGRAM", p.id, `nothing to do in a ${programId}`);
      }
    }
  }

  /* ── navigation ──
     Rebuilt from the placements alone. Occupy the floor, erode by a person,
     flood from the doorway, and see what the flood reaches. */
  const nx = Math.max(2, Math.round(room.w / CELL));
  const nz = Math.max(2, Math.round(room.d / CELL));
  const solid = new Uint8Array(nx * nz);
  const mark = (b) => {
    const i0 = idx(b.x - b.w / 2, room.w, nx), i1 = idx(b.x + b.w / 2 - 1e-6, room.w, nx);
    const j0 = idx(b.z - b.d / 2, room.d, nz), j1 = idx(b.z + b.d / 2 - 1e-6, room.d, nz);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) solid[j * nx + i] = 1;
  };
  for (const p of floor) mark(boxOf(p));
  for (const b of blocked) mark({ x: b.x, z: b.z, w: b.w, d: b.d });

  const open = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let clear = true;
      for (let dj = -1; dj <= 1 && clear; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || solid[jj * nx + ii]) { clear = false; break; }
        }
      }
      open[j * nx + i] = clear ? 1 : 0;
    }
  }

  /* The standable cell nearest a doorway, or −1 if the way in is walled up by
     what was put in the room. Spiralling outward a cell at a time, because a
     doorway is a metre wide and the cell it nominally lands on can be the one
     the door frame is in. */
  const mouth = (way, rad0 = 6) => {
    const inward = way.side === "south" ? -1 : way.side === "north" ? 1 : 0;
    const dz = way.side === "south" ? room.d / 2 : way.side === "north" ? -room.d / 2 : 0;
    const sideways = way.side === "east" || way.side === "west";
    const di0 = sideways
      ? idx(way.side === "east" ? room.w / 2 - 0.5 : -room.w / 2 + 0.5, room.w, nx)
      : idx(way.x, room.w, nx);
    const dj0 = sideways ? idx(way.x, room.d, nz) : idx(dz + inward * 0.5, room.d, nz);
    for (let rad = 0; rad <= rad0; rad++) {
      for (let dj = -rad; dj <= rad; dj++) {
        for (const dii of [-(rad - Math.abs(dj)), rad - Math.abs(dj)]) {
          const ii = di0 + dii, jj = dj0 + dj;
          if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && open[jj * nx + ii]) return jj * nx + ii;
        }
      }
    }
    return -1;
  };

  const start = mouth(door);
  const seen = new Uint8Array(nx * nz);
  let reached = 0;
  if (start < 0) {
    add("BLOCKS_DOOR", culprit(floor, room, door), "no standable cell within 1.5m of the doorway");
  } else {
    const q = [start]; seen[start] = 1;
    while (q.length) {
      const p = q.pop(); reached++;
      const i = p % nx, j = (p / nx) | 0;
      for (const nb of [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, j > 0 ? p - nx : -1, j < nz - 1 ? p + nx : -1]) {
        if (nb >= 0 && open[nb] && !seen[nb]) { seen[nb] = 1; q.push(nb); }
      }
    }
    for (const p of floor) {
      const b = boxOf(p);
      const pad = (CATALOGUE[p.id]?.clear || WALK) + 0.3;
      if (!touches(seen, nx, nz, room, b.x, b.z, b.w + pad * 2, b.d + pad * 2)) {
        add("UNREACHABLE", p.id, "no route from the doorway");
      }
    }

    /* ── every OTHER way out ──
       Reachable is not the same as passable. A room can be entered from the
       street and still be a wall as far as the room behind it is concerned,
       and a plan whose spanning tree runs through it is then a plan that does
       not work. Each opening is asked the same question the entrance was, and
       asked against the flood that started at the entrance, so a doorway
       standing clear on the far side of a barricade still fails. */
    for (const way of ways) {
      if (way === door) continue;
      /* HALF A METRE, not a metre and a half. The primary door is allowed a
         generous search because the cell it nominally lands on is where the
         LEAF is; an onward doorway is not, and the wide search was the whole
         reason this check passed on rooms that did not work. It found a
         standable cell a metre and a half to the SIDE of the pinched opening,
         saw the flood had reached that, and reported the doorway clear — so a
         room whose way through was shut stayed shut, three re-plans and a
         prune later. */
      const m = mouth(way, 2);
      if (m < 0 || !seen[m]) {
        add("BLOCKS_DOOR", culprit(floor, room, way), `the ${way.side} doorway cannot be walked to`);
      }
    }

    /* ── and everything that offers an action ──
       The brief's "chairs cannot be used because nearby geometry blocks
       them", generalised: a thing you can sit in, open, search, pick up, work
       at or light is a thing somebody has to be able to STAND somewhere to
       do. Which somewhere is the affordance layer's business (js/affordance.js
       useSpots) and the planner's answer is not consulted — this re-derives
       the spots from the finished placement and floods to them. */
    for (const p of placed) {
      const kind = AFFORD[p.id];
      if (!kind) continue;
      // A thing standing on something else is used across its host, and the
      // host's own usability already answers for it.
      if (p.host && p.host !== "wall") continue;
      const spots = useSpots(p, kind);
      if (!spots.length) continue;
      const okSpot = spots.some((sp) => {
        if (Math.abs(sp.x) > room.w / 2 || Math.abs(sp.z) > room.d / 2) return false;
        return !!seen[idx(sp.z, room.d, nz) * nx + idx(sp.x, room.w, nx)];
      });
      if (!okSpot) add("UNUSABLE", p.id, `nowhere to stand and ${USES[kind].verb.toLowerCase()}`);
    }
  }

  /* ── clutter ──
     A room you cannot cross is not furnished, it is filled. Measured as the
     share of the floor a person can still stand on. */
  const walkFrac = reached / (nx * nz);
  if (walkFrac < 0.14) add("CLUTTER", "-", `only ${(walkFrac * 100).toFixed(0)}% of the floor is standable`);
  if (floor.length === 0) add("EMPTY", "-", "nothing was placed");

  /* ── light ──
     Every part of the floor a person can stand on should be within reach of
     something that burns. */
  let dark = 0, lit = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!seen[j * nx + i]) continue;
      const x = -room.w / 2 + (i + 0.5) * CELL, z = -room.d / 2 + (j + 0.5) * CELL;
      const near = placed.some((p) => CATALOGUE[p.id]?.lights
        && Math.hypot(p.x - x, p.z - z) < CATALOGUE[p.id].lights);
      if (near) lit++; else dark++;
    }
  }
  if (dark + lit > 0 && dark / (dark + lit) > 0.55) {
    add("DARK", "-", `${((dark / (dark + lit)) * 100).toFixed(0)}% of the usable floor is unlit`);
  }

  /* ── a light has to fall on something ──
     "Light sources do not illuminate meaningful areas" is a different failure
     from a dark room, and a room can fail it while passing the coverage check
     above: a lamp walled into the back of a stack of crates lights the inside
     of the stack. Meaningful means floor a person can stand on. */
  for (const p of placed) {
    const reach = CATALOGUE[p.id]?.lights;
    if (!reach) continue;
    let onFloorLit = 0;
    for (let j = 0; j < nz && onFloorLit === 0; j++) {
      for (let i = 0; i < nx; i++) {
        if (!seen[j * nx + i]) continue;
        const x = -room.w / 2 + (i + 0.5) * CELL, z = -room.d / 2 + (j + 0.5) * CELL;
        if (Math.hypot(p.x - x, p.z - z) < reach) { onFloorLit = 1; break; }
      }
    }
    if (!onFloorLit) add("DEAD_LIGHT", p.id, `${reach}m of reach and no standable floor in it`);
  }

  /* ── and the places people actually need to see ──
     Floor coverage is about walking; this is about working. A workbench in
     the dark corner of a lit room passes every check above and is still a
     bench nobody could use after dusk, which is exactly the room the brief
     means by "where is light needed". Only the surfaces somebody stands and
     WORKS at are asked — a shelf of crocks does not need a candle on it. */
  for (const p of floor) {
    if (!TASK.some((t) => (CATALOGUE[p.id]?.tags || []).includes(t))) continue;
    const seenLight = placed.some((q) => {
      const reach = CATALOGUE[q.id]?.lights;
      return reach && Math.hypot(q.x - p.x, q.z - p.z) < reach + Math.max(p.foot.w, p.foot.d) / 2;
    });
    if (!seenLight) add("UNLIT_TASK", p.id, "no light within reach of a working surface");
  }

  return {
    ok: v.length === 0,
    violations: v,
    stats: { objects: placed.length, onFloor: floor.length, walkFrac: +walkFrac.toFixed(3),
             litFrac: +(lit / Math.max(1, lit + dark)).toFixed(3) },
  };
}

/* The tags that mean "somebody stands here and does something that needs
   seeing". Deliberately short: cooking, working a trade and reading are the
   three activities in this catalogue that fail in the dark. */
const TASK = ["work", "cook", "study"];

// The height above which a piece is in a window rather than under it.
const SILL = 1.05;

/* WHICH PIECE IS IN THE WAY. A blocked doorway used to be reported against
   "-", because no single object owns the failure: the room is blocked, and
   any of several things might be why.

   That was true and it was also the reason the fault survived to the world.
   Stage 9 re-plans a rejected room three times and then PRUNES what still
   will not pass, and the pruner works by name — so a violation naming nothing
   was a violation nothing could be done about, and a room whose second
   doorway was walled in shipped walled in. Measured, that was every one of
   the handful of unreachable rooms left in the project.

   The nearest floor piece to the blocked opening is the honest answer:
   whatever else is going on, that is the thing standing in the doorway, and
   taking it out is the repair a person would make. */
function culprit(floor, room, way) {
  const sideways = way.side === "east" || way.side === "west";
  const at = sideways
    ? { x: way.side === "east" ? room.w / 2 - 0.6 : -room.w / 2 + 0.6, z: way.x }
    : { x: way.x, z: way.side === "south" ? room.d / 2 - 0.6 : -room.d / 2 + 0.6 };
  let best = null, bestD = 3.0;
  for (const p of floor) {
    const gap = Math.hypot(p.x - at.x, p.z - at.z);
    if (gap < bestD) { bestD = gap; best = p.id; }
  }
  return best || "-";
}

// Is this box standing against the named side of the room? Half a metre of
// tolerance, which is a piece pushed back as far as its own trim allows.
function againstSide(b, room, side) {
  const band = 0.5;
  if (side === "north") return b.z - b.d / 2 < -room.d / 2 + band;
  if (side === "south") return b.z + b.d / 2 > room.d / 2 - band;
  if (side === "west") return b.x - b.w / 2 < -room.w / 2 + band;
  if (side === "east") return b.x + b.w / 2 > room.w / 2 - band;
  return false;
}

function idx(v, span, n) { return Math.min(n - 1, Math.max(0, Math.floor((v + span / 2) / CELL))); }
function touches(seen, nx, nz, room, x, z, w, d) {
  const i0 = idx(x - w / 2, room.w, nx), i1 = idx(x + w / 2, room.w, nx);
  const j0 = idx(z - d / 2, room.d, nz), j1 = idx(z + d / 2, room.d, nz);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (seen[j * nx + i]) return true;
  return false;
}

/* ── the floor, as one thing ────────────────────────────────────────────
   Everything above asks about ONE room. That is most of the work and it is
   not all of it: "furniture prevents navigation through the building" is not
   a property any room has. A plan can be four rooms each of which passes
   every check in this file and still be a building whose back half nobody can
   reach, because the failure lives in the join.

   So this rebuilds the WHOLE floor as one occupancy grid — every partition
   solid, every doorway a hole in one, every piece of furniture from every
   room in its place — and floods from the front door. What the flood does not
   reach is a room that exists on the drawing and nowhere else.

   It shares nothing with the zoner that produced the plan. The zoner proves
   its spanning tree is connected in the GRAPH; this asks whether it is
   connected on the FLOOR, after the rooms have been furnished, which is a
   different question and the one a player asks.

   @param zones    the plan, in floor-local metres, each with {x,z,w,d}
   @param doors    the openings that were cut: {axis, at, along, width}
   @param placed   every piece on the floor, in FLOOR-local metres
   @param entrance {x, z} where the way in meets the outside wall
   @returns {ok, violations, stats:{reachedZones, zones, walkFrac}}          */
export function validateFloor({ w, d, zones, doors = [], placed = [], entrance, wallT = 0.18 }) {
  const v = [];
  /* HALF THE PITCH OF A ROOM'S OWN GRID, and it is not an optimisation.
     Every room is checked on a grid whose origin is that room's centre; this
     one is a single grid over the whole storey, so the cell boundaries fall
     in different places and a 0.7 m gap that survives erosion in one
     alignment can vanish in the other. Measured, the two checks disagreed
     about one storey in forty and every disagreement was that and nothing
     else: a route the room could prove and the floor could not.

     Twice the resolution, twice the erosion radius, same 0.25 m of shoulder
     — a more accurate answer to the same question rather than a different
     question. It costs four times the cells of one pass per storey. */
  const cell = CELL / 2, erode = 2;
  const nx = Math.max(2, Math.round(w / cell));
  const nz = Math.max(2, Math.round(d / cell));
  const solid = new Uint8Array(nx * nz);
  const ix = (v0) => Math.min(nx - 1, Math.max(0, Math.floor((v0 + w / 2) / cell)));
  const iz = (v0) => Math.min(nz - 1, Math.max(0, Math.floor((v0 + d / 2) / cell)));
  const mark = (b) => {
    const i0 = ix(b.x - b.w / 2), i1 = ix(b.x + b.w / 2 - 1e-6);
    const j0 = iz(b.z - b.d / 2), j1 = iz(b.z + b.d / 2 - 1e-6);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) solid[j * nx + i] = 1;
  };

  /* THE WALLS FIRST, and they come from the zones rather than from a wall
     list: a room's boundary is a wall unless it is the outside of the
     building, and deriving it here is what keeps this check independent of
     whatever partitionRuns decided to emit. */
  for (const z of zones) {
    for (const [side, box] of [
      ["north", { x: z.x, z: z.z - z.d / 2 - wallT / 2, w: z.w + wallT, d: wallT }],
      ["south", { x: z.x, z: z.z + z.d / 2 + wallT / 2, w: z.w + wallT, d: wallT }],
      ["west", { x: z.x - z.w / 2 - wallT / 2, z: z.z, w: wallT, d: z.d + wallT }],
      ["east", { x: z.x + z.w / 2 + wallT / 2, z: z.z, w: wallT, d: z.d + wallT }],
    ]) { void side; mark(box); }
  }
  // …then the doorways punched back out of them, and the front door with them.
  const clear = (b) => {
    const i0 = ix(b.x - b.w / 2), i1 = ix(b.x + b.w / 2 - 1e-6);
    const j0 = iz(b.z - b.d / 2), j1 = iz(b.z + b.d / 2 - 1e-6);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) solid[j * nx + i] = 0;
  };
  for (const dr of doors) {
    clear(dr.axis === "x"
      ? { x: dr.at, z: dr.along, w: wallT * 4, d: dr.width }
      : { x: dr.along, z: dr.at, w: dr.width, d: wallT * 4 });
  }
  // The furniture, last, so nothing can be cleared out from under it.
  for (const p of placed) {
    if (!p.foot || (p.host && p.host !== "wall") || CATALOGUE[p.id]?.flat) continue;
    if (CATALOGUE[p.id]?.anchor === "wallHigh") continue;   // above head height
    mark(boxOf(p));
  }

  /* Erode by a person, then flood from just inside the way in.

     TWO 1-D PASSES, not one 2-D one. Eroding by a square is separable — a
     cell survives if it survives along x and then along z — so the cost per
     cell is 2(2r+1) rather than (2r+1)², and at the half-metre pitch this
     grid runs at that is the difference between five operations a cell and
     twenty-five. Same answer, exactly, because the structuring element is a
     square; it would not be for a disc, and a disc is not what a person
     walking down a corridor is. */
  const open = new Uint8Array(nx * nz);
  const rowPass = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let ok = i >= erode && i < nx - erode;
      for (let di = -erode; di <= erode && ok; di++) if (solid[j * nx + i + di]) ok = false;
      rowPass[j * nx + i] = ok ? 1 : 0;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let ok = j >= erode && j < nz - erode;
      for (let dj = -erode; dj <= erode && ok; dj++) if (!rowPass[(j + dj) * nx + i]) ok = false;
      open[j * nx + i] = ok ? 1 : 0;
    }
  }
  const seen = new Uint8Array(nx * nz);
  let start = -1;
  const ei = ix(entrance.x);
  const ej = iz(entrance.z - Math.sign(entrance.z || 1) * 0.8);
  for (let rad = 0; rad <= 16 && start < 0; rad++) {
    for (let dj = -rad; dj <= rad && start < 0; dj++) {
      for (const dii of [-(rad - Math.abs(dj)), rad - Math.abs(dj)]) {
        const ii = ei + dii, jj = ej + dj;
        if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && open[jj * nx + ii]) { start = jj * nx + ii; break; }
      }
    }
  }
  let reached = 0;
  if (start < 0) {
    v.push({ code: "BLOCKS_DOOR", id: "-", detail: "nowhere to stand inside the front door" });
  } else {
    const q = [start]; seen[start] = 1;
    while (q.length) {
      const p = q.pop(); reached++;
      const i = p % nx, j = (p / nx) | 0;
      for (const nb of [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1,
                        j > 0 ? p - nx : -1, j < nz - 1 ? p + nx : -1]) {
        if (nb >= 0 && open[nb] && !seen[nb]) { seen[nb] = 1; q.push(nb); }
      }
    }
  }

  let got = 0;
  const inside = (x, z, bw, bd) => {
    for (let j = iz(z - bd / 2); j <= iz(z + bd / 2); j++) {
      for (let i = ix(x - bw / 2); i <= ix(x + bw / 2); i++) if (seen[j * nx + i]) return true;
    }
    return false;
  };
  const reachedZone = zones.map((z) => inside(z.x, z.z, z.w - 0.4, z.d - 0.4));
  for (const z of zones) {
    if (reachedZone[z.index]) { got++; continue; }
    /* NAME THE PIECE, not only the room. Stage 9 repairs by removing what a
       violation names, so a fault that names a room is a fault nothing can be
       done about — the same reason a blocked doorway used to name "-" and
       shipped blocked. What stands between a cut-off room and the part of the
       building that CAN be reached is the honest answer, and taking it out is
       the repair a person would make. */
    v.push({ code: "UNREACHABLE", id: z.purpose || `zone ${z.index}`, zone: z.index,
      blame: blameFor(z, zones, doors, reachedZone, placed),
      detail: "no route to it from the front door once the floor is furnished" });
  }

  return {
    ok: v.length === 0,
    violations: v,
    stats: { zones: zones.length, reachedZones: got, walkFrac: +(reached / (nx * nz)).toFixed(3) },
  };
}

/* Which piece is standing between a cut-off room and the rest of the
   building. Every doorway from the room to somewhere the flood DID reach is a
   candidate route; the nearest solid thing to any of them is what shut it.
   Returns an index into `placed`, or −1 when nothing is near enough to blame
   — which happens, and is worth being able to say. */
function blameFor(zone, zones, doors, reachedZone, placed) {
  let best = -1, bestD = 2.6;
  for (const dr of doors) {
    const other = dr.a === zone.index ? dr.b : dr.b === zone.index ? dr.a : -1;
    if (other < 0 || !reachedZone[other]) continue;
    const at = dr.axis === "x" ? { x: dr.at, z: dr.along } : { x: dr.along, z: dr.at };
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (!p.foot || (p.host && p.host !== "wall") || CATALOGUE[p.id]?.flat) continue;
      if (CATALOGUE[p.id]?.anchor === "wallHigh") continue;
      const gap = Math.hypot(p.x - at.x, p.z - at.z);
      if (gap < bestD) { bestD = gap; best = i; }
    }
  }
  return best;
}

/* ── the corpus check ───────────────────────────────────────────────────
   "Repeated arrangements make different buildings visually identical" is not
   a property of one interior — no single room can be checked for it. It is a
   property of a SET, so it gets its own function, and the fingerprint is what
   a person would actually notice: which objects, and roughly where. */
export function distinctness(layouts) {
  const prints = layouts.map((placed) => placed
    .map((p) => `${p.id}@${Math.round(p.x / 0.5)},${Math.round(p.z / 0.5)}`)
    .sort().join("|"));
  const unique = new Set(prints).size;
  // …and the weaker question of whether the CONTENTS repeat, which catches a
  // generator that always picks the same objects and only moves them.
  const sets = new Set(layouts.map((p) => [...new Set(p.map((x) => x.id))].sort().join(",")));
  return {
    total: layouts.length, unique, uniqueFrac: unique / Math.max(1, layouts.length),
    distinctSets: sets.size,
  };
}
