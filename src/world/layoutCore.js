/**
 * LAYOUT CORE: the pieces every seeded level layout shares (Arcade's village and terrain). Nothing here knows about houses, lanes or kerbs:
 *
 *   streams     one named PRNG stream per stage (`${seed}|${domain}|${name}`), so a stage's draws never shift
 *               another's;
 *   noise       a 32-bit lattice hash, smooth value noise and fbm: the seeded FIELDS a layout reads;
 *   geometry    distances to segments and polylines, arc-length walks, axis-aligned rectangle tests;
 *   Poisson     Bridson's Poisson-disc sampling for one class against a spatial hash of everything placed
 *               before it, with the mask and the fields deciding through one `refuse` callback;
 *   proof       `unreachable()`: flood the level from the spawn with every blocker stamped and report which
 *               targets cannot be reached.
 *
 * The Python ports (tools/blender/v2/core/layout_core.py) mirror these line for line. PARITY RULES: no
 * trigonometry (directions come from DIRS64); numbers leave through r4 (floor(x + 0.5)); every stage draws
 * from its own stream in a fixed order whatever branch is taken; integer loop counters, never accumulated floats.
 */
import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';
import { clamp01, DIRS64 } from './grammarCore.js';

const M = 4294967296;
export const r4 = v => Math.floor(v * 10000 + 0.5) / 10000;
export const sq = v => v * v;
/** A stage's own PRNG stream: `domain` is the generator (`world` for the village, `streets` for the city). */
export const layoutStream = (seed, domain, name) => mulberry32(hashSeed(`${seed}|${domain}|${name}`));

// ---------------------------------------------------------------- noise

/** A 32-bit lattice hash to [0, 1): identical in Python with masked multiplies. */
export function hash3(ix, iz, seed) {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / M;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
/** Smooth value noise on the integer lattice. */
export function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), u = fade(x - ix), v = fade(z - iz);
  const a = hash3(ix, iz, seed), b = hash3(ix + 1, iz, seed), c = hash3(ix, iz + 1, seed), d = hash3(ix + 1, iz + 1, seed);
  const top = a + (b - a) * u, bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}
/** Fractal sum of `octaves` value-noise layers, then a contrast stretch about 0.5. */
export function fbm(x, z, seed, { scale, octaves, contrast = 1 }) {
  let sum = 0, amp = 1, total = 0, f = 1 / scale;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f + o * 17.3, z * f + o * 11.7, (seed + o * 7919) % M);
    total += amp; amp *= 0.5; f *= 2;
  }
  return clamp01((sum / total - 0.5) * contrast + 0.5);
}
/** A class weight conditioned on the fields: `favor: {forest: 0.9}` scales it by up to 1.9x where the field is 1. */
export function favorAt(favor, fields, x, z) {
  let w = 1;
  // A field the level lacks reads 0: a class that needs it never grows there.
  for (const [name, f] of Object.entries(favor ?? {})) w *= Math.max(0, 1 + f * (2 * (fields[name] ? fields[name](x, z) : 0) - 1));
  return w;
}
/** A compact fingerprint of a grid of r4 values: FNV over its millimetre integers. */
export function gridHash(values) {
  let s = '';
  for (let i = 0; i < values.length; i++) s += (i ? ',' : '') + Math.floor(values[i] * 1000 + 0.5);
  return hashSeed(s);
}

// ---------------------------------------------------------------- geometry

