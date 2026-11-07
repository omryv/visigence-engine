// Catalog contracts for the generated blocks (block-shapes.js).
//
// The rules these enforce are the ones that make a CITY possible rather than
// another hamlet: part count that does not grow with a building's height,
// modules that abut without a seam, and window openings that are genuinely
// inside the wall they are punched through.
import { test, eq, ok, report } from "../kernel/harness.js";
import { MODULE, buildingParts, roadParts, junctionParts, plazaParts,
         treeParts, pineParts, birchParts, bushParts, hedgeParts } from "../../../src/genesis/world/block-shapes.js";
import { allItems, findItem } from "../../../src/genesis/world/props-packs.js";
import { BLOCK_META, blockSpec, footprintOf } from "../../../src/genesis/world/worldplan.js";

/* ── geometry helpers ── */
// Ray-casting point-in-polygon. Needed because a gable wall's outline is a
// peaked pentagon: a window can sit inside the bounding box and still be
// outside the sloped edge, which ExtrudeGeometry triangulates into garbage.
function inside(poly, px, py) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const bbox = (pts) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, x1, y0, y1 };
};
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Every extrude in a spec must have holes strictly inside its outline, and no
// two holes may intersect.
function checkExtrudes(proc, label) {
  for (const p of proc.parts) {
    if (p.shape !== "extrude" || !p.holes?.length) continue;
    for (const hole of p.holes) {
      for (const [hx, hy] of hole) {
        ok(inside(p.outline, hx, hy), `${label}: hole vertex ${hx},${hy} outside its outline`);
      }
    }
    for (let i = 0; i < p.holes.length; i++) {
      for (let j = i + 1; j < p.holes.length; j++) {
        ok(!overlap(bbox(p.holes[i]), bbox(p.holes[j])), `${label}: holes ${i} and ${j} intersect`);
      }
    }
  }
}

/* ── the rule that makes a city affordable ── */
test("a building's part count does not grow with its height", () => {
  // The rule is O(1) in storeys, not "every height costs the same integer".
  // A block short enough to have no unreachable middle emits no lit slab for
  // one, which makes it CHEAPER — that is the rule working, not breaking it.
  // What must never happen is cost climbing as the building climbs.
  const counts = [6, 12, 24, 48, 96].map((floors) => buildingParts({ floors }).parts.length);
  eq(new Set(counts).size, 1, `cost grew with storeys: ${counts.join(" → ")}`);

  const low = buildingParts({ floors: 2 });
  ok(low.parts.length <= counts[0], "a 2-storey block must not cost more than a 96-storey one");

  // And it must genuinely be taller — not the same building with more windows
  // drawn on it.
  const topOf = (b) => Math.max(...b.parts.map((p) => (p.pos?.[1] ?? 0)));
  ok(topOf(buildingParts({ floors: 24 })) > topOf(low) * 5, "the tall one really is tall");
});

test("every generated building keeps its windows inside its walls", () => {
  for (const floors of [1, 2, 3, 6, 12]) {
    for (const roof of ["flat", "gable", "hip"]) {
      for (const sides of ["free", "party"]) {
        for (const bays of [1, 2, 3, 5]) {
          const b = buildingParts({ floors, roof, sides, bays, w: 6 + bays, d: 9 });
          checkExtrudes(b, `floors=${floors} roof=${roof} sides=${sides} bays=${bays}`);
        }
      }
    }
  }
});

test("windows never climb into the gable above the wall head", () => {
  // The invariant: the topmost window's head is floorH*(floors-1+0.8), which
  // is always below floorH*floors. Assert it rather than trust the algebra.
  for (const floors of [1, 4, 9]) {
    for (const floorH of [2.4, 3.2, 4.6]) {
      const b = buildingParts({ floors, floorH, roof: "gable", sides: "free" });
      const H = floors * floorH;
      for (const p of b.parts) {
        if (p.shape !== "extrude") continue;
        for (const hole of p.holes || []) {
          for (const [, hy] of hole) ok(hy < H, `window head ${hy} reaches the wall head ${H}`);
        }
      }
    }
  }
});

