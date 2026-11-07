/**
 * WORLD TERRAIN: the relief and the water of an open Arcade level, grown from the same seeded fields as the
 * village (world/worldGrammar.js) and shaped by what the village decided. No AI, no network: the rules in
 * the pack (`world.terrain`), a few noise fields and one least-cost path.
 *
 * One height grid (1 m cells over the meadow) is shaped in the order a builder would:
 *
 *   1. relief     hills from their own fbm, ramped up toward the rim and flattened where the village is, plus
 *                 a low swell everywhere, so the core stays flat and the rim rolls; or, for a level that stands
 *                 on its seed's Visigenesis world, that world's ground at the site, handed in as data
 *                 (world/kernelGround.js: the kernel has already bent it to the mission);
 *   2. lanes      each lane gets its own profile: sampled along the lane, anchored at the square (the spine)
 *                 or at the spine crossing (a cross lane), then grade-limited both ways; the ground within the
 *                 lane and its shoulder takes the profile and a bank blends back to the hill, so a lane cuts
 *                 through a rise at an easy grade;
 *   3. spurs      a straight ramp from each reserved place's pad to its lane;
 *   4. water      (planned) ponds at the moisture peaks outside the core, each a wobbled 64-gon; a brook from
 *                 a spring in the rim hills to a stone pool at the square's edge, the least-cost path over the
 *                 grid (downhill, around the pads and ponds, meandering on a noise field, crossing a lane at
 *                 right angles where it must: a footbridge stands there);
 *   5. lots       house lots (chosen by the village, refused where the ground under them spans too much) are
 *                 levelled to their mean height with a skirt; their walks ramp to the lane;
 *   6. pads       every reserved place and the square are levelled last, so they win;
 *   7. carve      each pond on its own terrace with a shallow shelf and a deep centre, the brook's channel
 *                 whose surface only ever descends toward the pool, and the pool itself.
 *
 * The result is plain data: the height grid and a water-depth grid (the engine's Terrain reads both: the
 * player and the enemies stand on the heights, the nav grid refuses deep water and steep banks), the ponds,
 * the brook with its bridges, fords and bank stones, lily pads, and the pool. Everything the village places
 * afterwards takes its height from the finished grid.
 *
 * PARITY RULES (as worldGrammar.js): no trigonometry (directions from DIRS64); numbers leave through r4; every
 * loop counts integers; ties break on the lower index. tools/blender/v2/arcade/world_terrain.py is the port.
 */
import { hashSeed } from '../kernel/seed.js';
import { clamp01, DIRS64 } from './grammarCore.js';
import { r4, sq, layoutStream, hash3, vnoise, fbm, gridHash, polyAt, polyLength } from './layoutCore.js';

const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const stream = (seed, name) => layoutStream(seed, 'world', name);
const SQ2 = 1.4142135623730951, INV2 = 0.7071067811865476;

// ---------------------------------------------------------------- noise (shared with the village)

// The lattice hash, value noise, fbm and the grid fingerprint are theme-neutral (world/layoutCore.js).
export { hash3, vnoise, fbm, gridHash };

// ---------------------------------------------------------------- polylines

/** The nearest point of a polyline to (x, z): its distance `d`, the segment's end index `i` and the parameter `t`. */
export function polyProject(x, z, pts) {
  let d = Infinity, bi = 1, bt = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const e = Math.sqrt(sq(x - a[0] - dx * t) + sq(z - a[1] - dz * t));
    if (e < d) { d = e; bi = i; bt = t; }
  }
  return { d, i: bi, t: bt };
}
/** A per-point value (a profile, a water surface) at a projection. */
const along = (vals, p) => vals[p.i - 1] + (vals[p.i] - vals[p.i - 1]) * p.t;
const dist = (a, b) => Math.sqrt(sq(b[0] - a[0]) + sq(b[1] - a[1]));
/** The DIRS64 direction closest to (dx, dz): a pond's shoreline radius is read along it. */
export function kNear(dx, dz) {
  let best = 0, bv = -Infinity;
  for (let k = 0; k < 64; k++) { const v = dx * DIRS64[k][0] + dz * DIRS64[k][1]; if (v > bv) { bv = v; best = k; } }
  return best;
}

// ---------------------------------------------------------------- the height grid

