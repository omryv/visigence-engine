// Site composition: the plan vocabulary, and the guarantee that a generated
// site is deterministic, procedural-only, and doesn't stack blocks on top of
// each other.
import { test, eq, close, ok, report } from "../kernel/harness.js";
import { SITE_KINDS, SITE_SIZES, makePlan, validatePlan, recipeBlocks, blockSpec, footprintOf, patternsOf } from "../../../src/genesis/world/worldplan.js";
import { composeSite, findCrossing, buildMaze } from "../../../src/genesis/world/compose.js";
import { isInterior } from "../../../src/genesis/world/interiors.js";
import { Blockers } from "../../../src/genesis/player/collide.js";
import { mulberry32 } from "../../../src/kernel/seed.js";

const SEED = "K7QN-3F2A-9XBD";
// A stand-in landscape: a gently rolling plateau with a river ravine cut
// across it at z≈40 — level banks either side, like real river valleys.
const ground = (x, z) => 22 + Math.sin(x / 70) * 2 - Math.exp(-((z - 40) * (z - 40)) / 90) * 36;
const flat = () => 12;

const compose = (kind, size = "medium", sampler = flat, center = { x: 0, z: 0 }) =>
  composeSite({ plan: makePlan({ kind, size }), seed: SEED, center, sampler, uidStart: 0 });

test("every recipe block exists, is procedural, and never carries a url", () => {
  for (const kind of Object.keys(SITE_KINDS)) {
    for (const id of recipeBlocks(kind)) {
      const spec = blockSpec(id);
      ok(spec, `${kind}: unknown block "${id}"`);
      ok(spec.proc?.parts?.length, `${kind}/${id}: not procedural`);
      ok(!spec.url, `${kind}/${id}: carries a url`);
    }
  }
});

test("footprints are finite and sane", () => {
  /* Two ceilings, because there are two kinds of thing in the catalogue. A
     block is a block and sixty metres is already generous for one; a LANDMARK
     is the object a whole world is arranged around, and the citadel's curtain
     wall is a hundred and twenty metres across on purpose. Reading the role
     rather than raising the number for everyone keeps the check able to catch
     the thing it was written for — a spec whose geometry has run away. */
  for (const kind of Object.keys(SITE_KINDS)) {
    for (const id of recipeBlocks(kind)) {
      const spec = blockSpec(id);
      const { w, d, r } = footprintOf(spec.proc);
      const cap = spec.meta.role === "landmark" ? 200 : 60;
      ok(isFinite(w) && isFinite(d) && isFinite(r), `${id}: non-finite`);
      ok(w > 0.05 && d > 0.05 && r > 0.05, `${id}: degenerate ${w}×${d}`);
      ok(w < cap && d < cap, `${id}: implausible ${w}×${d} for a ${spec.meta.role}`);
    }
  }
});

test("plan validation rejects junk", () => {
  eq(validatePlan(makePlan({ kind: "market-hamlet" })).length, 0);
  ok(validatePlan(null).length, "null accepted");
  ok(validatePlan({ v: 1, kind: "nope", size: "medium" }).length, "unknown kind accepted");
  ok(validatePlan({ v: 1, kind: "market-hamlet", size: "huge" }).length, "unknown size accepted");
  ok(validatePlan({ v: 99, kind: "market-hamlet", size: "small" }).length, "version drift accepted");
  // makePlan itself always yields something valid.
  eq(validatePlan(makePlan({ kind: "bogus", size: "bogus" })).length, 0);
});

test("every kind composes something", () => {
  for (const kind of Object.keys(SITE_KINDS)) {
    const sampler = SITE_KINDS[kind].ground === "crossing" ? ground : flat;
    const out = compose(kind, "medium", sampler);
    ok(out.records.length > 0, `${kind}: produced nothing (${out.reason || ""})`);
  }
});

test("composition is deterministic per seed + site", () => {
  for (const kind of Object.keys(SITE_KINDS)) {
    const sampler = SITE_KINDS[kind].ground === "crossing" ? ground : flat;
    const a = compose(kind, "medium", sampler);
    const b = compose(kind, "medium", sampler);
    eq(JSON.stringify(a.records), JSON.stringify(b.records), `${kind} drifted:`);
  }
});