test("gable slabs fall away from the ridge, not toward it", () => {
  // A sign slip here does not crash, does not change the part count and does
  // not move the footprint — it silently builds a valley instead of a roof.
  for (const sides of ["free", "party"]) {
    const b = buildingParts({ floors: 2, w: 8, d: 9, roof: "gable", sides });
    const slabs = b.parts.filter((p) => p.rotX && p.shape === "box");
    eq(slabs.length, 2, "a gable is two slabs");
    for (const s of slabs) {
      const [, py, pz] = s.pos, th = s.rotX, len = s.dims[2] / 2;
      // Rotation about X: y' = -z sin θ, z' = z cos θ for a point on the axis.
      const end = (t) => ({ y: py - t * len * Math.sin(th), z: pz + t * len * Math.cos(th) });
      const a = end(1), c = end(-1);
      const outer = Math.abs(a.z) > Math.abs(c.z) ? a : c;
      const inner = outer === a ? c : a;
      ok(outer.y < inner.y, `slab at z=${pz} rises away from the ridge`);
      ok(Math.abs(inner.z) < Math.abs(outer.z), "inner end is the ridge end");
    }
  }
});

test("every roof sits above the wall head it covers", () => {
  for (const roof of ["flat", "gable", "hip"]) {
    const floors = 3, floorH = 3.2;
    const b = buildingParts({ floors, floorH, w: 10, d: 10, roof });
    const top = 0.34 + floors * floorH;
    const roofY = Math.max(...b.parts.map((p) => p.pos?.[1] ?? 0));
    ok(roofY >= top - 0.2, `${roof}: highest part ${roofY} is below the wall head ${top}`);
  }
});

/* ── the rule that makes a street ── */
/* ── the entrance ──
   Collision is one axis-aligned box per MESH, so a doorway punched as a hole
   in a single wall is solid to the player however open the door is. The gap
   has to be between meshes. */
test("a doorway is a real gap between meshes, not a hole in one wall", () => {
  const b = buildingParts({ floors: 4, w: 12, d: 11, bays: 4 });
  const frontOf = (spec) => spec.parts.filter(
    (p) => p.shape === "extrude" && p.depth === 0.34 && !p.rotY && p.pos[2] > 0);

  // A doorless block keeps the cheap single-mesh face and declares no hinge.
  const solid = buildingParts({ floors: 4, w: 12, d: 11, bays: 4, door: false });

  ok(b.door?.hinge, "no hinge declared, so E would do nothing");
  ok(b.parts.some((p) => p.door), "nothing flagged as the swinging leaf");
  eq(frontOf(b).length, 3, "the entrance face should be two piers and a lintel");

  // Nothing may cross the doorway below head height.
  for (const piece of frontOf(b)) {
    const xs = piece.outline.map(([x]) => x), ys = piece.outline.map(([, y]) => y);
    if (Math.min(...xs) < -0.1 && Math.max(...xs) > 0.1) {
      ok(Math.min(...ys) >= 2.4 - 1e-6, "a mesh spans the doorway at floor level");
    }
  }
  // Nothing lit may stand in the doorway — that is literally what you saw
  // when opening the door revealed a glowing panel. Checked as the property,
  // not the mechanism: lifting the slab above the room and notching it around
  // the opening are both legal ways to satisfy it.
  // Only the entrance face can be in the doorway: the back wall's lit skin
  // sits at the same x and the same height, and is not in anybody's way.
  const px = 0, py = 0.34 + 1.2;   // building-local: middle of the door, chest height
  for (const p of b.parts.filter((q) => q.emissive != null && q.pos[2] > 0)) {
    const hit = p.shape === "extrude"
      ? inside(p.outline, px - p.pos[0], py - p.pos[1])
      : Math.abs(px - p.pos[0]) <= p.dims[0] / 2 && Math.abs(py - p.pos[1]) <= p.dims[1] / 2;
    ok(!hit, "a lit part stands in the doorway");
  }

  // And the block must declare the room behind the door, or nothing can
  // furnish it.
  const ground = (b.rooms || []).filter((rm) => rm.at === "ground");
  eq(ground.length, 1, "a door with no ground room declared behind it");
  eq(ground[0].level, 0, "the ground room is on the bottom tier");
  for (const rm of b.rooms) ok(rm.w > 0 && rm.d > 0 && rm.h > 0, "a room has no envelope");
  // A doorless block still declares its head rooms — a walkway can land on the
  // terrace above one — but nothing on the ground, because nothing gets in.
  eq((solid.rooms || []).filter((rm) => rm.at === "ground").length, 0,
    "a doorless block declares a ground room nothing can enter");

  eq(solid.door, undefined, "a doorless block must not declare a hinge");
  eq(frontOf(solid).length, 1, "no door means no split");
});

