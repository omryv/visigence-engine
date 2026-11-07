// Interiors: reachable rooms only, circulation that does not cost per storey,
// every piece an ordinary editable placement rather than geometry welded into
// a shell — and, since the rooms are now planned rather than scattered, the
// constraints that make a planned room worth having. Those are the bulk of
// this file: a layout solver whose guarantees are not tested is a scatter.
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";
import {
  INTERIOR_REF, isInterior, roomsOf, connectedLevels, composeInteriors,
  coreParts, stairParts, partitionParts, floorPlateParts,
} from "../../../src/genesis/world/interiors.js";
import { planRoom, PROGRAMS } from "../../../src/genesis/world/interior-plan.js";
import { CATALOGUE, interiorStyle, buildPiece, footprintOf, ITEM_IDS } from "../../../src/genesis/world/furniture.js";
import { mulberry32 } from "../../../src/kernel/seed.js";

const uidAt = (i) => `u${i}`;
const tower = (opts = {}) => buildingParts({ floors: 12, tiers: 3, w: 13, d: 12, bays: 4, ...opts });
const rec = (uid, proc, x = 0, z = 0, rotationY = 0, y = 0) => ({
  uid, ref: "street/block-stack", url: null, label: "Stack",
  proc, position: [x, y, z], rotationY, scale: 1,
});
const port = (uid, level, kind = "walkway") => ({ uid, index: 0, kind, level, x: 0, y: 0, z: 0, nx: 0, nz: 1 });

// A room and a plan for it, in one call — most tests below want both.
function plan(programId, { w = 6, d = 7, h = 3.1, seed = 7, budget = 1 } = {}) {
  const rng = mulberry32(seed);
  const style = interiorStyle({ wealth: 0.5, age: 0.4, wear: 0.4, rng });
  const room = { w, d, h, area: w * d };
  return planRoom({ room, programId, style, rng, door: { x: 0, side: "south" }, budget });
}
// The axis-aligned box a placement occupies on the floor.
const boxOf = (p) => {
  const c = Math.abs(Math.cos(p.rot)), s = Math.abs(Math.sin(p.rot));
  return { x: p.x, z: p.z, w: p.foot.w * c + p.foot.d * s, d: p.foot.w * s + p.foot.d * c };
};
const overlap = (a, b) => {
  const ox = (a.w + b.w) / 2 - Math.abs(a.x - b.x);
  const oz = (a.d + b.d) / 2 - Math.abs(a.z - b.z);
  return ox > 0 && oz > 0 ? Math.min(ox, oz) : 0;
};
// Everything standing on the floor — the only things that can collide there.
const onFloor = (out) => out.filter((p) => !p.host && !p.spec.flat);

/* ── room envelopes ── */

test("a block declares a ground room and one head room per tier", () => {
  const proc = tower();
  ok(proc.rooms.length >= 3, `expected a room per tier, got ${proc.rooms.length}`);
  ok(proc.rooms.some((r) => r.at === "ground"), "no ground room");
  for (const r of proc.rooms) {
    ok(r.w > 0 && r.d > 0 && r.h > 0, "degenerate room envelope");
  }
});

test("room envelopes follow the placement, rotation and slope included", () => {
  const proc = buildingParts({ floors: 2, w: 10, d: 8 });
  const flat = roomsOf(rec("a", proc, 0, 0, 0, 0));
  const moved = roomsOf(rec("a", proc, 40, -25, Math.PI / 2, 6));
  eq(flat.length, moved.length);
  for (let i = 0; i < flat.length; i++) {
    close(moved[i].y - flat[i].y, 6, 1e-6, "room did not follow the ground");
    close(Math.hypot(moved[i].x - 40, moved[i].z + 25), Math.hypot(flat[i].x, flat[i].z), 1e-6,
      "rotation moved the room off its own placement");
  }
});

test("scale carries the envelope with the geometry", () => {
  const proc = buildingParts({ floors: 2, w: 10, d: 8 });
  const one = roomsOf({ ...rec("a", proc), scale: 1 })[0];
  const two = roomsOf({ ...rec("a", proc), scale: 2 })[0];
  close(two.w, one.w * 2, 1e-6);
  close(two.h, one.h * 2, 1e-6);
});

/* ── reachability ── */

