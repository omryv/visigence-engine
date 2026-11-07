/* Can you get in, and can you walk there.
 *
 * Everything else about a generated place can be right — the door is
 * declared, the room is furnished, the road arrives — and the place still be
 * one you cannot enter or cross, because "there is a door here" is a claim
 * about intent and collision is a fact about geometry. This file holds the
 * facts, and every assertion in it was written against something a headless
 * walk of built towns actually found.
 *
 * The walk itself is not run here: it needs the whole build — erosion, sculpt
 * strokes, three thousand placements — and the suite is deliberately engine-
 * free. What is held here is the arithmetic the walk depends on, which is
 * where every one of those defects actually lived:
 *
 *   the box a part occupies      a wall is an `extrude`, and the analytic
 *                                checker did not know the shape
 *   what an open door removes    the leaf, not the building it is in
 *   the way up to a door         a building on a slope needs one
 *   the ground in front of it    and nothing may stand there
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { partBox, blockersOf, blocked, surfaceAt, STEP_UP, RADIUS } from "../../../src/kernel/core/reach.js";
import { doorSteps, groundBuildings, RISER, TREAD } from "../../../src/genesis/world/footing.js";
import { composeSite, doorwaysOf } from "../../../src/genesis/world/compose.js";
import { makePlan, blockSpec } from "../../../src/genesis/world/worldplan.js";
import { allItems } from "../../../src/genesis/world/props-packs.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";
import { isInterior } from "../../../src/genesis/world/interiors.js";

/* ══ the box a part occupies ═════════════════════════════════════════════ */

test("the collision box knows every shape the renderer can build", () => {
  /* partBox knew four of the eight shapes Props.partGeometry makes, and an
     `extrude` — which is what every wall in this project is — carries no
     `dims` at all, so the first question anybody asked it about a house was
     a TypeError. No town could be walked. */
  const shapes = [
    { shape: "box", dims: [2, 3, 4], pos: [0, 0, 0] },
    { shape: "cylinder", dims: [1, 4], pos: [0, 0, 0] },
    { shape: "cone", dims: [2, 5], pos: [0, 0, 0] },
    { shape: "sphere", dims: [1.5], pos: [0, 0, 0] },
    { shape: "blob", dims: [2], pos: [0, 0, 0] },
    { shape: "lathe", profile: [[2, 0], [1.5, 3]], pos: [0, 0, 0] },
    { shape: "wedge", dims: [3, 2, 4], pos: [0, 0, 0] },
    { shape: "extrude", depth: 0.34, outline: [[-4, 0], [4, 0], [4, 3], [-4, 3]], pos: [0, 0, 0] },
  ];
  for (const p of shapes) {
    const b = partBox(p);
    for (const k of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"]) {
      ok(Number.isFinite(b[k]), `${p.shape}: ${k} is ${b[k]}`);
    }
    ok(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ, `${p.shape}: an empty box`);
  }
});

test("a wall stands where its outline is, not where its origin is", () => {
  // An extruded face runs from y = 0 UP. Read as a centred box it straddles
  // the ground it stands on: half the wall underground, and the doorway's
  // head at knee height.
  const wall = { shape: "extrude", depth: 0.34, pos: [0, 0, 0],
                 outline: [[-4, 0], [4, 0], [4, 3], [-4, 3]] };
  const b = partBox(wall);
  close(b.minY, 0, 1e-9, "the foot of the wall");
  close(b.maxY, 3, 1e-9, "the head of the wall");
  close(b.minZ, -0.17, 1e-9, "half its thickness either side of its plane");
  // A wedge is built the same way: from zero up.
  const w = partBox({ shape: "wedge", dims: [3, 2, 4], pos: [0, 0, 0] });
  close(w.minY, 0, 1e-9, "the foot of the wedge");
  close(w.maxY, 2, 1e-9, "the head of the wedge");
});

