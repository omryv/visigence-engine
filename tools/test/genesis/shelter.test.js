/* Shelter and footings: the two facts that make a building part of the world
 * rather than a thing standing on it.
 *
 * FOOTINGS answer "what is under the floor" — the fault that put a hillside,
 * and on a shore the sea, inside the room with you.
 * SHELTER answers "what is over your head" — the fault that let rain fall
 * through every roof, soaked the inside of every house in a storm, settled
 * snow on kitchen tables and left a room lit by as much open sky as the field
 * outside it.
 *
 * The raster is checked AGAINST the exact volume test rather than against
 * itself, because a field that agrees with nothing is just a picture.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { toWorld } from "../../../src/kernel/core/ports.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";
import { allItems } from "../../../src/genesis/world/props-packs.js";
import {
  ShelterField, shelterVolumes, shelterAt, inVolume, aperturesOf, doorApertureOf, SPAN, RES,
} from "../../../src/kernel/core/shelter.js";
import {
  groundBuildings, groundUnder, planExtent, footingParts, MAX_DROP,
} from "../../../src/genesis/world/footing.js";

const rec = (uid, proc, x = 0, z = 0, rotationY = 0, y = 0) => ({
  uid, ref: "street/block-stack", url: null, label: "B",
  proc, position: [x, y, z], rotationY, scale: 1,
});
const house = () => allItems().find((i) => i.id === "house").proc;
// A hillside that runs 1 in 8 along x, with a bump on it.
const slope = (x, z) => x * 0.125 + Math.sin(z * 0.21) * 0.4;
const flat = () => 10;

/* ══════════════════ footings ══════════════════ */

test("the plan extent is the building, not its chimney pot", () => {
  const e = planExtent(house());
  ok(e.w > 6 && e.w < 9, `a 7.3m house measured ${e.w}m across`);
  ok(e.d > 6 && e.d < 9, `and ${e.d}m deep`);
  const tall = planExtent(buildingParts({ floors: 6, tiers: 3, w: 13, d: 12 }));
  ok(tall.w >= 13 && tall.w < 16, `a 13m block measured ${tall.w}m`);
});

test("the ground under a building is sampled over its footprint, not its centre", () => {
  // The bug in one assertion: the centre says nothing about the corners.
  const r = rec("a", house(), 0, 0, 0, slope(0, 0));
  const g = groundUnder({ record: r, sampler: slope });
  ok(g.hi - g.lo > 0.8, `a 1-in-8 slope under a 7m house came to ${(g.hi - g.lo).toFixed(2)}m of fall`);
  ok(g.hi >= slope(0, 0) && g.lo <= slope(0, 0), "the centre sample was outside its own footprint");
});

test("a building stands on the highest ground it covers, so none is above its floor", () => {
  const proc = house();
  const room = proc.rooms[0];
  for (const rot of [0, 0.7, Math.PI / 2, 2.4]) {
    for (const [x, z] of [[0, 0], [40, -25], [-13, 60]]) {
      const out = groundBuildings({
        records: [rec("a", proc, x, z, rot, slope(x, z))], sampler: slope, uidAt: (i) => `f${i}`,
      });
      const seated = out.records[0];
      eq(seated.seat, "point", "the height was decided and then thrown away");
      const floorY = seated.position[1] + room.y;
      // Every corner of the room, in world space.
      const c = Math.cos(rot), s = Math.sin(rot);
      for (const u of [-0.5, 0, 0.5]) {
        for (const v of [-0.5, 0, 0.5]) {
          const lx = u * room.w, lz = v * room.d;
          const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
          ok(slope(wx, wz) <= floorY + 1e-6,
            `ground ${(slope(wx, wz) - floorY).toFixed(2)}m above the floor at rot ${rot}`);
        }
      }
    }
  }
});