test("only tier heads a walkway actually reached count as connected", () => {
  eq(connectedLevels("a", []).length, 0);
  const links = [{ a: port("a", 1), b: port("b", 1) }, { a: port("c", 2), b: port("a", 2) }];
  eq(connectedLevels("a", links).join(","), "1,2");
});

test("an unlinked tower is furnished on the ground floor and nowhere else", () => {
  const proc = tower();
  const out = composeInteriors({ records: [rec("a", proc)], links: [], seed: "S", uidAt });
  const ground = proc.rooms.find((r) => r.at === "ground");
  const ys = new Set(out.map((r) => Math.round(r.position[1])));
  ok([...ys].every((y) => y - Math.round(ground.y) < ground.h * 1.6), "furnished an unreachable floor");
});

test("a walkway landing on a tier furnishes that tier too", () => {
  const proc = tower();
  const lvl = proc.rooms.find((r) => r.at === "head" && r.level > 0);
  const links = [{ a: port("a", lvl.level), b: port("b", lvl.level) }];
  const alone = composeInteriors({ records: [rec("a", proc)], links: [], seed: "S", uidAt });
  const linked = composeInteriors({ records: [rec("a", proc)], links, seed: "S", uidAt });
  ok(linked.length > alone.length, "a reached tier was not furnished");
});

test("a block that declares no rooms is left alone", () => {
  const out = composeInteriors({
    records: [{ uid: "a", proc: { parts: [{ shape: "box", dims: [1, 1, 1], pos: [0, 0, 0] }] }, position: [0, 0, 0] }],
    links: [], seed: "S", uidAt,
  });
  eq(out.length, 0);
});

/* ── circulation ── */

test("a shaft costs the same at four storeys and forty", () => {
  const short = coreParts({ h: 12 }), tall = coreParts({ h: 120 });
  eq(short.parts.length, tall.parts.length, "core cost grew with height");
});

test("one shaft per building, not one per floor", () => {
  const proc = tower();
  const links = proc.rooms.filter((r) => r.at === "head")
    .map((r) => ({ a: port("a", r.level), b: port("b", r.level) }));
  const out = composeInteriors({ records: [rec("a", proc)], links, seed: "S", uidAt });
  eq(out.filter((r) => r.ref.endsWith("core")).length, 1);
});

test("a stair exists to reach a floor, and never otherwise", () => {
  /* The fault this pins down was in every world: a two-storey cottage got a
     flight of stairs up into blank plaster. `storeys` counts FLOORS and a
     block declares a room per TIER, so a building with nothing furnishable
     above it still measured as multi-storey. Nothing above → no stair. */
  const two = buildingParts({ floors: 2, w: 10, d: 9 });
  const alone = composeInteriors({ records: [rec("a", two)], seed: "S", uidAt });
  ok(!alone.some((r) => /(stair|core)$/.test(r.ref)),
    "a stair in a building with no reachable floor above it");

  // Reach the tier above and the stair becomes real — with a floor to land on.
  const head = two.rooms.find((r) => r.at === "head");
  const links = [{ a: port("a", head.level), b: port("x", head.level) }];
  const linked = composeInteriors({ records: [rec("a", two)], links, seed: "S", uidAt });
  const stair = linked.find((r) => r.ref.endsWith("stair"));
  ok(stair, "a reached upper floor with no way up to it");
  const floors = linked.filter((r) => r.ref.endsWith("floor"));
  ok(floors.length, "a stair arriving at open air");
  ok(floors.every((f) => f.position[1] > stair.position[1] + 0.5), "the floor is under its own stair");
});

test("a tall block gets a shaft rather than a flight per storey", () => {
  const proc = tower();
  const links = proc.rooms.filter((r) => r.at === "head")
    .map((r) => ({ a: port("b", r.level), b: port("x", r.level) }));
  const high = composeInteriors({ records: [rec("b", proc)], links, seed: "S", uidAt });
  ok(high.some((r) => r.ref.endsWith("core")), "no shaft in a twelve-storey block");
  ok(!high.some((r) => r.ref.endsWith("stair")), "a shaft AND a stair in the same building");
});