/** Distance from (x, z) to the segment ab. */
export function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.sqrt(sq(x - a[0] - dx * t) + sq(z - a[1] - dz * t));
}
export function polyDist(x, z, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(x, z, pts[i - 1], pts[i]));
  return best;
}
/** Point on a polyline at arc-length u, with its unit tangent. */
export function polyAt(pts, u) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.sqrt(sq(b[0] - a[0]) + sq(b[1] - a[1]));
    if (u <= acc + l || i === pts.length - 1) {
      const t = l > 0 ? Math.max(0, Math.min(1, (u - acc) / l)) : 0;
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: l > 0 ? (b[0] - a[0]) / l : 1, tz: l > 0 ? (b[1] - a[1]) / l : 0 };
    }
    acc += l;
  }
  return { x: pts[0][0], z: pts[0][1], tx: 1, tz: 0 };
}
export function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.sqrt(sq(pts[i][0] - pts[i - 1][0]) + sq(pts[i][1] - pts[i - 1][1]));
  return l;
}
/** The nearest point of a polyline to (x, z). */
export function polyNearest(x, z, pts) {
  let best = null, bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.sqrt(sq(x - px) + sq(z - pz));
    if (d < bd) { bd = d; best = [px, pz]; }
  }
  return best;
}
/** Axis-aligned rectangle {x0, x1, z0, z1} against a circle, another rectangle, and a point. */
export const rectCircle = (R, cx, cz, r) => {
  const nx = Math.max(R.x0, Math.min(cx, R.x1)), nz = Math.max(R.z0, Math.min(cz, R.z1));
  return sq(nx - cx) + sq(nz - cz) < r * r;
};
export const rectRect = (A, B, gap) => A.x0 < B.x1 + gap && B.x0 < A.x1 + gap && A.z0 < B.z1 + gap && B.z0 < A.z1 + gap;
export const rectHas = (R, x, z, m) => x > R.x0 - m && x < R.x1 + m && z > R.z0 - m && z < R.z1 + m;

// ---------------------------------------------------------------- Poisson-disc sampling

/** A spatial hash of points with a ground and a canopy radius, on 2 m cells: `near(x, z, d)` yields every point within d. */
export class PointHash {
  constructor(cell = 2) { this.cell = cell; this.map = new Map(); this.fmax = 0; }
  key(i, j) { return i * 65536 + j; }
  add(x, z, r, c = r) { const i = Math.floor(x / this.cell), j = Math.floor(z / this.cell), k = this.key(i, j); (this.map.get(k) ?? this.map.set(k, []).get(k)).push([x, z, r, c]); }
  *near(x, z, d) {
    const i0 = Math.floor((x - d) / this.cell), i1 = Math.floor((x + d) / this.cell), j0 = Math.floor((z - d) / this.cell), j1 = Math.floor((z + d) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const b = this.map.get(this.key(i, j)); if (b) yield* b; }
  }
}

/**
 * Bridson's Poisson-disc sampling for one class over the square |x|, |z| <= bound, against the points every
 * earlier class placed (`placed`, whose `fmax` is the largest footprint in it). A candidate `refuse` turns down
 * (the mask, the fields, the class's own rules; it gets the candidate's pre-drawn roll) still joins the front as
 * a ghost: it keeps the class's spacing, is never emitted, and does not block other classes, so sparse regions
 * are still crossed. Thinned to `max` by a per-point roll so the survivors stay spread out.
 *
 * @param {{rng: () => number, bound: number, r: number, foot: number, canopy?: boolean, max: number,
 *   placed: PointHash, refuse: (x: number, z: number, roll: number) => boolean}} o
 * @returns {{x: number, z: number, k: number, s: number}[]}  k: a 64th turn, s: a size in [0.85, 1.15)
 */
export function poissonDisc({ rng, bound, r, foot, canopy = false, max, placed, refuse }) {
  const own = new PointHash(), out = [], reach = foot + placed.fmax;
  // Spacing: r within the class (the Poisson radius), footprints between classes (a `canopy` class keeps clear of
  // earlier crowns too, the rest only of their ground footprints).
  const crowded = (x, z) => {
    for (const p of placed.near(x, z, reach)) if (sq(x - p[0]) + sq(z - p[1]) < sq(foot + (canopy ? p[3] : p[2]))) return true;
    for (const q of own.near(x, z, r)) if (sq(x - q[0]) + sq(z - q[1]) < r * r) return true;
    return false;
  };
  const active = [];
  const consider = (x, z) => {
    if (x < -bound || x > bound || z < -bound || z > bound || crowded(x, z)) return false;
    own.add(x, z, r); active.push([x, z]);
    const roll = rng(), spin = rng(), size = rng(), keep = rng();
    if (!refuse(x, z, roll)) out.push({ x: r4(x), z: r4(z), k: Math.floor(spin * 64) % 64, s: r4(0.85 + 0.3 * size), keep });
    return true;
  };
  // Seeds across the map so an early refusal cannot strand a corner; then the front.
  for (let s = 0; s < 6; s++) consider(r4((rng() * 2 - 1) * bound), r4((rng() * 2 - 1) * bound));
  let guard = Math.ceil(sq((2 * bound) / (r / Math.SQRT2))) * 4;
  while (active.length && guard-- > 0) {
    const ai = Math.floor(rng() * active.length), [ax, az] = active[ai];
    let grew = false;
    for (let k = 0; k < 8; k++) {
      const d = DIRS64[Math.floor(rng() * 64) % 64], dist = r * (1 + rng());
      if (consider(r4(ax + d[0] * dist), r4(az + d[1] * dist))) grew = true;
    }
    if (!grew) { active[ai] = active[active.length - 1]; active.pop(); }
  }
  // Thin to the cap by a roll drawn at emission, so the survivors stay spread; keep emission order.
  const kept = out.length > max ? out.slice().sort((a, b) => a.keep - b.keep || a.x - b.x || a.z - b.z).slice(0, max) : out;
  const set = new Set(kept);
  return out.filter(p => set.has(p)).map(({ keep, ...p }) => p);
}

