// Flood contracts: water is what the SEA can reach. A hollow with no path to
// open water is dry ground, digging a channel to it makes it wet, and the
// reveal order always grows outward from water that was already there.
import { test, eq, ok, report } from "./harness.js";
import { floodFromSea, wetAt } from "../../../src/kernel/water/flood.js";

const SIZE = 4096;
const RES = 33;
const at = (i, j) => j * RES + i;

// Build a field from a per-cell function. Heights are in metres, sea = 0.
function field(fn, res = RES) {
  const data = new Float32Array(res * res);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) data[j * res + i] = fn(i, j);
  return { res, size: SIZE, data };
}

// The standard fixture: a 4-cell ocean margin (which is what the terrain's
// own edge falloff produces), dry land inside it.
const MARGIN = 4;
const inOcean = (i, j) => i < MARGIN || j < MARGIN || i >= RES - MARGIN || j >= RES - MARGIN;
const inPit = (i, j) => Math.abs(i - 16) <= 2 && Math.abs(j - 16) <= 2;
const inChannel = (i, j) => j === 16 && i >= MARGIN && i < 14;

const plain = () => field((i, j) => (inOcean(i, j) ? -30 : 10));
const withPit = () => field((i, j) => (inOcean(i, j) ? -30 : inPit(i, j) ? -20 : 10));
const withChannel = () => field((i, j) =>
  inOcean(i, j) ? -30 : inPit(i, j) ? -20 : inChannel(i, j) ? -5 : 10);

test("open sea everywhere is entirely wet", () => {
  const f = floodFromSea(field(() => -12));
  ok(f.seeded, "the border seeded the flood");
  eq(f.wetCount, RES * RES, "every cell wet");
});

test("dry land everywhere holds no water", () => {
  const f = floodFromSea(field(() => 40));
  eq(f.wetCount, 0);
  eq(f.seeded, false, "nothing on the border to seed from");
});

test("the ocean margin floods and the land inside it does not", () => {
  const f = floodFromSea(plain());
  ok(f.seeded, "seeded from the border");
  ok(f.wet[at(0, 0)] === 1, "corner is sea");
  ok(f.wet[at(16, 16)] === 0, "the middle is land");
  // Every wet cell must be in the margin — nothing leaked inland.
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      if (f.wet[at(i, j)]) ok(inOcean(i, j), `leak at ${i},${j}`);
    }
  }
});

test("a landlocked pit below sea level stays DRY", () => {
  const f = floodFromSea(withPit());
  eq(f.wet[at(16, 16)], 0, "pit centre");
  eq(f.wet[at(14, 16)], 0, "pit edge");
  eq(f.steps[at(16, 16)], -1, "and carries no reveal order");
  // It is genuinely below sea level — this is a topology result, not a
  // side effect of the pit being shallow.
  ok(withPit().data[at(16, 16)] < 0, "pit really is below sea level");
});

test("digging a channel to the sea floods that same pit", () => {
  const f = floodFromSea(withChannel());
  eq(f.wet[at(16, 16)], 1, "pit centre is now water");
  eq(f.wet[at(8, 16)], 1, "so is the channel");
  eq(f.wet[at(8, 15)], 0, "but not the land beside it");
});

test("the reveal order grows outward from water that was already there", () => {
  const before = floodFromSea(withPit());
  const after = floodFromSea(withChannel(), before);

  ok(after.newCount > 0, "the channel and pit are new");
  eq(after.steps[at(0, 0)], 0, "open sea was already wet — reveals immediately");
  eq(after.steps[at(MARGIN, 16)], 1, "the channel mouth is one step from the sea");

  // Monotonic along the channel, then further still into the pit.
  for (let i = MARGIN; i < 13; i++) {
    ok(after.steps[at(i + 1, 16)] > after.steps[at(i, 16)], `channel step at ${i}`);
  }
  ok(after.steps[at(16, 16)] > after.steps[at(13, 16)], "the pit fills last");
  eq(after.maxSteps, Math.max(...[...after.steps]), "maxSteps is the real maximum");
});

test("with no previous mask nothing is new, so nothing animates", () => {
  const f = floodFromSea(withChannel(), null);
  eq(f.newCount, 0, "a fresh world starts fully flooded");
  eq(f.maxSteps, 0, "and needs no front to sweep");
  eq(f.steps[at(16, 16)], 0);
});

test("a previous mask on a coarser grid is resampled, not thrown away", () => {
  // This is the ordinary case, not an exotic one: the erosion pass bakes 513²
  // and every sculpt stroke bakes 257², so the FIRST dig in any world hands
  // in a mask from the other grid. Dropping it there would silently kill the
  // animation exactly when the author is watching for it.
  const RES2 = (RES - 1) * 2 + 1; // 65² — the same world, one level finer
  const fine = (fn) => field((i, j) => fn(i / 2, j / 2), RES2);
  const coarsePit = floodFromSea(field((i, j) => (inOcean(i, j) ? -30 : inPit(i, j) ? -20 : 10)));

  const after = floodFromSea(
    fine((i, j) => (inOcean(i, j) ? -30 : inPit(i, j) ? -20 : inChannel(i, j) ? -5 : 10)),
    coarsePit,
  );
  ok(after.newCount > 0, "the channel still registers as new");
  ok(after.maxSteps > 0, "so there is a front to sweep");
  eq(after.steps[0], 0, "open sea it already knew about reveals immediately");
});