/** Heights on the vertices of a square grid centred on the origin; bilinear between them, as the engine's sampler. */
export class HeightGrid {
  constructor(size, cell) {
    this.size = size; this.cell = cell; this.res = Math.floor(size / cell + 0.5) + 1;
    this.h = new Float64Array(this.res * this.res);
  }
  coord(i) { return -this.size / 2 + i * this.cell; }
  /** The same bilinear lookup as the kernel's src/kernel/terrain/heightfield.js createBakedSampler. */
  sample(x, z) {
    const res = this.res, scale = (res - 1) / this.size, data = this.h;
    let fx = (x + this.size / 2) * scale, fz = (z + this.size / 2) * scale;
    fx = Math.min(Math.max(fx, 0), res - 1.001);
    fz = Math.min(Math.max(fz, 0), res - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = data[iz * res + ix], b = data[iz * res + ix + 1], c = data[(iz + 1) * res + ix], d = data[(iz + 1) * res + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }
  /** Central-difference slope (metres per metre) over one cell either side. */
  slope(x, z) {
    const e = this.cell, dx = this.sample(x + e, z) - this.sample(x - e, z), dz = this.sample(x, z + e) - this.sample(x, z - e);
    return Math.sqrt(dx * dx + dz * dz) / (2 * e);
  }
  /** Lowest ground under a footprint of radius r: a trunk or a rock sits on it without floating downhill. */
  low(x, z, r) {
    return Math.min(this.sample(x, z), this.sample(x + r, z), this.sample(x - r, z), this.sample(x, z + r), this.sample(x, z - r));
  }
  /**
   * Blend the vertices inside a box toward targets: fn(x, z, h) returns null (untouched) or [target, weight].
   * Rows then columns, so both ports visit the vertices in the same order.
   */
  blend(x0, x1, z0, z1, fn) {
    const res = this.res, c = this.cell, half = this.size / 2;
    const i0 = Math.max(0, Math.ceil((x0 + half) / c)), i1 = Math.min(res - 1, Math.floor((x1 + half) / c));
    const j0 = Math.max(0, Math.ceil((z0 + half) / c)), j1 = Math.min(res - 1, Math.floor((z1 + half) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const at = j * res + i, h = this.h[at], r = fn(this.coord(i), this.coord(j), h, at);
      if (r) this.h[at] = h + (r[0] - h) * r[1];
    }
  }
}

const bbox = (pts, pad) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  return [x0 - pad, x1 + pad, z0 - pad, z1 + pad];
};

/** A corridor along a polyline: flat to its profile within `flat`, blended back over `blend`. */
function corridor(g, pts, hs, flat, blend) {
  const [x0, x1, z0, z1] = bbox(pts, flat + blend);
  g.blend(x0, x1, z0, z1, (x, z) => {
    const p = polyProject(x, z, pts);
    if (p.d >= flat + blend) return null;
    return [along(hs, p), p.d <= flat ? 1 : 1 - smooth((p.d - flat) / blend)];
  });
}
/** A level disc: flat within r, blended over `blend`. */
export function disc(g, x, z, r, blend, target) {
  g.blend(x - r - blend, x + r + blend, z - r - blend, z + r + blend, (vx, vz) => {
    const d = Math.sqrt(sq(vx - x) + sq(vz - z));
    if (d >= r + blend) return null;
    return [target, d <= r ? 1 : 1 - smooth((d - r) / blend)];
  });
}
/** A level rectangle: flat within `flat` of the rect, blended over `blend`. */
export function slab(g, R, flat, blend, target) {
  g.blend(R.x0 - flat - blend, R.x1 + flat + blend, R.z0 - flat - blend, R.z1 + flat + blend, (x, z) => {
    const dx = Math.max(R.x0 - x, 0, x - R.x1), dz = Math.max(R.z0 - z, 0, z - R.z1), d = Math.sqrt(dx * dx + dz * dz);
    if (d >= flat + blend) return null;
    return [target, d <= flat ? 1 : 1 - smooth((d - flat) / blend)];
  });
}

// ---------------------------------------------------------------- 1. relief

/** The hills of one seed: rim-ramped fbm flattened by village-ness, plus a low swell. */
export function reliefField(rules, seed, fields) {
  const R = rules.terrain.relief, sr = hashSeed(`${seed}:world:relief`), ss = hashSeed(`${seed}:world:swell`);
  return (x, z) => {
    const e = R.edge, rim = smooth((Math.max(Math.abs(x), Math.abs(z)) - e[0]) / (e[1] - e[0]));
    const amp = R.height * rim * (1 - R.core * fields.village(x, z));
    return amp * (R.base + (1 - R.base) * fbm(x, z, sr, R)) + R.swell * (2 * vnoise(x / R.swellScale, z / R.swellScale, ss) - 1);
  };
}

/**
 * The grid, with its relief: the village's own hills (reliefField), or `given` — heights handed in on this very
 * grid ({res, heights}, row-major, r4), which is how a level stands on its seed's Visigenesis world
 * (world/kernelGround.js). Everything after step 1 shapes either alike, and so does the Python port, which reads
 * the same numbers.
 */
export function makeGround(rules, seed, fields, given = null) {
  const T = rules.terrain, g = new HeightGrid(rules.size, T.grid);
  if (given) {
    if (given.res !== g.res || given.heights?.length !== g.res * g.res) throw new Error(`makeGround: the given relief is ${given.res}² (${given.heights?.length} heights); this grid is ${g.res}²`);
    for (let i = 0; i < g.h.length; i++) g.h[i] = given.heights[i];
    return g;
  }
  const relief = reliefField(rules, seed, fields);
  for (let j = 0; j < g.res; j++) for (let i = 0; i < g.res; i++) g.h[j * g.res + i] = relief(g.coord(i), g.coord(j));
  return g;
}

// ---------------------------------------------------------------- 2. lanes and 3. spurs

/** A grade-limited profile anchored at one point: clamped forward from the anchor, then backward. */
function profile(raw, pts, anchor, h0, grade) {
  const n = pts.length, h = raw.slice();
  h[anchor] = h0;
  for (let i = anchor + 1; i < n; i++) { const d = dist(pts[i - 1], pts[i]) * grade; h[i] = Math.min(Math.max(h[i], h[i - 1] - d), h[i - 1] + d); }
  for (let i = anchor - 1; i >= 0; i--) { const d = dist(pts[i + 1], pts[i]) * grade; h[i] = Math.min(Math.max(h[i], h[i + 1] - d), h[i + 1] + d); }
  return h.map(r4);
}
function sampled(g, pts) {
  const raw = pts.map(p => g.sample(p[0], p[1])), n = raw.length;
  return raw.map((v, i) => (i === 0 || i === n - 1 ? v : (raw[i - 1] + 2 * v + raw[i + 1]) / 4));
}

/** Give every lane its `h` profile (the spine anchored at the square, cross lanes at the spine) and cut it in. */
export function gradeLanes(rules, g, lanes, square) {
  const T = rules.terrain, P = rules.paths, L = T.lanes, spine = lanes[0];
  const hs = r4(g.sample(square.x, square.z));
  let anchor = 0, bd = Infinity;
  for (let i = 0; i < spine.pts.length; i++) { const d = dist(spine.pts[i], [square.x, square.z]); if (d < bd) { bd = d; anchor = i; } }
  spine.h = profile(sampled(g, spine.pts), spine.pts, anchor, hs, L.grade);
  for (const lane of lanes.slice(1)) {
    let a = 0, ad = Infinity;
    for (let i = 0; i < lane.pts.length; i++) { const d = polyProject(lane.pts[i][0], lane.pts[i][1], spine.pts).d; if (d < ad) { ad = d; a = i; } }
    const at = polyProject(lane.pts[a][0], lane.pts[a][1], spine.pts);
    lane.h = profile(sampled(g, lane.pts), lane.pts, a, r4(along(spine.h, at)), L.grade);
  }
  for (const lane of lanes) corridor(g, lane.pts, lane.h, lane.w / 2 + P.verge + L.shoulder, L.bank);
  return hs;
}

/**
 * Pads for the places a player stands at (the spawn, every site, every place with a spur) and the square, read once
 * the lanes are cut: each levels the inner part of its clearance (`pads.flat` of its radius; the ring beyond is
 * for solids to keep off). Pads that would overlap share one height, their cluster's mean, so two neighbouring
 * places never fight over the ground between them. Cover needs no pad: it sits on the ground like a rock.
 */
export function padTargets(rules, g, reserved, square, hs) {
  const D = rules.terrain.pads;
  const pads = reserved.filter(c => c.id === 'spawn' || c.id === 'site' || c.spur).map(c => ({ x: c.x, z: c.z, r: r4(c.r * D.flat), h: r4(g.sample(c.x, c.z)) }));
  pads.push({ x: square.x, z: square.z, r: square.r + rules.paths.verge, h: hs });
  const n = pads.length, root = pads.map((_, i) => i);
  const find = i => { while (root[i] !== i) i = root[i]; return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.sqrt(sq(pads[i].x - pads[j].x) + sq(pads[i].z - pads[j].z)) >= pads[i].r + pads[j].r + 2 * D.blend) continue;
    const a = find(i), b = find(j);
    if (a !== b) root[Math.max(a, b)] = Math.min(a, b);
  }
  const sum = new Array(n).fill(0), count = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { const a = find(i); sum[a] += pads[i].h; count[a]++; }
  return pads.map((p, i) => { const a = find(i); return { ...p, h: r4(sum[a] / count[a]) }; });
}
/** A pad added after the others (the square's pool): it takes the height of the first pad it would overlap. */
export function joinPad(rules, pads, p) {
  const D = rules.terrain.pads;
  for (const q of pads) if (Math.sqrt(sq(p.x - q.x) + sq(p.z - q.z)) < p.r + q.r + 2 * D.blend) { p.h = q.h; break; }
  pads.push(p);
  return p;
}
export function rampSpurs(rules, g, spurs) {
  const S = rules.terrain.spurs, ends = spurs.map(s => [r4(g.sample(s.pts[0][0], s.pts[0][1])), r4(g.sample(s.pts[1][0], s.pts[1][1]))]);
  spurs.forEach((s, i) => corridor(g, s.pts, ends[i], s.w / 2 + S.flat, S.blend));
}

// ---------------------------------------------------------------- 4. water, planned

/** A pond's shoreline radius along direction k (a 64-gon wobbled by noise sampled on a circle, so it closes). */
function shoreRadii(W, r, seed, index) {
  const ws = hashSeed(`${seed}:world:pond${index}`), out = [];
  for (let k = 0; k < 64; k++) {
    const d = DIRS64[k];
    out.push(r4(r * (1 + W.wobble * (2 * vnoise(d[0] * W.wobbleScale + 7.1, d[1] * W.wobbleScale + 3.3, ws) - 1))));
  }
  return out;
}

export function planPonds(rules, seed, fields, mask) {
  const W = rules.terrain.ponds, bound = rules.size / 2 - rules.margin, out = [], cands = [];
  const n = Math.floor(bound);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -bound + i * 2, z = -bound + j * 2;
    if (x > bound || z > bound) continue;
    if (fields.village(x, z) > W.village) continue;
    cands.push({ x, z, m: fields.moisture(x, z), idx: cands.length });
  }
  cands.sort((a, b) => b.m - a.m || a.idx - b.idx);
  for (const c of cands) {
    if (out.length >= W.max) break;
    if (c.m < (out.length < W.min ? W.moistMin : W.moist)) break;
    const r = r4(W.r[0] + (W.r[1] - W.r[0]) * clamp01((c.m - W.moistMin) / (1 - W.moistMin)));
    const reach = r * (1 + W.wobble);
    if (Math.abs(c.x) > bound - reach - 1 || Math.abs(c.z) > bound - reach - 1) continue;
    if (mask.blocked(c.x, c.z, reach + W.clear, { lots: true, zones: false, spurs: true })) continue;
    if (out.some(p => Math.sqrt(sq(p.x - c.x) + sq(p.z - c.z)) < p.reach + reach + W.apart)) continue;
    const radii = shoreRadii(W, r, seed, out.length);
    out.push({ index: out.length, x: r4(c.x), z: r4(c.z), r, radii, reach: r4(Math.max(...radii)), m: r4(c.m) });
  }
  return out;
}

