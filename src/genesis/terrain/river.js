/* A river, solved — not simulated, not painted.
 *
 * Click a headwater and this module answers the only question a river is:
 * WHERE DOES THE WATER GO. Steepest descent on the canonical grid, the same
 * D8 convention the flow-accumulation bake uses (masks.js bakeFlow), with the
 * one honest complication terrain forces: a pit. Real ground has hollows, and
 * water reaching one does not stop — it POOLS to the hollow's spill saddle
 * and continues from there. So the solve is descend → pool → spill → descend,
 * until the course reaches water the sea can already touch (the caller's
 * flood mask) or leaves the plate.
 *
 * What comes back is data, not effect:
 *
 *   path        the decimated centreline, [ [x, z, ySurface] … ] — ySurface
 *               is the STEPPED water height (a cumulative minimum over the
 *               ground, quantised into reaches), which is what a water
 *               surface above sea level needs and the terrain alone cannot
 *               say.
 *   pools       hollows the course flooded on the way: { x, z, level, cells }
 *   reachedSea  whether the mouth is on sea-connected water
 *   strokes     ordinary sculpt strokes ({ x, z, r, amount, mode }) that
 *               carve the channel — because there is no second terrain
 *               system here and there must never be one (js/landform.js).
 *               Replayed through SculptLayer they are undo, save, handoff
 *               and export, all for free.
 *
 * Determinism: the solve is a pure function of (field, wet, spec, seed). The
 * only randomness is the meander, drawn from seeded fbm — same seed, same
 * bends. No Math.random, no clock.
 *
 * Pure JS — no three.js, no DOM. Runs in the suite under JavaScriptCore.
 */

import { fbm } from "../../kernel/terrain/noise.js";

/* Solver bounds. BASIN_CAP is a runaway backstop, far above any real hollow
   on a 513² plate; STEP_CAP likewise for the walk itself (the longest
   possible descent visits each cell at most once). */
const BASIN_CAP = 40000;
const STEP_CAP = 8000;

/* One reach riser. Water heights are quantised into steps at least this tall
   so the surface reads as reaches and riffles rather than a smear. */
const REACH_STEP = 0.4;

const D8 = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
];

/* A tiny binary min-heap over cell indices keyed by height — what the
   pool-and-spill needs and an array sort per step would not survive. */
