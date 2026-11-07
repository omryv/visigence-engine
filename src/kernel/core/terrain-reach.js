/* terrain-reach.js — where on this ground can the player get to, and how long
 * should it take?
 *
 * reach.js answers that question for a building: it walks a grid through the
 * placements with the collision rules. This answers it for the LAND, on the
 * baked field every consumer already holds ({ res, size, data } — the 513²
 * canonical ground, or any other bake), and then goes one step further: for a
 * start and an objective it finds the quickest walking route between them and
 * prices it. That price is PAR — the time a fair course should allow for the
 * leg — and it is only fair if the route is one the body in controller.js can
 * actually walk, at the speed it actually walks.
 *
 *   reachTerrain(field, { spawn, level, controller, wet, snapCells })
 *   terrainRegions(field, { level, controller, wet })
 *   parRoute(field, from, to, { level, controller, wet, reach, snapCells,
 *                               tolerance, steepGrade, longParSeconds })
 *
 * ── what a walkable cell is
 *
 * The field's lattice points are the cells: point (i, j) stands at
 * x = (i / (res − 1) − 0.5) · size, the same mapping bakeHeightField writes
 * and createBakedSampler reads, so a cell here is a sample there and nothing
 * is resampled. A cell is WALKABLE when both hold:
 *
 *   footing   it is dry, or it is water no deeper than wadeDepth. "Water" is
 *             the sea-connected mask when the caller passes one (`wet`, from
 *             floodFromSea or bakeCanonicalGround) — a hollow below the line
 *             with no path to the sea is dry ground, exactly as the flood and
 *             the walk controller treat it — and is "below `level`" when no
 *             mask is given, the old every-low-cell-is-sea rule.
 *   slope     the gradient measured from the cell to its neighbours (central
 *             differences along x and z, one-sided at the border) is no more
 *             than maxSlope.
 *
 * A height that is not a finite number (a NaN from a sampler bug, an
 * Infinity) is never walkable, and neither is a cell whose gradient is not
 * finite because a neighbour is NaN: a broken bake shows up as ground nobody
 * can stand on, not as ground a route quietly crosses.
 *
 * The LIMIT is the one 3dgen's nav bake uses (controller.js, maxSlope 0.85),
 * but the MEASURING RULE is not. 3dgen (src/world/navgrid.js:62-63) asks
 * slopeAt, a central difference over ±2 m on the bilinear sampler at its own
 * cell centres (src/world/terrain/heightfield.js:224), and its flood also
 * refuses any step that rises more than stepUp (navgrid.js:104). This module
 * differences over two lattice cells (16 m at the canonical spacing) and does
 * not apply stepUp to the land, for the reason below. So the two repositories
 * share the numbers and can still disagree about a particular hillside; a
 * reach answer from one is not a proof of the other's.
 *
 * And a STEP between two walkable neighbours (eight of them; a diagonal only
 * when both cells it cuts past are walkable too, so a route never squeezes
 * between two cliff cells or across the corner of a bay) is allowed when its
 * own grade, rise over the horizontal length of that step, is within maxSlope.
 * That second test is not redundant with the first: a cell on the lip of a
 * terrace can be gentle on average and still drop more than maxSlope to the
 * neighbour below it.
 *
 * ── what stepUp is NOT doing here
 *
 * controller.js carries stepUp 0.55, and 3dgen's flood refuses any neighbour
 * step with a rise over it. At the canonical spacing (4096 / 512 = 8 m) that
 * test would refuse every step steeper than 0.55 / 8 ≈ 0.069 — about 4° —
 * and strand most of any world, while the walk controller has no such limit
 * on terrain at all: the field is bilinear between its samples, so there IS
 * no vertical step anywhere on it, only slope. stepUp is a rule about
 * placements (a kerb, a stair, a wall), which is where reach.js applies it.
 * So it is deliberately not applied to the land, and the slope limit is the
 * one terrain rule.
 *
 * ── swimming is not reach
 *
 * The body can swim (controller.js, swim 3.5). A route that needs it is not a
 * walking route, and a par that assumes it would be priced at the wrong speed
 * over water nobody tested for currents or a far shore — so the flood stops
 * at wadeDepth, and an objective across open sea is unreachable, an error. A
 * course that means to send a player swimming should say so and get a
 * different check; this one will not guess.
 *
 * ── the route, and the par
 *
 * Dijkstra over the reached cells, from the start's cell to the objective's,
 * on time: a step costs (horizontal + flatPerClimb · rise) / walk seconds,
 * where rise is the metres gained on that step (descent is free — the rule
 * and the reasons for it are in controller.js). Par is that total, so:
 *
 *   par ≥ horizontal distance / walk, always, with equality on flat ground.
 *
 * The queue is a binary heap with decrease-key (position index per cell), so
 * it never holds more than one entry per cell. Ties — two cells at the same
 * cost, which on a flat plateau is most of them — are broken by the smaller
 * cell index, and the neighbour order is fixed, so the same field and the
 * same two points give the same path in any engine. No Math.hypot (not
 * required to be correctly rounded), no exp: sqrt, multiply and add only.
 *
 * The path comes back decimated: the cell-by-cell route is reduced with
 * Ramer–Douglas–Peucker in three dimensions (iterative, so a route of tens of
 * thousands of cells does not hit the stack limit) at `tolerance` metres,
 * half a cell by default. Distance, climb, descent and maxGrade are measured
 * on the FULL route, never on the decimated one — decimating a path shortens
 * it and flattens it, and a par measured after that would be a par for a
 * route nobody walks.
 *
 * ── snapping a point onto the lattice
 *
 * A start or an objective is put on the nearest WALKABLE cell no more than
 * snapCells cell-lengths from the point itself — a circle measured from the
 * point, not a square around its rounded cell, and never from a point first
 * clamped onto the map. So a coordinate off the plate snaps only if the edge
 * of the lattice is within that circle of it, and a coordinate a kilometre
 * off, or ±Infinity, or NaN, snaps to nothing. (The point's own cell is always
 * in range, so snapCells 0 means "the cell under the point".)
 *
 * The objective is snapped by the same rule as the start — onto walkable
 * ground, not onto ground the start has reached. Snapping it onto REACHED
 * ground instead would move an objective on a plateau above a cliff, or on
 * the far bank of a one-cell-wide deep trench, back onto the start's side of
 * the obstacle and call the route fine; this way the nearest ground under the
 * objective is found first, and if the start cannot walk to THAT, the
 * objective is unreachable.
 *
 * `snapped` is true when the point was moved further than half a cell's
 * diagonal — further than any point on the lattice is from its own nearest
 * cell. A point exactly halfway between cells is not snapped, whichever of
 * the equally near cells the tie (smaller index) picks.
 *
 * ── the verdict
 *
 * In the shape 2dgen's level analyser uses (builder/core/analyze.js:30
 * there): issues { id, severity, message, at, entityId }, ids stable for an
 * unchanged problem, sorted errors first; the verdict is the worst severity
 * present. `at` is a world point [x, z] to show the issue at, or null;
 * entityId is always null here (the land has no entities) and is kept so a
 * panel that renders 2dgen's issues renders these unchanged.
 *
 *   error     start-unwalkable      no walkable cell within snapCells of
 *                                   `from`. at: `from`
 *             objective-unreachable no walkable cell within snapCells of `to`
 *                                   (sea, a slope, off the map), or the
 *                                   walkable cell under it is ground the start
 *                                   cannot get to. at: `to`; the message names
 *                                   the cell it stands on when there is one
 *   warning   start-snapped,        the point was moved more than half a
 *             objective-snapped     cell's diagonal to reach walkable ground.
 *                                   at: the point as given; the message names
 *                                   where it was put and how far
 *             steep-leg             a stretch of the decimated route (a
 *                                   segment at least one cell long) climbs or
 *                                   drops at more than steepGrade. at: the
 *                                   start of the steepest stretch; the issue
 *                                   also carries `segments`, the path indices
 *                                   [k − 1, k] of every steep stretch
 *             long-leg              par exceeds longParSeconds. at: null
 *
 * Pure JS. No three.js, no DOM, no randomness, no clock.
 */