test("an upper floor is a floor, with the stairwell left out of it", () => {
  const proc = buildingParts({ floors: 4, tiers: 2, w: 13, d: 12 });
  const links = proc.rooms.filter((r) => r.at === "head")
    .map((r) => ({ a: port("a", r.level), b: port("x", r.level) }));
  const out = composeInteriors({ records: [rec("a", proc)], links, seed: "S", uidAt });
  const slabs = out.filter((r) => r.ref.endsWith("floor"));
  ok(slabs.length >= 2, `an upper floor emitted as ${slabs.length} slab(s) — that is a plate with no opening`);
  // Collision here is one box per mesh, so the well has to be a gap between
  // slabs rather than a hole in one.
  const stair = out.find((r) => /(stair|core)$/.test(r.ref));
  ok(stair, "no circulation at all");
  for (const s of slabs) {
    const box = s.proc.parts[0].dims;
    const dx = Math.abs(s.position[0] - stair.position[0]) - box[0] / 2;
    const dz = Math.abs(s.position[2] - stair.position[2]) - box[2] / 2;
    ok(dx > -0.9 || dz > -0.9, "a floor slab was laid across its own stairwell");
  }
});

test("a partition leaves a real gap, because collision is one box per mesh", () => {
  const proc = partitionParts({ len: 6, h: 3, gap: 1.4 });
  const low = proc.parts.filter((p) => p.pos[1] < 2.3 - 0.01);
  ok(low.length >= 2, "partition is not split around an opening");
  const sorted = low.slice().sort((a, b) => a.pos[0] - b.pos[0]);
  const gap = (sorted[1].pos[0] - sorted[1].dims[0] / 2) - (sorted[0].pos[0] + sorted[0].dims[0] / 2);
  ok(gap > 1.0, `gap is only ${gap.toFixed(2)}m — nobody fits through`);
});

/* ── the placement contract ── */

test("every interior piece is an ordinary, editable placement", () => {
  const out = composeInteriors({ records: [rec("a", tower())], seed: "S", uidAt });
  ok(out.length > 0, "nothing was placed");
  for (const r of out) {
    ok(isInterior(r), `${r.label} is not tagged as an interior`);
    ok(r.ref.startsWith(INTERIOR_REF), "ref lost its prefix");
    ok(typeof r.uid === "string" && r.uid.length > 0, "no uid");
    ok(Array.isArray(r.position) && r.position.length === 3, "no position");
    ok(r.position.every(Number.isFinite), `${r.label} has a non-finite position`);
    ok(Number.isFinite(r.rotationY), "no rotation");
    ok(r.proc && Array.isArray(r.proc.parts) && r.proc.parts.length, `${r.label} has no geometry`);
    eq(r.seat, "point", "an interior piece was seated on the terrain");
  }
});

test("interiors are deterministic", () => {
  const a = composeInteriors({ records: [rec("a", tower())], seed: "S", uidAt });
  const b = composeInteriors({ records: [rec("a", tower())], seed: "S", uidAt });
  eq(JSON.stringify(a), JSON.stringify(b));
});

test("uids continue the site's own numbering rather than colliding with it", () => {
  const out = composeInteriors({ records: [rec("a", tower())], seed: "S", uidAt, index: 40 });
  ok(out.every((r) => Number(r.uid.slice(1)) >= 40), "an interior reused a site uid");
});

test("furniture stands inside the room it belongs to", () => {
  const proc = buildingParts({ floors: 6, tiers: 1, w: 14, d: 12 });
  const out = composeInteriors({ records: [rec("a", proc, 0, 0, 0)], links: [], seed: "S", uidAt });
  const room = roomsOf(rec("a", proc, 0, 0, 0)).find((r) => r.at === "ground");
  for (const r of out) {
    const dx = Math.abs(r.position[0] - room.x), dz = Math.abs(r.position[2] - room.z);
    ok(dx <= room.w / 2 + 0.4, `${r.label} is ${dx.toFixed(1)}m out along the frontage`);
    ok(dz <= room.d / 2 + 0.4, `${r.label} is ${dz.toFixed(1)}m out along the depth`);
  }
});