test("a different site index rerolls the layout", () => {
  const base = { plan: makePlan({ kind: "market-hamlet" }), seed: SEED, center: { x: 0, z: 0 }, sampler: flat };
  const a = composeSite({ ...base, siteIndex: 0 });
  const b = composeSite({ ...base, siteIndex: 1 });
  ok(JSON.stringify(a.records) !== JSON.stringify(b.records), "reroll produced the identical site");
});

test("size scales the build", () => {
  const counts = SITE_SIZES.map((s) => compose("market-hamlet", s).records.length);
  ok(counts[0] < counts[2], `expected growth, got ${counts.join(" < ")}`);
});

test("placements never overlap", () => {
  for (const kind of Object.keys(SITE_KINDS)) {
    const sampler = SITE_KINDS[kind].ground === "crossing" ? ground : flat;
    const { records } = compose(kind, "large", sampler);
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i], b = records[j];
        // Two things on the SAME floor must not share ground. Two things on
        // different floors legitimately stack — an interior is placed above
        // the building it furnishes, directly over its own ground plan.
        if (Math.abs(a.position[1] - b.position[1]) > 1.5) continue;
        /* Interiors are exempt, and deliberately so: a candle stands ON a
           table and a chair is pushed UP TO one, so a half-metre rule that is
           right for a courtyard is simply wrong indoors. They are not
           unchecked — interiors.test.js holds them to footprint reservation,
           clearance, walkability and stacking rules that are far stricter
           than this one. */
        if (isInterior(a) || isInterior(b)) continue;
        const d = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
        ok(d > 0.5, `${kind}: ${a.label} and ${b.label} are ${d.toFixed(2)}m apart`);
      }
    }
  }
});

test("records are placement-shaped and uid-unique", () => {
  const { records } = compose("market-hamlet", "large");
  const uids = new Set();
  for (const r of records) {
    ok(r.uid && !uids.has(r.uid), `duplicate uid ${r.uid}`);
    uids.add(r.uid);
    eq(r.url, null, "url leaked:");
    // Procedural, never a GLB: either a catalogue block or a piece of the
    // interior the composer furnished it with.
    ok(r.ref.startsWith("builder/") || isInterior(r), `ref not procedural: ${r.ref}`);
    ok(r.proc?.parts?.length, "no proc spec");
    ok(r.position.length === 3 && r.position.every(Number.isFinite), "bad position");
    ok(Number.isFinite(r.rotationY), "bad rotation");
    eq(r.autoFit, false, "autoFit should be off for authored-size blocks:");
  }
});

test("ruins decay: squashed pieces, and only via stretch/tint", () => {
  const { records } = compose("ruined-hamlet", "large");
  const squashed = records.filter((r) => r.stretch && r.stretch[1] < 0.95);
  ok(squashed.length >= 3, `expected broken pieces, got ${squashed.length}`);
  for (const r of squashed) {
    ok(r.stretch.every((v) => v > 0.05 && v < 3), `implausible stretch ${r.stretch}`);
    if (r.tint) ok(r.tint.every((v) => v > 0 && v < 3), `implausible tint ${r.tint}`);
  }
});

test("flat sites emit a soft pad; crossings do not", () => {
  const hamlet = compose("market-hamlet");
  ok(hamlet.pads.length > 0, "no pads for a hamlet");
  for (const p of hamlet.pads) ok(p.r > 0 && p.amount > 0 && Number.isFinite(p.x), "bad pad");
  const bridge = compose("bridge-checkpoint", "medium", ground);
  eq(bridge.pads.length, 0, "a crossing should not be flattened:");
});

test("findCrossing spans the ravine, not the flat", () => {
  const c = findCrossing(ground, 0, 40);
  ok(c, "no crossing found across an obvious ravine");
  ok(c.drop > 2.2, `shallow: ${c.drop}`);
  ok(ground(c.ax, c.az) > 0.8 && ground(c.bx, c.bz) > 0.8, "a bank is underwater");
  eq(findCrossing(flat, 0, 0), null, "found a crossing on flat ground:");
});

test("the bridge deck sits at bank height, seated on its own point", () => {
  const { records } = compose("bridge-checkpoint", "medium", ground);
  const deck = records.filter((r) => r.ref === "builder/bridge");
  ok(deck.length > 0, "no deck");
  for (const d of deck) {
    eq(d.seat, "point", "deck should not re-seat to the river bed:");
    ok(d.position[1] > ground(d.position[0], d.position[2]), "deck is below the ground under it");
  }
});