/**
 * Where the square's pool stands: on the first diagonal (from a seeded start) where it fits, sliding outward.
 * The pool is waded like the brook (a low rim, shallow water), so like the brook it may stand inside a reserved
 * place's clearance ring, never on its pad; it keeps off the lanes, the spurs and the square.
 */
function placeBasin(rules, rng, square, mask, lots) {
  const T = rules.terrain, Bs = T.basin, B = T.brook, P = rules.paths, diags = [[INV2, INV2], [-INV2, INV2], [-INV2, -INV2], [INV2, -INV2]];
  const start = Math.floor(rng() * 4) % 4;
  const free = (x, z) => {
    for (const c of mask.reserved) if (sq(x - c.x) + sq(z - c.z) < sq(c.r * B.reserve + Bs.r)) return false;
    for (const l of mask.lanes) if (polyProject(x, z, l.pts).d < l.w / 2 + P.verge + Bs.r) return false;
    for (const s of mask.spurs) if (polyProject(x, z, s.pts).d < s.w / 2 + Bs.r) return false;
    for (const L of lots) if (x > L.rect.x0 - Bs.r - 1 && x < L.rect.x1 + Bs.r + 1 && z > L.rect.z0 - Bs.r - 1 && z < L.rect.z1 + Bs.r + 1) return false;
    return true;
  };
  for (let q = 0; q < 4; q++) {
    const d = diags[(start + q) % 4];
    for (let s = 0; s <= 8; s++) {
      const far = square.r + P.verge + Bs.r + Bs.gap + s * 0.5, x = r4(square.x + d[0] * far), z = r4(square.z + d[1] * far);
      if (free(x, z)) return { x, z, r: Bs.r, part: Bs.part, q: (start + q) % 4 };
    }
  }
  return null;
}