import { CONTROLLER } from "./controller.js";

/* How far a spawn or an objective may sit from the cell it is put on,
   measured from the point in cell lengths. Four cells is 32 m at the
   canonical spacing: enough to lift a marker dropped on a wet beach or a
   cliff edge onto the ground beside it, and not enough to move it to a
   different place. Every snap is reported, and one of more than half a
   cell's diagonal is a warning. */
export const SNAP_CELLS = 4;

/* The route's two warnings. steepGrade 0.5 is 26.6°, a hillside a walker
   takes on by zig-zagging; longParSeconds 600 is ten minutes of walking, the
   length a single leg of a course stops being a leg and becomes a trek. Both
   are judgements about a COURSE, not facts about the body, which is why they
   live here and not in CONTROLLER. */
export const ROUTE_LIMITS = Object.freeze({ steepGrade: 0.5, longParSeconds: 600 });

const SQRT2 = Math.SQRT2;
// half a cell's diagonal, in cell lengths: the furthest any point is from its
// own nearest lattice cell, and so the line between "put on its cell" and
// "snapped". The 1e-9 absorbs the rounding of a point exactly halfway.
const HALF_DIAG = SQRT2 / 2;
const SNAP_EPS = 1e-9;

/* The eight neighbours in a fixed order. di, dj, and whether the step is a
   diagonal. The order is part of the determinism contract. */
