/* The interior pipeline, stage by stage.
 *
 * tests/interiors.test.js covers the room: what goes in it and where. This
 * file covers the reasoning ABOVE the room — what the building is, who is in
 * it, how its floor divides into rooms at all — and the check BELOW it, which
 * is the validator that has to be able to say no.
 *
 * The validator is tested twice over, and deliberately: once by feeding it
 * layouts that are wrong on purpose, so that a rule which has quietly stopped
 * firing is caught, and once over a corpus of real generated rooms, so that a
 * rule which fires when it should not is caught too. A validator that never
 * rejects and a validator that always rejects are the same useless thing.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { mulberry32 } from "../../../src/kernel/seed.js";
import {
  ARCHETYPES, ARCHETYPE_IDS, surveyBuilding, classify, occupantsOf, roomProgramme,
  climateOf, CLIMATES, corridorOn, affinityOf,
} from "../../../src/genesis/world/archetype.js";
import {
  subdivide, adjacency, planFloor, partitionRuns, MIN_SIDE, MIN_AREA, DOOR_W, WALL_T, CORRIDOR_W,
} from "../../../src/kernel/core/partition.js";
import { validateRoom, distinctness, CODES } from "../../../src/genesis/world/interior-validate.js";
import { planRoom, PROGRAMS, contextual } from "../../../src/genesis/world/interior-plan.js";
import { interiorStyle, footprintOf, CATALOGUE } from "../../../src/genesis/world/furniture.js";
import { composeInteriors, planValidated, roomsOf, wallRunParts } from "../../../src/genesis/world/interiors.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";

/* A bare shell with exactly the evidence the classifier is allowed to read:
   an envelope, a room per storey, and a given number of lit openings. */
function shell({ w, d, storeys = 1, h = 3, windows = 0 }) {
  const parts = [{ shape: "box", dims: [w, h * storeys, d], pos: [0, (h * storeys) / 2, 0] }];
  for (let i = 0; i < windows; i++) {
    parts.push({ shape: "box", dims: [0.8, 1.1, 0.1], pos: [i * 0.9 - w / 2 + 0.6, 1.5, d / 2],
      emissive: 0xffddaa });
  }
  const rooms = [];
  for (let i = 0; i < storeys; i++) {
    rooms.push({ level: i, at: i ? "head" : "ground", y: i * h, h, x: 0, z: 0, w: w - 0.7, d: d - 0.7 });
  }
  return { storeys, rooms, parts };
}
const style = () => interiorStyle({ wealth: 0.5, age: 0.4, wear: 0.4, rng: mulberry32(3) });
// The codes that mean the layout is physically wrong, as opposed to thin or
// dim. These are the ones nothing may ship with.
const HARD = ["INTERSECT", "OUT_OF_BOUNDS", "UNREACHABLE", "FLOATING",
              "WALL_DETACHED", "HEAVY_UNSUPPORTED", "SEAT_UNUSABLE", "BLOCKS_DOOR"];
const hard = (check) => check.violations.filter((v) => HARD.includes(v.code));

/* ══════════════════ stage 1 · read the geometry ══════════════════ */

test("the survey measures the envelope, not the chimney pot", () => {
  const proc = shell({ w: 8, d: 6, storeys: 2, windows: 4 });
  // A tall thin flue on the roof: the kind of part that used to set the plan.
  proc.parts.push({ shape: "cylinder", dims: [0.3, 2.4], pos: [2, 7.2, 0] });
  const ev = surveyBuilding(proc);
  ok(ev.w <= 8.01 && ev.d <= 6.01, `survey grew the footprint to ${ev.w}×${ev.d}`);
  eq(ev.storeys, 2);
  close(ev.areaPerFloor, ev.area / 2, 1e-6);
  ok(ev.aspect >= 1, "aspect must be the long side over the short one");
});

test("window density is a fraction, however many openings there are", () => {
  for (const windows of [0, 3, 40]) {
    const ev = surveyBuilding(shell({ w: 9, d: 7, windows }));
    ok(ev.windows >= 0 && ev.windows <= 1, `windows out of range: ${ev.windows}`);
  }
  ok(surveyBuilding(shell({ w: 9, d: 7, windows: 0 })).windows === 0, "a blind wall reads as glazed");
  ok(surveyBuilding(shell({ w: 9, d: 7, windows: 8 })).windows > 0.5, "a glazed frontage reads as blind");
});

test("a block with no declared rooms is still measurable", () => {
  const ev = surveyBuilding({ parts: [{ shape: "box", dims: [12, 4, 9], pos: [0, 2, 0] }] });
  ok(ev.w > 0 && ev.d > 0 && ev.storeys >= 1, "survey gave up on a roomless block");
});

/* ══════════════════ stage 2 · classify ══════════════════ */

test("the classifier tells a house from a barn from a watchtower", () => {
  eq(classify({ proc: shell({ w: 7.5, d: 6.5, storeys: 2, windows: 8 }), kind: "house" }).archetype,
     "residence", "a two-storey glazed cottage is not a house");
  eq(classify({ proc: shell({ w: 4.4, d: 4.2, storeys: 3, windows: 1 }), kind: "tower" }).archetype,
     "guardpost", "a tall blind shaft is not a guard post");
  const barn = classify({ proc: shell({ w: 18, d: 14, storeys: 1, h: 5, windows: 0 }), kind: "platform" });
  ok(["warehouse", "farm"].includes(barn.archetype), `a blind 250m² single storey came out ${barn.archetype}`);
});

test("geometry outvotes the label it was placed with", () => {
  // The same `house` id, on proportions no house has ever had.
  const got = classify({ proc: shell({ w: 16, d: 13, storeys: 1, h: 5, windows: 0 }), kind: "house" });
  ok(got.archetype !== "residence",
    "a blind 200m² shed classified as a house because of its catalogue id");
  // …and the id still wins where the geometry is genuinely ambiguous.
  eq(classify({ proc: shell({ w: 7, d: 6, storeys: 2, windows: 7 }), kind: "row-shop" }).archetype,
     "shop", "a shop-shaped shop came out something else");
});

