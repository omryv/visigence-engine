// Erosion contracts. The droplet loop had no test of its own — it was covered
// only through canonical.js, where a failure reads as "the world is different"
// rather than as "the simulation is". These pin the two properties every
// consumer of this module actually depends on: the result is a function of its
// inputs and nothing else, and the thermal pass caps the slope it says it caps.
//
// The thermal half is the reason this file exists now. It is a relaxation, so
// the ways it can be wrong are quiet ones: a bias toward the corner the scan
// starts in, an oscillation between two cells that trade the same material
// forever, or material appearing out of the boundary. None of those show up as
// an exception, and all three show up here.
import { test, eq, close, ok, report } from "./harness.js";
import { erode, erodeWithDelta, thermal, DEFAULT_TALUS, MAX_THERMAL_RATE } from "../../../src/kernel/terrain/erosion.js";

const RES = 65;
const CELL = 8;
const OPTS = { drops: 400, inertia: 0.06, capacity: 3.2, deposit: 0.25, erode: 0.28, evaporate: 0.012 };

/* A cone: steep near the middle, flat at the rim. Steep enough that the sides
   are well past any talus angle the tests use, so there is always something
   for the relaxation to do. */
function cone(res = RES, peak = 400) {
  const d = new Float32Array(res * res);
  const c = (res - 1) / 2;
  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const r = Math.hypot(x - c, z - c) / c;
      d[z * res + x] = Math.max(0, 1 - r) * peak;
    }
  }
  return d;
}

function sum(a) { let s = 0; for (const v of a) s += v; return s; }

/* The steepest drop between any two orthogonal or diagonal neighbours, as a
   grade. This is the number the talus angle is a cap on. */
function maxGrade(data, res, cell) {
  let worst = 0;
  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const h = data[z * res + x];
      for (const [dx, dz, dist] of [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
        const g = Math.abs(h - data[nz * res + nx]) / (cell * dist);
        if (g > worst) worst = g;
      }
    }
  }
  return worst;
}

// ── the droplets ────────────────────────────────────────────────────────────

test("the same seed erodes the same ground", () => {
  const a = cone(), b = cone();
  erode(a, RES, CELL, OPTS, 12345);
  erode(b, RES, CELL, OPTS, 12345);
  for (let i = 0; i < a.length; i++) eq(a[i], b[i], `cell ${i}`);
});

test("a different seed cuts a different valley", () => {
  const a = cone(), b = cone();
  erode(a, RES, CELL, OPTS, 12345);
  erode(b, RES, CELL, OPTS, 999);
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  ok(differing > a.length * 0.05, `${differing} of ${a.length} cells differ`);
});

test("erodeWithDelta leaves its input alone and reports what moved", () => {
  const base = cone();
  const before = Float32Array.from(base);
  const { data, delta } = erodeWithDelta(base, RES, CELL, OPTS, 7);
  for (let i = 0; i < base.length; i++) eq(base[i], before[i], `input cell ${i} untouched`);
  for (let i = 0; i < data.length; i++) close(delta[i], data[i] - before[i], 1e-4, `delta ${i}`);
});

// ── the thermal pass ────────────────────────────────────────────────────────

test("no iterations is a no-op, which is what an absent thermal block means", () => {
  const a = cone(), b = cone();
  thermal(a, RES, CELL, {});
  thermal(b, RES, CELL, { iterations: 0, talus: 0.1, rate: 1 });
  for (let i = 0; i < a.length; i++) eq(a[i], cone()[i], `cell ${i} untouched`);
  for (let i = 0; i < b.length; i++) eq(b[i], a[i], `cell ${i}`);
});

test("a world eroded without a thermal block is the world it was before one existed", () => {
  // The compatibility claim in src/kernel/presets.js, as an assertion: the five
  // world files on the shelf carry an erosion block with no `thermal` key.
  const a = cone(), b = cone();
  erode(a, RES, CELL, OPTS, 42);
  erode(b, RES, CELL, { ...OPTS, thermal: { iterations: 0 } }, 42);
  for (let i = 0; i < a.length; i++) eq(a[i], b[i], `cell ${i}`);
});

