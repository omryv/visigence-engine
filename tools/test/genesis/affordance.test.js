/* What you can DO with the things in a room.
 *
 * The layout suites either side of this one ask whether an interior is
 * correct — the right objects, in defensible positions, in a room you can
 * cross. This one asks whether it is INHABITABLE, which is a different claim
 * and the one the whole affordance layer exists to make: a chair you can sit
 * in, a cupboard that opens, a book you can pick up.
 *
 * Three kinds of assertion, and the middle one is the load-bearing one:
 *
 *   THE TABLE AGREES WITH THE CATALOGUE. An affordance naming a piece that
 *   does not exist, or a piece that opens with no leaf to swing, is a prompt
 *   attached to nothing.
 *   THE SPOT IS REAL. `useSpots` is the half that costs something — the floor
 *   somebody has to be standing on for the verb to be possible — and a spot
 *   inside the piece's own body, or inside the wall behind it, is a spot that
 *   makes every check downstream a formality.
 *   IT SURVIVES THE JOURNEY. An interior whose chairs stop being chairs the
 *   moment it leaves the editor was only ever furnished for the person who
 *   generated it, so the field is followed all the way to the handoff record.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { mulberry32 } from "../../../src/kernel/seed.js";
import {
  AFFORD, USES, USE_KINDS, SWINGS, affordanceOf, useSpots, useRecord, STAND,
} from "../../../src/genesis/world/affordance.js";
import { CATALOGUE, ITEM_IDS, buildPiece, footprintOf, interiorStyle } from "../../../src/genesis/world/furniture.js";
import { planRoom, PROGRAMS } from "../../../src/genesis/world/interior-plan.js";
import { validateRoom } from "../../../src/genesis/world/interior-validate.js";
import { composeInteriors, planValidated } from "../../../src/genesis/world/interiors.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";
import { buildFusionRecord } from "../../../src/genesis/world/fusion.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";

const room = { w: 6, d: 7, h: 3, area: 42 };
const style = () => interiorStyle({ wealth: 0.5, age: 0.4, wear: 0.4, rng: mulberry32(3) });
const foot = (id) => footprintOf(id, mulberry32(2), room);
const P = (id, x, z, extra = {}) => ({ id, x, z, rot: 0, y: 0, host: null, foot: foot(id), ...extra });

/* ══════════════════ the table and the catalogue ══════════════════ */

test("every verb names a piece that exists, and a kind that exists", () => {
  for (const [id, kind] of Object.entries(AFFORD)) {
    ok(CATALOGUE[id], `${id} affords "${kind}" and is not in the catalogue`);
    ok(USES[kind], `${id} affords "${kind}", which is not one of ${USE_KINDS.join(", ")}`);
  }
  for (const kind of USE_KINDS) {
    ok(USES[kind].verb && USES[kind].reach > 0, `${kind}: no verb, or no reach`);
    ok(Object.values(AFFORD).includes(kind), `nothing in the catalogue ever affords "${kind}"`);
  }
});

test("a thing that opens has a leaf to swing, and nothing else has one", () => {
  // The one place these two lists could drift apart, checked rather than
  // shared: js/affordance.js says what opens and js/furniture.js emits the
  // hinge, because a piece knows where its own doors are and the verb table
  // does not.
  const declares = new Set(ITEM_IDS.filter((id) => CATALOGUE[id].opens));
  for (const id of SWINGS) ok(declares.has(id), `${id} offers "Open" and declares no hinge`);
  for (const id of declares) ok(SWINGS.has(id), `${id} declares a hinge and offers nothing to open it with`);
  ok(SWINGS.size >= 3, `only ${SWINGS.size} things in the world open`);
});

test("the hinge is on the piece, and something hangs off it", () => {
  for (const id of SWINGS) {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = mulberry32(seed);
      const f = footprintOf(id, rng, room);
      const built = buildPiece(id, { style: style(), rng, room, foot: f });
      const door = built.proc.door;
      ok(door, `${id}: no proc.door — the engine has nothing to register`);
      ok(Math.abs(door.hinge[0]) <= f.w / 2 + 0.02 && Math.abs(door.hinge[2]) <= f.d / 2 + 0.02,
        `${id}: the hinge is outside the piece it belongs to`);
      ok(Math.abs(door.swing) > 0.8, `${id}: a leaf that barely moves`);
      const leaves = built.proc.parts.filter((p) => p.door);
      ok(leaves.length > 0, `${id}: a hinge with nothing hanging on it`);
    }
  }
});