/** A small binary heap of (cost, index), popped in lexicographic order: the Python port uses heapq on the same tuples. */
class Heap {
  constructor() { this.d = []; this.i = []; }
  get size() { return this.d.length; }
  less(a, b) { return this.d[a] < this.d[b] || (this.d[a] === this.d[b] && this.i[a] < this.i[b]); }
  swap(a, b) { [this.d[a], this.d[b]] = [this.d[b], this.d[a]]; [this.i[a], this.i[b]] = [this.i[b], this.i[a]]; }
  push(d, i) {
    this.d.push(d); this.i.push(i);
    let c = this.d.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (!this.less(c, p)) break; this.swap(c, p); c = p; }
  }
  pop() {
    const d = this.d[0], i = this.i[0], ld = this.d.pop(), li = this.i.pop();
    if (this.d.length) {
      this.d[0] = ld; this.i[0] = li;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < this.d.length && this.less(l, m)) m = l;
        if (r < this.d.length && this.less(r, m)) m = r;
        if (m === c) break;
        this.swap(c, m); c = m;
      }
    }
    return [d, i];
  }
}
const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQ2], [-1, 1, SQ2], [1, -1, SQ2], [-1, -1, SQ2]];

/** The brook: a spring in the rim hills, the least-cost path over the grid to the square's pool, bridges where it crosses a lane. */
export function planBrook(rules, seed, fields, mask, g, lanes, spurs, square, ponds, lots) {
  const T = rules.terrain, B = T.brook, W = T.ponds, P = rules.paths, rng = stream(seed, 'brook');
  // A world without a brook (the desert: its water is the oasis) has none, and no pool at the square either.
  if (!B) return null;
  const bound = rules.size / 2 - rules.margin;
  const basin = placeBasin(rules, rng, square, mask, lots);
  if (!basin) return null;
  // The spring: the best-scoring point on rings around the square (high, wet, a little luck), far enough from the pool
  // and standing at least `fall` over it, because a brook runs down: on ground that rises toward the square (a
  // world's, world/kernelGround.js) a spring below the pool would only carve a level trench to it. With no such
  // point there is no brook, and the pool is not built either.
  const sj = hashSeed(`${seed}:world:spring`), poolH = g.sample(basin.x, basin.z);
  let src = null, best = -Infinity;
  const rings = Math.floor((B.from[1] - B.from[0]) / 2 + 0.5);
  for (let ri = 0; ri <= rings; ri++) for (let k = 0; k < 64; k++) {
    const rad = B.from[0] + ri * 2, d = DIRS64[k], x = r4(square.x + d[0] * rad), z = r4(square.z + d[1] * rad);
    if (Math.abs(x) > bound - 2 || Math.abs(z) > bound - 2) continue;
    if (mask.blocked(x, z, B.w / 2 + B.bank + 1, { lots: true, zones: false, spurs: true })) continue;
    if (sq(x - basin.x) + sq(z - basin.z) < sq(B.minLen)) continue;
    if (g.sample(x, z) - poolH < B.fall) continue;
    // High and wet springs score, with a little luck.
    const score = g.sample(x, z) + B.wet * fields.moisture(x, z) + B.jitter * hash3(k, ri, sj);
    if (score > best) { best = score; src = { x, z }; }
  }
  if (!src) return null;
  // Costs on the grid's vertices: impassable near pads, the square and the ponds; dearer across lanes and spurs.
  const res = g.res, N = res * res, blocked = new Uint8Array(N), pen = new Float64Array(N), fac = new Float64Array(N);
  const sm = hashSeed(`${seed}:world:meander`);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const at = j * res + i, x = g.coord(i), z = g.coord(j);
    fac[at] = 1 + B.meander * vnoise(x / B.meanderScale, z / B.meanderScale, sm);
    let no = Math.abs(x) > bound - 1 || Math.abs(z) > bound - 1;
    if (!no) for (const c of mask.reserved) if (sq(x - c.x) + sq(z - c.z) < sq(c.r * B.reserve + B.w / 2 + B.bank * 0.5)) { no = true; break; }
    if (!no && sq(x - square.x) + sq(z - square.z) < sq(square.r + P.verge + B.w / 2)) no = true;
    // Around every lot, its fence line included: the channel and its bank never reach the yard.
    if (!no) for (const L of lots) { const m = B.w / 2 + B.bank + B.yard; if (x > L.rect.x0 - m && x < L.rect.x1 + m && z > L.rect.z0 - m && z < L.rect.z1 + m) { no = true; break; } }
    if (!no) for (const p of ponds) { const d = Math.sqrt(sq(x - p.x) + sq(z - p.z)); if (d < p.reach + W.terrace + W.blend + B.w / 2 && d < p.radii[kNear(x - p.x, z - p.z)] + W.terrace + W.blend + B.w / 2) { no = true; break; } }
    blocked[at] = no ? 1 : 0;
    if (no) continue;
    // Dearer across a lane (it crosses at a footbridge) and across a spur (at a ford).
    for (const l of lanes) if (polyProject(x, z, l.pts).d < l.w / 2 + P.verge + B.w / 2) pen[at] += B.lane;
    for (const s of spurs) if (polyProject(x, z, s.pts).d < s.w / 2 + B.w / 2) pen[at] += B.spur;
  }
  const node = (x, z) => Math.floor((z + g.size / 2) / g.cell + 0.5) * res + Math.floor((x + g.size / 2) / g.cell + 0.5);
  const from = node(src.x, src.z), to = node(basin.x, basin.z);
  blocked[from] = blocked[to] = 0;
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N), heap = new Heap();
  cost[from] = 0; heap.push(0, from);
  while (heap.size) {
    const [d, c] = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === to) break;
    const ci = c % res, cj = (c - ci) / res;
    for (const [di, dj, len] of STEPS) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
      const n = nj * res + ni;
      if (blocked[n] || done[n]) continue;
      const nd = d + len * g.cell * (fac[c] + fac[n]) * 0.5 + B.up * Math.max(0, g.h[n] - g.h[c]) + pen[n];
      if (nd < cost[n]) { cost[n] = nd; prev[n] = c; heap.push(nd, n); }
    }
  }
  if (!done[to]) return null;
  const path = [];
  for (let c = to; c >= 0; c = prev[c]) { const i = c % res; path.push([g.coord(i), g.coord((c - i) / res)]); }
  path.reverse();
  path.push([basin.x, basin.z]);
  // Soften the grid's staircase (the spring and the pool stay put), then square every lane crossing up.
  let pts = path;
  for (let pass = 0; pass < 2; pass++) pts = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p : [(pts[i - 1][0] + 2 * p[0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * p[1] + pts[i + 1][1]) / 4]));
  pts = pts.map(p => [r4(p[0]), r4(p[1])]);
  const bridges = [];
  for (const l of lanes) {
    const reach = l.w / 2 + P.verge + B.cross;
    let a = -1, b = -1;
    for (let i = 0; i < pts.length; i++) {
      const near = polyProject(pts[i][0], pts[i][1], l.pts).d < reach + 0.5;
      if (near && a < 0) a = i;
      if (near) b = i;
      else if (a >= 0) break;
    }
    if (a < 0 || a === 0 || b === pts.length - 1) continue;
    const mid = pts[Math.floor((a + b) / 2)], pr = polyProject(mid[0], mid[1], l.pts), s0 = l.pts[pr.i - 1], s1 = l.pts[pr.i];
    const sl = dist(s0, s1), tx = (s1[0] - s0[0]) / sl, tz = (s1[1] - s0[1]) / sl;
    const cx = s0[0] + (s1[0] - s0[0]) * pr.t, cz = s0[1] + (s1[1] - s0[1]) * pr.t;
    let nx = -tz, nz = tx;
    if ((pts[b + 1][0] - pts[a - 1][0]) * nx + (pts[b + 1][1] - pts[a - 1][1]) * nz < 0) { nx = -nx; nz = -nz; }
    // Square across the lane; the water runs to the plug's edge (where the lane keeps its ground under the deck).
    const edge = l.w / 2 + P.verge * 0.6;
    const cross = [[r4(cx - nx * reach), r4(cz - nz * reach)], [r4(cx - nx * edge), r4(cz - nz * edge)], [r4(cx), r4(cz)],
      [r4(cx + nx * edge), r4(cz + nz * edge)], [r4(cx + nx * reach), r4(cz + nz * reach)]];
    pts = [...pts.slice(0, a), ...cross, ...pts.slice(b + 1)];
    bridges.push({ lane: l.id, x: r4(cx), z: r4(cz), front: [r4(tx), r4(tz)], reach: r4(reach), at: a + 2 });
  }
  // Later crossings shift the indices of earlier ones: find each bridge's point again.
  for (const br of bridges) for (let i = 0; i < pts.length; i++) if (pts[i][0] === br.x && pts[i][1] === br.z) { br.at = i; break; }
  return { pts, w: B.w, depth: B.depth, source: [pts[0][0], pts[0][1]], basin, bridges };
}