const NBR = [
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

const cellOf = (field, x, z) => {
  const k = (field.res - 1) / field.size;
  return [(x + field.size / 2) * k, (z + field.size / 2) * k];
};
const worldOf = (field, i, j) => [
  (i / (field.res - 1) - 0.5) * field.size,
  (j / (field.res - 1) - 0.5) * field.size,
];

/** Which cells a body can stand on, by footing and slope alone. */
export function walkableCells(field, { level = 0, controller = CONTROLLER, wet = null } = {}) {
  const { res, size, data } = field;
  const step = size / (res - 1);
  const N = res * res;
  if (wet && wet.length !== N) throw new Error(`walkableCells: wet mask has ${wet.length} cells, field has ${N}`);
  const walkable = new Uint8Array(N);
  const wade = controller.wadeDepth, max2 = controller.maxSlope * controller.maxSlope;
  let count = 0;
  for (let j = 0; j < res; j++) {
    const jm = j > 0 ? j - 1 : j, jp = j < res - 1 ? j + 1 : j;
    for (let i = 0; i < res; i++) {
      const p = j * res + i;
      const h = data[p];
      if (!Number.isFinite(h)) continue;
      const under = wet ? wet[p] === 1 : h < level;
      if (under && level - h > wade) continue;
      const im = i > 0 ? i - 1 : i, ip = i < res - 1 ? i + 1 : i;
      const gx = (data[j * res + ip] - data[j * res + im]) / ((ip - im) * step);
      const gz = (data[jp * res + i] - data[jm * res + i]) / ((jp - jm) * step);
      // written so a NaN gradient fails it: NaN <= x is false
      if (!(gx * gx + gz * gz <= max2)) continue;
      walkable[p] = 1;
      count++;
    }
  }
  return { walkable, count };
}

/* The nearest cell to (x, z) that `accept` admits, no more than `cells` cell
   lengths from the POINT (or half a diagonal, if that is more, so the point's
   own cell is always a candidate). Distance from the unclamped point, so an
   off-plate coordinate is as far from the border cells as it really is; ties
   by the smaller index. Returns { cell, metres, snapped } or null. */
function snapTo(field, x, z, cells, accept) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const { res } = field;
  const [fx, fz] = cellOf(field, x, z);
  const r = cells > HALF_DIAG ? cells : HALF_DIAG + SNAP_EPS;
  const r2 = r * r;
  const i0 = Math.max(0, Math.ceil(fx - r)), i1 = Math.min(res - 1, Math.floor(fx + r));
  const j0 = Math.max(0, Math.ceil(fz - r)), j1 = Math.min(res - 1, Math.floor(fz + r));
  let best = -1, bestD = Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = (i - fx) * (i - fx) + (j - fz) * (j - fz);
      if (d > r2) continue;
      const p = j * res + i;
      if (!accept(p)) continue;
      if (d < bestD || (d === bestD && p < best)) { bestD = d; best = p; }
    }
  }
  if (best < 0) return null;
  const d = Math.sqrt(bestD);
  return { cell: best, metres: d * (field.size / (res - 1)), snapped: d > HALF_DIAG + SNAP_EPS };
}

/* May a body step from p to its neighbour q? Both walkable, the grade within
   the limit, and a diagonal only past two walkable corners. */
