import { BufferGeometry, BufferAttribute } from 'three/webgpu';

/**
 * ARCADE GROUND: the meshes of the village's relief and water (world/worldTerrain.js), built from the level's
 * height grid. Pure geometry, no materials: CombatEnvironment gives the ground the toon lawn with its overlay
 * and the water the toon water.
 *
 * The ground is ONE tensor-product grid: the meadow's own vertices (every metre, every second metre in lite)
 * and, past the rim, a few coarse rows and columns of a skirt that keeps rising into low hills, so the level
 * sits in a bowl instead of ending at an edge. Because rows and columns are shared, the seam between the
 * meadow and the skirt has no T-junctions and never cracks. Heights inside the meadow are the grid's own, the
 * same numbers the player and the nav grid stand on; UVs are the meadow's (0..1 over it) so the ground overlay
 * canvas lands where the layout painted it, and the skirt's run past 1 onto the overlay's cleared border.
 *
 * A level that stands on its seed's Visigenesis world (world/kernelGround.js) has no skirt: the grid runs on past the
 * rim on the world's own heights (`beyond`, worldAround's), so what lies past the meadow is the rest of the world the
 * level was cut from, with its sea (buildSeaGeometry).
 */

const smooth = v => { const t = v < 0 ? 0 : v > 1 ? 1 : v; return t * t * (3 - 2 * t); };

/** The skirt's extra rise past the rim: a smooth climb with a slow wobble so its ridge line is not a square. */
function skirtRise(x, z, half, S) {
  const out = Math.max(Math.abs(x) - half, Math.abs(z) - half, 0);
  if (out <= 0) return 0;
  const wob = 0.72 + 0.28 * Math.sin(x * 0.11 + 1.7) * Math.cos(z * 0.09 - 0.4);
  return S.rise * smooth(out / S.out) * wob;
}

/** The grid's coordinates along one axis: the skirt's coarse steps, then the meadow's, then the skirt's again. */
function axis(size, cell, step, S, lite) {
  const half = size / 2, n = Math.round(size / cell), out = [], sc = lite ? S.cell * 2.5 : S.cell, ns = Math.max(1, Math.round(S.out / sc));
  for (let k = ns; k >= 1; k--) out.push(-half - k * sc);
  for (let i = 0; i <= n; i += step) out.push(-half + i * cell);
  if ((n % step) !== 0) out.push(half);
  for (let k = 1; k <= ns; k++) out.push(half + k * sc);
  return out;
}

/**
 * The axis past the meadow when the level stands on its world (world/kernelGround.js worldAround): the meadow's own
 * coordinates, then steps that start at `first` metres and grow by `growth` each, up to `widest`, out to `reach`
 * metres from the rim on each side. One tensor-product grid still, so the seam at the rim shares every vertex.
 */
function worldAxis(size, cell, step, B, lite) {
  const half = size / 2, n = Math.round(size / cell), outer = [];
  let at = 0, d = lite ? B.first * 2 : B.first;
  while (at < B.reach) { at = Math.min(B.reach, at + d); outer.push(at); d = Math.min(B.widest, d * B.growth); }
  const out = [];
  for (let k = outer.length - 1; k >= 0; k--) out.push(-half - outer[k]);
  for (let i = 0; i <= n; i += step) out.push(-half + i * cell);
  if ((n % step) !== 0) out.push(half);
  for (const o of outer) out.push(half + o);
  return out;
}

/** A level on its world: how far the world is drawn past the rim and how its ground is coloured (CombatEnvironment). */
export const WORLD_BEYOND = Object.freeze({ reach: 320, first: 2, growth: 1.28, widest: 32, fade: 14, keep: 0.18 });