/** Distance from (x, z) to the nearest water edge (ponds, brook, pool), with the point it is measured toward. */
export function waterEdge(water, x, z) {
  let best = Infinity, tx = x, tz = z;
  for (const p of water.ponds) {
    const d = Math.sqrt(sq(x - p.x) + sq(z - p.z)), e = d - p.radii[kNear(x - p.x, z - p.z)];
    if (e < best) { best = e; tx = p.x; tz = p.z; }
  }
  const B = water.brook;
  if (B) {
    const pr = polyProject(x, z, B.pts), e = pr.d - B.w / 2;
    if (e < best) { const a = B.pts[pr.i - 1], b = B.pts[pr.i]; best = e; tx = a[0] + (b[0] - a[0]) * pr.t; tz = a[1] + (b[1] - a[1]) * pr.t; }
    const bs = B.basin, eb = Math.sqrt(sq(x - bs.x) + sq(z - bs.z)) - bs.r;
    if (eb < best) { best = eb; tx = bs.x; tz = bs.z; }
  }
  return { e: best, x: tx, z: tz };
}

/** True when the water keeps (x, z) with a footprint of `pad` away; `wet` classes (reeds) may stand in the shallows. */
export function waterBlocks(rules, water, x, z, pad, wet) {
  const W = rules.terrain.ponds;
  for (const p of water.ponds) {
    const d = Math.sqrt(sq(x - p.x) + sq(z - p.z));
    if (d - p.reach > W.terrace + pad) continue;
    if (d < p.radii[kNear(x - p.x, z - p.z)] + (wet ? -W.wetIn : W.terrace * 0.5) + pad) return true;
  }
  const B = water.brook;
  if (B) {
    if (polyProject(x, z, B.pts).d < B.w / 2 + (wet ? 0 : rules.terrain.brook.bank) + pad) return true;
    if (sq(x - B.basin.x) + sq(z - B.basin.z) < sq(B.basin.r + pad + (wet ? 0 : 0.3))) return true;
  }
  return false;
}