/* ── stacking ──
   Massing tiers are the one thing allowed to cost parts, because there are
   never many of them. Storeys still must not. */
test("a stacked building costs per tier, never per storey", () => {
  for (const tiers of [1, 2, 3, 4]) {
    const counts = [12, 30, 60].map((floors) =>
      buildingParts({ floors, tiers, setback: 0.18, shift: 0.6 }).parts.length);
    eq(new Set(counts).size, 1, `${tiers} tiers: storeys must be free (${counts.join(" → ")})`);
  }
  // And a tier genuinely costs something, or the setbacks are not being built.
  const one = buildingParts({ floors: 12, tiers: 1 });
  const four = buildingParts({ floors: 12, tiers: 4 });
  ok(four.parts.length > one.parts.length, "four masses cost more than one");
  ok(four.parts.length < one.parts.length * 5, "but a tier is not a whole new building");
});

test("an upper tier never overhangs the mass it stands on", () => {
  // `shift` slides a tier off centre; if it may slide further than the
  // setback freed, the tower leans out over thin air.
  for (const shift of [0, 0.5, 1]) {
    const b = buildingParts({ floors: 16, tiers: 4, w: 12, d: 10, setback: 0.2, shift });
    const walls = b.parts.filter((p) => p.shape === "extrude" && p.depth === 0.34);
    // Group by the tier's base height, NOT in fours — the entrance face is
    // three meshes (two piers and a lintel), so a tier is not always four.
    const byTier = new Map();
    for (const p of walls) {
      if (!byTier.has(p.pos[1])) byTier.set(p.pos[1], []);
      byTier.get(p.pos[1]).push(p);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b).map((k) => byTier.get(k));
    let prev = null;
    for (let t = 0; t < tiers.length; t++) {
      const tier = tiers[t];
      const xs = tier.map((p) => p.pos[0]), zs = tier.map((p) => p.pos[2]);
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
      if (prev) {
        ok(box.x0 >= prev.x0 - 1e-6 && box.x1 <= prev.x1 + 1e-6,
          `shift ${shift}: tier ${t} hangs off the x face`);
        ok(box.z0 >= prev.z0 - 1e-6 && box.z1 <= prev.z1 + 1e-6,
          `shift ${shift}: tier ${t} hangs off the z face`);
      }
      prev = box;
    }
  }
});

test("a row unit keeps its frontage however many tiers it carries", () => {
  // Setbacks may eat into depth, never into the run: a terrace of stacked
  // units still has to meet its neighbours on the party line.
  for (const tiers of [1, 2, 3]) {
    const unit = buildingParts({ floors: 9, tiers, w: MODULE, d: 8.5, sides: "party", shift: 1 });
    eq(Math.round(footprintOf(unit).w * 1000) / 1000, MODULE, `${tiers} tiers`);
  }
});

test("row units are exactly one module wide and never overhang it", () => {
  for (const roof of ["flat", "gable"]) {
    const unit = buildingParts({ floors: 3, w: MODULE, d: 8.5, roof, sides: "party" });
    const foot = footprintOf(unit);
    eq(Math.round(foot.w * 1000) / 1000, MODULE, `${roof} row unit frontage`);
    // Nothing — plinth lip, eaves, cornice — may cross the party line, or two
    // abutting units interpenetrate instead of sharing a wall.
    for (const p of unit.parts) {
      const half = p.shape === "extrude"
        ? Math.max(...p.outline.map(([x]) => Math.abs(x)))
        : (p.dims ? p.dims[0] / 2 : 0);
      const cx = Math.abs(p.pos?.[0] ?? 0);
      // Side walls are turned a quarter turn, so their outline spans depth.
      if (p.rotY) continue;
      ok(cx + half <= MODULE / 2 + 1e-6, `${roof}: a part reaches ${cx + half} past the party line`);
    }
  }
});