function stepAllowed(data, walkable, res, p, i, j, n, step, maxSlope) {
  const [di, dj, diag] = NBR[n];
  const ni = i + di, nj = j + dj;
  if (ni < 0 || nj < 0 || ni >= res || nj >= res) return -1;
  const q = nj * res + ni;
  if (!walkable[q]) return -1;
  if (diag && (!walkable[j * res + ni] || !walkable[nj * res + i])) return -1;
  const run = diag ? step * SQRT2 : step;
  const rise = data[q] - data[p];
  if ((rise < 0 ? -rise : rise) > maxSlope * run) return -1;
  return q;
}

/**
 * Flood the walkable ground from a spawn.
 *
 *   field   { res, size, data } — a baked height field
 *   spawn   [x, z] in world metres
 *   level   the waterline (params.water.level), default 0
 *   wet     optional sea-connected mask (Uint8Array, res²)
 *
 * Returns { res, size, step, walkable, reached, walkableCount, reachedCount,
 * walkableFraction, reachedFraction, spawnCell, snapped, snapMetres }, where
 * walkableFraction is walkable cells over all cells and reachedFraction is
 * reached cells over WALKABLE cells — how much of the standable ground this
 * spawn can get to. spawnCell is −1 (and reached all zero) when there is no
 * walkable cell within snapCells of the spawn; `snapped` is true when the
 * spawn was moved more than half a cell's diagonal to reach walkable ground,
 * and snapMetres is always the distance from the spawn point to the cell it
 * was put on.
 *
 * `settings` records what the flood was made with — the field's data array
 * and the wet mask (by identity), the level, the controller's version,
 * maxSlope and wadeDepth, and snapCells — so parRoute can refuse a reach
 * handed to it that was flooded under different rules instead of routing
 * over a mask that does not mean what it thinks.
 */
export function reachTerrain(field, { spawn, level = 0, controller = CONTROLLER, wet = null, snapCells = SNAP_CELLS } = {}) {
  if (!spawn || spawn.length < 2) throw new Error("reachTerrain: spawn [x, z] is required");
  const { res, size, data } = field;
  const N = res * res;
  const step = size / (res - 1);
  const { walkable, count } = walkableCells(field, { level, controller, wet });
  const reached = new Uint8Array(N);
  const out = {
    res, size, step, walkable, reached,
    walkableCount: count, reachedCount: 0,
    walkableFraction: count / N, reachedFraction: 0,
    spawnCell: -1, snapped: false, snapMetres: 0,
    settings: Object.freeze({
      data, wet, level, snapCells,
      version: controller.version, maxSlope: controller.maxSlope, wadeDepth: controller.wadeDepth,
    }),
  };
  const snap = snapTo(field, spawn[0], spawn[1], snapCells, (p) => walkable[p] === 1);
  if (!snap) return out;
  out.spawnCell = snap.cell;
  out.snapped = snap.snapped;
  out.snapMetres = snap.metres;

  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  reached[snap.cell] = 1;
  queue[tail++] = snap.cell;
  const maxSlope = controller.maxSlope;
  while (head < tail) {
    const p = queue[head++];
    const i = p % res, j = (p - i) / res;
    for (let n = 0; n < 8; n++) {
      const q = stepAllowed(data, walkable, res, p, i, j, n, step, maxSlope);
      if (q < 0 || reached[q]) continue;
      reached[q] = 1;
      queue[tail++] = q;
    }
  }
  out.reachedCount = tail;
  out.reachedFraction = count ? tail / count : 0;
  return out;
}

/**
 * Every region of the walkable ground at once: which cells a body standing on
 * any one of them can walk to, for every cell, without being told a spawn.
 *
 * reachTerrain answers "where can I get to from HERE". A tool that has to
 * PUT the start somewhere — the 2D overworld projection (js/overworld.js),
 * which wants its start and its goal on the largest stretch of ground a
 * player can cross — needs the other question, and asking reachTerrain it
 * from every unlabelled cell costs a walkableCells pass per region, and
 * broken hillsides are most of the regions there are: the default world at
 * 513² has 833, 641 of them a single cell (tests/overworld.test.js floods
 * it). So this floods once, with the
 * same walkable mask and the same step rule (stepAllowed), which is
 * symmetric — both ends walkable, |rise| within the limit, a diagonal past
 * two walkable corners either way — so "reachable from" is an equivalence
 * and the regions are well defined. Flooding reachTerrain from any cell of a
 * region reaches exactly that region (tests/overworld.test.js checks it on
 * the default world).
 *
 * Returns { res, size, walkable, walkableCount, labels, sizes, largest }:
 * labels[p] is the region of cell p (−1 for a cell nobody can stand on),
 * numbered in the order their lowest-index cell is met (row-major), sizes[k]
 * the cells in region k, and largest the region with the most cells (the
 * smaller label on a tie; −1 when nothing is walkable).
 */