test("the emitters produce sane, themeable geometry", () => {
  for (const [name, proc] of Object.entries({
    core: coreParts({ h: 20 }), stair: stairParts({ rise: 3.2 }),
    partition: partitionParts({ len: 5 }), floor: floorPlateParts({ w: 8, d: 8 }),
  })) {
    ok(proc.parts.length > 0, `${name}: empty`);
    for (const p of proc.parts) {
      ok(p.pos.every(Number.isFinite), `${name}: bad position`);
      if (p.dims) ok(p.dims.every((v) => v > 0 && isFinite(v)), `${name}: bad dims ${p.dims}`);
      ok(!p.tex || typeof p.tex === "string", `${name}: bad tex`);
    }
  }
});

/* ══════════════════ the catalogue ══════════════════ */

test("every catalogued object builds real geometry at any style", () => {
  for (const wealth of [0, 0.5, 1]) {
    for (const age of [0, 1]) {
      const rng = mulberry32(11);
      const style = interiorStyle({ wealth, age, wear: age, rng });
      const room = { w: 6, d: 7, h: 3, area: 42 };
      for (const id of ITEM_IDS) {
        const piece = buildPiece(id, { style, rng, room });
        ok(piece.proc.parts.length > 0, `${id}: no parts`);
        for (const p of piece.proc.parts) {
          ok(p.pos.every(Number.isFinite), `${id}: non-finite position`);
          if (p.dims) ok(p.dims.every((v) => v > 0 && Number.isFinite(v)), `${id}: bad dims ${p.dims}`);
          if (p.profile) ok(p.profile.every(([r, y]) => Number.isFinite(r) && Number.isFinite(y) && r >= 0),
            `${id}: bad lathe profile`);
          ok(Number.isFinite(p.color), `${id}: no colour`);
        }
        ok(piece.foot.w > 0 && piece.foot.d > 0 && piece.foot.h > 0, `${id}: degenerate footprint`);
      }
    }
  }
});

test("what a lamp says it lights is what the engine is asked to light", () => {
  /* Two numbers describe the same flame: `lights` is the reach the layout
     solver plans around, and `light` on a part is the reach the renderer's
     lamp pool spends a real point light on. If they drift, a room is planned
     lit and rendered dark — which is exactly the failure interiors exist to
     stop, and it is invisible in a screenshot until you stand in the room. */
  const rng = mulberry32(13);
  const style = interiorStyle({ wealth: 0.6, age: 0.3, wear: 0.3, rng });
  const room = { w: 6, d: 7, h: 3, area: 42 };
  for (const id of ITEM_IDS) {
    const lit = buildPiece(id, { style, rng, room }).proc.parts.filter((p) => p.light > 0);
    const reach = CATALOGUE[id].lights;
    if (!reach) {
      eq(lit.length, 0, `${id} lights the room but never said so`);
      continue;
    }
    eq(lit.length, 1, `${id} declares one light and emits ${lit.length}`);
    close(lit[0].light, reach, 1e-6, `${id}: planned for ${reach}m, lights ${lit[0].light}m`);
    ok(lit[0].noCollide, `${id}: you can walk into its flame`);
  }
});

test("a poor old house and a rich new one are not the same materials", () => {
  const poor = interiorStyle({ wealth: 0.05, age: 0.95, wear: 0.9, rng: mulberry32(3) });
  const rich = interiorStyle({ wealth: 0.95, age: 0.05, wear: 0.05, rng: mulberry32(3) });
  ok(poor.wood !== rich.wood, "timber did not track wealth");
  ok(poor.grime > rich.grime, "a neglected house is not grimier than a kept one");
  ok(poor.glowPower < rich.glowPower, "a poor house burns as much light as a rich one");
});

test("every object declares a footprint the solver can reserve", () => {
  const rng = mulberry32(5);
  const room = { w: 6, d: 7, h: 3, area: 42 };
  for (const id of ITEM_IDS) {
    const spec = CATALOGUE[id];
    ok(typeof spec.anchor === "string", `${id}: no anchor`);
    ok(typeof spec.label === "string" && spec.label.length, `${id}: no label`);
    const f = footprintOf(id, rng, room);
    /* 3.5 m is the cap on a piece of FURNITURE — nobody has built a four-metre
       wardrobe. A floor covering is not furniture: a runner runs the length
       of the room it is laid in, by definition, and the reservation is safe
       precisely because `flat` pieces are excused the walkability and
       reachability passes. So a flat piece is capped by the room instead. */
    const cap = spec.flat ? Math.max(room.w, room.d) : 3.5;
    ok(f.w > 0.02 && f.w < cap, `${id}: implausible width ${f.w}`);
    ok(f.d > 0.02 && f.d < cap, `${id}: implausible depth ${f.d}`);
    ok(f.h > 0.01 && f.h < 2.6, `${id}: implausible height ${f.h}`);
  }
});

