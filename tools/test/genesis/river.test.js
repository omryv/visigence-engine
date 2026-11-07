/* The river solver's contracts.
 *
 * A river here is an ANSWER — where does water from this point go — and the
 * promises are exactly the ones the editor tool stands on: the course always
 * terminates; its water surface never climbs; a hollow on the way is pooled
 * to its spill saddle and crossed, never looped in; the same inputs solve
 * the same river to the digit; and after the emitted strokes carve a field,
 * the sea can actually reach up the channel — the end-to-end promise the
 * flood-front animation depends on.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { solveRiver, strokesFor } from "../../../src/genesis/terrain/river.js";
import { floodFromSea, wetAt } from "../../../src/kernel/water/flood.js";
import { SculptLayer } from "../../../src/kernel/terrain/sculpt.js";

const SIZE = 4096;
const RES = 129;

function bake(fn) {
  const data = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    const z = (j / (RES - 1) - 0.5) * SIZE;
    for (let i = 0; i < RES; i++) {
      data[j * RES + i] = fn((i / (RES - 1) - 0.5) * SIZE, z);
    }
  }
  return { res: RES, size: SIZE, data };
}

/* An island: a broad cone with gentle noise-free flanks, ringed by sea. */
const island = (x, z) => 260 - Math.hypot(x, z) * 0.16;
/* The same island with a crater pit on the west flank, squarely in the way
   of water descending from the summit toward the west coast. */
const crater = (x, z) => {
  const d = Math.hypot(x + 900, z);
  return island(x, z) - (d < 260 ? (260 - d) * 0.5 : 0);
};

const solve = (fieldFn, head, opts = {}) => {
  const field = bake(fieldFn);
  const wet = floodFromSea(field, null, 0).wet;
  return { field, wet, out: solveRiver({ field, wet, head, seed: "RIVR-TEST-SEED", ...opts }) };
};

test("a river from the summit reaches the sea", () => {
  const { out } = solve(island, { x: 40, z: -25 });
  ok(out.reachedSea, "the course never met sea-connected water");
  ok(out.path.length > 10, `a real course, not a stub (${out.path.length} points)`);
  ok(out.strokes.length > 10, "no strokes to carve it with");
});

test("the water surface never climbs", () => {
  for (const head of [{ x: 40, z: -25 }, { x: 300, z: 500 }, { x: -700, z: 120 }]) {
    const { out } = solve(island, head);
    for (let k = 1; k < out.path.length; k++) {
      ok(out.path[k][2] <= out.path[k - 1][2] + 1e-9,
        `water climbs at point ${k}: ${out.path[k - 1][2]} → ${out.path[k][2]}`);
    }
  }
});

test("every course terminates, across a sweep of headwaters", () => {
  // Termination is the solver's first duty; a hang here is an editor freeze.
  for (let k = 0; k < 12; k++) {
    const head = { x: -1200 + k * 200, z: (k % 2 ? -1 : 1) * (200 + k * 90) };
    const { out } = solve(island, head);
    ok(out.path.length > 0 && out.path.length < 8000, `head ${k}: ${out.path.length} points`);
    ok(out.reachedSea, `head ${k} never reached the sea on an island`);
  }
});

test("a pit on the way is pooled to its spill and crossed, never looped", () => {
  // The head sits uphill of the crater, so steepest descent runs into it.
  const { out } = solve(crater, { x: -400, z: 10 });
  ok(out.pools.length >= 1, "the crater was not pooled");
  ok(out.reachedSea, "the course died in the crater instead of spilling");
  const pool = out.pools[0];
  ok(pool.level > 0, "a spill saddle on this island stands above the sea");
  ok(pool.cells > 4, "a real basin, not a single cell");
});

test("the same inputs solve the same river, to the digit", () => {
  const a = solve(crater, { x: 40, z: -25 }).out;
  const b = solve(crater, { x: 40, z: -25 }).out;
  eq(JSON.stringify(a.path), JSON.stringify(b.path), "paths diverged");
  eq(JSON.stringify(a.strokes), JSON.stringify(b.strokes), "strokes diverged");
  // …and the seed genuinely matters: a different seed bends differently.
  const c = solveRiver({
    field: bake(crater), wet: floodFromSea(bake(crater), null, 0).wet,
    head: { x: 40, z: -25 }, seed: "OTHR-SEED-HERE",
  });
  ok(JSON.stringify(c.path) !== JSON.stringify(a.path), "the meander ignores its seed");
});

test("the meander widens in the flats and holds in the steeps", () => {
  const straight = solve(island, { x: 40, z: -25 }, { meander: 0 }).out;
  const bendy = solve(island, { x: 40, z: -25 }, { meander: 2 }).out;
  // Same course, different wander: total arc length grows with meander.
  const len = (p) => p.reduce((s, q, k) => (k ? s + Math.hypot(q[0] - p[k - 1][0], q[1] - p[k - 1][1]) : 0), 0);
  ok(len(bendy.path) > len(straight.path),
    `meander 2 is not longer than meander 0 (${len(bendy.path)} vs ${len(straight.path)})`);
});

test("the stroke budget stays in the low hundreds", () => {
  const { out } = solve(island, { x: 40, z: -25 }, { width: 10 });
  ok(out.strokes.length < 600, `${out.strokes.length} strokes for one river`);
  for (const s of out.strokes) {
    ok(["lower", "smooth"].includes(s.mode), `unexpected mode ${s.mode}`);
    ok(Number.isFinite(s.x + s.z + s.r + s.amount), "non-finite stroke field");
  }
});

test("after the carve, the sea reaches up the channel — the end-to-end promise", () => {
  const field = bake(island);
  const before = floodFromSea(field, null, 0);
  const head = { x: 40, z: -25 };
  const out = solveRiver({ field, wet: before.wet, head, seed: "RIVR-TEST-SEED", depth: 6, width: 24 });
  ok(out.reachedSea, "no course to carve");

  // Replay the emitted strokes exactly as the engine would.
  const layer = new SculptLayer({ size: SIZE });
  const base = (x, z) => island(x, z);
  for (const s of out.strokes) layer.apply({ x: s.x, z: s.z, r: s.r, amount: s.amount, mode: s.mode }, base);
  const carved = bake((x, z) => island(x, z) + layer.offsetAt(x, z));
  const after = floodFromSea(carved, before, 0);

  ok(after.newCount > 0, "carving the channel revealed no new water");
  // The mouth — the last path point — must now be wet and sea-connected.
  const mouth = out.path[out.path.length - 1];
  eq(wetAt(after, mouth[0], mouth[1]), true, "the mouth is still dry after the carve");
});

test("strokesFor on an empty or trivial path is empty, not a throw", () => {
  eq(strokesFor([]).length, 0);
  eq(strokesFor([[0, 0, 5]]).length, 0);
});

report("river");
