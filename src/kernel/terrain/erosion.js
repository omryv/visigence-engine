// Hydraulic erosion (particle droplets), as a pure function.
//
// This is the simulation that decides what the land finally looks like: which
// ridges keep their edge, where the valleys cut, what silt ends up on the
// shelf. It used to live INSIDE engine/terrain/erosion-worker.js, which meant
// the only way to run it was to spin up a Worker and wait for a message —
// fine for the editor, impossible for a plain module, a test, or any other
// page that wants the same ground.
//
// So the maths moved here and the worker became what a worker should be: a
// message boundary around a function. Nothing about the simulation changed.
// Same droplet loop, same constants, same mulberry32 stream, same rounding —
// so a world eroded through the worker and a world eroded by calling this
// directly are the same world, which is the property the seed promises and
// the landing page's hero depends on.
//
// Determinism, and what it is conditional on: the result is a function of
// (data, res, cell, opts, seed) and nothing else — no clock, no Math.random,
// no floating-point reduction order that varies by engine. It is NOT
// resolution-independent: a droplet steps one CELL per iteration, so the same
// seed at a different `res` walks a different distance in metres and carves a
// different valley. Every caller that wants the editor's ground must erode at
// the editor's grid (513) and resample afterwards, rather than eroding at
// whatever resolution it happens to be drawing.
//
// Pure JS, no three.js, no DOM — runs in the worker, in a page, and in the
// JavaScriptCore test suite.

import { mulberry32 } from "../seed.js";

/** Erode `data` (res × res heights, metres) IN PLACE. `cell` is the grid
    spacing in metres. Returns nothing — the caller owns the array.

    Every option falls back to the engine's shipped default (presets.js) when
    missing or non-finite. Destructuring with no defaults meant a hand-edited
    world file carrying `erosion: { enabled: true }` and nothing else NaN'd
    the whole field — a world that loads "successfully" and draws nothing. */
const num = (v, dflt) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
export function erode(data, res, cell, opts, seed) {
  const o = opts || {};
  const drops = num(o.drops, 35000), inertia = num(o.inertia, 0.06);
  const capacity = num(o.capacity, 3.2), deposit = num(o.deposit, 0.25);
  const erodeRate = num(o.erode, 0.28), evaporate = num(o.evaporate, 0.012);
  const rng = mulberry32(seed);
  const grad = (x, z) => {
    const ix = Math.min(Math.max(x | 0, 0), res - 2), iz = Math.min(Math.max(z | 0, 0), res - 2);
    const fx = x - ix, fz = z - iz;
    const i = iz * res + ix;
    const h00 = data[i], h10 = data[i + 1], h01 = data[i + res], h11 = data[i + res + 1];
    return [
      ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / cell,
      ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / cell,
      h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz,
    ];
  };
  const depositAt = (x, z, amt) => {
    const ix = Math.min(Math.max(x | 0, 0), res - 2), iz = Math.min(Math.max(z | 0, 0), res - 2);
    const fx = x - ix, fz = z - iz, i = iz * res + ix;
    data[i] += amt * (1 - fx) * (1 - fz); data[i + 1] += amt * fx * (1 - fz);
    data[i + res] += amt * (1 - fx) * fz; data[i + res + 1] += amt * fx * fz;
  };

  for (let d = 0; d < drops; d++) {
    let x = rng() * (res - 2) + 0.5, z = rng() * (res - 2) + 0.5;
    let dx = 0, dz = 0, speed = 1, water = 1, sediment = 0;
    for (let life = 0; life < 48; life++) {
      const [gx, gz, h] = grad(x, z);
      dx = dx * inertia - gx * (1 - inertia);
      dz = dz * inertia - gz * (1 - inertia);
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) break;
      dx /= len; dz /= len;
      const nx = x + dx, nz = z + dz;
      if (nx < 1 || nz < 1 || nx >= res - 2 || nz >= res - 2) break;
      const nh = grad(nx, nz)[2];
      const dh = nh - h;
      const cap = Math.max(-dh, 0.01) * speed * water * capacity;
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposit;
        sediment -= amt;
        depositAt(x, z, amt);
      } else {
        const amt = Math.min((cap - sediment) * erodeRate, -dh);
        sediment += amt;
        depositAt(x, z, -amt);
      }
      speed = Math.sqrt(Math.max(speed * speed + dh * -9.81 * 0.01, 0));
      water *= 1 - evaporate;
      x = nx; z = nz;
      if (water < 0.01) break;
    }
  }

  thermal(data, res, cell, o.thermal || {});
}