/* ══════════════════ the layout constraints ══════════════════ */

test("no two pieces on the floor intersect", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 12; seed++) {
      const out = onFloor(plan(programId, { seed }).placed);
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const ov = overlap(boxOf(out[i]), boxOf(out[j]));
          ok(ov <= 1e-6, `${programId}/${seed}: ${out[i].id} and ${out[j].id} overlap by ${ov.toFixed(2)}m`);
        }
      }
    }
  }
});

test("nothing pokes through a wall", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 8; seed++) {
      const w = 6, d = 7;
      for (const p of plan(programId, { seed, w, d }).placed) {
        const b = boxOf(p);
        ok(Math.abs(b.x) + b.w / 2 <= w / 2 + 1e-3, `${programId}: ${p.id} through the side wall`);
        ok(Math.abs(b.z) + b.d / 2 <= d / 2 + 1e-3, `${programId}: ${p.id} through the end wall`);
      }
    }
  }
});

test("wall furniture has its back to a wall", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const w = 6, d = 7;
    for (const p of plan("bedroom", { seed, w, d }).placed) {
      if (p.host || CATALOGUE[p.id].anchor !== "wall") continue;
      // Local −z is the back of every wall piece in the catalogue; turned by
      // the placement's rotation it must land on the room's boundary.
      const bx = p.x - Math.sin(p.rot) * p.foot.d / 2;
      const bz = p.z - Math.cos(p.rot) * p.foot.d / 2;
      const toWall = Math.min(w / 2 - Math.abs(bx), d / 2 - Math.abs(bz));
      ok(toWall < 0.14, `${p.id} stands ${toWall.toFixed(2)}m off the wall it should be against`);
    }
  }
});

test("a bed is always against a wall, in every bedroom", () => {
  let beds = 0;
  for (let seed = 1; seed <= 14; seed++) {
    const out = plan("bedroom", { seed }).placed.filter((p) => p.id === "bed");
    ok(out.length >= 1, `seed ${seed}: a bedroom with no bed`);
    for (const b of out) {
      beds++;
      const bx = b.x - Math.sin(b.rot) * b.foot.d / 2;
      const bz = b.z - Math.cos(b.rot) * b.foot.d / 2;
      ok(Math.min(3 - Math.abs(bx), 3.5 - Math.abs(bz)) < 0.14, "a bed floating in the middle of the room");
    }
  }
  ok(beds >= 14, "beds went missing");
});

test("seating stands at the thing it seats", () => {
  for (const programId of ["living", "hall", "office", "kitchen"]) {
    for (let seed = 1; seed <= 10; seed++) {
      const out = plan(programId, { seed }).placed;
      const seats = out.filter((p) => CATALOGUE[p.id].anchor === "companion");
      const hosts = out.filter((p) => CATALOGUE[p.id].seats);
      for (const s of seats) {
        ok(s.host, `${s.id} was placed with no host`);
        const h = hosts.find((x) => x.id === s.host);
        ok(h, `${s.id} claims a host that is not in the room`);
        // Within arm's reach of the host's edge, not merely somewhere near it.
        const reach = Math.hypot(s.x - h.x, s.z - h.z)
          - Math.max(h.foot.w, h.foot.d) / 2 - Math.max(s.foot.w, s.foot.d) / 2;
        ok(reach < 0.6, `${s.id} sits ${reach.toFixed(2)}m clear of its ${h.id}`);
      }
    }
  }
});