test("the gap that leaves is filled with masonry, and only when there is one", () => {
  const level = groundBuildings({ records: [rec("a", house())], sampler: flat, uidAt: (i) => `f${i}` });
  eq(level.footings.length, 0, "a footing under a house on level ground");

  const hill = groundBuildings({ records: [rec("a", house(), 0, 0, 0, 0)], sampler: slope, uidAt: (i) => `f${i}` });
  // The pass emits two kinds of masonry on a slope: the footing that fills the
  // gap under the building, and the flight that gets you up to its door. This
  // one is about the footing.
  const masonry = hill.footings.filter((r) => r.ref === "site/footing");
  eq(masonry.length, 1, "a house on a hillside standing on nothing");
  const f = masonry[0];
  eq(f.seat, "point");
  const g = groundUnder({ record: rec("a", house()), sampler: slope });
  const drop = Math.min(MAX_DROP, g.hi - g.lo);
  const top = Math.max(...f.proc.parts.map((p) => p.pos[1] + p.dims[1] / 2));
  close(top, drop, 0.05, "the footing does not reach the floor it holds up");
  close(f.position[1] + top, hill.records[0].position[1], 0.05,
    "the footing and the building it carries are at different heights");
  /* Nothing may hang below the origin. A seat:"point" placement is seated by
     its LOWEST point, not its origin, so a proc built downward is pushed up
     by its own depth — which floated every footing a metre over the hill it
     was supposed to be dug into. This assertion is that bug. */
  for (const p of f.proc.parts) {
    ok(p.dims.every((v) => v > 0 && Number.isFinite(v)), `bad footing dims ${p.dims}`);
    ok(p.pos[1] - p.dims[1] / 2 >= -1e-6,
      `a footing course hangs ${(p.dims[1] / 2 - p.pos[1]).toFixed(2)}m below its own origin`);
  }
});

test("a footing steps rather than standing up as one slab", () => {
  const deep = footingParts({ w: 8, d: 7, drop: 3.4 });
  ok(deep.parts.length >= 3, `a 3.4m drop came out as ${deep.parts.length} course(s)`);
  // Widest at the bottom: a footing spreads its load as it goes down. Parts
  // are emitted from the ground up.
  const widths = deep.parts.map((p) => p.dims[0]);
  for (let i = 1; i < widths.length; i++) {
    ok(widths[i] < widths[i - 1], "a footing that widens as it rises");
  }
  eq(footingParts({ w: 8, d: 7, drop: 0.4 }).parts.length, 1, "one course for a low step");
});

test("only buildings get footings — a barrel is not a building", () => {
  const barrel = { uid: "b", ref: "prop/barrel", position: [3, 0, 3], rotationY: 0, scale: 1,
    proc: { parts: [{ shape: "cylinder", dims: [0.3, 0.8], pos: [0, 0.4, 0] }] } };
  const out = groundBuildings({ records: [barrel], sampler: slope, uidAt: (i) => `f${i}` });
  eq(out.footings.length, 0, "a barrel was given a foundation");
  eq(out.records[0].seat, undefined, "a barrel was taken off the terrain it should follow");
});

/* ══════════════════ shelter ══════════════════ */

test("a building encloses one volume per room it declares", () => {
  const proc = buildingParts({ floors: 4, tiers: 2, w: 12, d: 10 });
  const vols = shelterVolumes(rec("a", proc, 5, -7, 0, 20), toWorld);
  eq(vols.length, proc.rooms.length);
  for (const v of vols) {
    ok(v.roofY > v.floorY, "a volume with no headroom");
    ok(v.w > 0 && v.d > 0, "a volume with no floor");
  }
  // The envelope is measured inside the walls, so shelter reaches past it.
  const r0 = proc.rooms[0];
  ok(vols[0].w > r0.w && vols[0].d > r0.d, "shelter stops at the plaster, not the wall");
});