test("a taper is bounded by its widest end", () => {
  // rTop may be WIDER than the base; a bound taken from the base is inside
  // the mesh, which is a wall you walk into and a roof you fall through.
  const b = partBox({ shape: "cylinder", dims: [1, 4], rTop: 2.5, pos: [0, 0, 0] });
  close(b.maxX, 2.5, 1e-9, "the wide end");
});

/* ══ what an open door takes out of the world ════════════════════════════ */

test("opening a door removes the leaf, not the building", () => {
  /* blockersOf skipped the whole placement whenever it declared a hinge.
     That is right for one record shape only — a door leaf, where every part
     IS the door — and js/block-shapes.js declares the hinge on the BUILDING.
     So every house with a front door had no walls: the checker walked
     through the masonry and pronounced the room reachable. */
  const proc = buildingParts({ floors: 1, w: 8, d: 7.5, bays: 2, roof: "gable" });
  ok(proc.door?.hinge, "the generated building no longer declares a door");
  const rec = { uid: "b", ref: "test/house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 };
  const boxes = blockersOf([rec]);
  ok(boxes.length > 4, `a building with a door contributed ${boxes.length} boxes`);
  // The leaf is gone; the wall it hangs in is not.
  const leaf = proc.parts.find((p) => p.door);
  const leafBox = partBox(leaf);
  const still = boxes.some((b) => Math.abs(b.minZ - leafBox.minZ) < 1e-6 && Math.abs(b.maxX - leafBox.maxX) < 1e-6);
  ok(!still, "the leaf is still solid with the door open");
  // …and standing outside the back wall is standing inside something.
  const back = -(7.5 / 2 - 0.17);
  ok(blocked(boxes, 0, back, 1.0, RADIUS), "the back wall is not solid");
});

test("a door you cannot open is not a door", () => {
  /* Every block that declares a room is claiming a furnished interior, and
     interiors.js will furnish it. A leaf with no hinge is a board nailed
     across the opening — the room is dressed and sealed. The four hand-
     authored blocks that got this wrong are named, so the day one of them
     grows a hinge this test says so rather than going quietly green. */
  const SEALED = new Set(["tower", "castle-spires", "castle-round"]);
  const known = new Set();
  for (const item of allItems()) {
    if (!item.proc?.rooms?.length) continue;
    const openable = !!item.proc.door?.hinge;
    if (!openable) {
      known.add(item.id);
      ok(SEALED.has(item.id),
        `${item.pack}/${item.id} declares a room behind a door that cannot be opened`);
    }
  }
  for (const id of SEALED) {
    ok(known.has(id), `${id} can be opened now — take it off the sealed list`);
  }
});

/* ══ the way up to the door ══════════════════════════════════════════════ */

test("a building on a slope is given steps up to its door", () => {
  /* footing.js stands a building on the HIGHEST ground it covers, which is
     what keeps the hillside out of the room and what puts the front door up
     a bank: the door is usually on the downhill face. The footing's own
     courses are inset 7 cm a side — a ledge, not a tread — so without a
     flight there is no way in at all. */
  const proc = buildingParts({ floors: 1, w: 8, d: 7.5, bays: 2, roof: "gable" });
  const rec = { uid: "b", ref: "test/house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 };
  // Ground falling away toward +z, which is the face the door is on.
  const slope = (x, z) => -z * 0.25;
  const out = groundBuildings({ records: [rec], sampler: slope, uidAt: (n) => `u${n}` });
  const steps = out.footings.find((f) => f.ref === "site/steps");
  ok(steps, "no steps on a building whose door is a metre above the ground");
  ok(steps.proc.parts.length >= 2, `a flight of ${steps.proc.parts.length}`);
  // Every riser inside a stride, or it is a wall with a pattern on it.
  const tops = steps.proc.parts.map((p) => p.pos[1] + p.dims[1] / 2).sort((a, b) => a - b);
  for (let i = 1; i < tops.length; i++) {
    ok(tops[i] - tops[i - 1] <= STEP_UP, `a ${(tops[i] - tops[i - 1]).toFixed(2)} m riser`);
  }
  // …and every tread wide enough to stand on, which is the other half of it:
  // a 7 cm ledge is inside the player's own radius.
  for (const p of steps.proc.parts) ok(p.dims[2] >= RADIUS * 2, `a ${p.dims[2]} m tread`);
  eq(steps.seat, "point", "the flight is seated on the terrain it was solved against");
});

test("level ground is given no steps at all", () => {
  const proc = buildingParts({ floors: 1, w: 8, d: 7.5, bays: 2, roof: "gable" });
  const rec = { uid: "b", ref: "test/house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 };
  const out = groundBuildings({ records: [rec], sampler: () => 4, uidAt: (n) => `u${n}` });
  ok(!out.footings.some((f) => f.ref === "site/steps"), "a flight of steps on flat ground");
  ok(RISER <= STEP_UP && TREAD > RADIUS * 2, "the stair's own numbers are not walkable");
});

/* ══ the ground in front of the door ═════════════════════════════════════ */

test("nothing is placed in a doorway", () => {
  /* The failure this ends: `free` compares footprint CIRCLES, and a circle
     round a building says nothing about which side of it the door is on. A
     street lamp half a metre outside that circle stands dead in the opening,
     0.43 m proud — which is 12 cm inside what the walk controller will climb
     over. Whole streets of the market town could not be entered. */
  const KINDS = ["market-hamlet", "old-town", "castle-court", "shore-village"];
  for (const kind of KINDS) {
    const out = composeSite({
      plan: makePlan({ kind, size: "medium" }),
      center: { x: 0, z: 0 }, seed: `DOOR-${kind}`, sampler: () => 10, waterLevel: 0,
      interiorMax: 0, interiorBudget: 0,
    });
    const doors = [];
    for (const rec of out.records) {
      const c = Math.cos(rec.rotationY || 0), s = Math.sin(rec.rotationY || 0);
      const scale = rec.scale ?? 1;
      for (const d of doorwaysOf(rec.proc)) {
        const len = Math.hypot(d.x, d.z) || 1;
        const u = (d.x + (d.x / len) * 0.5) * scale, v = (d.z + (d.z / len) * 0.5) * scale;
        doors.push({ uid: rec.uid,
          x: rec.position[0] + u * c + v * s, z: rec.position[2] - u * s + v * c });
      }
    }
    ok(doors.length, `${kind}: not one block in the site declares a way in`);
    for (const rec of out.records) {
      if (isInterior(rec)) continue;
      const spec = blockSpec(rec.ref.split("/")[1]);
      const foot = spec?.foot?.r ?? 0.5;
      for (const d of doors) {
        if (d.uid === rec.uid) continue;
        const gap = Math.hypot(rec.position[0] - d.x, rec.position[2] - d.z);
        // Its own footprint has to clear the standing room in front of the
        // door. A big block simply may not be there at all.
        ok(gap > Math.min(foot, 1.0), `${kind}: ${rec.ref} stands ${gap.toFixed(2)} m from a doorway`);
      }
    }
  }
});

/* ══ standing on what you are given ══════════════════════════════════════ */

test("the floor of a room is a thing you can stand on", () => {
  // Every one of these checks is a claim about the SAME arithmetic the walk
  // controller uses, so the floor a room declares has to be the surface the
  // collision boxes offer at that point.
  const proc = buildingParts({ floors: 2, w: 9, d: 9, bays: 3 });
  const rec = { uid: "b", ref: "test/block", proc, position: [0, 0, 0], rotationY: 0, scale: 1 };
  const boxes = blockersOf([rec]);
  const room = proc.rooms.find((r) => r.at === "ground");
  const stand = surfaceAt(boxes, room.x, room.z, room.y, RADIUS);
  close(stand, room.y, 1e-6, `the floor of the ground room is at ${room.y}`);
});

report("access");