/** A lot's rectangle against the water: its edges (sampled as the lanes are) and the brook's two ends. */
export function waterRect(rules, water, R, margin) {
  const W = rules.terrain.ponds, B = water.brook;
  for (const p of water.ponds) {
    const nx = Math.max(R.x0, Math.min(p.x, R.x1)), nz = Math.max(R.z0, Math.min(p.z, R.z1));
    if (sq(nx - p.x) + sq(nz - p.z) < sq(p.reach + W.clear + margin)) return true;
  }
  if (!B) return false;
  const bank = rules.terrain.brook.bank;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8, edge = [[R.x0 + (R.x1 - R.x0) * t, R.z0], [R.x0 + (R.x1 - R.x0) * t, R.z1], [R.x0, R.z0 + (R.z1 - R.z0) * t], [R.x1, R.z0 + (R.z1 - R.z0) * t]];
    for (const [ex, ez] of edge) if (polyProject(ex, ez, B.pts).d < B.w / 2 + bank + margin) return true;
  }
  for (const e of [B.pts[0], B.pts[B.pts.length - 1]]) if (e[0] > R.x0 - margin && e[0] < R.x1 + margin && e[1] > R.z0 - margin && e[1] < R.z1 + margin) return true;
  const bs = B.basin, nx = Math.max(R.x0, Math.min(bs.x, R.x1)), nz = Math.max(R.z0, Math.min(bs.z, R.z1));
  return sq(nx - bs.x) + sq(nz - bs.z) < sq(bs.r + margin + 0.3);
}

// ---------------------------------------------------------------- 5. lots and walks, 6. pads

/** The ground under a lot: min, max and mean of a 3x3 sample. */
export function rectStats(g, R) {
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) {
    const h = g.sample(R.x0 + (R.x1 - R.x0) * i / 2, R.z0 + (R.z1 - R.z0) * j / 2);
    lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
  }
  return { lo, hi, mean: sum / 9 };
}
export function levelLots(rules, g, lots) {
  const T = rules.terrain;
  for (const L of lots) slab(g, L.rect, rules.houses.margin, T.lots.skirt, L.y);
}
export function rampWalks(rules, g, walks, lots) {
  const T = rules.terrain, ends = walks.map(w => [lots.find(L => L.slot === w.lot).y, r4(g.sample(w.pts[1][0], w.pts[1][1]))]);
  walks.forEach((w, i) => corridor(g, w.pts, ends[i], w.w / 2 + T.walks.flat, T.walks.blend));
}
export function levelPads(rules, g, pads) {
  for (const p of pads) disc(g, p.x, p.z, p.r, rules.terrain.pads.blend, p.h);
}