test("the way in stays walkable", () => {
  // Re-run the solver's own reachability test from the outside: erode the
  // occupied grid by a person and flood from the door. If a piece is not
  // reached, it is in a room you cannot walk into.
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 8; seed++) {
      const { placed, grid, doorCell } = plan(programId, { seed });
      const { nx, nz, cells } = grid;
      const open = new Uint8Array(nx * nz);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        let clear = true;
        for (let dj = -1; dj <= 1 && clear; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || cells[jj * nx + ii] === 1) { clear = false; break; }
        }
        open[j * nx + i] = clear ? 1 : 0;
      }
      let start = -1;
      for (let rad = 0; rad <= 5 && start < 0; rad++) {
        for (let di = -rad; di <= rad && start < 0; di++) {
          const ii = doorCell.i + di, jj = doorCell.j - rad + Math.abs(di);
          if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && open[jj * nx + ii]) start = jj * nx + ii;
        }
      }
      ok(start >= 0, `${programId}/${seed}: the doorway is blocked solid`);
      const seen = new Uint8Array(nx * nz);
      const q = [start]; seen[start] = 1;
      let reached = 0;
      while (q.length) {
        const p = q.pop(); reached++;
        const i = p % nx, j = (p / nx) | 0;
        for (const nb of [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, j > 0 ? p - nx : -1, j < nz - 1 ? p + nx : -1]) {
          if (nb >= 0 && open[nb] && !seen[nb]) { seen[nb] = 1; q.push(nb); }
        }
      }
      ok(reached > 6, `${programId}/${seed}: only ${reached} cells of floor are reachable`);
      for (const p of onFloor(placed)) {
        // Standing AT a piece, not in it: grow the body by the clearance it
        // asked for, or by a person where it asked for none.
        const b = boxOf(p);
        const pad = (CATALOGUE[p.id].clear || 0.62) + 0.3;
        b.w += pad * 2; b.d += pad * 2;
        const i0 = Math.max(0, Math.floor((b.x - b.w / 2 + grid.w / 2) / 0.25));
        const i1 = Math.min(nx - 1, Math.floor((b.x + b.w / 2 + grid.w / 2) / 0.25));
        const j0 = Math.max(0, Math.floor((b.z - b.d / 2 + grid.d / 2) / 0.25));
        const j1 = Math.min(nz - 1, Math.floor((b.z + b.d / 2 + grid.d / 2) / 0.25));
        let touch = false;
        for (let j = j0; j <= j1 && !touch; j++) for (let i = i0; i <= i1; i++) if (seen[j * nx + i]) { touch = true; break; }
        ok(touch, `${programId}/${seed}: ${p.id} cannot be walked to`);
      }
    }
  }
});

test("heavy things stay on the floor and small things get off it", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 8; seed++) {
      for (const p of plan(programId, { seed }).placed) {
        const spec = CATALOGUE[p.id];
        if (spec.heavy) eq(p.y, 0, `${p.id} is heavy and was put up at ${p.y}m`);
        /* Two different meanings of `host`: a companion BELONGS to a piece
           (a chair to a table) and stands on the floor beside it, while a
           surface piece STANDS ON one and must be off the floor. Only the
           second is a stacking claim. */
        if (spec.anchor === "surface") {
          ok(p.y > 0.02, `${p.id} claims to stand on a ${p.host} but sits on the floor`);
        }
        if (spec.anchor === "companion") {
          eq(p.y, 0, `${p.id} is seating and was put up at ${p.y}m`);
        }
      }
    }
  }
});

test("wall-mounted things stay on the wall, at head height or above", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 8; seed++) {
      const w = 6, d = 7;
      for (const p of plan(programId, { seed, w, d }).placed) {
        if (CATALOGUE[p.id].anchor !== "wallHigh") continue;
        eq(p.host, "wall", `${p.id} is a wall fitting placed on the floor`);
        ok(p.y > 1.0, `${p.id} is mounted at ${p.y}m, which is not out of the way`);
        const toWall = Math.min(w / 2 - Math.abs(p.x), d / 2 - Math.abs(p.z));
        ok(toWall < 0.25, `${p.id} hangs ${toWall.toFixed(2)}m off the wall`);
      }
    }
  }
});

/* Dead data is invisible: an id nobody can place still reads correctly in
   the programme table, still passes review, and simply never appears.
   `instrument` shipped with `anchor: "free"` — which is not one of the four
   the floor pass offers cells for — so the one object added to make a study
   read as research rather than administration was refused before it reached
   a slot generator, in every room in every world, and the only evidence was
   its absence. This is the check that makes the whole class loud. */