test("a local overhang relaxes to exactly the angle of repose", () => {
  // One cell standing above a plain: the LOCAL case, which is what this pass
  // is for and the one that actually converges in a handful of iterations.
  // Sheddable height 100 m at a 0.8 grade over 8 m cells needs about 16 cells
  // of apron, which fits inside this grid with room to spare.
  const res = 65, d = new Float32Array(res * res);
  d[32 * res + 32] = 100;
  thermal(d, res, CELL, { iterations: 60, talus: DEFAULT_TALUS, rate: 0.5 });
  close(maxGrade(d, res, CELL), DEFAULT_TALUS, 1e-3, "settles at the talus angle");
});

test("a whole mountainside gets gentler, one cell of transport per pass", () => {
  /* And it does NOT reach the cap in any reasonable iteration count, which is
     the honest shape of this simulation rather than a shortfall in it. Thermal
     erosion is local: material moves one cell per pass, so re-grading a cone
     32 cells across is a diffusion problem needing on the order of a thousand
     passes. Measured on the canonical 513² grid a real world starts at grade
     2.53 and 16 passes cost 283 ms to bring it to 2.08.

     So the useful setting is tens of passes and the effect is knocking the
     edges off crests, not flattening ranges — which is what the knob is
     documented as in src/kernel/presets.js. A test that asserted the cap here
     would be asserting a promise the pass does not make. */
  const d = cone();
  const before = maxGrade(d, RES, CELL);
  ok(before > DEFAULT_TALUS, `the cone starts steeper than the talus: ${before.toFixed(2)}`);
  thermal(d, RES, CELL, { iterations: 60, talus: DEFAULT_TALUS, rate: 0.5 });
  const after = maxGrade(d, RES, CELL);
  ok(after < before, `steepest grade fell from ${before.toFixed(2)} to ${after.toFixed(2)}`);
});

test("the ground never gets steeper along the way", () => {
  /* THE PROPERTY THE RATE CEILING EXISTS FOR. Eight neighbours shed into each
     other at once, so a cell's own contribution lands on ground that is
     dropping underneath it in the same pass; past roughly rate 0.65 that
     overshoots and the field ripples. It still converges, but it spends its
     first hundred passes making the ground WORSE than it found it, and on a
     terrain tool that reads as the noise being ugly rather than as a setting
     being wrong. Nothing about it throws, which is why it is asserted. */
  const d = cone();
  let prev = maxGrade(d, RES, CELL);
  for (let i = 0; i < 40; i++) {
    thermal(d, RES, CELL, { iterations: 5, talus: DEFAULT_TALUS, rate: 0.5 });
    const now = maxGrade(d, RES, CELL);
    ok(now <= prev + 1e-6, `pass ${i * 5}: grade ${now.toFixed(4)} after ${prev.toFixed(4)}`);
    prev = now;
  }
});

test("an unstable rate is clamped rather than obeyed", () => {
  // rate 5 is not a faster relaxation, it is a different and wrong one.
  const clamped = cone(), ceiling = cone();
  thermal(clamped, RES, CELL, { iterations: 20, talus: DEFAULT_TALUS, rate: 5 });
  thermal(ceiling, RES, CELL, { iterations: 20, talus: DEFAULT_TALUS, rate: MAX_THERMAL_RATE });
  for (let i = 0; i < clamped.length; i++) eq(clamped[i], ceiling[i], `cell ${i}`);
});

test("a gentler talus makes gentler ground", () => {
  const steep = cone(), gentle = cone();
  thermal(steep, RES, CELL, { iterations: 60, talus: 1.5, rate: 0.5 });
  thermal(gentle, RES, CELL, { iterations: 60, talus: 0.4, rate: 0.5 });
  ok(maxGrade(gentle, RES, CELL) < maxGrade(steep, RES, CELL), "lower talus, lower slope");
});