/**
 * @param {{size: number, cell: number, res: number, heights: number[], depth?: number[]}} terrain  the layout's finished grid
 * @param {{out: number, cell: number, rise: number}} skirt
 * @param {{lite?: boolean, tolerance?: number, beyond?: {height: (x: number, z: number) => number, tint: (y: number, slope: number) => number[], reach?: number, first?: number, growth?: number, widest?: number, fade?: number, keep?: number}}} [options]
 *   lite: a 2 m grid over the meadow and a coarser skirt, refined back to 1 m in the cells that hold water or that
 *   would stray more than `tolerance` metres from the ground the player stands on (a lane's cut bank, a pad's edge):
 *   where a refined cell meets a coarse one, the shared edge's midpoint lies on the coarse edge, so the seam never
 *   cracks. beyond: a level on its seed's world (world/kernelGround.js worldAround): past the rim the grid runs out
 *   to `reach` metres (WORLD_BEYOND) on the WORLD's heights instead of a skirt, and every vertex carries a `far`
 *   colour (rgb from `tint(height, slope)`, alpha its weight: 0 in the meadow, rising over `fade` metres past the rim
 *   to 1 − `keep`) that the ground material blends over the lawn
 * @returns {BufferGeometry} positions, normals and uvs; `userData.tris` split into meadow and skirt, and the
 *   number of refined cells
 */
export function buildGroundGeometry(terrain, skirt, { lite = false, tolerance = 0.12, beyond = null } = {}) {
  const { size, cell, res, heights } = terrain, depth = terrain.depth, half = size / 2, step = lite ? 2 : 1;
  const B = beyond ? { ...WORLD_BEYOND, ...beyond } : null;
  const xs = B ? worldAxis(size, cell, step, B, lite) : axis(size, cell, step, skirt, lite), n = xs.length;
  const raw = (i, j) => heights[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))];
  // Inside the meadow a vertex sits exactly on a grid vertex; outside, it takes the clamped edge height plus the rise,
  // or, on a world, the world's own height there.
  const outside = (x, z) => Math.abs(x) > half + 1e-9 || Math.abs(z) > half + 1e-9;
  const height = (x, z) => {
    if (B && outside(x, z)) return B.height(x, z);
    const i = Math.round((Math.min(half, Math.max(-half, x)) + half) / cell), j = Math.round((Math.min(half, Math.max(-half, z)) + half) / cell);
    return raw(i, j) + (B ? 0 : skirtRise(x, z, half, skirt));
  };
  const pos = [], nrm = [], uv = [], idx = [], far = [];
  const vert = (x, z, y = height(x, z)) => {
    pos.push(x, y, z); uv.push((x + half) / size, (half - z) / size);
    // Normals by central differences a cell either side, so the toon terminator follows the hills smoothly.
    const dx = (height(x + cell, z) - height(x - cell, z)) / (2 * cell), dz = (height(x, z + cell) - height(x, z - cell)) / (2 * cell), l = Math.hypot(dx, 1, dz);
    nrm.push(-dx / l, 1 / l, -dz / l);
    if (B) {
      const out = Math.max(Math.abs(x) - half, Math.abs(z) - half, 0), w = (1 - B.keep) * smooth(out / B.fade), [r, g, b] = B.tint(y, Math.hypot(dx, dz));
      far.push(r, g, b, w);
    }
    return pos.length / 3 - 1;
  };
  const V = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) V.push(vert(xs[i], xs[j]));
  const Y = v => pos[v * 3 + 1];
  // Split each quad along the diagonal that follows the ground, so ridges and hollows do not zig-zag.
  const quad = (a, b, c, d) => { if (Math.abs(Y(a) - Y(d)) < Math.abs(Y(b) - Y(c))) idx.push(a, c, d, a, d, b); else idx.push(a, c, b, b, c, d); };
  const inMeadow = (i, j) => xs[i] >= -half && xs[i + 1] <= half && xs[j] >= -half && xs[j + 1] <= half;
  // Lite: which 2 m cells go back to 1 m (water in them, or a midpoint the coarse quad would miss by more than the tolerance).
  const fine = new Uint8Array((n - 1) * (n - 1));
  if (step > 1) for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    if (!inMeadow(i, j)) continue;
    const gi = Math.round((xs[i] + half) / cell), gj = Math.round((xs[j] + half) / cell);
    const h00 = raw(gi, gj), h10 = raw(gi + 2, gj), h01 = raw(gi, gj + 2), h11 = raw(gi + 2, gj + 2), alongAD = Math.abs(h00 - h11) < Math.abs(h10 - h01);
    let refine = false;
    for (let dj = 0; dj <= 2 && !refine; dj++) for (let di = 0; di <= 2 && !refine; di++) {
      if (depth?.[(gj + dj) * res + gi + di] > 0) { refine = true; break; }
      const u = di / 2, w = dj / 2;
      // the coarse quad's height here, on whichever of its two triangles holds the point
      const flat = alongAD ? (u >= w ? h00 + (h10 - h00) * u + (h11 - h10) * w : h00 + (h01 - h00) * w + (h11 - h01) * u)
        : (u + w <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * w : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - w));
      if (Math.abs(raw(gi + di, gj + dj) - flat) > tolerance) refine = true;
    }
    fine[j * (n - 1) + i] = refine ? 1 : 0;
  }
  const mids = new Map(), isFine = (i, j) => i >= 0 && j >= 0 && i < n - 1 && j < n - 1 && fine[j * (n - 1) + i] === 1;
  /** An edge midpoint: the ground's own height when the cell across is fine too, else on the coarse edge. */
  const mid = (gi, gj, a, b, across) => {
    const key = gj * res + gi;
    if (across && mids.has(key)) return mids.get(key);
    const x = -half + gi * cell, z = -half + gj * cell, v = vert(x, z, across ? raw(gi, gj) : (Y(a) + Y(b)) / 2);
    if (across) mids.set(key, v);
    return v;
  };
  let meadow = 0, refined = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = V[j * n + i], b = V[j * n + i + 1], c = V[(j + 1) * n + i], d = V[(j + 1) * n + i + 1], before = idx.length;
    if (!isFine(i, j)) quad(a, b, c, d);
    else {
      refined++;
      const gi = Math.round((xs[i] + half) / cell), gj = Math.round((xs[j] + half) / cell);
      const top = mid(gi + 1, gj, a, b, isFine(i, j - 1)), bottom = mid(gi + 1, gj + 2, c, d, isFine(i, j + 1));
      const left = mid(gi, gj + 1, a, c, isFine(i - 1, j)), right = mid(gi + 2, gj + 1, b, d, isFine(i + 1, j));
      const centre = vert(-half + (gi + 1) * cell, -half + (gj + 1) * cell);
      quad(a, top, left, centre); quad(top, b, centre, right); quad(left, centre, c, bottom); quad(centre, right, bottom, d);
    }
    if (inMeadow(i, j)) meadow += (idx.length - before) / 3;
  }
  const g = new BufferGeometry(), total = idx.length / 3;
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  if (B) g.setAttribute('far', new BufferAttribute(new Float32Array(far), 4));
  g.setIndex(new BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeBoundingSphere();
  g.userData.tris = { meadow, skirt: total - meadow, total, refined };
  if (B) g.userData.axis = xs;
  return g;
}