// ---------------------------------------------------------------- 7. the carve

/** Is (x, z) inside one of the kept oriented rectangles ({x, z, f: front, hw, hd}, world/worldLandmarks.js), grown by `m`? */
export function inKeep(keep, x, z, m = 0) {
  for (const R of keep) {
    const dx = x - R.x, dz = z - R.z, u = dx * R.f[0] + dz * R.f[1], v = dx * R.f[1] - dz * R.f[0];
    if (Math.abs(u) < R.hw + m && Math.abs(v) < R.hd + m) return true;
  }
  return false;
}
/** Is (x, z) under a bridge? The lane keeps its height there (the deck spans the channel), the water runs beneath. */
function underBridge(brook, lanes, P, x, z) {
  for (const br of brook.bridges) {
    if (sq(x - br.x) + sq(z - br.z) > sq(br.reach + 0.5)) continue;
    const l = lanes.find(q => q.id === br.lane);
    if (polyProject(x, z, l.pts).d < l.w / 2 + P.verge * 0.6) return true;
  }
  return false;
}

/**
 * Carve the water into the finished ground: each pond on a terrace at its rim's mean height, a lip, a shallow
 * shelf and a deep centre; the brook's channel, whose surface only descends from the spring to the pool; the pool.
 * Returns the water surface per vertex (-Infinity where dry), from which the depth grid is taken.
 */
export function carveWater(rules, g, water, lanes) {
  const T = rules.terrain, W = T.ponds, B = T.brook, Bs = T.basin, P = rules.paths;
  const surface = new Float64Array(g.res * g.res).fill(-Infinity);
  for (const p of water.ponds) {
    let sum = 0;
    for (let k = 0; k < 64; k++) sum += g.sample(p.x + DIRS64[k][0] * p.radii[k], p.z + DIRS64[k][1] * p.radii[k]);
    const rim = sum / 64;
    p.level = r4(rim - W.freeboard);
    const far = p.reach + W.terrace + W.blend;
    g.blend(p.x - far, p.x + far, p.z - far, p.z + far, (x, z, h, at) => {
      const d = Math.sqrt(sq(x - p.x) + sq(z - p.z)), R = p.radii[kNear(x - p.x, z - p.z)], e = d - R;
      if (e >= W.terrace + W.blend) return null;
      // a frozen pond is ice to walk on: level ground just under its surface and no water depth
      if (d < R && W.frozen) return [p.level - W.frozen, 1];
      if (d < R) { surface[at] = p.level; return [p.level - W.depth * smooth((1 - d / R) / W.shelf), 1]; }
      if (e < W.terrace) return [p.level + W.freeboard * smooth(e / W.lip), 1];
      return [rim, 1 - smooth((e - W.terrace) / W.blend)];
    });
  }
  const K = water.brook;
  if (K) {
    // The surface: the ground less a freeboard, never rising downstream; the pool takes the last of it.
    const bs = K.basin, n = K.pts.length;
    bs.y = r4(g.sample(bs.x, bs.z));
    const S = [];
    for (let i = 0; i < n - 1; i++) { const raw = g.sample(K.pts[i][0], K.pts[i][1]) - B.freeboard; S.push(r4(i === 0 ? raw : Math.min(S[i - 1], raw))); }
    bs.level = r4(Math.min(S[n - 2], bs.y - Bs.freeboard));
    S.push(bs.level);
    K.surface = S;
    const [x0, x1, z0, z1] = bbox(K.pts, K.w / 2 + B.bank), keep = water.keep ?? [];
    g.blend(x0, x1, z0, z1, (x, z, h, at) => {
      const pr = polyProject(x, z, K.pts);
      if (pr.d >= K.w / 2 + B.bank || underBridge(K, lanes, P, x, z)) return null;
      // A landmark's rectangle on the bank (the mill house) keeps its pad: the bank is cut up to its wall.
      if (keep.length && inKeep(keep, x, z)) return null;
      // The channel stops at the pool's kerb (no round cap past its end): the kerb stands on uncut ground.
      if (sq(x - bs.x) + sq(z - bs.z) < sq(bs.r + 0.35) || (pr.i === n - 1 && pr.t >= 1)) return null;
      const s = along(S, pr), bed = s - K.depth;
      if (pr.d <= K.w / 2 + 0.3) surface[at] = Math.max(surface[at], s);
      const target = pr.d <= K.w / 2 ? bed : bed + (h - bed) * smooth((pr.d - K.w / 2) / B.bank);
      return [Math.min(h, target), 1];
    });
    g.blend(bs.x - bs.r, bs.x + bs.r, bs.z - bs.r, bs.z + bs.r, (x, z, h, at) => {
      const d = Math.sqrt(sq(x - bs.x) + sq(z - bs.z));
      if (d >= bs.r) return null;
      surface[at] = bs.level;
      return [Math.min(h, bs.level - Bs.depth * smooth((bs.r - d) / (bs.r * 0.5))), 1];
    });
  }
  return surface;
}