/* ── maze ── */

// Walk the passages and count what you can reach from cell 0,0.
function reachable(cols, rows, pieces) {
  const blocked = new Set(pieces.filter((p) => p.type === "wall").map((p) => `${p.dir},${p.i},${p.j}`));
  const seen = new Set(["0,0"]);
  const queue = [[0, 0]];
  while (queue.length) {
    const [i, j] = queue.pop();
    const moves = [
      [i + 1, j, `v,${i + 1},${j}`], [i - 1, j, `v,${i},${j}`],
      [i, j + 1, `h,${i},${j + 1}`], [i, j - 1, `h,${i},${j}`],
    ];
    for (const [ni, nj, edge] of moves) {
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      if (blocked.has(edge)) continue;         // a wall stops you; a door does not
      const k = `${ni},${nj}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([ni, nj]);
    }
  }
  return seen.size;
}

test("every maze pattern connects every cell", () => {
  for (const pattern of patternsOf("maze")) {
    for (const n of [4, 6, 8]) {
      const pieces = buildMaze(n, n, pattern, mulberry32(99), 0.4);
      eq(reachable(n, n, pieces), n * n, `${pattern} ${n}×${n} left cells stranded:`);
    }
  }
});

test("maze pieces are one per edge, on the grid, never doubled", () => {
  const n = 6;
  const pieces = buildMaze(n, n, "winding", mulberry32(7), 0.4);
  const keys = new Set();
  for (const p of pieces) {
    const k = `${p.dir},${p.i},${p.j}`;
    ok(!keys.has(k), `two pieces on edge ${k}`);
    keys.add(k);
    ok(p.type === "wall" || p.type === "door", `bad type ${p.type}`);
    const maxI = p.dir === "v" ? n : n - 1;
    const maxJ = p.dir === "v" ? n - 1 : n;
    ok(p.i >= 0 && p.i <= maxI && p.j >= 0 && p.j <= maxJ, `edge off-grid: ${k}`);
  }
  // Total edges in an n×n grid, minus the passages that were carved open.
  ok(pieces.length < (n + 1) * n * 2, "nothing was carved");
});

test("every maze has doors, and braided has more ways through than winding", () => {
  for (const pattern of patternsOf("maze")) {
    const pieces = buildMaze(6, 6, pattern, mulberry32(4), 0.4);
    ok(pieces.some((p) => p.type === "door"), `${pattern}: no doors`);
  }
  const winding = buildMaze(8, 8, "winding", mulberry32(11), 0.4).filter((p) => p.type === "wall").length;
  const braided = buildMaze(8, 8, "braided", mulberry32(11), 0.4).filter((p) => p.type === "wall").length;
  ok(braided < winding, `braided (${braided}) should have fewer walls than winding (${winding})`);
});

test("maze composes on the 6m grid and is deterministic per pattern", () => {
  for (const pattern of patternsOf("maze")) {
    const plan = makePlan({ kind: "maze", size: "small", pattern });
    const base = { plan, seed: SEED, center: { x: 0, z: 0 }, sampler: flat, uidStart: 0 };
    const a = composeSite(base), b = composeSite(base);
    eq(JSON.stringify(a.records), JSON.stringify(b.records), `${pattern} drifted:`);
    ok(a.records.length > 10, `${pattern}: too few pieces`);
    for (const r of a.records) {
      // Every piece sits on a 3m half-grid line and is axis-aligned.
      const onGrid = Math.abs(((r.position[0] % 3) + 3) % 3) < 1e-6 && Math.abs(((r.position[2] % 3) + 3) % 3) < 1e-6;
      ok(onGrid, `off-grid piece at ${r.position[0]},${r.position[2]}`);
      const q = Math.abs(r.rotationY % (Math.PI / 2));
      ok(q < 1e-3 || Math.abs(q - Math.PI / 2) < 1e-3, `piece not axis-aligned: ${r.rotationY}`);
    }
  }
});

test("the door block declares a hinge and swinging parts", () => {
  const door = blockSpec("door");
  ok(door, "no door block");
  ok(door.proc.door?.hinge?.length === 3, "no hinge");
  ok(door.proc.door.swing > 0.5, "no swing");
  ok(door.proc.parts.some((p) => p.door), "no part hangs off the hinge");
  ok(door.proc.parts.some((p) => !p.door), "the whole block swings");
  // It has to tile with a wall run, or a maze grid shows gaps.
  const wall = blockSpec("wall");
  ok(Math.abs(door.foot.w - wall.foot.w) < 0.2, `door ${door.foot.w}m ≠ wall ${wall.foot.w}m`);
});

/* ── collision ── */

const wallBox = (minX, maxX, minZ, maxZ, extra = {}) =>
  ({ minX, maxX, minZ, maxZ, minY: 0, maxY: 3, ...extra });

test("blockers stop movement through a wall and let you slide along it", () => {
  const b = new Blockers();
  b.set("w", [wallBox(-3, 3, -0.2, 0.2)]);
  // Walking straight at it: stopped at its face, never through it — even
  // though the destination on the far side is itself clear (tunnelling).
  const head_on = b.resolve(0, -2, 0, 2, 0, 0.42);
  ok(head_on.z < -0.5, `walked through the wall, ended at z=${head_on.z}`);
  ok(head_on.z > -2.01, "stopped dead instead of walking up to the wall");
  // Along it: the x component survives, so you slide rather than stick.
  const along = b.resolve(0, -2, 2, 2, 0, 0.42);
  close(along.x, 2, 1e-9, "sliding along the wall was blocked:");
  ok(along.z < -0.5, `slid through the wall, ended at z=${along.z}`);
  // Nowhere near it: untouched.
  const clear = b.resolve(20, 20, 22, 22, 0, 0.42);
  eq(clear.x, 22); eq(clear.z, 22);
});

test("you step over low sills and ducking clearance does not block", () => {
  const b = new Blockers();
  b.set("sill", [{ minX: -3, maxX: 3, minZ: -0.3, maxZ: 0.3, minY: 0, maxY: 0.1 }]);
  eq(b.resolve(0, -2, 0, 2, 0, 0.42).z, 2, "a 10cm threshold blocked the player");
  const c = new Blockers();
  c.set("lintel", [{ minX: -3, maxX: 3, minZ: -0.3, maxZ: 0.3, minY: 2.4, maxY: 3 }]);
  eq(c.resolve(0, -2, 0, 2, 0, 0.42).z, 2, "a high lintel blocked the player");
});

test("an open door leaf stops blocking its doorway", () => {
  const b = new Blockers();
  b.set("d", [wallBox(-1, 1, -0.1, 0.1, { door: true })]);
  ok(b.resolve(0, -2, 0, 2, 0, 0.42).z < -0.4, "a closed door let the player through");
  close(b.resolve(0, -2, 0, 2, 0, 0.42, () => true).z, 2, 1e-9, "an open door still blocked:");
});

test("removing a placement frees its ground", () => {
  const b = new Blockers();
  b.set("w", [wallBox(-3, 3, -0.2, 0.2)]);
  b.remove("w");
  eq(b.cells.size, 0, "buckets leaked after removal:");
  eq(b.resolve(0, -2, 0, 2, 0, 0.42).z, 2, "a removed wall still blocks");
});

/* ── the connection pass ──
   Walkways are not placed by the recipe. They are what is left after the
   matcher has looked at what was actually built. */

test("a stacked district links its towers, and only at real ports", () => {
  const out = compose("stacked-district", "medium");
  const decks = out.records.filter((r) => r.ref === "generated/walkway");
  ok(out.links.length > 0, "no towers were joined at all");
  eq(decks.length, out.links.length, "one deck per link");

  const byUid = new Map(out.records.map((r) => [r.uid, r]));
  for (const l of out.links) {
    // Both ends must name placements that exist and actually declared the
    // port the link claims to use.
    for (const p of [l.a, l.b]) {
      const host = byUid.get(p.uid);
      ok(host, `link endpoint ${p.uid} is not in the site`);
      ok(host.proc.ports?.[p.index], `${p.uid} has no port #${p.index}`);
      eq(host.proc.ports[p.index].kind, p.kind, "the link used a different kind than it recorded");
    }
    ok(l.a.uid !== l.b.uid, "a tower was bridged to itself");
  }
});

