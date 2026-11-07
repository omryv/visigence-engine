/* Which placements are worth a pin.
 *
 * engine/fx/pins.js has always said the cloud is "a finding aid for AUTHORED
 * objects" and that a wall of pins is "a wall of plastic between the author
 * and the thing they just made". Nothing enforced it: `_syncPins` walked
 * every record in the world, so one press of a site template put a pin over
 * every metre of every lane, every footing under every house, and every
 * chest sealed behind a shut door.
 *
 * js/pinnable.js is the rule, and this is the rule asserted — both halves of
 * it, and the boundaries either side of each threshold, because a filter
 * that is one unit out in the wrong direction hides a placement the author
 * cannot then find.
 */
import { test, ok, eq, report } from "../kernel/harness.js";
import { isPinnable, SURFACE_MAX_H, SURFACE_MIN_SPAN, DERIVED_REFS, PIN_LEGIBLE_MAX } from "../../../src/genesis/world/pinnable.js";

// The two measurements Props hands the filter, off the built mesh.
const box = (height, size) => ({ height, size });

/* ── the catalogue half ── */

test("furniture inside a building carries no pin of its own", () => {
  // A chest is a metre tall and a metre wide — it passes the surface test on
  // geometry alone. It is dropped because of what it IS, not what shape it
  // is: you cannot see it through the wall, and the building is the thing
  // the author placed.
  ok(!isPinnable({ ref: "interior/chest" }, box(0.9, 1.2)), "a chest indoors");
  ok(!isPinnable({ ref: "interior/settee" }, box(0.8, 2.0)), "a settee indoors");
  ok(!isPinnable({ ref: "interior/sconce" }, box(0.3, 0.4)), "a sconce indoors");
});

test("the ground fill a building stands on carries no pin", () => {
  // A footing on a steep slope is TALL — the deepest clear two metres — so
  // the geometric half cannot reach it. It is derived: it exists
  // because a house is standing on it, and the house is what to point at.
  ok(!isPinnable({ ref: "site/footing" }, box(2.4, 12)), "a deep footing");
  ok(!isPinnable({ ref: "site/steps" }, box(0.42, 2.0)), "a doorstep flight");
  ok(!isPinnable({ ref: "generated/walkway" }, box(1.1, 9)), "a walkway deck");
});

test("every derived family is a ref prefix, so a new one cannot be a typo", () => {
  eq(DERIVED_REFS.length, 3, "interior/, site/, generated/:");
  for (const p of DERIVED_REFS) ok(p.endsWith("/"), `${p} is a prefix, not a name`);
  // Prefix, not substring: a catalogue item that merely CONTAINS the word is
  // not derived. "builder/interior-door" would be a hand-placed block.
  ok(isPinnable({ ref: "builder/interior-door" }, box(2.2, 1.5)), "a block whose name contains a family");
});

/* ── the geometric half ── */

test("what you walk on is not a thing to be found", () => {
  ok(!isPinnable({ ref: "land/lane" }, box(0.09, 6)), "a dirt lane");
  ok(!isPinnable({ ref: "land/setts" }, box(0.12, 6)), "setts");
  ok(!isPinnable({ ref: "land/avenue" }, box(0.16, 14)), "a ceremonial avenue");
  ok(!isPinnable({ ref: "street/junction" }, box(0.12, 9)), "a junction");
  ok(!isPinnable({ ref: "street/plaza" }, box(0.14, 18)), "a plaza");
});

test("everything that stands up keeps its pin", () => {
  ok(isPinnable({ ref: "street/row-house" }, box(9.2, 9.2)), "a row house");
  ok(isPinnable({ ref: "builder/fence" }, box(1.25, 3)), "a fence panel");
  ok(isPinnable({ ref: "builder/lamp" }, box(4.2, 4.2)), "a lamp");
  ok(isPinnable({ ref: "builder/well" }, box(1.6, 2.4)), "a well");
  ok(isPinnable({ ref: "street/tree" }, box(11, 8)), "a tree");
  ok(isPinnable({ ref: "builder/bridge" }, box(1.4, 6)), "a bridge span");
});

test("a small flat thing is an object, not a surface", () => {
  // Breadth alone would swallow these, and they are exactly the case the
  // finding aid exists for: one press, placed by hand, easy to lose.
  ok(isPinnable({ ref: "builder/floor" }, box(0.12, 1.5)), "a single floor tile");
  ok(isPinnable({ ref: "objects/crate" }, box(0.4, 1.2)), "a low crate");
});

test("both thresholds are boundaries, and neither is one-sided", () => {
  const wide = SURFACE_MIN_SPAN + 1;
  ok(!isPinnable({ ref: "x/y" }, box(SURFACE_MAX_H - 0.01, wide)), "just under the height bar is a surface");
  ok(isPinnable({ ref: "x/y" }, box(SURFACE_MAX_H + 0.01, wide)), "just over it is not");
  const low = SURFACE_MAX_H - 0.1;
  ok(!isPinnable({ ref: "x/y" }, box(low, SURFACE_MIN_SPAN + 0.01)), "just over the span bar is a surface");
  ok(isPinnable({ ref: "x/y" }, box(low, SURFACE_MIN_SPAN - 0.01)), "just under it is not");
});

/* ── failing safe ── */

test("an unmeasured placement is pinned rather than silently dropped", () => {
  // A record whose mesh has not been built yet, or whose bounding box came
  // back empty, has no geometry to judge. The wrong answer here is a spare
  // pin; the unacceptable answer is a placement with no pin and no reason.
  ok(isPinnable({ ref: "imported/thing" }), "no box at all");
  ok(isPinnable({ ref: "imported/thing" }, box(0, 0)), "an empty box");
  ok(isPinnable({ ref: "imported/thing" }, box(NaN, NaN)), "a box that is not numbers");
  // But a derived record is still derived without a box — that half is a
  // catalogue fact and needs no measurement.
  ok(!isPinnable({ ref: "interior/chest" }), "furniture, unmeasured");
});

test("no record at all is not a pin", () => {
  ok(!isPinnable(null), "null");
  ok(!isPinnable(undefined), "undefined");
  ok(isPinnable({}), "a record with no ref is not derived, so it is pinned");
});

test("the legibility ceiling is a reading limit, well under any render cost", () => {
  // pins.js: "Ten thousand pins are ten thousand vertices — less than a
  // single terrain tile". The ceiling is not about the frame.
  ok(PIN_LEGIBLE_MAX > 0 && PIN_LEGIBLE_MAX < 1000, `${PIN_LEGIBLE_MAX} is a number of things a person can read`);
});

report("pins");
