/* The discovery layer's one judgement call, under test.
 *
 * A pin per placement is correct right up until a settlement arrives, at
 * which point forty fence posts become forty hard markers and the layer that
 * was supposed to answer "where is it" starts answering "here is everything",
 * which is the same as answering nothing. Crowding is what decides which pins
 * step back — so it has to be arithmetic anybody can check, not a feel.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { crowding, crowdFade, CROWD_CELL } from "../../../src/genesis/fx/crowding.js";

const at = (...xz) => xz.map(([x, z]) => ({ x, z }));

test("a lone object is not in a crowd", () => {
  const c = crowding(at([0, 0]));
  eq(c.length, 1);
  eq(c[0], 0);
});

test("an empty world produces an empty answer, not a crash", () => {
  eq(crowding([]).length, 0);
});

test("objects sharing a patch of ground each see the others", () => {
  // four placements well inside one cell
  const c = crowding(at([1, 1], [2, 2], [3, 1], [2, 3]));
  for (const v of c) eq(v, 3, "each of four sees the other three:");
});

test("objects a long way apart are each alone", () => {
  const c = crowding(at([0, 0], [500, 0], [0, 500], [-500, -500]));
  for (const v of c) eq(v, 0);
});

test("crowding is per-neighbourhood, not global", () => {
  // a tight run of three, and one object by itself far away
  const c = crowding(at([0, 0], [1, 1], [2, 2], [900, 900]));
  eq(c[0], 2); eq(c[1], 2); eq(c[2], 2);
  eq(c[3], 0, "the far one must not be dragged into the run's count:");
});

test("negative coordinates bucket the same way positive ones do", () => {
  // The world is centred on the origin, so half of every settlement has
  // negative coordinates — a floor() that behaves differently either side of
  // zero would make the west half of a village fade and the east half not.
  const west = crowding(at([-1, -1], [-2, -2], [-3, -3]));
  const east = crowding(at([1, 1], [2, 2], [3, 3]));
  eq(west[0], east[0]);
  eq(west.length, east.length);
});

test("two neighbouring cells do not collide into one bucket", () => {
  // The failure this guards: a hash of the form x*k + z maps (x+1, z) and
  // (x, z+k) to the same bucket, so two unrelated corners of a world get
  // counted as one crowd and both fade for no reason.
  const c = crowding(at([0, 0], [CROWD_CELL * 40, 0], [0, CROWD_CELL * 40]));
  for (const v of c) eq(v, 0, "three separated placements must each be alone:");
});

test("cell size is a knob, and widening it merges neighbours", () => {
  const pts = at([0, 0], [CROWD_CELL * 1.5, 0]);
  eq(crowding(pts, CROWD_CELL)[0], 0, "apart at the default cell:");
  eq(crowding(pts, CROWD_CELL * 4)[0], 1, "together at a wider one:");
});

test("the fade curve falls with crowding and never reaches zero", () => {
  close(crowdFade(0), 1, 1e-9, "a lone pin keeps full weight:");
  ok(crowdFade(1) < crowdFade(0), "one neighbour already softens it");
  ok(crowdFade(8) < crowdFade(3), "and it keeps softening");
  ok(crowdFade(1000) >= 0.16, "but a pin never disappears entirely — it is still the only way to find that object");
});

test("the fade curve is monotone, so density never brightens a pin", () => {
  let prev = Infinity;
  for (let n = 0; n <= 40; n++) {
    const v = crowdFade(n);
    ok(v <= prev, `crowdFade(${n}) rose above crowdFade(${n - 1})`);
    prev = v;
  }
});

test("a fence run is quieted, a lost object is not", () => {
  // The whole point, stated as the test: twelve posts in a line, one crate
  // dropped in a field. The crate must stay markedly louder than any post.
  const run = Array.from({ length: 12 }, (_, i) => ({ x: i * 0.6, z: 0 }));
  const list = [...run, { x: 800, z: 800 }];
  const c = crowding(list);
  const post = crowdFade(c[0]), lost = crowdFade(c[list.length - 1]);
  ok(lost > post * 2, `a lone object (${lost.toFixed(2)}) must outweigh a post in a run (${post.toFixed(2)})`);
  eq(c[list.length - 1], 0, "and the lone object is in no crowd at all:");
});

report("crowding");