test("every archetype is reachable from some building", () => {
  // A classifier that can only ever answer "residence" is a constant.
  const seen = new Set();
  for (const kind of ["house", "row-house", "row-shop", "civic", "tower", "platform", "block"]) {
    for (const w of [4, 7, 11, 16, 24]) {
      for (const storeys of [1, 2, 4]) {
        for (const windows of [0, 3, 9]) {
          seen.add(classify({ proc: shell({ w, d: w * 0.8, storeys, windows }), kind }).archetype);
        }
      }
    }
  }
  ok(seen.size >= 5, `the classifier only ever answers ${[...seen].join(", ")}`);
});

test("classification is deterministic, and confidence is real", () => {
  const args = { proc: shell({ w: 8, d: 7, storeys: 2, windows: 6 }), kind: "house", seed: "S", uid: "a" };
  const one = classify(args), two = classify(args);
  eq(one.archetype, two.archetype);
  eq(one.rng(), two.rng(), "the classifier's stream is not reproducible");
  ok(one.confidence >= 0, "negative confidence");
  eq(one.ranked.length, 3, "no runners-up to compare against");
  ok(one.ranked[0].score >= one.ranked[1].score, "ranking is not sorted");
});

/* ══════════════════ stage 7 · who is in it ══════════════════ */

test("a household is plausible, and belongs to its building", () => {
  for (const archetype of ARCHETYPE_IDS) {
    for (let s = 1; s <= 12; s++) {
      const evidence = surveyBuilding(shell({ w: 9, d: 8, storeys: 2, windows: 5 }));
      const p = occupantsOf({ archetype, evidence, rng: mulberry32(s) });
      for (const k of ["wealth", "age", "wear", "period"]) {
        ok(p[k] >= 0 && p[k] <= 1, `${archetype}: ${k} out of range at ${p[k]}`);
      }
      ok(p.occupants >= 1, `${archetype}: a building with nobody in it`);
      ok(ARCHETYPES[archetype].trades.includes(p.trade),
        `${archetype}: nobody in that trade would be here — ${p.trade}`);
      ok(p.children <= p.occupants, "more children than occupants");
      if (archetype === "warehouse") eq(p.children, 0, "children living in a warehouse");
    }
  }
});

test("two identical shells are two different households", () => {
  const evidence = surveyBuilding(shell({ w: 9, d: 8, storeys: 2, windows: 5 }));
  const a = occupantsOf({ archetype: "residence", evidence, rng: mulberry32(1) });
  const b = occupantsOf({ archetype: "residence", evidence, rng: mulberry32(2) });
  ok(JSON.stringify(a) !== JSON.stringify(b), "every house holds the same family");
});

test("the household reaches the furniture, and only where it should", () => {
  const weaver = { trade: "weaver", activity: "working", wealth: 0.4, children: 0, occupants: 3, wear: 0.4 };
  const parlour = contextual({ profile: weaver, programId: "living" });
  ok(parlour.ids.has("loom"), "a weaver's parlour with no loom in reach");
  const bed = contextual({ profile: weaver, programId: "bedroom" });
  ok(!bed.ids.has("loom"), "the loom followed them to bed");

  // Children bring a cradle; an empty house does not.
  const withKids = contextual({ profile: { ...weaver, children: 2 }, programId: "bedroom" });
  ok(withKids.ids.has("cradle"), "children with nowhere to sleep");
  ok(!bed.ids.has("cradle"), "a cradle in a childless house");

  // A building shut up for the season holds less than a working one.
  const shut = contextual({ profile: { ...weaver, activity: "shut" }, programId: "living" });
  ok(shut.density < parlour.density, "a shut-up building is as full as a working one");
});

test("a room grammar puts the public rooms at the front", () => {
  for (const archetype of ARCHETYPE_IDS) {
    const list = roomProgramme({ archetype, level: 0, at: "ground", zones: 3, rng: mulberry32(5) });
    eq(list.length, 3, `${archetype}: asked for three rooms, got ${list.length}`);
    for (let i = 1; i < list.length; i++) {
      ok(list[i].publicness >= list[i - 1].publicness,
        `${archetype}: a private room was ranked ahead of a public one`);
    }
    for (const r of list) {
      ok(PROGRAMS[r.purpose], `${archetype}: room purpose "${r.purpose}" has no programme to build it from`);
    }
  }
});

test("a house sleeps upstairs, whatever its archetype says downstairs", () => {
  const ground = new Set(), upper = new Set();
  for (let s = 1; s <= 40; s++) {
    for (const r of roomProgramme({ archetype: "residence", level: 0, at: "ground", zones: 2, rng: mulberry32(s) })) ground.add(r.purpose);
    for (const r of roomProgramme({ archetype: "residence", level: 1, at: "head", zones: 2, rng: mulberry32(s) })) upper.add(r.purpose);
  }
  ok(!ground.has("bedroom"), "a bedroom opening onto the street");
  ok(upper.has("bedroom"), "a house that never puts a bed upstairs");
  ok(ground.size > 1, "every house has the same ground floor");
});

test("a space too small to turn round in is a cupboard, whatever it was called", () => {
  // 2.7 × 2.2 inside the walls: under six square metres, which is a cupboard.
  const proc = shell({ w: 3.4, d: 2.9, storeys: 1, windows: 2 });
  const out = composeInteriors({
    records: [{ uid: "closet", ref: "builder/house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "S", uidAt: (i) => `u${i}`,
  });
  const ids = out.map((r) => r.ref.split("/").pop());
  ok(ids.length > 0, "a small room was left empty");
  ok(!ids.includes("bed") && !ids.includes("hearth"),
    `a 9m² space was furnished as a room: ${[...new Set(ids)].join(", ")}`);
});

/* ══════════════════ stage 3 · divide ══════════════════ */

test("every room a cut leaves is a room you can use", () => {
  for (let s = 1; s <= 30; s++) {
    const rng = mulberry32(s);
    const w = 6 + (s % 7) * 2.5, d = 5 + (s % 5) * 2;
    const zones = subdivide({ w, d, grain: 22, rng, maxZones: 4 });
    for (const z of zones) {
      ok(z.w >= MIN_SIDE - 1e-6 && z.d >= MIN_SIDE - 1e-6,
        `a ${z.w.toFixed(1)}×${z.d.toFixed(1)} room is not a room`);
      ok(z.w * z.d >= MIN_AREA - 1e-6, `a ${(z.w * z.d).toFixed(1)}m² room`);
      // A millimetre: zone edges are reported to the nearest millimetre, so
      // the sum of two rounded numbers is allowed to land one out.
      ok(Math.abs(z.x) + z.w / 2 <= w / 2 + 1e-3, "a room outside the building");
      ok(Math.abs(z.z) + z.d / 2 <= d / 2 + 1e-3, "a room outside the building");
    }
  }
});

test("rooms do not overlap, and the walls between them are real", () => {
  for (let s = 1; s <= 30; s++) {
    const zones = subdivide({ w: 13, d: 10, grain: 20, rng: mulberry32(s), maxZones: 4 });
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i], b = zones[j];
        const gx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
        const gz = Math.abs(a.z - b.z) - (a.d + b.d) / 2;
        ok(gx > -1e-6 || gz > -1e-6, `seed ${s}: two rooms occupy the same floor`);
        // Where they face each other, the gap is exactly a wall thickness —
        // rooms that merely touch have no wall between them.
        if (gz < -1e-6) ok(gx < -1e-6 || gx >= WALL_T - 0.01, `seed ${s}: rooms share a plane with no wall in it`);
      }
    }
  }
});