/**
 * The world's sea around a level on its world: one flat surface at the world's sea level over every cell of the
 * ground's grid past the rim (the meadow is dry ground, world/kernelGround.js chose it so), then a band of wide quads
 * out to `horizon`, so the water runs on under the fog. `shore` (the toon water's shallow tone) is 1 where the ground
 * under it comes within a metre of the surface, 0 in open water.
 *
 * @param {number[]} xs  the ground's axis (buildGroundGeometry's `userData.axis`)
 * @param {number} half  the meadow's half-size
 * @param {number} sea   the surface, level metres
 * @param {(x: number, z: number) => number} height  the world's ground (worldAround's)
 */
export function buildSeaGeometry(xs, half, sea, height, { horizon = 1000, clear = 0.5 } = {}) {
  const pos = [], shore = [], idx = [], n = xs.length, ground = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ground[j * n + i] = height(xs[i], xs[j]);
  // Vertices only where a cell that may show water needs them: a cell whose ground stands `clear` metres over the
  // surface at all four corners hides it and is left out; the coast's cells, and everything seaward, stay.
  const at = new Int32Array(n * n).fill(-1);
  const vert = k => {
    if (at[k] < 0) { const below = sea - ground[k]; pos.push(xs[k % n], sea, xs[(k - (k % n)) / n]); shore.push(below <= 0 ? 1 : Math.max(0, 1 - below)); at[k] = pos.length / 3 - 1; }
    return at[k];
  };
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    if (xs[i] >= -half && xs[i + 1] <= half && xs[j] >= -half && xs[j + 1] <= half) continue;
    const k = j * n + i, corners = [k, k + 1, k + n, k + n + 1];
    if (corners.every(c => ground[c] > sea + clear)) continue;
    const [a, b, c, d] = corners.map(vert);
    idx.push(a, c, b, b, c, d);
  }
  // The band to the horizon: the grid's outer square to the horizon's, four trapezoids.
  const lo = xs[0], hi = xs[n - 1], ring = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]].map(([x, z]) => { pos.push(x, sea, z); shore.push(0); return pos.length / 3 - 1; });
  const outer = [[-horizon, -horizon], [horizon, -horizon], [horizon, horizon], [-horizon, horizon]].map(([x, z]) => { pos.push(x, sea, z); shore.push(0); return pos.length / 3 - 1; });
  // Wound like the ground's quads, (b − a) × (c − a) pointing up, so the band faces the sky.
  for (let k = 0; k < 4; k++) { const k1 = (k + 1) % 4; idx.push(ring[k], outer[k1], outer[k], ring[k], ring[k1], outer[k1]); }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('shore', new BufferAttribute(new Float32Array(shore), 1));
  g.setIndex(new BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeBoundingSphere();
  g.userData.tris = idx.length / 3;
  return g;
}