test("a walkway hangs at port height rather than sitting on the ground", () => {
  const out = compose("stacked-district", "medium");
  for (const d of out.records.filter((r) => r.ref === "generated/walkway")) {
    eq(d.seat, "point", "a deck must not be re-seated onto the terrain");
    ok(d.position[1] > 25, `deck at y=${d.position[1]} fell to the ground (flat test ground is 22)`);
    ok(d.proc.parts.length >= 3, "a deck is at least a slab and two rails");
  }
});

test("a deck spans the gap it was matched across", () => {
  const out = compose("stacked-district", "large");
  for (let i = 0; i < out.links.length; i++) {
    const l = out.links[i];
    const deck = out.records.filter((r) => r.ref === "generated/walkway")[i];
    const run = Math.hypot(l.b.x - l.a.x, l.b.z - l.a.z);
    const slab = deck.proc.parts[0];
    // The deck is the 3D length, so it is never shorter than the plan run.
    ok(slab.dims[0] >= run - 0.05, `deck ${slab.dims[0]} shorter than its ${run.toFixed(1)}m gap`);
    ok(slab.dims[0] < run + 5, "deck wildly longer than its gap");
  }
});

test("the same seed lays the same walkways", () => {
  const a = compose("stacked-district", "medium");
  const b = compose("stacked-district", "medium");
  eq(JSON.stringify(a.links), JSON.stringify(b.links), "links drifted between runs");
});