class MinHeap {
  constructor(key) { this.key = key; this.a = []; }
  get size() { return this.a.length; }
  push(v) {
    const { a, key } = this; a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (key(a[p]) <= key(a[i])) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const { a, key } = this;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && key(a[l]) < key(a[m])) m = l;
        if (r < a.length && key(a[r]) < key(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/** Solve a river from a headwater.
 *
 *  field    { res, size, data } — the canonical baked ground
 *  wet      Uint8Array res² — sea-connected mask (floodFromSea(...).wet), or
 *           null; without it only the plate border ends a course
 *  head     { x, z } world metres
 *  width    channel width in metres (bank to bank)
 *  depth    carve depth in metres at the centreline
 *  meander  0..2 — how far the course wanders where the valley lets it
 *  level    the world's waterline (params.water.level)
 *  seed     the world seed string; the meander draws on its own channel
 */
export function solveRiver({
  field, wet = null, head, width = 14, depth = 3.5, meander = 1, level = 0, seed = 0,
}) {
  const { res, size, data } = field;
  const cell = size / (res - 1);
  const clampI = (v) => Math.min(res - 1, Math.max(0, v));
  const toI = (w) => clampI(Math.round((w / size + 0.5) * (res - 1)));
  const xOf = (i) => (i / (res - 1) - 0.5) * size;

  let ci = toI(head.x), cj = toI(head.z);
  const cells = [];            // [i, j, ySurface] per step, pre-decimation
  const pools = [];
  const inPath = new Uint8Array(res * res);
  let reachedSea = false;
  let ySurf = data[cj * res + ci];

  const seaAt = (i, j) => (wet ? wet[j * res + i] === 1 : false);
  const border = (i, j) => i === 0 || j === 0 || i === res - 1 || j === res - 1;

  for (let step = 0; step < STEP_CAP; step++) {
    const idx = cj * res + ci;
    // The water surface never rises along the course: cumulative minimum.
    ySurf = Math.min(ySurf, data[idx]);
    cells.push([ci, cj, ySurf]);
    inPath[idx] = 1;

    /* Termination is CONNECTIVITY, not altitude: a landlocked hollow below
       the waterline renders as dry ground (water/flood.js), so the course
       must pool through it, not end in it. Only with no wet mask at all does
       "below the waterline" have to stand in for "sea". */
    if (seaAt(ci, cj) || (!wet && data[idx] < level)) { reachedSea = true; break; }
    if (border(ci, cj)) { reachedSea = seaAt(ci, cj) || data[idx] < level; break; }

    // Steepest descent, D8, gradient not raw drop (diagonals span √2 cells).
    let best = -1, bj = 0, bi = 0, bestGrade = 0;
    for (const [dx, dz, dist] of D8) {
      const ni = ci + dx, nj = cj + dz;
      if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
      const nidx = nj * res + ni;
      if (inPath[nidx]) continue;
      const g = (data[idx] - data[nidx]) / dist;
      if (g > bestGrade) { bestGrade = g; best = nidx; bi = ni; bj = nj; }
    }
    if (best >= 0) { ci = bi; cj = bj; continue; }

    /* ── pool and spill ──
       No lower neighbour: this is a pit (or a flat). Priority-flood the
       basin upward, always expanding the LOWEST frontier cell, until one of
       them has a way DOWN that is not in the basin — that cell is the spill
       saddle, the pool stands at its height, and the course resumes on the
       far side. Bounded; deterministic (heights and index order only). */
    const basin = new Set([idx]);
    const heap = new MinHeap((k) => data[k]);
    heap.push(idx);
    let spill = -1, exit = -1;
    while (heap.size && basin.size < BASIN_CAP) {
      const c = heap.pop();
      const cx = c % res, cz = (c / res) | 0;
      for (const [dx, dz] of D8) {
        const ni = cx + dx, nj = cz + dz;
        if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
        const nidx = nj * res + ni;
        if (basin.has(nidx)) continue;
        if (data[nidx] < data[c]) { spill = c; exit = nidx; break; }
        basin.add(nidx); heap.push(nidx);
      }
      if (spill >= 0) break;
    }
    if (spill < 0) { reachedSea = false; break; }   // a basin the size cap ended: a lake
    const poolLevel = data[spill];
    pools.push({
      x: xOf(ci), z: xOf(cj), level: poolLevel, cells: basin.size,
    });
    // The pool IS the water surface across the hollow — not below it.
    ySurf = Math.min(ySurf, poolLevel);
    ci = exit % res; cj = (exit / res) | 0;
  }

  const path = shapePath(cells, { size, res, cell, width, meander, seed });
  const strokes = strokesFor(path, { width, depth, level, reachedSea, cell });
  return { path, pools, reachedSea, strokes };
}

/* ── the centreline ──
   Cells → world polyline: smoothed (three-point average, twice), decimated
   to ~0.35·width spacing, then meandered — a perpendicular seeded-fbm offset
   whose amplitude follows the inverse of the local grade, so flat valleys
   wander and gorges do not. Water heights ride along and stay monotone;
   afterwards they are quantised into REACH_STEP risers. */
function shapePath(cells, { size, res, cell, width, meander, seed }) {
  if (!cells.length) return [];
  const xOf = (i) => (i / (res - 1) - 0.5) * size;
  let pts = cells.map(([i, j, y]) => [xOf(i), xOf(j), y]);

  for (let pass = 0; pass < 2; pass++) {
    const sm = pts.map((p, k) => {
      if (k === 0 || k === pts.length - 1) return p.slice();
      return [
        (pts[k - 1][0] + p[0] + pts[k + 1][0]) / 3,
        (pts[k - 1][1] + p[1] + pts[k + 1][1]) / 3,
        p[2],
      ];
    });
    pts = sm;
  }

  // Decimate by arc length.
  const spacing = Math.max(cell * 0.75, width * 0.35);
  const out = [pts[0]];
  let acc = 0;
  for (let k = 1; k < pts.length; k++) {
    acc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (acc >= spacing || k === pts.length - 1) { out.push(pts[k]); acc = 0; }
  }

  // Meander. Seeded, deterministic; the head and mouth stay pinned.
  const sk = typeof seed === "string"
    ? [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) : (seed >>> 0);
  let arc = 0;
  for (let k = 1; k < out.length - 1; k++) {
    const [px, pz] = out[k - 1], [nx, nz] = out[k + 1];
    const tx = nx - px, tz = nz - pz;
    const len = Math.hypot(tx, tz) || 1;
    arc += len * 0.5;
    // Local grade from the water heights the walk already measured.
    const grade = Math.abs(out[k - 1][2] - out[k + 1][2]) / len;
    const amp = meander * width * 0.9 / (1 + grade * 14);
    const w = (fbm(arc / (width * 6), 0.37, sk, 3) - 0.5) * 2;
    out[k] = [out[k][0] + (-tz / len) * amp * w, out[k][1] + (tx / len) * amp * w, out[k][2]];
  }

  // Monotone then stepped: a river's surface never climbs, and it reads as
  // reaches and riffles rather than a ramp.
  for (let k = 1; k < out.length; k++) out[k][2] = Math.min(out[k][2], out[k - 1][2]);
  let tread = out[0][2];
  for (let k = 0; k < out.length; k++) {
    if (tread - out[k][2] >= REACH_STEP) tread = out[k][2];
    out[k][2] = tread;
  }

  // Rounded like sculpt strokes are, for the same transport reason.
  return out.map(([x, z, y]) => [r2(x), r2(z), r2(y)]);
}

const r2 = (v) => Math.round(v * 100) / 100;

/* ── the carve ──
   Ordinary sculpt strokes: `lower` dabs along the centreline with a radius
   wider than the water so the banks shoulder in, then a `smooth` pass along
   the bed. Overlap is exact arithmetic: the per-dab amount divides the
   requested depth by the summed falloff of an infinite line of dabs at this
   spacing, so the carved centre depth is `depth` wherever the line is
   locally straight. Near the mouth the bed is forced below the waterline so
   the sea actually connects. */
export function strokesFor(path, { width = 14, depth = 3.5, level = 0, reachedSea = true, cell = 0 } = {}) {
  if (path.length < 2) return [];
  /* The dab radius follows the requested width — but never drops below what
     the flood can RESOLVE. floodFromSea is 4-connected while the course
     walks D8, so a carved corridor one cell wide connected only diagonally
     would never flood: the channel has to span at least a couple of grid
     cells wherever the caller told us the grid's cell size. */
  const radius = Math.max(width * 1.4, cell * 2.2);
  const spacing = Math.max(2, width * 0.35);

  // Σ falloff(k·spacing / radius) over the dab line, k ∈ ℤ.
  let overlap = 0;
  for (let k = Math.ceil(-radius / spacing); k * spacing < radius; k++) {
    const t = 1 - Math.abs(k * spacing) / radius;
    if (t > 0) overlap += t * t * (3 - 2 * t);
  }
  const amount = depth / Math.max(overlap, 1);

  const strokes = [];
  let acc = 0;
  const push = (x, z, extra = 0) =>
    strokes.push({ x: r2(x), z: r2(z), r: r2(radius), amount: r2(amount + extra), mode: "lower" });

  push(path[0][0], path[0][1]);
  for (let k = 1; k < path.length; k++) {
    const [ax, az] = path[k - 1], [bx, bz] = path[k];
    const seg = Math.hypot(bx - ax, bz - az);
    acc += seg;
    while (acc >= spacing) {
      const t = 1 - (acc - spacing) / seg;
      acc -= spacing;
      push(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  }

  /* The mouth: the tidal stretch must sit BELOW the waterline or the flood
     stops one cell short of the channel it was promised. Along a descending
     course the stepped water height IS the ground height there, so for every
     point low enough that the main carve alone leaves its bed above the
     target, one extra dab makes up exactly the difference (its peak
     contribution is its amount). Overlap between neighbours only deepens
     the mouth further, which a mouth can take. */
  if (reachedSea) {
    const targetBed = level - Math.max(1.5, depth * 0.3);
    for (const [x, z, y] of path) {
      if (y > level + depth * 1.5) continue;         // above the tidal stretch
      const extra = (y - depth) - targetBed;         // main line leaves y − depth
      if (extra <= 0) continue;
      strokes.push({ x, z, r: r2(radius), amount: r2(extra), mode: "lower" });
    }
  }

  // One smoothing pass along the bed, sparse — settles dab ridges without
  // erasing the channel.
  for (let k = 0; k < path.length; k += Math.max(2, Math.round((width * 2) / spacing))) {
    strokes.push({ x: path[k][0], z: path[k][1], r: r2(radius * 1.5), amount: 4, mode: "smooth" });
  }
  return strokes;
}