/**
 * The water as one mesh: each pond a fan over its wobbled shoreline (pushed a little under the lip, so the
 * bank hides the edge), the brook a ribbon on its descending surface (broken under every footbridge), and the
 * pool inside its stone rim. A `shore` attribute runs 0 in open water to 1 at the edge, for the toon water's
 * shallow tone.
 *
 * @param {{ponds: object[], brook: object|null}} water  the layout's water (levels and surfaces filled in)
 * @param {Array<[number, number]>} dirs  the 64 unit directions (world/houseGrammar.js DIRS64)
 */
export function buildWaterGeometry(water, dirs, { overlap = 0.3, poolRim = 0.22 } = {}) {
  const pos = [], shore = [], idx = [];
  const vert = (x, y, z, s) => { pos.push(x, y, z); shore.push(s); return shore.length - 1; };
  for (const p of water?.ponds ?? []) {
    const c = vert(p.x, p.level, p.z, 0), ring = [];
    for (let k = 0; k < 64; k++) { const r = p.radii[k] + overlap; ring.push(vert(p.x + dirs[k][0] * r, p.level, p.z + dirs[k][1] * r, 1)); }
    // a middle ring so the shallow tone fades in over the shelf, not across the whole pond
    const mid = [];
    for (let k = 0; k < 64; k++) { const r = p.radii[k] * 0.62; mid.push(vert(p.x + dirs[k][0] * r, p.level, p.z + dirs[k][1] * r, 0.15)); }
    for (let k = 0; k < 64; k++) {
      const k1 = (k + 1) % 64;
      idx.push(c, mid[k1], mid[k]);
      idx.push(mid[k], mid[k1], ring[k1], mid[k], ring[k1], ring[k]);
    }
  }
  const B = water?.brook;
  if (B?.surface) {
    const dry = new Set(B.bridges.map(b => b.at)), n = B.pts.length, hw = B.w / 2 + 0.25;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const a = B.pts[Math.max(0, i - 1)], b = B.pts[Math.min(n - 1, i + 1)], tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
      const nx = -tz / l, nz = tx / l, [x, z] = B.pts[i], y = B.surface[i];
      const row = [vert(x - nx * hw, y, z - nz * hw, 1), vert(x, y, z, 0.25), vert(x + nx * hw, y, z + nz * hw, 1)];
      // A segment touching a bridge's middle point runs under the deck, where the lane keeps its ground: skip it.
      if (prev && !dry.has(i) && !dry.has(i - 1)) {
        idx.push(prev[0], row[1], row[0], prev[0], prev[1], row[1]);
        idx.push(prev[1], row[2], row[1], prev[1], prev[2], row[2]);
      }
      prev = row;
    }
    const bs = B.basin, r = bs.r - poolRim, c = vert(bs.x, bs.level, bs.z, 0.2), ring = [];
    for (let k = 0; k < 64; k += 2) ring.push(vert(bs.x + dirs[k][0] * r, bs.level, bs.z + dirs[k][1] * r, 0.8));
    for (let k = 0; k < ring.length; k++) idx.push(c, ring[(k + 1) % ring.length], ring[k]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('shore', new BufferAttribute(new Float32Array(shore), 1));
  g.setIndex(new BufferAttribute(shore.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeBoundingSphere();
  g.userData.tris = idx.length / 3;
  return g;
}