/* THE FOOTPRINT IS A PROMISE, and the solver spends the whole file keeping
   it: it reserves what a piece declares, refuses a cell that is taken, and
   re-floods the room to prove you can still cross it. All of that is worth
   nothing if the piece then BUILDS outside what it reserved — the floor the
   solver called walkable has a stone step on it, and the room is impassable
   in exactly the way no check could see.

   It was not hypothetical: the throne's dais was built almost a metre outside
   the seat's footprint on every side, so the one object a throne room exists
   for was surrounded by floor that was declared clear and was not. Only
   pieces that stand ON the floor are held to this — a banner hangs above head
   height and reserves nothing. */
test("nothing builds outside the floor it reserved", () => {
  const room = { w: 8, d: 8, h: 3.4, area: 64 };
  const STANDS = new Set(["wall", "corner", "floor", "rug", "companion"]);
  for (const id of ITEM_IDS) {
    const spec = CATALOGUE[id];
    if (!STANDS.has(spec.anchor) || spec.flat) continue;
    for (let seed = 1; seed <= 8; seed++) {
      const rng = mulberry32(seed);
      const foot = footprintOf(id, rng, room);
      const piece = buildPiece(id, { style: interiorStyle({ rng: mulberry32(seed + 40) }), rng, room, foot });
      for (const part of piece.proc.parts) {
        if (part.noCollide || part.emissive != null || !part.dims) continue;
        const round = part.shape === "cylinder" || part.shape === "cone" || part.shape === "sphere";
        const ex = round ? part.dims[0] : part.dims[0] / 2;
        const ez = round ? part.dims[0] : (part.dims[2] ?? part.dims[0]) / 2;
        const overW = (Math.abs(part.pos?.[0] ?? 0) + ex) * 2 - foot.w;
        const overD = (Math.abs(part.pos?.[2] ?? 0) + ez) * 2 - foot.d;
        ok(overW < 0.25, `${id}: builds ${overW.toFixed(2)} m wider than the floor it reserved`);
        ok(overD < 0.25, `${id}: builds ${overD.toFixed(2)} m deeper than the floor it reserved`);
      }
    }
  }
});

test("every id a programme names is one some pass can actually place", () => {
  // The passes, and the anchors each owns (js/interior-plan.js planRoom):
  //   floor pass   wall · corner · floor · rug     ← must and may are drawn here
  //   wall pass    wallHigh                        ← also drawn from may
  //   seating      companion                       ← from a host's own edges
  //   surfaces     surface                         ← from SURFACE_KIT
  //   light        ceiling                         ← the hung lamp only
  const DRAWN = new Set(["wall", "corner", "floor", "rug", "wallHigh"]);
  const REACHED = new Set([...DRAWN, "companion", "surface", "ceiling"]);

  for (const id of ITEM_IDS) {
    ok(REACHED.has(CATALOGUE[id].anchor),
      `${id}: anchor "${CATALOGUE[id].anchor}" belongs to no pass — it can never be placed`);
  }
  for (const [programId, program] of Object.entries(PROGRAMS)) {
    for (const id of program.must) {
      ok(CATALOGUE[id], `${programId}: must-list names ${id}, which is not in the catalogue`);
      ok(DRAWN.has(CATALOGUE[id].anchor),
        `${programId}: must-list names ${id}, whose "${CATALOGUE[id].anchor}" anchor the must pass cannot draw`);
    }
    for (const [id] of program.may) {
      ok(CATALOGUE[id], `${programId}: may-list names ${id}, which is not in the catalogue`);
      ok(DRAWN.has(CATALOGUE[id].anchor),
        `${programId}: may-list names ${id}, whose "${CATALOGUE[id].anchor}" anchor is another pass's — `
        + `it will never be drawn from here`);
    }
    // A programme that names a hung light must name one that exists and hangs.
    if (program.hang) {
      ok(CATALOGUE[program.hang]?.anchor === "ceiling" && CATALOGUE[program.hang].lights > 0,
        `${programId}: hangs "${program.hang}", which is not a ceiling light`);
    }
  }
});

test("every room ends up with light in it", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 10; seed++) {
      const out = plan(programId, { seed }).placed;
      ok(out.some((p) => CATALOGUE[p.id].lights), `${programId}/${seed}: a room with no light source`);
    }
  }
});