test("nothing offers a verb it has no business offering", () => {
  // A throne is a seat, has the `sit` tag, and affords nothing — the room it
  // stands in is an argument for a chair nobody may sit in. Deriving the verb
  // from the tag would have put "Sit" on it, which is the exact reason the
  // list is written out rather than inferred.
  eq(AFFORD.throne, undefined, "the throne offers a seat");
  eq(AFFORD.cradle, undefined, "the cradle offers a bed");
  for (const [id, kind] of Object.entries(AFFORD)) {
    const tags = CATALOGUE[id].tags || [];
    if (kind === "sit") ok(tags.includes("sit"), `${id} offers a seat and is not seating`);
    if (kind === "rest") ok(tags.includes("sleep"), `${id} offers a bed and is not a bed`);
    if (kind === "light") ok(CATALOGUE[id].lights > 0, `${id} offers a flame and burns nothing`);
    if (kind === "take") ok(!CATALOGUE[id].heavy, `${id} is picked up and is heavy`);
  }
});

/* ══════════════════ where you stand ══════════════════ */

test("a use spot is outside the thing it is a spot for", () => {
  for (const [id] of Object.entries(AFFORD)) {
    const f = foot(id);
    for (const rot of [0, 0.7, Math.PI / 2, -2.1]) {
      for (const at of useSpots({ id, x: 0, z: 0, rot, foot: f })) {
        const c = Math.cos(rot), s = Math.sin(rot);
        // Back into the piece's own frame, where its footprint is axis-aligned.
        const ox = at.x * c - at.z * s, oz = at.x * s + at.z * c;
        ok(Math.abs(ox) > f.w / 2 - 1e-6 || Math.abs(oz) > f.d / 2 - 1e-6,
          `${id}: you are asked to stand inside it to use it`);
      }
    }
  }
});

test("which side you come at it from is the anchor's answer, not the verb's", () => {
  /* A chair and a settee are both `sit` and are approached from opposite
     ends: a chair's front is the table it is drawn up to, a settee's back is
     the wall it stands against. Deriving the approach from the verb put the
     settee's only spot inside the plaster and rejected every soft seat in
     the project. */
  const front = (id) => useSpots({ id, x: 0, z: 0, rot: 0, foot: foot(id) })[0];
  ok(front("settee").z > 0, "a settee is sat in from behind the wall it stands against");
  ok(front("chair").z < 0, "a chair is sat in from the table side");
  ok(front("cabinet").z > 0, "a cupboard opens into the wall");
  // A wall fitting has ONE spot and it is in the room.
  eq(useSpots({ id: "sconce", x: 0, z: 0, rot: 0, foot: foot("sconce") }).length, 1);
});

test("the spot is a whole body clear, because the walk grid is coarse", () => {
  // A spot half a body off a wardrobe lands inside the band the walk grid
  // erodes before it floods, and reads as unstandable — measured, that
  // rejected the bed in every bedroom in the project.
  ok(STAND >= 0.6, `a standing spot ${STAND}m clear will not survive the walk grid`);
  const f = foot("bed");
  const [spot] = useSpots({ id: "bed", x: 0, z: 0, rot: 0, foot: f });
  ok(spot.z - f.d / 2 >= STAND - 1e-6, "the bed's spot is inside the mattress");
});

test("a piece with nowhere to stand and use it is reported", () => {
  /* A stool in a corner with a chest against each of the two sides you could
     reach it from. It is reachable — you can walk up and touch it — and there
     is nowhere to stand and sit down, which is a different failure and the
     one the brief names by name. */
  const big = { w: 8, d: 8, h: 3, area: 64 };
  const at = (id, x, z, rot = 0) => ({ id, x, z, rot, y: 0, host: null,
    foot: footprintOf(id, mulberry32(2), big) });
  const door = { x: 0, side: "south" };
  const codes = (placed) => validateRoom({ room: big, placed, door, programId: "workshop" })
    .violations.filter((v) => v.code === "UNUSABLE").map((v) => v.id);

  const stool = at("stool", 3.5, -3.5);
  ok(!codes([stool]).includes("stool"), "a stool alone in a room was called unusable");
  const boxed = [stool, at("chest", 3.5, -2.6), at("chest", 2.6, -3.5, Math.PI / 2)];
  ok(codes(boxed).includes("stool"), "a stool boxed into a corner by two chests passed");
});

/* ══════════════════ what the planner guarantees ══════════════════ */

test("everything a shipped room offers, somebody can stand and do", () => {
  /* planValidated is what the world actually gets: three draws, and then a
     prune of what still will not pass. Asked of its OUTPUT rather than of a
     single draw, because a single draw is allowed to be wrong — that is what
     the three draws are for, and a check that tolerates a residual is a check
     that will tolerate a regression. */
  const profile = { trade: "clerk", activity: "settled", wealth: 0.5, wear: 0.4,
                    occupants: 3, children: 0, period: 0.5 };
  let checked = 0;
  for (const programId of Object.keys(PROGRAMS)) {
    for (let s = 1; s <= 8; s++) {
      const r = { w: 4 + (s % 5) * 1.3, d: 4.2 + (s % 4) * 1.5, h: 3 };
      r.area = r.w * r.d;
      const door = { x: 0, side: ["south", "north", "east", "west"][s % 4] };
      const out = planValidated({ room: r, programId, style: style(), seed: "USE",
        key: `${programId}:${s}`, door, blocked: [], profile });
      const bad = validateRoom({ room: r, placed: out.placed, door, programId, extraIds: out.extras })
        .violations.filter((v) => v.code === "UNUSABLE");
      eq(bad.length, 0, `${programId}/${s}: ${bad.map((v) => `${v.id} — ${v.detail}`).join("; ")}`);
      ok(out.placed.length > 0, `${programId}/${s}: the room was emptied`);
      checked++;
    }
  }
  ok(checked > 100, "the corpus was too small to mean anything");
});