export function terrainRegions(field, { level = 0, controller = CONTROLLER, wet = null } = {}) {
  const { res, size, data } = field;
  const N = res * res;
  const step = size / (res - 1);
  const { walkable, count } = walkableCells(field, { level, controller, wet });
  const labels = new Int32Array(N).fill(-1);
  const sizes = [];
  const queue = new Int32Array(N);
  const maxSlope = controller.maxSlope;
  let largest = -1;
  for (let s = 0; s < N; s++) {
    if (!walkable[s] || labels[s] >= 0) continue;
    const k = sizes.length;
    let head = 0, tail = 0;
    labels[s] = k;
    queue[tail++] = s;
    while (head < tail) {
      const p = queue[head++];
      const i = p % res, j = (p - i) / res;
      for (let n = 0; n < 8; n++) {
        const q = stepAllowed(data, walkable, res, p, i, j, n, step, maxSlope);
        if (q < 0 || labels[q] >= 0) continue;
        labels[q] = k;
        queue[tail++] = q;
      }
    }
    sizes.push(tail);
    if (largest < 0 || tail > sizes[largest]) largest = k;
  }
  return { res, size, walkable, walkableCount: count, labels, sizes, largest };
}

/* ── the heap ──
   A binary min-heap of cell indices keyed by (cost, index), with pos[cell]
   the cell's slot so a cheaper arrival moves the existing entry up instead of
   pushing a second one. */
function makeHeap(N, cost) {
  const heap = new Int32Array(N);
  const pos = new Int32Array(N).fill(-1);
  let n = 0;
  const less = (a, b) => cost[a] < cost[b] || (cost[a] === cost[b] && a < b);
  const up = (k) => {
    const c = heap[k];
    while (k > 0) {
      const pk = (k - 1) >> 1, pc = heap[pk];
      if (!less(c, pc)) break;
      heap[k] = pc; pos[pc] = k; k = pk;
    }
    heap[k] = c; pos[c] = k;
  };
  const down = (k) => {
    const c = heap[k];
    for (;;) {
      const l = 2 * k + 1;
      if (l >= n) break;
      const r = l + 1;
      const m = r < n && less(heap[r], heap[l]) ? r : l;
      if (!less(heap[m], c)) break;
      heap[k] = heap[m]; pos[heap[k]] = k; k = m;
    }
    heap[k] = c; pos[c] = k;
  };
  return {
    get size() { return n; },
    // insert, or decrease the key of a cell already queued
    push(c) {
      if (pos[c] >= 0) { up(pos[c]); return; }
      heap[n] = c; pos[c] = n; n++; up(n - 1);
    },
    pop() {
      const top = heap[0];
      pos[top] = -2; // settled
      n--;
      if (n > 0) { heap[0] = heap[n]; pos[heap[0]] = 0; down(0); }
      return top;
    },
    settled: (c) => pos[c] === -2,
  };
}

/* Ramer–Douglas–Peucker on [x, z, y] points, iterative. Keeps index 0 and the
   last index always. */