test("you are under a roof indoors and under the sky outside it, at any angle", () => {
  const proc = house();
  const room = proc.rooms[0];
  for (const rot of [0, 0.9, Math.PI / 2, -2.1]) {
    const r = rec("a", proc, 30, -12, rot, 8);
    const vols = shelterVolumes(r, toWorld);
    const mid = toWorld(r, [0, room.y + 1.2, 0]);
    eq(shelterAt(vols, ...mid), 1, "no roof over the middle of the room");
    // A step past the wall, along the room's own axis.
    const outward = toWorld(r, [0, room.y + 1.2, room.d / 2 + 2.0]);
    eq(shelterAt(vols, ...outward), 0, "the roof extends two metres into the street");
    // …and above the ridge.
    const sky = toWorld(r, [0, room.y + room.h + 2, 0]);
    eq(shelterAt(vols, ...sky), 0, "a chimney counts as indoors");
  }
});

test("the raster agrees with the truth it approximates", () => {
  const proc = house();
  const room = proc.rooms[0];
  const recs = [rec("a", proc, 0, 0, 0.4, 12), rec("b", proc, 14, 6, -1.1, 12),
                rec("c", buildingParts({ floors: 3, w: 12, d: 10 }), -18, -9, 2.0, 12)];
  const vols = recs.flatMap((r) => shelterVolumes(r, toWorld));
  const field = new ShelterField().setVolumes(vols);
  field.update(0, 0, true);

  // Sample the window on a grid finer than a building and coarser than a
  // texel, and require the two answers to match almost everywhere. Edges are
  // allowed to differ by one texel — that is what a raster IS.
  let checked = 0, wrong = 0;
  const y = 12 + room.y + 1.2;
  for (let x = -60; x <= 60; x += 0.7) {
    for (let z = -60; z <= 60; z += 0.7) {
      const exact = shelterAt(vols, x, y, z);
      const got = field.sample(x, y, z);
      checked++;
      if (exact === got) continue;
      // Within a texel of a boundary, either answer is honest.
      const near = vols.some((v) => {
        const dx = Math.abs(x - v.x), dz = Math.abs(z - v.z);
        const reach = Math.hypot(v.w, v.d) / 2 + field.cell * 1.5;
        return dx < reach && dz < reach;
      });
      if (!near) wrong++;
    }
  }
  ok(checked > 20000, "the sample was too coarse to mean anything");
  eq(wrong, 0, `${wrong} of ${checked} points disagreed away from any wall`);
});

test("the window follows the viewer and covers what rain can reach", () => {
  const field = new ShelterField();
  ok(field.span >= 84, `a ${field.span}m window cannot cover a 42m rain volume`);
  eq(field.data.length, RES * RES * 4);
  field.setVolumes([]);
  field.update(0, 0, true);
  ok(!field.needsUpdate(4, -6), "redrawn for a step");
  ok(field.needsUpdate(SPAN, 0), "not redrawn after walking a whole window");
});

test("a roof over one storey is not a roof over the one above it", () => {
  // The lowest ceiling wins: standing on the ground floor of a tower, what is
  // between you and the sky is the ceiling, not the parapet.
  const proc = buildingParts({ floors: 6, tiers: 2, w: 12, d: 11 });
  const r = rec("a", proc, 0, 0, 0, 0);
  const vols = shelterVolumes(r, toWorld);
  const field = new ShelterField().setVolumes(vols);
  field.update(0, 0, true);
  const low = proc.rooms[0];
  eq(field.sample(0, low.y + 1.4, 0), 1, "no ceiling over the ground floor");
  eq(shelterAt(vols, 0, low.y + low.h + 0.4, 0), 0, "the ground-floor ceiling is not a ceiling");
});

test("rain falls where there are no buildings", () => {
  const field = new ShelterField().setVolumes([]);
  field.update(0, 0, true);
  for (let i = 0; i < 40; i++) eq(field.sample(i * 3 - 60, 5, i * 2 - 40), 0, "shelter in an empty field");
});

/* ══════════════════ apertures ══════════════════ */