test("a previous result with a mask that disagrees with its own res is refused", () => {
  const f = floodFromSea(withChannel(), { res: 99, wet: new Uint8Array(4) });
  eq(f.newCount, 0, "corrupt input falls back to no-animation");
  eq(f.wet[at(16, 16)], 1, "and the flood itself is unaffected");
});

test("water never vanishes when the world edge sits above sea level", () => {
  // Inverted world: dry rim, sunken middle. Nothing can seed from the border,
  // and the safe answer is the old rule rather than an empty sea.
  const f = floodFromSea(field((i, j) => (inOcean(i, j) ? 20 : -8)));
  eq(f.seeded, false);
  ok(f.wetCount > 0, "the basin is still water");
  eq(f.wet[at(16, 16)], 1);
  eq(f.wet[at(0, 0)], 0, "the dry rim is still dry");
});

test("every wet cell carries a reveal order, even an orphaned basin", () => {
  // A wet region that shares NO cell with the previous mask has nothing to
  // grow from. Its cells must still encode as water: the byte encoder does
  // 1 + round(steps/maxSteps * 254), which for -1 wraps into a large order
  // and would strand that water invisible until the end of a sweep.
  const ocean = floodFromSea(plain());
  const shifted = floodFromSea(withChannel(), {
    res: RES,
    wet: new Uint8Array(RES * RES), // "nothing was wet before"
  });
  ok(ocean.wetCount > 0);
  for (let p = 0; p < RES * RES; p++) {
    if (shifted.wet[p]) ok(shifted.steps[p] >= 0, `wet cell ${p} has no order`);
    else eq(shifted.steps[p], -1, `dry cell ${p} must stay unset`);
  }
});

test("the flood is deterministic", () => {
  const a = floodFromSea(withChannel());
  const b = floodFromSea(withChannel());
  eq(a.wetCount, b.wetCount);
  eq(a.maxSteps, b.maxSteps);
  for (let p = 0; p < RES * RES; p++) {
    if (a.wet[p] !== b.wet[p] || a.steps[p] !== b.steps[p]) throw new Error(`diverged at ${p}`);
  }
});

test("wetAt reads the mask in world coordinates", () => {
  const f = floodFromSea(withChannel());
  const cell = (i) => (i / (RES - 1) - 0.5) * SIZE;
  eq(wetAt(f, cell(16), cell(16)), true, "the flooded pit");
  eq(wetAt(f, cell(16), cell(10)), false, "land above it");
  eq(wetAt(f, cell(0), cell(0)), true, "the corner ocean");
  eq(wetAt(f, -SIZE, 0), false, "outside the grid");
  eq(wetAt(null, 0, 0), null, "no field yet");
});

/* ── flood level ──
   The waterline is a threshold, not a rebuild: the same field floods further
   as `level` rises, and topology still decides. These are the contracts the
   flood slider rests on. */

test("raising the level floods land the sea has a path to", () => {
  const f0 = floodFromSea(plain());
  const f1 = floodFromSea(plain(), null, 20); // above the land's 10m

  eq(f0.wet[at(16, 16)], 0, "dry at the natural coastline");
  eq(f1.wet[at(16, 16)], 1, "drowned once the level clears the land");
  ok(f1.wetCount > f0.wetCount, "a higher level wets strictly more");
  eq(f1.wetCount, RES * RES, "nothing stands above 20m here");
});

test("a landlocked hollow stays dry however high the level, until it is reached", () => {
  // The pit floor is -20 inside land at 10. Flooding to 5 leaves the ring of
  // land around it standing, so the sea still has no path in.
  const mid = floodFromSea(withPit(), null, 5);
  eq(mid.wet[at(16, 16)], 0, "still sealed: the rim is above the waterline");
  ok(mid.wet[at(0, 0)] === 1, "the open sea rose all the same");

  // Once the level tops the rim, the sea reaches it and it fills.
  const over = floodFromSea(withPit(), null, 15);
  eq(over.wet[at(16, 16)], 1, "the rim is under water, so the pit connects");
});

test("level 0 is exactly the old behaviour", () => {
  const a = floodFromSea(withPit());
  const b = floodFromSea(withPit(), null, 0);
  eq(a.wetCount, b.wetCount, "same wet count");
  for (let p = 0; p < a.wet.length; p++) if (a.wet[p] !== b.wet[p]) throw new Error(`cell ${p} differs`);
});

test("a previous mask on the same grid is read cell for cell — no resample fringe", () => {
  /* The regression this guards: the engine used to re-bake the water field at
     257² after a sculpt stroke while erosion had left a 513² mask, so every
     first dig paid a resample and the shoreline moved. Final grounds now stay
     on one grid, and on one grid the old mask must be exact: the ONLY new
     cells after digging the channel are the channel and the pit it reaches. */
  const before = floodFromSea(withPit());
  const after = floodFromSea(withChannel(), before);
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const p = at(i, j);
      if (before.wet[p]) eq(after.steps[p], 0, `old water re-revealed at ${i},${j}`);
      if (after.wet[p] && !before.wet[p]) {
        ok(inChannel(i, j) || inPit(i, j), `fringe cell wet at ${i},${j}`);
      }
    }
  }
  eq(after.newCount, after.wetCount - before.wetCount, "newCount is exactly the dug cells");
});

report("flood");