test("a floor too small to divide is left as one room", () => {
  const zones = subdivide({ w: 4, d: 3.2, grain: 8, rng: mulberry32(1), maxZones: 4 });
  eq(zones.length, 1, "a 13m² cottage was cut into cupboards");
});

test("grain, not luck, decides how many rooms a floor has", () => {
  const open = subdivide({ w: 16, d: 12, grain: 300, rng: mulberry32(4), maxZones: 4 });
  const fine = subdivide({ w: 16, d: 12, grain: 22, rng: mulberry32(4), maxZones: 4 });
  eq(open.length, 1, "a warehouse floor was partitioned");
  ok(fine.length >= 3, `a 192m² house came to ${fine.length} rooms`);
});

test("no partition is cut through the staircase", () => {
  const keepOut = { x: 4.2, z: -3.1, w: 2.0, d: 3.0 };
  for (let s = 1; s <= 40; s++) {
    const zones = subdivide({ w: 13, d: 10, grain: 18, rng: mulberry32(s), maxZones: 4, keepOut });
    // The reserved rectangle has to sit whole inside exactly one room.
    const inside = zones.filter((z) =>
      Math.abs(z.x - keepOut.x) < (z.w - keepOut.w) / 2 + 1e-6 &&
      Math.abs(z.z - keepOut.z) < (z.d - keepOut.d) / 2 + 1e-6);
    eq(inside.length, 1, `seed ${s}: the stair straddles ${inside.length} rooms`);
  }
});

/* ══════════════════ stage 4 · assign, and cut the doors ══════════════════ */

const floorPlan = (seed, over = {}) => planFloor({
  w: 13, d: 10, entrance: { x: 0, z: 5, side: "south" },
  programme: roomProgramme({ archetype: "residence", level: 0, at: "ground", zones: 4, rng: mulberry32(seed) }),
  rng: mulberry32(seed), grain: 18, maxZones: 4, ...over,
});

test("every room has a purpose, a depth and a way in", () => {
  for (let s = 1; s <= 25; s++) {
    const { zones } = floorPlan(s);
    for (const z of zones) {
      ok(PROGRAMS[z.purpose], `room purpose "${z.purpose}" cannot be built`);
      ok(Number.isFinite(z.publicness), "a room with no publicness");
      ok(z.door && ["north", "south", "east", "west"].includes(z.door.side), "a room with no door");
      const span = z.door.side === "east" || z.door.side === "west" ? z.d : z.w;
      ok(Math.abs(z.door.x) <= span / 2, `a doorway ${z.door.x}m outside a ${span}m wall`);
    }
  }
});