// ---------------------------------------------------------------- the reachability proof

/**
 * Walk the level: flood the nav grid from the spawn with every blocker stamped (boxes and circles, grown by
 * the player's radius) and report which targets cannot be reached. Pure, for the compiler's proof and tests.
 * Raised geometry the body walks under (a building's upper-floor walls, its slabs, decks and stair treads:
 * `projectileOnly` records, which the engine keeps out of the ground's 2D blockers too) is not stamped.
 * With a `terrain` (sim/Terrain.js), a cell the body cannot stand on (too steep, water too deep) is blocked
 * too, and no step may rise or fall more than the terrain's `stepDown`.
 */
export function unreachable(placements, spawn, targets, { size = 80, cell = 0.5, radius = 0.45, terrain = null } = {}) {
  const n = Math.round(size / cell), grid = new Uint8Array(n * n);
  const idx = (x, z) => [Math.floor((x + size / 2) / cell), Math.floor((z + size / 2) / cell)];
  for (const p of placements) {
    if (p.collision === 'none' || !p.collision || p.projectileOnly) continue;
    let hx, hz;
    if (p.collision === 'box') { const c = Math.abs(Math.cos(p.yaw ?? 0)), s = Math.abs(Math.sin(p.yaw ?? 0)); hx = p.halfX * c + p.halfZ * s; hz = p.halfX * s + p.halfZ * c; }
    else hx = hz = p.radius;
    const [i0, j0] = idx(p.x - hx - radius, p.z - hz - radius), [i1, j1] = idx(p.x + hx + radius, p.z + hz + radius);
    for (let j = Math.max(0, j0); j <= Math.min(n - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(n - 1, i1); i++) {
      if (p.collision === 'circle') { const cx = -size / 2 + (i + 0.5) * cell, cz = -size / 2 + (j + 0.5) * cell; if (sq(cx - p.x) + sq(cz - p.z) > sq(p.radius + radius)) continue; }
      grid[j * n + i] = 1;
    }
  }
  // The border the engine keeps unwalkable (three 0.5 m cells), whatever the proof's own cell size.
  const rim = Math.round(1.5 / cell);
  for (let i = 0; i < n; i++) for (let k = 0; k < rim; k++) grid[k * n + i] = grid[(n - 1 - k) * n + i] = grid[i * n + k] = grid[i * n + n - 1 - k] = 1;
  let heights = null;
  if (terrain) {
    heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const cx = -size / 2 + (i + 0.5) * cell, cz = -size / 2 + (j + 0.5) * cell;
      heights[j * n + i] = terrain.heightAt(cx, cz);
      if (!terrain.standableAt(cx, cz)) grid[j * n + i] = 1;
    }
  }
  const seen = new Uint8Array(n * n), [si, sj] = idx(spawn.x, spawn.z), queue = [sj * n + si];
  seen[sj * n + si] = 1;
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], i = c % n, j = (c - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nc = nj * n + ni;
      if (seen[nc] || grid[nc]) continue;
      if (heights && Math.abs(heights[nc] - heights[c]) > terrain.stepDown) continue;
      seen[nc] = 1; queue.push(nc);
    }
  }
  const out = [];
  for (const t of targets) {
    // A target is reached when any free cell within its ring is.
    const [ti, tj] = idx(t.x, t.z), reach = Math.ceil((t.r ?? 1.5) / cell);
    let ok = false;
    for (let j = tj - reach; j <= tj + reach && !ok; j++) for (let i = ti - reach; i <= ti + reach && !ok; i++) if (i >= 0 && j >= 0 && i < n && j < n && seen[j * n + i]) ok = true;
    if (!ok) out.push(t);
  }
  return out;
}