test("a free-standing block DOES overhang — it is not a row unit", () => {
  const free = buildingParts({ floors: 3, w: MODULE, d: 8.5, sides: "free" });
  ok(footprintOf(free).w > MODULE, "eaves and plinth lip stand proud");
});

test("road pieces tile on the same module as walls and fences", () => {
  for (const [label, proc] of [["road", roadParts()], ["zebra", roadParts({ markings: "zebra" })],
                               ["plaza", plazaParts()]]) {
    const foot = footprintOf(proc);
    eq(Math.round(foot.w * 1000) / 1000, MODULE, `${label} runs ${MODULE}m along X`);
  }
  // The junction is square and as wide as the road is, so a run meeting
  // another run at right angles joins flush on both approaches.
  const road = footprintOf(roadParts()), cross = footprintOf(junctionParts());
  eq(Math.round(cross.w * 100) / 100, Math.round(road.d * 100) / 100, "junction spans the road's width");
  eq(Math.round(cross.w * 100) / 100, Math.round(cross.d * 100) / 100, "and is square");
});

/* ── catalog wiring ── */
test("every generated block resolves through the composer's lookup", () => {
  const ids = ["road", "road-plain", "crossing", "junction", "plaza",
               "block-low", "block-mid", "block-high", "civic",
               "row-house", "row-shop", "tree", "tree-small", "pine", "hedge"];
  for (const id of ids) {
    const spec = blockSpec(id);
    ok(spec, `blockSpec("${id}") resolves`);
    ok(spec.proc.parts.length > 0, `${id} has parts`);
    ok(spec.foot.r > 0, `${id} has a footprint`);
    checkExtrudes(spec.proc, id);
  }
});

test("no BLOCK_META entry names a block that does not exist", () => {
  for (const id of Object.keys(BLOCK_META)) {
    ok(findItem(id), `BLOCK_META has "${id}" but the catalog does not`);
  }
});

test("every catalog item is either procedural or a stream, and ids are unique", () => {
  const seen = new Set();
  for (const it of allItems()) {
    ok(!seen.has(it.id), `duplicate catalog id: ${it.id}`);
    seen.add(it.id);
    ok(!!it.proc || !!it.url, `${it.id} is neither proc nor url`);
    if (it.proc) {
      ok(Array.isArray(it.proc.parts) && it.proc.parts.length, `${it.id} has no parts`);
      for (const p of it.proc.parts) ok(typeof p.shape === "string", `${it.id} part without a shape`);
      checkExtrudes(it.proc, it.id);
    }
  }
});

test("planting is cheap and stands on the ground", () => {
  // The Unity-quality species cost a few more parts than the old lollipops
  // (trunk + limbs + displaced-blob crown lobes), but stay well under a
  // building's ~16 — cheap enough to plant in rows.
  for (const [label, proc] of [
    ["tree", treeParts()], ["pine", pineParts()], ["birch", birchParts()],
    ["bush", bushParts()], ["hedge", hedgeParts()],
  ]) {
    ok(proc.parts.length <= 8, `${label} costs ${proc.parts.length} meshes`);
    const lowest = Math.min(...proc.parts.map((p) => p.pos?.[1] ?? 0));
    ok(lowest >= 0, `${label} starts at or above its origin, not buried`);
  }
});

test("generation is pure — the same numbers give the same parts", () => {
  const a = JSON.stringify(buildingParts({ floors: 5, w: 10, d: 9, bays: 3 }));
  const b = JSON.stringify(buildingParts({ floors: 5, w: 10, d: 9, bays: 3 }));
  eq(a, b);
});

report("blocks");