test("material is moved, not created — the total is conserved", () => {
  const d = cone();
  const before = sum(d);
  thermal(d, RES, CELL, { iterations: 40, talus: 0.5, rate: 0.5 });
  // Every gram shed by a cell is credited to a neighbour inside the grid: a
  // cell on the rim skips the neighbours that are off it, so nothing leaves.
  close(sum(d) / before, 1, 1e-5, "total height");
});

test("the relaxation is symmetric, not biased toward the corner the scan starts in", () => {
  // A Jacobi update reads the previous iteration everywhere. An in-place one
  // would not, and a radially symmetric cone is exactly where that shows: the
  // four quadrants would settle to four different profiles.
  const d = cone();
  thermal(d, RES, CELL, { iterations: 30, talus: 0.5, rate: 0.5 });
  const c = (RES - 1) / 2;
  const at = (x, z) => d[z * RES + x];
  for (let k = 1; k <= c; k++) {
    close(at(c + k, c), at(c - k, c), 1e-3, `east/west at ${k}`);
    close(at(c, c + k), at(c, c - k), 1e-3, `north/south at ${k}`);
    close(at(c + k, c), at(c, c + k), 1e-3, `east/south at ${k}`);
  }
});

test("a settled field is a fixed point, not two cells trading forever", () => {
  // Run a local overhang to convergence, then keep going: an oscillation
  // between two cells swapping the same material would never stop moving.
  const res = 65, a = new Float32Array(res * res);
  a[32 * res + 32] = 100;
  thermal(a, res, CELL, { iterations: 120, talus: DEFAULT_TALUS, rate: 0.5 });
  const b = Float32Array.from(a);
  thermal(b, res, CELL, { iterations: 40, talus: DEFAULT_TALUS, rate: 0.5 });
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  ok(worst < 1e-3, `forty more passes move the settled field by ${worst.toExponential(2)} m`);
});

test("thermal is deterministic and has no RNG of its own", () => {
  const a = cone(), b = cone();
  thermal(a, RES, CELL, { iterations: 25, talus: 0.6, rate: 0.5 });
  thermal(b, RES, CELL, { iterations: 25, talus: 0.6, rate: 0.5 });
  for (let i = 0; i < a.length; i++) eq(a[i], b[i], `cell ${i}`);
});

test("the pass runs inside erode, after the droplets", () => {
  const withThermal = cone(), withoutThermal = cone();
  erode(withThermal, RES, CELL, { ...OPTS, thermal: { iterations: 40, talus: 0.5, rate: 0.5 } }, 3);
  erode(withoutThermal, RES, CELL, OPTS, 3);
  ok(maxGrade(withThermal, RES, CELL) < maxGrade(withoutThermal, RES, CELL),
    "the eroded surface comes out gentler when the thermal block asks for it");
});

test("missing or malformed options fall back to the shipped defaults, never to NaN", () => {
  // The regression: destructuring with no defaults meant a world file
  // carrying `erosion: { enabled: true }` and nothing else NaN'd the field —
  // a world that loads "successfully" and draws nothing.
  for (const opts of [{}, undefined, { drops: 500 }, { drops: "many", inertia: null }]) {
    const d = cone();
    erode(d, RES, CELL, opts, 7);
    for (let i = 0; i < d.length; i++) {
      if (!Number.isFinite(d[i])) throw new Error(`NaN at ${i} for opts ${JSON.stringify(opts)}`);
    }
  }
  // And a non-finite value means THE DEFAULT, not zero: same seed, same field.
  const a = cone(), b = cone();
  erode(a, RES, CELL, { ...OPTS, inertia: NaN }, 7);
  erode(b, RES, CELL, { ...OPTS, inertia: 0.06 }, 7);
  for (let i = 0; i < a.length; i++) eq(a[i], b[i], `cell ${i}`);
});

report("erosion");