test("the openings are read off the wall that has them", () => {
  const r = rec("a", house(), 0, 0, 0, 0);
  const aps = aperturesOf(r, toWorld);
  ok(aps.length >= 3, `a house with three windows reported ${aps.length} openings`);
  ok(aps.some((a) => a.kind === "window"), "no windows");
  /* THE WAY IN IS NOT A HOLE IN A WALL ANY MORE. It never was, on anything
     this project generates: a real doorway is the GAP between two piers
     (js/block-shapes.js), because collision is one box per mesh and a hole
     punched in a single wall is solid. The house block was the last one
     authored the old way, and it was a room nobody could enter. So the door
     is read where the engine reads it — off the hinge (Engine._syncShelter
     adds `doorApertureOf` to the same list). */
  const door = doorApertureOf(r, toWorld);
  ok(door && door.kind === "door", "no way in");
  for (const a of [...aps, door]) {
    ok(a.w > 0.3 && a.w < 4, `an opening ${a.w}m wide`);
    ok(a.h > 0.3 && a.h < 4, `an opening ${a.h}m tall`);
    ok(a.y > 0.2 && a.y < 5, `an opening at ${a.y}m`);
    close(Math.hypot(a.nx, a.nz), 1, 1e-6, "the inward direction is not a direction");
  }
});

test("an opening faces into the building it is cut in", () => {
  const proc = house();
  for (const rot of [0, 1.2, Math.PI, -0.8]) {
    const r = rec("a", proc, 20, -30, rot, 4);
    for (const a of aperturesOf(r, toWorld)) {
      // A step inward from the opening must be under the roof; a step outward
      // must not. That is the whole meaning of the vector.
      const vols = shelterVolumes(r, toWorld);
      const inY = Math.max(a.y, proc.rooms[0].y + 4 + 0.4);
      eq(shelterAt(vols, a.x + a.nx * 1.1, inY, a.z + a.nz * 1.1), 1,
        `${a.kind} at rot ${rot} opens away from the building`);
      eq(shelterAt(vols, a.x - a.nx * 1.6, inY, a.z - a.nz * 1.6), 0,
        `${a.kind} at rot ${rot} points into its own wall`);
    }
  }
});

test("openings follow the placement", () => {
  const proc = house();
  const here = aperturesOf(rec("a", proc, 0, 0, 0, 0), toWorld);
  const there = aperturesOf(rec("a", proc, 100, 50, 0, 7), toWorld);
  eq(here.length, there.length);
  for (let i = 0; i < here.length; i++) {
    close(there[i].x - here[i].x, 100, 1e-6);
    close(there[i].z - here[i].z, 50, 1e-6);
    close(there[i].y - here[i].y, 7, 1e-6);
  }
});

test("a solid block has no openings to claim", () => {
  eq(aperturesOf({ uid: "x", position: [0, 0, 0], rotationY: 0,
    proc: { parts: [{ shape: "box", dims: [4, 3, 4], pos: [0, 1.5, 0] }] } }, toWorld).length, 0);
});

/* ══════════════════ can you get in ══════════════════
   A footing that stands a house 1.5 m above the street is only an improvement
   if there is a way up it. Walk mode steps over 0.55 m and stops at anything
   taller, so every course has to be within a stride of the one below. */

test("a footing is climbable, course by course", () => {
  for (const drop of [0.3, 0.8, 1.6, 2.9, 4.0]) {
    const parts = footingParts({ w: 8, d: 7, drop }).parts;
    let below = 0;
    for (const p of parts.slice().sort((a, b) => a.pos[1] - b.pos[1])) {
      const top = p.pos[1] + p.dims[1] / 2;
      ok(top - below <= 0.55 + 1e-6,
        `a ${(top - below).toFixed(2)}m rise on a ${drop}m footing — nobody steps that`);
      below = top;
    }
    close(below, drop, 0.05, "the courses do not add up to the drop");
  }
});

test("the courses widen downward, so each one is a tread", () => {
  const parts = footingParts({ w: 8, d: 7, drop: 2.4 }).parts;
  for (let i = 1; i < parts.length; i++) {
    ok(parts[i - 1].dims[0] > parts[i].dims[0], "a course no wider than the one above it");
    ok(parts[i - 1].dims[2] > parts[i].dims[2], "no tread to stand on");
  }
});

report("shelter");