/* ══════════════════ what the world gets ══════════════════ */

test("a furnished house is a house full of things you can use", () => {
  const proc = buildingParts({ floors: 2, w: 12, d: 10, bays: 3 });
  const out = composeInteriors({
    records: [{ uid: "a", ref: "street/row-house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "S", uidAt: (i) => `u${i}`, biome: "verdant",
  });
  const usable = out.filter((r) => r.use);
  ok(usable.length > out.length * 0.3,
    `only ${usable.length} of ${out.length} pieces in a whole house do anything`);
  const kinds = new Set(usable.map((r) => r.use.kind));
  ok(kinds.size >= 4, `a whole house offers only: ${[...kinds].join(", ")}`);
  for (const r of usable) {
    ok(USES[r.use.kind], `${r.ref}: unknown verb kind ${r.use.kind}`);
    ok(r.use.verb && r.use.reach > 0, `${r.ref}: a verb with no reach`);
    if (r.use.kind === "sit" || r.use.kind === "rest") {
      ok(r.use.seatH > 0.2, `${r.ref}: sitting down puts you on the floor beside it`);
    }
  }
  // …and the casework that opens carries a real hinge through to the record.
  const hinged = out.filter((r) => r.proc?.door);
  ok(hinged.length > 0, "not one cupboard in the house opens");
  for (const r of hinged) {
    eq(r.use?.kind, "open", `${r.ref} swings and does not say so`);
  }
});

test("a shell piece is not something you can pick up", () => {
  const proc = buildingParts({ floors: 1, w: 9, d: 8, bays: 2 });
  const out = composeInteriors({
    records: [{ uid: "a", ref: "builder/house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "S", uidAt: (i) => `u${i}`,
  });
  for (const r of out) {
    const id = r.ref.split("/").pop();
    if (["partition", "floor", "ceiling", "daylight", "stair", "core"].includes(id)) {
      eq(r.use, undefined, `${id} offers "${r.use?.verb}" — the building is not furniture`);
    }
  }
});

test("the verb survives the handoff", () => {
  /* buildFusionRecord enumerates the fields it carries rather than spreading
     the record, which is right and is also how a field silently stops
     existing on the far side. An interior whose chairs stop being chairs the
     moment it leaves the editor was only ever furnished for the person who
     generated it. */
  const proc = buildingParts({ floors: 2, w: 11, d: 9, bays: 3 });
  const props = composeInteriors({
    records: [{ uid: "a", ref: "street/row-house", proc, position: [0, 0, 0], rotationY: 0, scale: 1 }],
    links: [], seed: "S", uidAt: (i) => `u${i}`,
  });
  const params = makeParams({ seed: "K7QN-3F2A-9XBD", preset: "highlands" });
  const rec = buildFusionRecord({ params, propRecords: props, field: bakeHeightField(params, 129) });
  const carried = rec.props.filter((p) => p.use);
  eq(carried.length, props.filter((p) => p.use).length, "verbs were dropped in transit");
  ok(carried.length > 0, "nothing in the house did anything to begin with");
  ok(rec.props.some((p) => p.proc?.door), "the hinges were dropped in transit");
});

test("what a thing is for does not change between two identical worlds", () => {
  const proc = buildingParts({ floors: 2, w: 11, d: 9, bays: 3 });
  const mk = () => composeInteriors({
    records: [{ uid: "a", ref: "street/row-house", proc, position: [2, 1, -3], rotationY: 0.4, scale: 1 }],
    links: [], seed: "SEED", uidAt: (i) => `u${i}`, biome: "meadow",
  }).map((r) => `${r.ref}:${r.use ? r.use.kind + r.use.verb : "-"}`).join("|");
  eq(mk(), mk());
});

test("affordanceOf and useRecord say the same thing, or nothing at all", () => {
  for (const id of ITEM_IDS) {
    const a = affordanceOf(id), r = useRecord(id);
    if (!AFFORD[id]) { eq(a, null, `${id} affords something unasked`); eq(r, null); continue; }
    eq(r.kind, a.kind);
    eq(r.verb, a.verb);
    eq(r.reach, a.reach);
  }
});

report("affordance");