function decimate(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const ux = B[0] - A[0], uz = B[1] - A[1], uy = B[2] - A[2];
    const uu = ux * ux + uz * uz + uy * uy;
    let worst = -1, worstD = tol2;
    for (let k = a + 1; k < b; k++) {
      const P = pts[k];
      const vx = P[0] - A[0], vz = P[1] - A[1], vy = P[2] - A[2];
      let t = uu > 0 ? (vx * ux + vz * uz + vy * uy) / uu : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = vx - t * ux, dz = vz - t * uz, dy = vy - t * uy;
      const d = dx * dx + dz * dz + dy * dy;
      if (d > worstD) { worstD = d; worst = k; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([worst, b], [a, worst]);
    }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

const SEVERITY = { error: 0, warning: 1, tip: 2 };

/**
 * The quickest walking route from `from` to `to` ([x, z] world metres), and
 * its par.
 *
 * opts: level, controller, wet, snapCells as for reachTerrain; `reach`, a
 * reachTerrain result already computed FROM THIS START on this field with
 * these same options (it is reused rather than recomputed — one from another
 * spawn, another field's data, another level, wet mask, snapCells or
 * controller limits is the caller's error, and is refused with the setting
 * that differs); `tolerance`, the decimation tolerance in metres (default
 * half a cell); `steepGrade` and `longParSeconds`, the warning thresholds
 * (default ROUTE_LIMITS).
 *
 * Returns { verdict, issues, path, distance, climb, descent, parSeconds,
 * maxGrade, cells, start, goal, reach }. With no route, path is [] and the
 * five measures are null. `start` and `goal` are { cell, snapped, snapMetres }
 * (null when nothing was found to snap to); `cells` is the length of the
 * undecimated route in cells.
 */
export function parRoute(field, from, to, opts = {}) {
  const {
    level = 0, controller = CONTROLLER, wet = null, snapCells = SNAP_CELLS,
    tolerance = null, steepGrade = ROUTE_LIMITS.steepGrade, longParSeconds = ROUTE_LIMITS.longParSeconds,
  } = opts;
  if (!from || from.length < 2) throw new Error("parRoute: start [x, z] is required");
  if (!to || to.length < 2) throw new Error("parRoute: objective [x, z] is required");
  const { res, size, data } = field;
  const step = size / (res - 1);
  const reach = opts.reach || reachTerrain(field, { spawn: from, level, controller, wet, snapCells });
  if (opts.reach) {
    const s = reach.settings || {};
    const want = {
      data, wet, level, snapCells,
      version: controller.version, maxSlope: controller.maxSlope, wadeDepth: controller.wadeDepth,
    };
    if (reach.res !== res || reach.size !== size) throw new Error(`parRoute: opts.reach is for a ${reach.res}-cell, ${reach.size} m field; this one is ${res} cells, ${size} m`);
    for (const k of Object.keys(want)) {
      if (s[k] !== want[k]) throw new Error(`parRoute: opts.reach was flooded with a different ${k === "data" ? "field" : k === "wet" ? "wet mask" : k}`);
    }
    const sp = snapTo(field, from[0], from[1], snapCells, (p) => reach.walkable[p] === 1);
    if ((sp ? sp.cell : -1) !== reach.spawnCell) throw new Error("parRoute: opts.reach was flooded from a different start");
  }

  const issues = [];
  // the 2dgen issue shape (builder/core/analyze.js:30 there); `extra` carries
  // a field one issue has and the others do not (steep-leg's segments)
  const add = (id, severity, message, at = null, entityId = null, extra = null) =>
    issues.push(extra ? { id, severity, message, at, entityId, ...extra } : { id, severity, message, at, entityId });
  const pt = (p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`;
  const cellPt = (c) => worldOf(field, c % res, (c - (c % res)) / res);
  const out = {
    verdict: "ok", issues, path: [],
    distance: null, climb: null, descent: null, parSeconds: null, maxGrade: null,
    cells: 0, start: null, goal: null, reach,
  };
  const finish = () => {
    issues.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
    out.verdict = issues.some((x) => x.severity === "error") ? "error"
      : issues.some((x) => x.severity === "warning") ? "warning" : "ok";
    return out;
  };

  if (reach.spawnCell < 0) {
    add("start-unwalkable", "error",
      `No walkable ground within ${snapCells} cells of the start ${pt(from)}: it is in deep water, on a slope steeper than ${controller.maxSlope}, or off the map.`,
      [from[0], from[1]]);
    return finish();
  }
  out.start = { cell: reach.spawnCell, snapped: reach.snapped, snapMetres: reach.snapMetres };

  // The objective goes on the nearest WALKABLE cell, as the start does, and
  // only then is asked whether the start reached it — see the header.
  const goal = snapTo(field, to[0], to[1], snapCells, (p) => reach.walkable[p] === 1);
  const unreachable = (stand) => {
    add("objective-unreachable", "error", stand
      ? `The objective ${pt(to)} stands on walkable ground at ${pt(cellPt(stand.cell))} that the start cannot walk to — across water deeper than ${controller.wadeDepth} m or past slopes steeper than ${controller.maxSlope}.`
      : `The objective ${pt(to)} is not on walkable ground: deep water, a slope steeper than ${controller.maxSlope} or the edge of the map within ${snapCells} cells.`,
      [to[0], to[1]]);
    return finish();
  };
  if (!goal) return unreachable(null);
  if (!reach.reached[goal.cell]) return unreachable(goal);
  out.goal = { cell: goal.cell, snapped: goal.snapped, snapMetres: goal.metres };
  for (const [id, who, s, p] of [
    ["start-snapped", "start", out.start, from], ["objective-snapped", "objective", out.goal, to],
  ]) {
    if (s.snapped) {
      add(id, "warning",
        `The ${who} ${pt(p)} is not on walkable ground; it was put on the nearest walkable cell, ${pt(cellPt(s.cell))}, ${s.snapMetres.toFixed(1)} m away.`,
        [p[0], p[1]]);
    }
  }

  // ── Dijkstra on time ──
  const N = res * res;
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = makeHeap(N, cost);
  const walk = controller.walk;
  const up = controller.climb.flatPerClimb, down = controller.climb.flatPerDescent;
  const maxSlope = controller.maxSlope;
  const src = reach.spawnCell, dst = goal.cell;
  cost[src] = 0;
  heap.push(src);
  while (heap.size) {
    const p = heap.pop();
    if (p === dst) break;
    const i = p % res, j = (p - i) / res;
    const cp = cost[p], hp = data[p];
    for (let n = 0; n < 8; n++) {
      const q = stepAllowed(data, reach.walkable, res, p, i, j, n, step, maxSlope);
      if (q < 0 || !reach.reached[q] || heap.settled(q)) continue;
      const rise = data[q] - hp;
      const flat = NBR[n][2] ? step * SQRT2 : step;
      const c = cp + (flat + (rise > 0 ? up * rise : -down * rise)) / walk;
      if (c < cost[q]) { cost[q] = c; prev[q] = p; heap.push(q); }
    }
  }
  // The flood said dst is reached, so the search always gets there when the
  // reach is this function's own or passed the settings check above. This is
  // for a reach whose masks were edited by hand: an unfinished search is an
  // unreachable objective, never a zero-length route with an infinite par.
  if (!(cost[dst] < Infinity)) {
    out.goal = null;
    return unreachable(goal);
  }

  // ── the full route, measured ──
  const cellsRev = [];
  for (let c = dst; c >= 0; c = prev[c]) { cellsRev.push(c); if (c === src) break; }
  const route = cellsRev.reverse();
  let distance = 0, climb = 0, descent = 0, maxGrade = 0;
  const pts = [];
  for (let k = 0; k < route.length; k++) {
    const p = route[k];
    const i = p % res, j = (p - i) / res;
    const [x, z] = worldOf(field, i, j);
    pts.push([x, z, data[p]]);
    if (k === 0) continue;
    const q = route[k - 1];
    const qi = q % res, qj = (q - qi) / res;
    const run = qi !== i && qj !== j ? step * SQRT2 : step;
    const rise = data[p] - data[q];
    distance += run;
    if (rise > 0) climb += rise; else descent -= rise;
    const g = (rise < 0 ? -rise : rise) / run;
    if (g > maxGrade) maxGrade = g;
  }
  out.cells = route.length;
  out.distance = distance;
  out.climb = climb;
  out.descent = descent;
  out.maxGrade = maxGrade;
  out.parSeconds = cost[dst];
  out.path = decimate(pts, tolerance ?? step / 2);

  // ── the warnings ──
  const segments = [];
  let steepest = 0, steepAt = null;
  for (let k = 1; k < out.path.length; k++) {
    const A = out.path[k - 1], B = out.path[k];
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const h = Math.sqrt(dx * dx + dz * dz);
    if (h < step) continue; // one cell's rise is the field's noise, not a stretch
    const g = Math.abs(B[2] - A[2]) / h;
    if (g > steepGrade) {
      segments.push([k - 1, k]);
      if (g > steepest) { steepest = g; steepAt = [A[0], A[1]]; }
    }
  }
  const steepLegs = segments.length;
  if (steepLegs) {
    add("steep-leg", "warning",
      `${steepLegs} stretch${steepLegs === 1 ? "" : "es"} of the route ${steepLegs === 1 ? "is" : "are"} steeper than ${steepGrade} (the steepest ${steepest.toFixed(2)}, from ${pt(steepAt)}); expect players to slow down or look for another way.`,
      steepAt, null, { segments });
  }
  if (out.parSeconds > longParSeconds) {
    add("long-leg", "warning",
      `Par is ${Math.round(out.parSeconds)} s, over ${longParSeconds} s: ${Math.round(distance)} m with ${Math.round(climb)} m of climb is a long walk for one leg.`);
  }
  return finish();
}