test("every room is walkable from the front door through doors that were cut", () => {
  for (let s = 1; s <= 25; s++) {
    const { zones, doors, entryZone } = floorPlan(s);
    const near = zones.map(() => []);
    for (const dr of doors) { near[dr.a].push(dr.b); near[dr.b].push(dr.a); }
    const seen = new Set([entryZone]);
    const q = [entryZone];
    while (q.length) for (const nb of near[q.pop()]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    eq(seen.size, zones.length, `seed ${s}: ${zones.length - seen.size} rooms are walled in`);
  }
});

test("the public room is at the street and the private one is behind it", () => {
  for (let s = 1; s <= 25; s++) {
    const { zones } = floorPlan(s);
    for (const a of zones) {
      for (const b of zones) {
        if (a.depth < b.depth) {
          ok(a.publicness <= b.publicness,
            `seed ${s}: a ${a.purpose} sits behind a ${b.purpose}`);
        }
      }
    }
    ok(zones.some((z) => z.isEntry), "no room was marked as the one you walk into");
  }
});

test("a doorway lands inside the wall it is cut in", () => {
  for (let s = 1; s <= 25; s++) {
    const { zones, doors } = floorPlan(s);
    for (const dr of doors) {
      const a = zones[dr.a], b = zones[dr.b];
      const lo = dr.axis === "x" ? Math.max(a.z - a.d / 2, b.z - b.d / 2) : Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const hi = dr.axis === "x" ? Math.min(a.z + a.d / 2, b.z + b.d / 2) : Math.min(a.x + a.w / 2, b.x + b.w / 2);
      ok(dr.along - dr.width / 2 >= lo - 1e-6 && dr.along + dr.width / 2 <= hi + 1e-6,
        `seed ${s}: a doorway hangs off the end of its wall`);
      eq(dr.width, DOOR_W);
    }
  }
});

test("no partition is built across the front door", () => {
  // A wall meeting the entrance wall AT the doorway is legal geometry and a
  // door that opens onto the edge of a wall. The entry room has to hold the
  // whole opening with room to get through it.
  for (let s = 1; s <= 30; s++) {
    const { zones, entryZone } = floorPlan(s);
    const z = zones[entryZone];
    ok(Math.abs(0 - z.x) <= z.w / 2 - DOOR_W / 2,
      `seed ${s}: the doorway at x=0 falls outside the ${z.w.toFixed(1)}m frontage of the room it opens into`);
  }
});

test("an upper floor is planned around the stair head, not a wall it has no door in", () => {
  const { zones, entryZone } = floorPlan(9, { entrance: { x: 4.2, z: -3.1, side: "north" } });
  eq(zones[entryZone].door.side, "north", "the stair came up through the front door");
});

/* ══════════════════ the partitions themselves ══════════════════ */

test("a partition leaves a doorway, because a hole in a box is still a box", () => {
  for (let s = 1; s <= 20; s++) {
    const { zones, doors } = floorPlan(s);
    const runs = partitionRuns({ zones, doors, h: 3.0 });
    for (const dr of doors) {
      // At floor level, no run on this wall may cover the opening.
      const covering = runs.filter((r) => !r.lintel && r.axis === dr.axis
        && Math.abs(r.at - dr.at) < 0.01
        && r.lo < dr.along + dr.width / 2 - 0.01 && r.hi > dr.along - dr.width / 2 + 0.01);
      eq(covering.length, 0, `seed ${s}: a wall was built across its own doorway`);
    }
    for (const r of runs) {
      ok(r.hi - r.lo > 0, "a run of zero length");
      ok(r.h > 0, "a wall of zero height");
      ok(r.y >= 0, "a wall below the floor");
      ok(r.lintel ? r.y > 1.9 : r.y === 0, "a lintel at knee height, or a wall floating");
    }
  }
});

test("wall runs build geometry the engine can take", () => {
  for (const len of [0.4, 3, 9]) {
    const proc = wallRunParts({ len, h: 2.8 });
    ok(proc.parts.length === 1, "a straight wall is one box");
    const p = proc.parts[0];
    ok(p.dims.every((v) => v > 0 && Number.isFinite(v)), `bad dims ${p.dims}`);
    close(p.dims[0], len, 1e-6);
    close(p.pos[1], 1.4, 1e-6, "a wall that does not stand on the floor");
  }
});

/* ══════════════════ stage 8 · the validator says no ══════════════════ */

const room = { w: 6, d: 7, h: 3, area: 42 };
const foot = (id) => footprintOf(id, mulberry32(2), room);
const P = (id, x, z, extra = {}) => ({ id, x, z, rot: 0, y: 0, host: null, foot: foot(id), ...extra });
const door = { x: 0, side: "south" };
const codes = (placed, programId = "living") =>
  validateRoom({ room, placed, door, programId }).violations.map((v) => v.code);

test("the validator has a name for every failure it claims to catch", () => {
  for (const code of Object.keys(CODES)) ok(CODES[code].length > 4, `${code}: no description`);
});

test("it catches two things standing in the same place", () => {
  ok(codes([P("chest", 0, -3), P("chest", 0.2, -3)]).includes("INTERSECT"),
    "two chests in the same square metre passed");
  ok(!codes([P("chest", -2, -3), P("chest", 2, -3)]).includes("INTERSECT"),
    "two chests at opposite ends of the room were reported as overlapping");
});

test("it catches an object through a wall", () => {
  ok(codes([P("bed", 0, 3.4)]).includes("OUT_OF_BOUNDS"), "a bed out in the street passed");
});

test("it catches a thing resting on nothing", () => {
  // A bowl claiming a table that is not in the room.
  ok(codes([P("bowl", 0, 0, { y: 0.75, host: "table" })]).includes("FLOATING"),
    "a bowl floating over an absent table passed");
  // …and one standing on a real table, but off the edge of it.
  const t = P("table", 0, 0);
  ok(codes([t, P("bowl", 2.2, 0, { y: t.foot.h, host: "table" })]).includes("FLOATING"),
    "a bowl balanced two metres off the end of its table passed");
  ok(!codes([t, P("bowl", 0.1, 0, { y: t.foot.h, host: "table" })]).includes("FLOATING"),
    "a bowl in the middle of its table was reported as floating");
});

test("it catches a wall fitting that is not on a wall", () => {
  const mid = codes([P("sconce", 0, 0, { y: 1.75, host: "wall" })]);
  ok(mid.includes("WALL_DETACHED"), "a sconce hovering in the middle of the room passed");
  const low = codes([P("sconce", 2.9, 0, { y: 0.4, host: "wall" })]);
  ok(low.includes("WALL_DETACHED"), "a sconce mounted at knee height passed");
});

test("it catches a heavy thing off the floor", () => {
  ok(codes([P("chest", 0, -3, { y: 0.9, host: "table" })]).includes("HEAVY_UNSUPPORTED"),
    "a chest on a tabletop passed");
});

test("it catches a chair with nothing to sit at", () => {
  ok(codes([P("chair", 0, 0, { host: "table" })]).includes("SEAT_UNUSABLE"),
    "a chair drawn up to an absent table passed");
  const t = P("table", 0, 0);
  ok(codes([t, P("chair", 0, 2.6, { host: "table" })]).includes("SEAT_UNUSABLE"),
    "a chair two metres clear of its table passed");
});

test("it catches an object with no business in the room", () => {
  ok(codes([P("bed", 0, -3)], "store").includes("OUT_OF_PROGRAM"), "a bed in a stock room passed");
  // …unless the household is the reason it is there.
  const withReason = validateRoom({
    room, placed: [P("bed", 0, -3)], door, programId: "store", extraIds: new Set(["bed"]),
  }).violations.map((v) => v.code);
  ok(!withReason.includes("OUT_OF_PROGRAM"), "a declared exception was still reported");
});

test("it catches a room nobody furnished, and one nobody can cross", () => {
  ok(codes([]).includes("EMPTY"), "an empty room passed");
  // Wall to wall in crates: physically legal, and unusable.
  const packed = [];
  for (let x = -2.4; x <= 2.4; x += 0.62) {
    for (let z = -3.2; z <= 3.2; z += 0.62) packed.push(P("crate", x, z));
  }
  const got = validateRoom({ room, placed: packed, door, programId: "store" }).violations.map((v) => v.code);
  ok(got.includes("CLUTTER") || got.includes("BLOCKS_DOOR"), "a room packed solid passed as usable");
});

test("it catches a room with the lights out", () => {
  ok(codes([P("chest", -2, -3), P("chest", 2, -3), P("table", 0, 0)]).includes("DARK"),
    "an unlit room passed");
  ok(!codes([P("hearth", 0, -3), P("table", 0, 0.5)]).includes("DARK"),
    "a room with a fire in it was reported as dark");
});

/* ══════════════════ stages 5–9 over a corpus ══════════════════ */

test("a planned room passes the check that was written independently of it", () => {
  let checked = 0;
  for (const programId of Object.keys(PROGRAMS)) {
    for (let s = 1; s <= 14; s++) {
      const rng = mulberry32(s * 31 + 7);
      const r = { w: 3.4 + (s % 5) * 1.4, d: 3.6 + (s % 4) * 1.6, h: 2.9 };
      r.area = r.w * r.d;
      const side = ["south", "north", "east", "west"][s % 4];
      const dr = { x: 0, side };
      const plan = planRoom({ room: r, programId, style: style(), rng, door: dr });
      const bad = hard(validateRoom({ room: r, placed: plan.placed, door: dr, programId,
        extraIds: plan.extras }));
      eq(bad.length, 0,
        `${programId}/${s} (${r.w.toFixed(1)}×${r.d.toFixed(1)}, ${side} door): `
        + bad.map((v) => `${v.code} ${v.id} ${v.detail}`).join("; "));
      checked++;
    }
  }
  ok(checked > 100, "the corpus was too small to mean anything");
});

test("nothing the pipeline ships still fails a physical rule", () => {
  // planValidated is the stage-9 loop: re-plan a rejected room, then prune
  // what still will not pass. Its OUTPUT is what the world gets.
  const profiles = [
    { trade: "smith", activity: "working", wealth: 0.3, wear: 0.6, occupants: 3, children: 0 },
    { trade: "innkeeper", activity: "meal", wealth: 0.7, wear: 0.3, occupants: 6, children: 2 },
    { trade: "merchant", activity: "packing", wealth: 0.8, wear: 0.2, occupants: 2, children: 0 },
    { trade: "widow", activity: "shut", wealth: 0.15, wear: 0.85, occupants: 1, children: 0 },
  ];
  let n = 0;
  for (const programId of Object.keys(PROGRAMS)) {
    for (let s = 0; s < 12; s++) {
      const r = { w: 3.2 + (s % 6) * 1.3, d: 3.4 + (s % 5) * 1.5, h: 2.8 + (s % 3) * 0.3 };
      r.area = r.w * r.d;
      const dr = { x: (s % 3) - 1, side: ["south", "north", "east", "west"][s % 4] };
      const out = planValidated({
        room: r, programId, style: style(), seed: "CORPUS", key: `${programId}:${s}`,
        door: dr, blocked: [], profile: profiles[s % profiles.length],
      });
      const bad = hard(validateRoom({ room: r, placed: out.placed, door: dr, programId,
        extraIds: out.extras }));
      eq(bad.length, 0, `${programId}/${s}: ${bad.map((v) => `${v.code} ${v.id}`).join("; ")}`);
      ok(out.placed.length > 0, `${programId}/${s}: the pruner emptied the room`);
      n++;
    }
  }
  ok(n >= 100, "too few rooms to call it a corpus");
});

test("no two buildings come out the same", () => {
  const layouts = [];
  for (let s = 0; s < 40; s++) {
    layouts.push(planValidated({
      room: { w: 6.4, d: 5.8, h: 2.9, area: 37.1 }, programId: "living", style: style(),
      seed: "STREET", key: `house-${s}`, door: { x: 0, side: "south" },
      blocked: [], profile: { trade: "labourer", activity: "settled", wealth: 0.4, wear: 0.5, occupants: 3, children: 1 },
    }).placed);
  }
  const d = distinctness(layouts);
  ok(d.uniqueFrac >= 0.95, `40 identical houses produced only ${d.unique} distinct rooms`);
  ok(d.distinctSets >= 12, `they were furnished from only ${d.distinctSets} different object sets`);
});

/* ══════════════════ stage 10 · what the world gets ══════════════════ */

test("a house comes out as rooms with walls between them", () => {
  const proc = buildingParts({ floors: 2, w: 12, d: 10, bays: 3 });
  const out = composeInteriors({
    records: [{ uid: "a", ref: "street/row-house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "STREET", uidAt: (i) => `u${i}`,
  });
  ok(out.some((r) => r.ref.endsWith("partition")), "a 120m² house was left as one room");
  ok(out.length > 20, `a whole house came to ${out.length} objects`);
});

test("what a building is FOR decides how its floor divides", () => {
  const mk = (proc, ref, uid) => composeInteriors({
    records: [{ uid, ref, proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "W", uidAt: (i) => `u${i}`,
  });
  const walls = (out) => out.filter((r) => r.ref.endsWith("partition")).length;

  // A store floor big enough to work in is one room; a dwelling of the same
  // area is a plan. That is the whole claim of the zoning stage.
  const barn = mk(shell({ w: 12, d: 10, storeys: 1, h: 5, windows: 0 }), "street/platform", "barn");
  const cottage = mk(shell({ w: 9, d: 8, storeys: 2, windows: 6 }), "builder/house", "cot");
  eq(walls(barn), 0, "a 105m² store floor was cut up into rooms");
  ok(walls(cottage) > 0, "a two-storey cottage was left as one room");

  const bigBarn = mk(shell({ w: 20, d: 15, storeys: 1, h: 5, windows: 0 }), "street/platform", "barn2");
  const bigHouse = mk(shell({ w: 20, d: 15, storeys: 2, h: 3, windows: 14 }), "street/row-house", "hs");
  ok(walls(bigHouse) > walls(bigBarn),
    `the same 280m² floor became ${walls(bigHouse)} walls as a house and ${walls(bigBarn)} as a warehouse`);
});

test("the interior a seed produces is the interior it always produces", () => {
  const mk = () => composeInteriors({
    records: [{ uid: "a", ref: "street/row-house", proc: buildingParts({ floors: 2, w: 11, d: 9 }),
      position: [3, 12, -4], rotationY: 0.8, scale: 1 }],
    links: [], seed: "SEED-ONE", uidAt: (i) => `u${i}`,
  });
  eq(JSON.stringify(mk()), JSON.stringify(mk()));
});

test("everything the pipeline emits stands inside the building it belongs to", () => {
  const proc = buildingParts({ floors: 3, w: 13, d: 11, bays: 3 });
  const rec = { uid: "a", ref: "street/block-stack", proc, position: [20, 5, -8], rotationY: 0.6, scale: 1 };
  const out = composeInteriors({ records: [rec], links: [], seed: "S", uidAt: (i) => `u${i}` });
  const rooms = roomsOf(rec);
  for (const r of out) {
    const fits = rooms.some((rm) => {
      const dx = r.position[0] - rm.x, dz = r.position[2] - rm.z;
      const reach = Math.hypot(rm.w, rm.d) / 2 + 0.5;
      return Math.hypot(dx, dz) <= reach;
    });
    ok(fits, `${r.label} at ${r.position} is not in any room of the building`);
  }
});

/* ══════════════════ the century, and the weather ══════════════════ */

test("a room is furnished out of the catalogue its century had", () => {
  const seen = (period) => {
    const kinds = new Set();
    for (const programId of ["kitchen", "living", "bedroom", "hall"]) {
      for (let s = 1; s <= 25; s++) {
        const r = { w: 6.4, d: 5.8, h: 2.9, area: 37.1 };
        for (const p of planRoom({ room: r, programId, style: style(), rng: mulberry32(s),
          door: { x: 0, side: "south" }, climate: "temperate",
          profile: { trade: "labourer", activity: "settled", wealth: 0.5, wear: 0.4,
                     occupants: 3, children: 0, period } }).placed) kinds.add(p.id);
      }
    }
    return kinds;
  };
  const old = seen(0.08), now = seen(0.96);
  ok(old.has("hearth") && !now.has("hearth"), "a fire is timeless");
  ok(!old.has("counterRun") && now.has("counterRun"), "fitted base units are timeless");
  ok(!old.has("coldStore"), "a medieval cottage with a refrigerator in it");
  ok(!old.has("pendant"), "a pendant on a flex, hung from a medieval rafter");
  ok(!old.has("lampTable"), "an oil lamp three hundred years before the oil");
  ok(now.has("pendant") || now.has("lampFloor"), "a modern room lit only by candles");
});

test("the anchor a room is arranged around is dated too", () => {
  // The must-list is not optional, so the era reaches it by substitution
  // rather than by refusal: what a fitted counter WAS is a fire.
  const p = (period) => planRoom({
    room: { w: 6, d: 5, h: 2.8, area: 30 }, programId: "kitchen", style: style(),
    rng: mulberry32(11), door: { x: 0, side: "south" },
    profile: { trade: "baker", activity: "settled", wealth: 0.5, wear: 0.4,
               occupants: 3, children: 0, period },
  }).placed.map((q) => q.id);
  ok(p(0.05).includes("hearth"), "an old kitchen with no fire in it");
  ok(p(0.95).includes("counterRun"), "a new kitchen with no counter in it");
});

test("every room ends up with light in it, in every century", () => {
  for (const period of [0.02, 0.3, 0.6, 0.99]) {
    for (const programId of Object.keys(PROGRAMS)) {
      for (let s = 1; s <= 4; s++) {
        const r = { w: 5 + (s % 3), d: 5.5 + (s % 4), h: 3 };
        r.area = r.w * r.d;
        const out = planRoom({ room: r, programId, style: style(), rng: mulberry32(s * 7),
          door: { x: 0, side: "south" }, climate: "temperate",
          profile: { trade: "clerk", activity: "settled", wealth: 0.5, wear: 0.4,
                     occupants: 2, children: 0, period } }).placed;
        ok(out.some((p) => CATALOGUE[p.id]?.lights),
          `${programId} at period ${period}: nothing in the room burns`);
      }
    }
  }
});

test("a house in the tropics is not built round a fire", () => {
  const fires = (climate) => {
    let n = 0;
    for (let s = 1; s <= 20; s++) {
      const r = { w: 6.4, d: 5.8, h: 2.9, area: 37.1 };
      if (planRoom({ room: r, programId: "living", style: style(), rng: mulberry32(s), climate,
        door: { x: 0, side: "south" },
        profile: { trade: "labourer", activity: "settled", wealth: 0.4, wear: 0.4,
                   occupants: 3, children: 1, period: 0.3 } }).placed.some((p) => p.id === "hearth")) n++;
    }
    return n;
  };
  const cold = fires("cold"), warm = fires("temperate"), hot = fires("hot");
  eq(hot, 0, `${hot} of 20 tropical parlours were arranged round a fireplace`);
  ok(cold > warm, `a cold country lit ${cold} fires and a mild one ${warm}`);
  ok(warm > 0, "nowhere temperate ever has a fire");
});

test("the climate a world is in comes from the world, not from a second opinion", () => {
  eq(climateOf("atoll"), "hot");
  eq(climateOf("tundra"), "cold");
  eq(climateOf("meadow"), "temperate");
  eq(climateOf(undefined), "temperate", "a world with no biome should not be exotic");
  for (const c of new Set(["verdant", "badlands", "tundra", "volcanic", "oasis", "meadow",
                           "shoreland", "atoll", "parkland", "weald"].map(climateOf))) {
    ok(CLIMATES.includes(c), `${c} is not one of the three climates anything reads`);
  }
});

/* ══════════════════ corridors, and who sits beside whom ══════════════════ */

test("a building with a passage has one, and everything opens off it", () => {
  for (const archetype of ARCHETYPE_IDS) {
    if (!corridorOn({ archetype, at: "head", level: 1 })) continue;
    for (let s = 1; s <= 10; s++) {
      const f = planFloor({
        w: 14, d: 11, entrance: { x: 0, z: 5.5, side: "south" },
        programme: roomProgramme({ archetype, level: 1, at: "head", zones: 4, rng: mulberry32(s) }),
        rng: mulberry32(s), grain: 26, maxZones: 4, corridor: true, affinity: affinityOf,
      });
      const spine = f.zones.filter((z) => z.purpose === "corridor");
      eq(spine.length, 1, `${archetype}/${s}: ${spine.length} passages on one floor`);
      ok(spine[0].isEntry, `${archetype}/${s}: you do not arrive in the passage`);
      ok(Math.min(spine[0].w, spine[0].d) <= CORRIDOR_W + 0.01,
        `${archetype}/${s}: a passage ${Math.min(spine[0].w, spine[0].d).toFixed(1)}m wide is a room`);
      // …and it is a passage TO somewhere: every room reached through doors
      // that were actually cut.
      const near = f.zones.map(() => []);
      for (const dr of f.doors) { near[dr.a].push(dr.b); near[dr.b].push(dr.a); }
      const seen = new Set([f.entryZone]); const q = [f.entryZone];
      while (q.length) for (const nb of near[q.pop()]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
      eq(seen.size, f.zones.length, `${archetype}/${s}: rooms walled off the passage`);
    }
  }
});

test("a cottage does not spend its ground floor on a corridor", () => {
  ok(!corridorOn({ archetype: "residence", at: "ground", level: 0 }), "a cottage with a hall downstairs");
  ok(corridorOn({ archetype: "residence", at: "head", level: 1 }), "three bedrooms opening into each other");
  ok(!corridorOn({ archetype: "workshop", at: "ground", level: 0 }), "a workshop with a passage in it");
  ok(corridorOn({ archetype: "infirmary", at: "ground", level: 0 }), "a ward block with no passage");
});

test("a wall stands between two rooms whether or not there is a door in it", () => {
  /* A slice plan connects each room to the next, so every shared run had a
     doorway on it and every shared run got built. A spine plan does not:
     two rooms on the same flank of a corridor are each connected to the
     CORRIDOR and never to each other. */
  for (let s = 1; s <= 20; s++) {
    const f = planFloor({
      w: 14, d: 11, entrance: { x: 0, z: 5.5, side: "south" },
      programme: roomProgramme({ archetype: "admin", level: 0, at: "ground", zones: 4, rng: mulberry32(s) }),
      rng: mulberry32(s), grain: 26, maxZones: 4, corridor: true, affinity: affinityOf,
    });
    const runs = partitionRuns({ zones: f.zones, doors: f.doors, edges: f.edges, h: 3 });
    for (const e of f.edges) {
      const on = runs.filter((r) => r.axis === e.axis && Math.abs(r.at - e.at) < 0.01 && !r.lintel);
      ok(on.length > 0, `seed ${s}: rooms ${e.a} and ${e.b} face each other across nothing`);
    }
  }
});

test("the wall between two rooms stands between them", () => {
  /* It used to be halfway between their CENTRES, which is the same number
     only when the rooms are the same size — so a six-metre room beside a
     four-metre one had its partition built half a metre inside it. */
  for (let s = 1; s <= 40; s++) {
    const zones = subdivide({ w: 15, d: 11, grain: 20, rng: mulberry32(s), maxZones: 4 });
    for (const e of adjacency(zones)) {
      const a = zones[e.a], b = zones[e.b];
      const [lo, hi] = e.axis === "x"
        ? [Math.min(a.x + a.w / 2, b.x + b.w / 2), Math.max(a.x - a.w / 2, b.x - b.w / 2)]
        : [Math.min(a.z + a.d / 2, b.z + b.d / 2), Math.max(a.z - a.d / 2, b.z - b.d / 2)];
      // The wall plane sits in the gap between the two facing faces, not in
      // either room.
      ok(e.at >= Math.min(lo, hi) - 1e-6 && e.at <= Math.max(lo, hi) + 1e-6,
        `seed ${s}: the wall between two rooms is built inside one of them`);
    }
  }
});

test("rooms that belong together end up next to each other", () => {
  /* Stated as what the pass GUARANTEES rather than as an average, because an
     average hides the case that matters. Not every plan can grant every wish
     — the geometry has the last word, and on a floor where both back rooms
     already touch the front one there is nothing to choose between them — so
     the claim is that no plan is left improvable: after the pass, no swap the
     pass is allowed to make would raise the total. A pass that had quietly
     stopped firing would leave plans it could still improve. */
  const total = (zones, edges) =>
    edges.reduce((t, e) => t + affinityOf(zones[e.a].purpose, zones[e.b].purpose), 0);
  let improvable = 0, plans = 0, moved = 0;
  for (const archetype of ["residence", "shop", "tavern", "admin", "infirmary", "library"]) {
    for (const zoneCount of [3, 4]) {
      for (let s = 1; s <= 20; s++) {
        // A FRESH STREAM PER CALL. Sharing one rng between the two runs is
        // the classic way to compare two different buildings and think you
        // are comparing two treatments of the same one.
        const args = (affinity) => ({
          w: 15, d: 11, entrance: { x: 0, z: 5.5, side: "south" },
          programme: roomProgramme({ archetype, level: 1, at: "head", zones: zoneCount, rng: mulberry32(s) }),
          rng: mulberry32(s), grain: 22, maxZones: zoneCount, affinity,
          corridor: corridorOn({ archetype, at: "head", level: 1 }),
        });
        const on = planFloor(args(affinityOf));
        const off = planFloor(args(null));
        plans++;
        const best = total(on.zones, on.edges);
        if (best > total(off.zones, off.edges)) moved++;
        ok(best >= total(off.zones, off.edges),
          `${archetype}/${zoneCount}/${s}: the affinity pass made the plan worse`);
        // …and it is a local optimum for the swaps it is allowed to make.
        for (let i = 0; i < on.zones.length; i++) {
          for (let j = i + 1; j < on.zones.length; j++) {
            const a = on.zones[i], b = on.zones[j];
            if (a.depth !== b.depth || a.purpose === b.purpose) continue;
            if (a.purpose === "corridor" || b.purpose === "corridor") continue;
            const swapped = on.zones.map((z, k) =>
              k === i ? { ...z, purpose: b.purpose } : k === j ? { ...z, purpose: a.purpose } : z);
            if (total(swapped, on.edges) > best) improvable++;
          }
        }
      }
    }
  }
  eq(improvable, 0, `${improvable} plans could still be improved by a swap the pass may make`);
  ok(moved > 0, `the adjacency table never changed a single plan out of ${plans}`);
});

test("a room that is nobody's neighbour is not moved for the sake of it", () => {
  // The swap is only ever between rooms at the same depth from the street,
  // which is what keeps the publicness ordering the previous pass decided.
  for (let s = 1; s <= 30; s++) {
    const { zones } = planFloor({
      w: 14, d: 11, entrance: { x: 0, z: 5.5, side: "south" },
      programme: roomProgramme({ archetype: "shop", level: 0, at: "ground", zones: 4, rng: mulberry32(s) }),
      rng: mulberry32(s), grain: 22, maxZones: 4, affinity: affinityOf,
    });
    for (const a of zones) {
      for (const b of zones) {
        if (a.purpose === "corridor" || b.purpose === "corridor") continue;
        if (a.depth < b.depth) {
          ok(a.publicness <= b.publicness,
            `seed ${s}: the affinity pass put a ${a.purpose} behind a ${b.purpose}`);
        }
      }
    }
  }
});

/* ══════════════════ the new codes, and the floor ══════════════════ */

test("it catches a window built out, and a stair stood in", () => {
  const tall = [P("wardrobe", 0, -3.0)];
  const blind = validateRoom({ room, placed: tall, door, programId: "bedroom" }).violations.map((v) => v.code);
  ok(!blind.includes("BLOCKS_WINDOW"), "a wardrobe against a blank wall was called a bricked-up window");
  const glazed = validateRoom({ room, placed: tall, door, programId: "bedroom", glazed: ["north"] })
    .violations.map((v) => v.code);
  ok(glazed.includes("BLOCKS_WINDOW"), "a wardrobe across the only window passed");
  // …and a chest under one is a window seat, not a fault.
  const low = validateRoom({ room, placed: [P("chest", 0, -3.1)], door, programId: "bedroom",
    glazed: ["north"] }).violations.map((v) => v.code);
  ok(!low.includes("BLOCKS_WINDOW"), "a chest under a window is not a window seat");

  const stair = [{ x: 1.6, z: -2.0, w: 2.0, d: 3.0 }];
  const inIt = validateRoom({ room, placed: [P("chest", 1.6, -2.0)], door, programId: "bedroom",
    blocked: stair }).violations.map((v) => v.code);
  ok(inIt.includes("BLOCKS_FIXTURE"), "a chest standing inside the staircase passed");
});

test("it catches a lamp that lights nothing, and a bench nobody can see at", () => {
  // A brazier walled into a corner behind a stack of crates: it burns, and
  // no floor anybody can stand on is inside its reach.
  const boxed = [P("brazier", -2.6, -3.1)];
  for (let x = -3; x <= -1.4; x += 0.5) boxed.push(P("crate", x, -2.0));
  for (let z = -3.2; z <= -1.6; z += 0.5) boxed.push(P("crate", -1.4, z));
  const got = validateRoom({ room, placed: boxed, door, programId: "store" }).violations;
  ok(got.some((v) => v.code === "DEAD_LIGHT" || v.code === "UNREACHABLE"),
    "a fire burning inside a stack of crates lit the room");

  // A workbench in a lit room, out of reach of every light in it.
  const far = [P("hearth", -2.2, -3.1), P("workbench", 2.2, 3.0)];
  const dark = validateRoom({ room, placed: far, door, programId: "workshop" }).violations.map((v) => v.code);
  ok(dark.includes("UNLIT_TASK"), "a workbench in the dark corner of a lit room passed");
  const near = validateRoom({ room, placed: [P("hearth", -2.2, -3.1), P("workbench", -1.4, -2.6)],
    door, programId: "workshop" }).violations.map((v) => v.code);
  ok(!near.includes("UNLIT_TASK"), "a bench beside the fire was reported as unlit");
});

test("every furnished storey can be walked from its own front door", () => {
  /* The check no ROOM can make. A plan can be four rooms each of which is
     furnished, lit, navigable and reachable through its own door, and still
     be a building whose back half nobody can get to — the failure lives in
     the join. This drives it over real pipeline output, which is the only
     place the claim means anything. */
  const shapes = [
    ["street/row-house", { floors: 2, w: 12, d: 10, bays: 3 }],
    ["builder/house", { floors: 1, w: 9, d: 8, bays: 2 }],
    ["street/civic", { floors: 3, w: 16, d: 13, bays: 4 }],
    ["street/block-stack", { floors: 4, w: 14, d: 12, bays: 3 }],
    ["street/row-shop", { floors: 2, w: 8, d: 11, bays: 2 }],
    ["street/platform", { floors: 1, w: 20, d: 15, bays: 4 }],
  ];
  let floors = 0;
  for (const [ref, args] of shapes) {
    const proc = buildingParts(args);
    for (let k = 0; k < 10; k++) {
      composeInteriors({
        records: [{ uid: `b${k}`, ref, proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
        links: [], seed: "FLOORS", uidAt: (i) => `u${i}`,
        biome: ["verdant", "tundra", "atoll"][k % 3],
        report: ({ archetype, level, check }) => {
          floors++;
          eq(check.violations.length, 0,
            `${ref} as a ${archetype}, level ${level}: `
            + check.violations.map((v) => `${v.code} ${v.id}`).join("; "));
          eq(check.stats.reachedZones, check.stats.zones);
        },
      });
    }
  }
  ok(floors >= 60, `only ${floors} storeys were checked`);
});

test("every archetype in the table is a building something can actually be", () => {
  // An archetype nothing can produce is an archetype, a room programme and a
  // catalogue of furniture that ship and can never appear.
  const seen = new Set();
  for (const kind of ["house", "row-house", "row-shop", "civic", "tower", "platform", "block",
                      "study", "villa", "cottage", "castle-spires", "castle-round", "castle-citadel"]) {
    for (const w of [5, 8, 12, 17, 23]) {
      for (const aspect of [1, 1.5, 2.2, 3]) {
        for (const storeys of [1, 2, 3, 5]) {
          for (const h of [2.7, 3.3, 4.6, 6.5]) {
            for (const windows of [0, 3, 10]) {
              seen.add(classify({ proc: shell({ w, d: w / aspect, storeys, h, windows }), kind }).archetype);
            }
          }
        }
      }
    }
  }
  for (const id of ARCHETYPE_IDS) ok(seen.has(id), `nothing anywhere is ever classified as a ${id}`);
});

test("every room programme is one some building actually asks for", () => {
  // The other direction: a programme nobody's grammar names is furniture
  // nobody will ever stand in.
  const asked = new Set(["corridor"]);   // the zoner's, not a grammar's
  for (const id of ARCHETYPE_IDS) {
    for (const list of Object.values(ARCHETYPES[id].rooms)) {
      for (const [purpose] of list) asked.add(purpose);
    }
  }
  for (const programId of Object.keys(PROGRAMS)) {
    ok(asked.has(programId), `no building in the table ever asks for a ${programId}`);
  }
  for (const purpose of asked) ok(PROGRAMS[purpose], `${purpose} is asked for and cannot be built`);
});

report("interior-pipeline");