// ---------------------------------------------------------------- shore dressing

/**
 * The water's own dressing, all visual (the brook is waded, the pool collides as one circle in the compiler):
 * bank stones along both sides of the brook (not under a bridge, not at a ford, not in the pool), a ring of
 * stones at the spring, stepping stones where a spur or a walk fords the brook, and lily pads on each pond.
 */
export function shoreDressing(rules, seed, g, water, lanes, crossings) {
  const T = rules.terrain, B = T.brook, W = T.ponds, P = rules.paths, out = [], fords = [];
  const K = water.brook;
  if (K) {
    // Fords: the brook point nearest each spur or walk that it crosses; three stones along the path.
    for (const [ci, c] of crossings.entries()) {
      const a = c.pts[0], b = c.pts[1], l = dist(a, b);
      if (!(l > 0)) continue;
      let bi = -1, bd = K.w / 2;
      for (let i = 1; i < K.pts.length - 1; i++) {
        const d = polyProject(K.pts[i][0], K.pts[i][1], [a, b]).d;
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0) continue;
      const cx = K.pts[bi][0], cz = K.pts[bi][1], ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
      fords.push({ x: cx, z: cz });
      for (let s = -1; s <= 1; s++) {
        const x = r4(cx + ux * s * B.ford), z = r4(cz + uz * s * B.ford);
        out.push({ part: 'stone.step', x, z, k: (ci * 11 + (s + 1) * 21) % 64, s: 1, lod: 0, y: r4(along(K.surface, polyProject(x, z, K.pts)) - 0.06), kind: 'ford' });
      }
    }
    const rng = stream(seed, 'banks'), parts = B.stones, len = polyLength(K.pts), n = Math.floor((len - 0.8) / B.spacing), keep = water.keep ?? [];
    let count = 0;
    for (let i = 0; i <= n; i++) {
      const u = 0.4 + i * B.spacing, at = polyAt(K.pts, u);
      for (const side of [-1, 1]) {
        const a = rng(), b = rng(), c = rng();
        const off = K.w / 2 + 0.12 + a * 0.25, x = r4(at.x - at.tz * side * off), z = r4(at.z + at.tx * side * off);
        if (underBridge(K, lanes, P, x, z) || K.bridges.some(br => sq(x - br.x) + sq(z - br.z) < sq(br.reach + 0.4))) continue;
        if (keep.length && inKeep(keep, x, z, 0.4)) continue;
        if (fords.some(f => sq(x - f.x) + sq(z - f.z) < sq(B.ford * 1.6))) continue;
        if (sq(x - K.basin.x) + sq(z - K.basin.z) < sq(K.basin.r + 0.4)) continue;
        out.push({ part: parts[Math.floor(b * parts.length) % parts.length], x, z, k: Math.floor(c * 64) % 64, s: r4(0.8 + 0.45 * a), lod: count % 2, y: r4(g.sample(x, z) - 0.04), kind: 'bank' });
        count++;
      }
    }
    for (let q = 0; q < 5; q++) {
      const d = DIRS64[(q * 13) % 64], x = r4(K.source[0] + d[0] * 0.9), z = r4(K.source[1] + d[1] * 0.9);
      out.push({ part: parts[q % parts.length], x, z, k: (q * 23) % 64, s: r4(1.05 + 0.1 * (q % 2)), lod: 0, y: r4(g.sample(x, z) - 0.04), kind: 'spring' });
    }
  }
  // Lily pads: a few per pond on the open water, apart from each other.
  const rng = stream(seed, 'lilies');
  for (const p of water.ponds) {
    const want = Math.floor(p.r * W.lilies), mine = [];
    for (let t = 0; t < want * 3 && mine.length < want; t++) {
      const kr = rng(), sr = rng(), spin = rng(), bloom = rng();
      const k = Math.floor(kr * 64) % 64, s = 0.3 + 0.45 * sr, x = r4(p.x + DIRS64[k][0] * s * p.radii[k]), z = r4(p.z + DIRS64[k][1] * s * p.radii[k]);
      if (mine.some(q => sq(q.x - x) + sq(q.z - z) < sq(W.lilyApart))) continue;
      const it = { part: bloom < W.bloom ? 'lily.bloom' : 'lily.pad', x, z, k: Math.floor(spin * 64) % 64, s: r4(0.85 + 0.3 * sr), lod: mine.length % 3 === 2 ? 1 : 0, y: r4(p.level + 0.01), kind: 'lily' };
      mine.push(it); out.push(it);
    }
  }
  return { flora: out, fords };
}

// ---------------------------------------------------------------- the finished terrain

/** Heights and water depths as plain arrays (r4), with their range: what the compiler hands the engine's Terrain. */
export function finishTerrain(g, surface) {
  const heights = new Array(g.h.length), depth = new Array(g.h.length);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < g.h.length; i++) {
    const h = r4(g.h[i]);
    heights[i] = h; depth[i] = surface[i] > -Infinity ? r4(Math.max(0, surface[i] - g.h[i])) : 0;
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { size: g.size, cell: g.cell, res: g.res, min: lo, max: hi, heights, depth };
}
