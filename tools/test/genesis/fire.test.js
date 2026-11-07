// Fire as a HEAT source, not a light: the scorch field it hands the
// vegetation shaders, and the invariant that a flame stands on the ground as
// it is NOW — sculpting the terrain under a fire used to leave it hanging in
// the air over the hollow it had been standing in.
//
// These are the real functions the renderer calls (engine/fx/burn-spec.js),
// not a re-derivation: fire.js keeps the three.js half, burn-spec keeps the
// rules, and this suite tests the rules directly so the two cannot drift.

import { test, eq, ok, close, report } from "../kernel/harness.js";
import {
  isPlantRef, burnFieldFor, reseatFires,
  PLANT_IGNITE_SCALE, SCORCH_RADIUS_SCALE, CHAR_SECONDS,
} from "../../../src/genesis/fx/burn-spec.js";

test("only green things burn", () => {
  for (const ref of ["street/tree", "street/tree-small", "street/pine",
                     "street/birch", "street/bush", "street/hedge"]) {
    ok(isPlantRef(ref), `${ref} is vegetation`);
  }
  for (const ref of ["street/row-house", "street/road", "field-kit/crate",
                     "interior/desk", "street/plaza", null, undefined, ""]) {
    ok(!isPlantRef(ref), `${ref} is not vegetation`);
  }
  // A near-miss must not ignite a building because a plant is spelled in it.
  ok(!isPlantRef("street/treehouse"), "a treehouse is a building");
  ok(!isPlantRef("street/pineapple-stand"), "substring matches do not ignite");
});

test("plants catch out to exactly the radius the grass scorches", () => {
  // One rule, so a tree never stands green in a ring of ash. If these two
  // ever diverge the world contradicts itself visually.
  eq(PLANT_IGNITE_SCALE, SCORCH_RADIUS_SCALE);
  ok(SCORCH_RADIUS_SCALE > 1, "the scorch reaches past the flame itself");
});

test("a fresh fire has not burnt anything yet", () => {
  const field = burnFieldFor([{ x: 5, z: -3, r: 2, t: 0 }]);
  eq(field.length, 4, "one vec4 per fire");
  eq(field[0], 5); eq(field[1], -3);
  close(field[2], 2 * SCORCH_RADIUS_SCALE, 1e-9, "scorch radius");
  eq(field[3], 0, "char starts at nothing");
});

test("char ramps to full and stops there", () => {
  close(burnFieldFor([{ x: 0, z: 0, r: 1, t: CHAR_SECONDS / 2 }])[3], 0.5, 1e-9,
    "smoothstep is symmetric at the midpoint");
  eq(burnFieldFor([{ x: 0, z: 0, r: 1, t: CHAR_SECONDS }])[3], 1);
  eq(burnFieldFor([{ x: 0, z: 0, r: 1, t: CHAR_SECONDS * 40 }])[3], 1, "and never exceeds it");
  // A fire with no clock yet (freshly re-added from params) reads as unburnt
  // rather than as NaN, which would blank the whole field in the shader.
  eq(burnFieldFor([{ x: 0, z: 0, r: 1 }])[3], 0);
});

test("every fire contributes one vec4, in order", () => {
  const field = burnFieldFor([
    { x: 1, z: 2, r: 1, t: CHAR_SECONDS }, { x: -4, z: 8, r: 3, t: 0 },
  ]);
  eq(field.length, 8);
  eq(field[4], -4); eq(field[5], 8);
  close(field[6], 3 * SCORCH_RADIUS_SCALE, 1e-9);
  eq(burnFieldFor([]).length, 0, "no fires, no field");
});

test("a flame follows the ground it stands on", () => {
  const fires = [{ x: 10, z: 10, y: 80, r: 2 }, { x: -30, z: 4, y: 12, r: 1 }];
  const dug = (x, z) => (x === 10 && z === 10 ? 20 : 12); // a hollow under the first
  ok(reseatFires(fires, dug), "the sculpted fire reports a move");
  eq(fires[0].y, 20, "it dropped into the hollow rather than hanging over it");
  eq(fires[1].y, 12, "untouched ground leaves its fire alone");

  // Idempotent: re-seating on unchanged ground reports nothing, which is what
  // lets the engine run this at the end of every brush stroke for free.
  ok(!reseatFires(fires, dug), "a second re-seat is a no-op");
  // And it works upward too — a raised hill lifts its fire with it.
  ok(reseatFires(fires, () => 95));
  eq(fires[0].y, 95);
});

report("fire");