test("a room is furnished, not decorated", () => {
  for (const programId of Object.keys(PROGRAMS)) {
    for (let seed = 1; seed <= 10; seed++) {
      const out = plan(programId, { seed }).placed;
      ok(out.length >= 5, `${programId}/${seed}: only ${out.length} objects — that is a shell`);
      const kinds = new Set(out.map((p) => p.id));
      ok(kinds.size >= 4, `${programId}/${seed}: only ${kinds.size} kinds of object`);
    }
  }
});

test("a room does what it is for", () => {
  const has = (out, tag) => out.some((p) => (CATALOGUE[p.id].tags || []).includes(tag));
  for (let seed = 1; seed <= 8; seed++) {
    ok(has(plan("bedroom", { seed }).placed, "sleep"), "a bedroom with nowhere to sleep");
    ok(has(plan("kitchen", { seed }).placed, "cook"), "a kitchen with nothing to cook on");
    ok(has(plan("workshop", { seed }).placed, "work"), "a workshop with nothing to work at");
    ok(has(plan("store", { seed }).placed, "store"), "a store with nothing to store in");
  }
});

test("no two rooms come out the same", () => {
  // The complaint this system exists to answer: identical rooms. Fingerprint
  // each layout by what is in it AND where, and require the set to be varied.
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const out = plan("living", { seed }).placed;
    seen.add(out.map((p) => `${p.id}@${p.x.toFixed(1)},${p.z.toFixed(1)}`).sort().join("|"));
  }
  ok(seen.size >= 28, `30 houses produced only ${seen.size} distinct rooms`);
});

test("room size changes what fits, not just how far apart it is", () => {
  const small = plan("living", { seed: 4, w: 3.4, d: 3.6 }).placed;
  const big = plan("living", { seed: 4, w: 9, d: 8 }).placed;
  ok(big.length > small.length + 2, `a 72m² room held ${big.length} objects and a 12m² one held ${small.length}`);
  for (const p of small) {
    const b = boxOf(p);
    ok(Math.abs(b.x) + b.w / 2 <= 1.7 + 1e-3 && Math.abs(b.z) + b.d / 2 <= 1.8 + 1e-3,
      `${p.id} did not shrink to fit a small room`);
  }
});

test("the same room planned twice is the same room", () => {
  const a = plan("kitchen", { seed: 21 }).placed;
  const b = plan("kitchen", { seed: 21 }).placed;
  eq(JSON.stringify(a.map((p) => [p.id, p.x, p.z, p.y, p.rot])),
     JSON.stringify(b.map((p) => [p.id, p.x, p.z, p.y, p.rot])));
});

/* ── integration ── */

test("a furnished building has storage, seating and light in it", () => {
  const proc = buildingParts({ floors: 2, w: 11, d: 10, bays: 3 });
  const out = composeInteriors({
    records: [{ ...rec("a", proc), ref: "street/row-house" }],
    links: [], seed: "STREET", uidAt,
  });
  const ids = out.map((r) => r.ref.slice(INTERIOR_REF.length));
  ok(ids.length > 8, `a whole house came to ${ids.length} objects`);
  const tagged = (tag) => ids.some((id) => (CATALOGUE[id]?.tags || []).includes(tag));
  ok(tagged("light"), "no light anywhere in the house");
  ok(tagged("store"), "nowhere to put anything");
  ok(tagged("sit") || tagged("eat") || tagged("cook"), "nowhere to sit, eat or cook");
});

test("two houses on the same street are two different households", () => {
  const proc = buildingParts({ floors: 2, w: 11, d: 10, bays: 3 });
  const fp = (uid) => composeInteriors({
    records: [{ ...rec(uid, proc), ref: "street/row-house" }], links: [], seed: "STREET", uidAt,
  }).map((r) => `${r.ref}@${r.position[0]},${r.position[2]}`).sort().join("|");
  ok(fp("a") !== fp("b"), "two houses were furnished identically");
});

test("budget scales a world down without emptying it", () => {
  const proc = buildingParts({ floors: 2, w: 12, d: 11, bays: 3 });
  const full = composeInteriors({ records: [rec("a", proc)], seed: "S", uidAt, budget: 1 });
  const lean = composeInteriors({ records: [rec("a", proc)], seed: "S", uidAt, budget: 0.35 });
  ok(lean.length < full.length, "budget did nothing");
  ok(lean.length > 4, "budget emptied the building");
});

report("interiors");