test("sites with nothing to join get no walkways, rather than bad ones", () => {
  // A maze is walls and doors: no block in it declares a walkway port, so the
  // pass must produce nothing at all rather than inventing a link.
  const out = compose("maze", "small");
  eq(out.links.length, 0);
  eq(out.records.filter((r) => r.ref === "generated/walkway").length, 0);
});

/* ══════════════ collision is in the placement's own axes ══════════════ */

test("a placement's boxes are read in its own frame, turned or not", () => {
  /* Blockers takes boxes in the PLACEMENT's axes plus the frame it stands
     in, because a world-axis box around a turned wall is not the wall — a
     six-metre wall at seventeen degrees becomes a 6.2 × 2.2 m slab of solid
     air, and a building at an angle is wrapped in an invisible shell you can
     see its front door through and never reach.

     The trap on the other side is worse and this test exists for it: an
     UNROTATED frame is still a frame. Dropping it when `rot === 0` reads the
     local boxes as world coordinates and moves the whole building's
     collision to the world origin — every square building in the project
     becomes something you walk straight through. It survived a full headless
     audit, because the audit carries the frame; it took a browser to see. */
  const wall = [{ minX: -3, maxX: 3, minZ: -0.1, maxZ: 0.1, minY: 0, maxY: 2.8 }];

  // Unrotated, but standing somewhere: solid THERE, and nowhere else.
  const b = new Blockers();
  b.set("a", wall.map((x) => ({ ...x })), { x: -6.5, z: 30, rot: 0 });
  ok(b.blocked(-6.5, 30, 0, 0.42), "an unrotated placement is not solid where it stands");
  ok(!b.blocked(0, 0, 0, 0.42), "…and its collision was left at the world origin");

  // Turned: solid along its own length, open across it.
  const c = new Blockers();
  c.set("b", wall.map((x) => ({ ...x })), { x: 0, z: 0, rot: Math.PI / 2 });
  ok(c.blocked(0, 2.5, 0, 0.42), "a quarter-turned wall is not solid along its length");
  ok(!c.blocked(2.5, 0, 0, 0.42), "a quarter-turned wall is still solid across its width");
  // The corner a world-axis box would wrongly claim.
  ok(!c.blocked(2.6, 2.6, 0, 0.42), "the turned wall is solid in a corner it does not occupy");

  // And the surface it offers is its own top, wherever it stands.
  const d = new Blockers();
  d.set("c", [{ minX: -2, maxX: 2, minZ: -2, maxZ: 2, minY: -0.2, maxY: 0.22 }], { x: 40, z: -12, rot: 0 });
  close(d.surfaceAt(40, -12, 0, 0.42), 0.22, 1e-9, "a slab you cannot stand on");
  eq(d.surfaceAt(0, 0, 0, 0.42), -Infinity, "a slab you can stand on from anywhere");
});

report("compose");