/* ── thermal erosion: the slope the water never touches ──
 *
 * The droplet loop above moves what water CARRIES, and it is the right model
 * for valleys, channels and the silt that ends up on the shelf. It has nothing
 * to say about a slope that is simply too steep to stand up. A crest the noise
 * cut at seventy degrees is still at seventy degrees after a hundred thousand
 * drops, because no droplet ever lingers on it — it accelerates away, and the
 * face it left behind is a knife edge with no debris under it. Real ground
 * does not do that. Rock spalls off, the pieces roll until the pile they land
 * on reaches its angle of repose, and what you actually see under a crest is
 * an apron of scree.
 *
 * So: every cell that stands more than `talus` above a neighbour is holding
 * material nothing supports, and it sheds it downhill.
 *
 * ── WHY THIS IS WORTH HAVING IN A TOOL ABOUT WALKING AROUND ──
 * A talus angle is a slope cap, and this repository already has a slope
 * problem with a name: `tools/walk-world.mjs` fails a world whose ground steps
 * harder than the walk controller climbs. Two of the four original worlds were
 * cut over faults of exactly that kind. Thermal relaxation is the generator's
 * own answer to it — it does not move a placement or lower a step, it stops
 * the ground from being cut that way in the first place — which is why the
 * knobs are terrain knobs rather than a post-hoc repair pass.
 *
 * ── DETERMINISM ──
 * No RNG at all: unlike the droplet loop this is a pure relaxation, a function
 * of the field and the three numbers. It is a JACOBI update — every cell reads
 * the previous iteration and writes into a scratch buffer that is applied at
 * the end — rather than in-place. In-place would also be deterministic, but it
 * would be deterministic AND directionally biased: a cell updated at the top of
 * the scan sees old neighbours to its right and new ones to its left, so scree
 * creeps toward whichever corner the loop starts in. It is resolution-
 * dependent in the same way the droplets are, and for the same reason, so it
 * runs at CANONICAL_RES with everything else.
 */
export const DEFAULT_TALUS = 0.8;

/* ── why `rate` has a ceiling, and why it is this one ──
 *
 * A cell sheds `rate · worst · 0.5` per pass. On a two-cell step that is a
 * proper no-overshoot limit at rate = 1: the pair's difference closes by at
 * most the whole excess and never crosses it. On a GRID it is not, because
 * eight neighbours are shedding into each other simultaneously and a cell's
 * own shed lands on ground that is dropping underneath it at the same time.
 *
 * Measured on a 400 m cone at 8 m cells, tracking the steepest grade in the
 * field every five passes:
 *
 *     rate 0.50   monotone, 1.563 → 1.123
 *     rate 0.60   monotone, 1.563 → 1.054
 *     rate 0.70   NOT monotone — the field steepens between passes
 *     rate 0.80   peaks at 1.808, steeper than the cone it started with
 *
 * So above roughly 0.65 the relaxation ripples: it still converges eventually,
 * but it spends the first hundred passes making the ground worse than it
 * found it, which for a terrain tool is not a slow setting — it is a wrong
 * one. Clamped rather than documented-and-trusted, because the failure is
 * invisible in a still frame and looks like the noise being ugly.
 */
export const MAX_THERMAL_RATE = 0.5;

/* The eight steps a cell can shed into, as (dx, dz, distance-in-cells).
   Diagonals are farther apart, so the same talus angle permits a taller drop
   across one — using the orthogonal limit for all eight would make the field
   quietly steeper along the diagonals than the number asks for. */
const NEIGHBOURS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
];

/** Relax `data` (res × res heights, metres) toward a maximum stable grade, IN
    PLACE. `cell` is the grid spacing in metres; `talus` is that grade as
    rise/run, so 0.8 caps the ground at about 39°. `rate` is how much of the
    imbalance one iteration resolves. Zero iterations is a no-op, which is what
    an absent `thermal` block means and why every world saved before this
    existed reloads unchanged. */
export function thermal(data, res, cell, { iterations = 0, talus = DEFAULT_TALUS, rate = MAX_THERMAL_RATE } = {}) {
  const iters = Math.max(0, Math.floor(iterations));
  if (!iters || !(rate > 0) || !(talus >= 0)) return;
  const step = Math.min(rate, MAX_THERMAL_RATE);

  const move = new Float32Array(data.length);
  const excess = new Float64Array(8);

  for (let it = 0; it < iters; it++) {
    move.fill(0);
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x;
        const h = data[i];
        let total = 0, worst = 0;
        for (let k = 0; k < 8; k++) {
          excess[k] = 0;
          const nx = x + NEIGHBOURS[k][0], nz = z + NEIGHBOURS[k][1];
          if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
          // How far this drop exceeds what the angle of repose supports.
          const over = h - data[nz * res + nx] - talus * cell * NEIGHBOURS[k][2];
          if (over > 0) { excess[k] = over; total += over; if (over > worst) worst = over; }
        }
        if (total <= 0) continue;
        /* Musgrave's rule: shed half the WORST overhang, split among the
           neighbours below the line in proportion to how far below they are.
           Halving is what keeps a two-cell pair from oscillating — moving the
           whole excess across would just swap which of the two is the cliff. */
        const shed = step * worst * 0.5;
        move[i] -= shed;
        for (let k = 0; k < 8; k++) {
          if (excess[k] <= 0) continue;
          move[(z + NEIGHBOURS[k][1]) * res + (x + NEIGHBOURS[k][0])] += shed * (excess[k] / total);
        }
      }
    }
    for (let i = 0; i < data.length; i++) data[i] += move[i];
  }
}

/** Erode a copy and report what moved. `data` is left untouched; the returned
    `delta` is (after − before) per cell, which is the only record of which
    ground was STRIPPED and which was BURIED — a scoured shelf and a buried
    one look identical once the water has gone. src/kernel/terrain/masks.js turns
    it into the deposition and wetness masks the terrain shader weights by. */
export function erodeWithDelta(data, res, cell, opts, seed) {
  const out = Float32Array.from(data);
  const delta = Float32Array.from(data);
  erode(out, res, cell, opts, seed);
  for (let i = 0; i < out.length; i++) delta[i] = out[i] - delta[i];
  return { data: out, delta };
}
