/**
 * WORLD LANDMARKS: the points of interest of an open Arcade level, placed by a seeded graph grammar that reads
 * the village's relief and water (world/worldGrammar.js, world/worldTerrain.js). No AI, no network: the rules in
 * the pack (`world.landmarks`), the height grid, the brook, the lots and a little seeded luck.
 *
 * Each kind has a SITE predicate and a claim:
 *
 *   windmill   the highest rim hill that is clear of everything and whose straight spur to a lane keeps an easy
 *              grade; its sails face into the wind (`face`, the same wind the toon shader sways the canopy with);
 *   watermill  a brook point with a real drop, away from the bridges, the fords, the pool and the spring; the mill
 *              house stands on the bank on a level pad, the wheel hangs in the channel and the brook keeps
 *              flowing under it (the carve leaves the house's rectangle alone);
 *   well       the square, on the diagonal opposite the pool;
 *   belltower  just past the square's rim on a free diagonal (opposite the well first), looking over the square;
 *   market     stalls on the square's free diagonals, then on the lane verges just off it, facing the centre,
 *              each with an awning colour from the seed;
 *   lookout    a rim hill on the far side of the village from the windmill, with the same grade rule;
 *   orchard    a grid of blossom trees grown by the tree grammar beside a farmhouse lot at the fringe;
 *   farm       a levelled plot of crop rows beside a farmhouse lot.
 *
 * Every landmark claims a level pad (through the terrain's pad clustering, so it never fights a neighbour over the
 * ground), a spur to the nearest lane (a corridor the scatter keeps out of, ramped like the mission's spurs, with
 * stepping stones where it fords the brook) and a clearance circle in the mask. What it returns is plain data the
 * compiler turns into placements and collision, and `landmarkPois` hands to the route graph (world/routeGraph.js):
 * typed hooks (visit, interact, deliver), wildlife tags and a keeper family for the stalls and the well.
 *
 * PARITY RULES (as the village): no trigonometry (fronts are unit vectors, spins DIRS64 indices from kNear); numbers
 * leave through r4; integer loops; ties on the lower index. tools/blender/v2/arcade/world_landmarks.py is the port.
 */
import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';
import { generateTree } from './treeGrammar.js';
import { DIRS64 } from './grammarCore.js';
import { hash3, polyProject, kNear, joinPad, rampSpurs, rectStats, slab, disc, waterBlocks } from './worldTerrain.js';

const r4 = v => Math.floor(v * 10000 + 0.5) / 10000;
const sq = v => v * v;
const stream = (seed, name) => mulberry32(hashSeed(`${seed}|world|${name}`));
const ORDER = ['windmill', 'watermill', 'well', 'belltower', 'market', 'lookout', 'orchard', 'farm'];

/** Do segments ab and cd cross? Orientation tests only (no trigonometry), shared with the Python port. */
const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}
function crossesPoly(a, b, polys) {
  for (const pts of polys) for (let i = 1; i < pts.length; i++) if (segmentsCross(a, b, pts[i - 1], pts[i])) return true;
  return false;
}
/** A rectangle's outline (closed) for `avoid`: an axis-aligned {x0, x1, z0, z1}. */
const outline = R => [[R.x0, R.z0], [R.x1, R.z0], [R.x1, R.z1], [R.x0, R.z1], [R.x0, R.z0]];

/**
 * A fringe plot's hook: the midpoint of the plot's edge that faces its lane (the nearest lane point a straight
 * spur reaches without crossing the plot or its lot), a metre out, with the part's front turned that way.
 */
function plotHook(W, spot, R, lot) {
  const avoid = [outline(R), outline(lot.rect)], near = nearestLane(spot.x, spot.z, W.lanes, avoid), dx = near.x - spot.x, dz = near.z - spot.z;
  const edges = [[spot.v[0], spot.v[1], spot.hv], [-spot.v[0], -spot.v[1], spot.hv], [spot.u[0], spot.u[1], spot.hu], [-spot.u[0], -spot.u[1], spot.hu]];
  let best = edges[0], bd = -Infinity;
  for (const e of edges) { const s = e[0] * dx + e[1] * dz; if (s > bd) { bd = s; best = e; } }
  return { x: r4(spot.x + best[0] * (best[2] + 1.0)), z: r4(spot.z + best[1] * (best[2] + 1.0)), front: [best[0], best[1]], avoid };
}

/**
 * The nearest point of the nearest lane to (x, z): the spur's far end. With `avoid` (the brook), a lane whose
 * straight spur would cross it is passed over for the next nearest; when every lane crosses, the nearest wins.
 */
function nearestLane(x, z, lanes, avoid = null) {
  let best = null, bd = Infinity, lane = null, any = null, ad = Infinity, anyLane = null;
  for (const l of lanes) {
    const p = polyProject(x, z, l.pts), a = l.pts[p.i - 1], b = l.pts[p.i], at = [r4(a[0] + (b[0] - a[0]) * p.t), r4(a[1] + (b[1] - a[1]) * p.t)];
    if (p.d < ad) { ad = p.d; any = at; anyLane = l.id; }
    if (avoid && crossesPoly([x, z], at, avoid)) continue;
    if (p.d < bd) { bd = p.d; best = at; lane = l.id; }
  }
  return best ? { x: best[0], z: best[1], d: bd, lane } : { x: any[0], z: any[1], d: ad, lane: anyLane };
}
const unit = (dx, dz) => { const l = Math.sqrt(dx * dx + dz * dz); return l > 0 ? [r4(dx / l), r4(dz / l)] : [0, 1]; };

/**
 * A landmark's claim on the ground: its pad (clustered with the mission's pads), its spur to the nearest lane
 * (ramped now, so the pad and the ramp agree), its clearance circle in the mask. Returns the spur or null.
 */
function claim(rules, W, L, pad, clear, h = null, avoid = null) {
  const { ground, pads, spurs, mask, lanes } = W;
  L.pad = pad; L.clear = clear; L.h = h ?? r4(ground.sample(L.x, L.z));
  // A pad of 0 (a fringe plot's hook) claims no levelling: it stands on the meadow as it is.
  if (pad > 0) {
    joinPad(rules, pads, { x: L.x, z: L.z, r: pad, h: L.h });
    L.h = pads[pads.length - 1].h;
    // A pad set to a chosen height (the mill's, just above its water) is levelled now, so its spur ramps from it.
    if (h !== null) disc(ground, L.x, L.z, pad, rules.terrain.pads.blend, L.h);
  }
  const near = nearestLane(L.x, L.z, lanes, avoid);
  L.lane = near.lane;
  let spur = null;
  if (near.d > 0.5) {
    spur = { id: `lm:${L.id}`, w: rules.paths.spur, pts: [[L.x, L.z], [near.x, near.z]], lane: near.lane };
    spurs.push(spur); mask.spurs.push(spur);
    rampSpurs(rules, ground, [spur]);
  }
  mask.reserved.push({ id: `lm:${L.id}`, x: L.x, z: L.z, r: clear, spur: false });
  L.spur = spur;
  return spur;
}

/**
 * A pad's levelling (its disc, the blend beyond it and the metre the bilinear ground reads past a vertex) must
 * never reach a levelled lot: true when a pad of radius `pad` at (x, z) would.
 */
function nearLots(rules, lots, x, z, pad) {
  const reach = pad + rules.terrain.pads.blend + 1.2;
  for (const L of lots) {
    const nx = Math.max(L.rect.x0, Math.min(x, L.rect.x1)), nz = Math.max(L.rect.z0, Math.min(z, L.rect.z1));
    if (sq(nx - x) + sq(nz - z) < sq(reach)) return true;
  }
  return false;
}

/** Straight spur grade from a pad at (x, z, h) to its nearest lane, and that lane's point. */
function spurGrade(g, lanes, x, z, h) {
  const near = nearestLane(x, z, lanes);
  const hl = g.sample(near.x, near.z), grade = near.d > 0.5 ? Math.abs(h - hl) / near.d : 0;
  return { grade, near };
}

/** Rim-hill candidates on a 2 m lattice: the band between `rim[0]` and `rim[1]` from the centre, scored high plus luck. */
function hillCandidates(rules, K, seed, W, kind) {
  const bound = rules.size / 2 - rules.margin, n = Math.floor(bound), sj = hashSeed(`${seed}:world:${kind}`), out = [];
  const { ground, mask, lanes } = W, rim = K.rim ?? rules.landmarks.rim;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -bound + i * 2, z = -bound + j * 2;
    if (x > bound || z > bound) continue;
    const far = Math.max(Math.abs(x), Math.abs(z));
    if (far < rim[0] || far > rim[1] || Math.abs(x) > bound - K.pad || Math.abs(z) > bound - K.pad) continue;
    // The body keeps off the lanes, the pads and the lots; the whole pad keeps off the water and its carved terrace.
    if (mask.blocked(x, z, K.body, { lots: true, zones: false, spurs: true, water: false })) continue;
    if (mask.water && waterBlocks(rules, mask.water, x, z, K.pad + rules.terrain.ponds.terrace + rules.terrain.ponds.blend, false)) continue;
    if (nearLots(rules, W.lots, x, z, K.pad)) continue;
    const h = ground.sample(x, z), { grade, near } = spurGrade(ground, lanes, x, z, h);
    if (grade > rules.landmarks.grade || near.d < 2) continue;
    out.push({ x: r4(x), z: r4(z), h: r4(h), score: h + rules.landmarks.luck * hash3(i, j, sj), idx: out.length });
  }
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out;
}

function placeWindmill(rules, K, ctx, W) {
  const c = hillCandidates(rules, K, ctx.seed, W, 'windmill')[0];
  if (!c) return null;
  const L = { kind: 'windmill', id: 'windmill', x: c.x, z: c.z, front: unit(K.face[0], K.face[1]), part: K.part };
  claim(rules, W, L, K.pad, K.clear);
  return L;
}

function placeLookout(rules, K, ctx, W, windmill) {
  const S = W.square, apart = rules.landmarks.apart;
  for (const c of hillCandidates(rules, K, ctx.seed, W, 'lookout')) {
    if (windmill) {
      // The far side of the village: the two hills never share a quadrant, and keep well apart.
      const ax = windmill.x - S.x, az = windmill.z - S.z, bx = c.x - S.x, bz = c.z - S.z;
      if (ax * bx + az * bz > 0 || Math.sqrt(sq(c.x - windmill.x) + sq(c.z - windmill.z)) < apart) continue;
    }
    const L = { kind: 'lookout', id: 'lookout', x: c.x, z: c.z, front: unit(S.x - c.x, S.z - c.z), part: K.part };
    claim(rules, W, L, K.pad, K.clear);
    return L;
  }
  return null;
}

/**
 * The watermill: a brook point with the best drop over its neighbours (plus luck), clear of the bridges, the fords
 * (spurs and walks), the pool and the spring. The house stands on whichever bank is free and level, its wall
 * `set` past the channel's edge, its right side toward the water; the wheel is placed once the water is carved.
 */
function placeWatermill(rules, K, ctx, W) {
  const B = W.water?.brook, T = rules.terrain.brook, { ground, mask, lots, walks, spurs } = W;
  if (!B || B.pts.length < 8) return null;
  const sj = hashSeed(`${ctx.seed}:world:watermill`), hd = K.collision.box[1], hw = K.collision.box[0], cands = [];
  const crossings = [...spurs, ...walks];
  // The water surface as the carve will set it (the ground along the brook less the freeboard, never rising
  // downstream): the mill's pad stands `bank` above it, whatever the bank's own height.
  const S = [];
  for (let i = 0; i < B.pts.length; i++) { const raw = ground.sample(B.pts[i][0], B.pts[i][1]) - T.freeboard; S.push(i === 0 ? raw : Math.min(S[i - 1], raw)); }
  for (let i = 3; i < B.pts.length - 4; i++) {
    const p = B.pts[i];
    if (B.bridges.some(b => sq(p[0] - b.x) + sq(p[1] - b.z) < sq(b.reach + K.keepOff))) continue;
    if (sq(p[0] - B.basin.x) + sq(p[1] - B.basin.z) < sq(K.keepOff + 3) || sq(p[0] - B.source[0]) + sq(p[1] - B.source[1]) < sq(K.keepOff + 2)) continue;
    if (crossings.some(c => polyProject(p[0], p[1], c.pts).d < K.keepOff)) continue;
    const drop = ground.sample(B.pts[i - 3][0], B.pts[i - 3][1]) - ground.sample(B.pts[i + 3][0], B.pts[i + 3][1]);
    cands.push({ i, score: drop + rules.landmarks.luck * 0.5 * hash3(i, 7, sj), idx: cands.length });
  }
  cands.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const bound = rules.size / 2 - rules.margin;
  for (const c of cands) {
    const p = B.pts[c.i], a = B.pts[c.i - 1], b = B.pts[c.i + 1], t = unit(b[0] - a[0], b[1] - a[1]);
    const n = [-t[1], t[0]], off = T.w / 2 + K.set + hd;
    for (const side of [1, -1]) {
      const cx = r4(p[0] + n[0] * side * off), cz = r4(p[1] + n[1] * side * off);
      if (Math.abs(cx) > bound - K.pad || Math.abs(cz) > bound - K.pad) continue;
      if (mask.blocked(cx, cz, K.body, { lots: true, zones: false, spurs: true, water: false })) continue;
      if (waterBlocks(rules, { ponds: mask.water.ponds, brook: null }, cx, cz, K.pad + rules.terrain.ponds.terrace + rules.terrain.ponds.blend, false)) continue;
      // Front along the flow, chosen so the house's right side faces the water: right = (fz, -fx).
      let front = t;
      if (front[1] * n[0] * side - front[0] * n[1] * side < 0) front = [r4(-t[0]), r4(-t[1])];
      // The house's own rectangle (long side along the flow) stays out of the channel, sampled round its edge.
      const rx = front[1], rz = -front[0];
      let ok = true;
      for (let k = 0; k <= 8 && ok; k++) {
        const u = -1 + k / 4, edge = [[cx + front[0] * hw * u + rx * hd, cz + front[1] * hw * u + rz * hd], [cx + front[0] * hw * u - rx * hd, cz + front[1] * hw * u - rz * hd],
          [cx + front[0] * hw + rx * hd * u, cz + front[1] * hw + rz * hd * u], [cx - front[0] * hw + rx * hd * u, cz - front[1] * hw + rz * hd * u]];
        for (const [ex, ez] of edge) if (polyProject(ex, ez, B.pts).d < T.w / 2 + K.set * 0.5) { ok = false; break; }
      }
      if (!ok) continue;
      const m = Math.max(hw, hd), R = { x0: cx - m, x1: cx + m, z0: cz - m, z1: cz + m };
      if (nearLots(rules, lots, cx, cz, K.pad)) continue;
      const st = rectStats(ground, R), h = r4(S[c.i] + K.bank);
      // The bank under the house is neither cut nor filled by more than `fill` to meet the pad, nor uneven.
      if (st.hi - st.lo > K.range || Math.abs(st.mean - h) > K.fill) continue;
      const L = { kind: 'watermill', id: 'watermill', x: cx, z: cz, front, part: K.part, at: c.i, side, rect: { x0: r4(R.x0), x1: r4(R.x1), z0: r4(R.z0), z1: r4(R.z1) }, hw, hd,
        wheel: { x: r4(p[0] + n[0] * side * (T.w / 2 - K.wheel.in)), z: r4(p[1] + n[1] * side * (T.w / 2 - K.wheel.in)), y: 0 } };
      // The mill's spur stays on its own bank: it never fords the brook it stands on.
      claim(rules, W, L, K.pad, K.clear, h, [B.pts]);
      return L;
    }
  }
  return null;
}

/**
 * The well on the diagonal opposite the pool, then a bell tower just past the rim on a free diagonal, then stalls
 * on the free diagonals and the lane verges off the square.
 */
function placeSquare(rules, K, M, ctx, W, rng, T = null) {
  const S = W.square, B = W.water?.brook, P = rules.paths, { mask, lanes } = W, out = [];
  const INV2 = 0.7071067811865476, diags = [[INV2, INV2], [-INV2, INV2], [-INV2, -INV2], [INV2, -INV2]];
  const wellRoll = rng(), countRoll = rng(), partRolls = [], colourRolls = [], keeperRolls = [];
  for (let i = 0; i < 6; i++) { partRolls.push(rng()); colourRolls.push(rng()); keeperRolls.push(rng()); }
  const q0 = B ? (B.basin.q + 2) % 4 : Math.floor(wellRoll * 4) % 4, d = S.r * (K ?? M).at;
  const keepers = rules.landmarks.keepers, awnings = M ? M.awnings : null;
  const keeperOf = roll => keepers[Math.floor(roll * keepers.length) % keepers.length];
  // A thing on the square may stand on the lanes' verges but not on the lanes, the pads, the well or the pool.
  // `r` keeps the thing's body off the lanes and the pool; `rr` (a box's full reach, whichever way it turns) keeps
  // it out of every reserved clearance.
  const free = (x, z, r, rr = r) => {
    for (const l of lanes) if (polyProject(x, z, l.pts).d < l.w / 2 + r) return false;
    for (const c of mask.reserved) if (sq(x - c.x) + sq(z - c.z) < sq(c.r + rr)) return false;
    if (B && sq(x - B.basin.x) + sq(z - B.basin.z) < sq(B.basin.r + r + 0.4)) return false;
    return true;
  };
  // Along a diagonal, from `at` of the radius outward to the rim: the first free spot (the lanes wobble).
  const slide = (q, r, rr) => {
    for (let s = 0; s <= 4; s++) {
      const dd = d + s * 0.35, x = r4(S.x + diags[q][0] * dd), z = r4(S.z + diags[q][1] * dd);
      if (free(x, z, r, rr)) return [x, z];
    }
    return null;
  };
  if (K) {
    const at = slide(q0, K.collision.circle, K.collision.circle);
    if (at) {
      const [x, z] = at;
      const L = { kind: 'well', id: 'well', x, z, front: unit(S.x - x, S.z - z), part: K.part, keeper: keeperOf(keeperRolls[0]) };
      L.lane = 'square'; mask.reserved.push({ id: 'lm:well', x, z, r: K.collision.circle + 0.6, spur: false });
      out.push(L);
    }
  }
  if (T && W.towerLot) {
    // The tower stands on the lot nearest the square (the layout took it from the houses, levelled and claimed),
    // facing the square's centre.
    const lot = W.towerLot;
    out.push({ kind: 'belltower', id: 'belltower', x: lot.x, z: lot.z, front: unit(S.x - lot.x, S.z - lot.z), part: T.part, lane: 'square', clear: r4(Math.max(lot.w, lot.d) / 2) });
  } else if (T) {
    // With no house lots, the tower stands just outside the square, as close to it as the mission's own clearances,
    // the lanes and the spurs allow: rings of sixteen directions from `at` of the radius outward, half a metre apart,
    // each ring starting opposite the well. It faces the square's centre. Its collider is a circle (a yawed box would
    // be stamped as its whole world bound), so its reach is that radius.
    const reach = T.collision.circle + 0.3, k0 = (Math.floor(q0 * 16 + 40) % 64);
    let placed = false;
    for (let s = 0; s <= T.slide && !placed; s++) {
      for (let i = 0; i < 16 && !placed; i++) {
        const d = DIRS64[(k0 + i * 4) % 64], dd = S.r * T.at + s * 0.5, x = r4(S.x + d[0] * dd), z = r4(S.z + d[1] * dd);
        if (B && sq(x - B.basin.x) + sq(z - B.basin.z) < sq(B.basin.r + reach + 1)) continue;
        if (!free(x, z, reach, reach) || mask.blocked(x, z, reach, { lots: true, zones: false, spurs: true })) continue;
        const L = { kind: 'belltower', id: 'belltower', x, z, front: unit(S.x - x, S.z - z), part: T.part, lane: 'square', clear: reach + T.clear };
        mask.reserved.push({ id: 'lm:belltower', x, z, r: reach + T.clear, spur: false });
        out.push(L); placed = true;
      }
      if (placed) break;
    }
  }
  if (!M) return out;
  const want = Math.min(M.max, M.min + Math.floor(countRoll * (M.max - M.min + 1))), r = Math.max(M.collision.box[0], M.collision.box[1]) + 0.1, rr = M.collision.box[0] + M.collision.box[1] + 0.1;
  // Spots in order: the diagonals the well and the pool left, then the four lane verges just past the square's rim.
  const spots = [];
  for (let q = 1; q <= 3; q++) { const qq = (q0 + q) % 4; if (B && qq === B.basin.q) continue; const at = slide(qq, r, rr); if (at) spots.push(at); }
  const lane1 = lanes.find(l => l.id !== 'spine' && Math.abs(l.base - S.z) < 3) ?? lanes[1];
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const x = r4(S.x + sx * (S.r + P.verge + M.off)), z = r4(S.z + sz * (lane1.w / 2 + P.verge + M.set));
    spots.push([x, z]);
  }
  let n = 0;
  for (let s = 0; s < spots.length && n < want; s++) {
    const [x, z] = spots[s];
    if (!free(x, z, r, rr) || (s >= 2 && mask.blocked(x, z, rr, { lots: true, zones: false, spurs: true }))) continue;
    if (out.some(o => sq(o.x - x) + sq(o.z - z) < sq(M.apart))) continue;
    const L = { kind: 'market', id: `stall${n}`, x, z, front: unit(S.x - x, S.z - z), part: M.parts[Math.floor(partRolls[n] * M.parts.length) % M.parts.length],
      colors: { Awning: awnings[Math.floor(colourRolls[n] * awnings.length) % awnings.length] }, keeper: keeperOf(keeperRolls[n + 1]), lane: 'square' };
    mask.reserved.push({ id: `lm:${L.id}`, x, z, r: r + 0.6, spur: false });
    out.push(L); n++;
  }
  return out;
}

/**
 * A fringe plot beside a farmhouse lot: tried on the lot's right, left and back, at `gap` from its rectangle,
 * its long side along the lane. `probe(x, z)` accepts a spot; the plot is taken when every probe passes.
 */
function fringeSpot(rules, W, lot, ext, gap, probe, used) {
  // A plot may run a little past the meadow's margin (the ground goes on into the skirt), never off the grid.
  const bound = rules.size / 2 - rules.margin + 2.0, [fx, fz] = lot.front, tx = fz, tz = -fx;
  const sides = [[tx, tz, lot.w / 2, ext[0] / 2], [-tx, -tz, lot.w / 2, ext[0] / 2], [-fx, -fz, lot.d / 2, ext[1] / 2]];
  for (const [dx, dz, half, mine] of sides) {
    const cx = r4(lot.x + dx * (half + gap + mine)), cz = r4(lot.z + dz * (half + gap + mine));
    // The plot's own axes: u along the lane (the lot's X), v toward the lane (the lot's front).
    const ux = tx, uz = tz, vx = fx, vz = fz, hu = ext[0] / 2, hv = ext[1] / 2;
    const corners = [[-hu, -hv], [hu, -hv], [-hu, hv], [hu, hv], [0, 0], [0, -hv], [0, hv]];
    let ok = true;
    for (const [u, v] of corners) {
      const x = cx + ux * u + vx * v, z = cz + uz * u + vz * v;
      if (Math.abs(x) > bound || Math.abs(z) > bound || !probe(x, z)) { ok = false; break; }
    }
    if (ok) for (const o of used) if (sq(o.x - cx) + sq(o.z - cz) < sq(o.r + Math.max(hu, hv) + 1)) { ok = false; break; }
    if (ok) return { x: cx, z: cz, u: [ux, uz], v: [vx, vz], hu, hv };
  }
  return null;
}

/** The lots a fringe plot is tried beside: farmhouses first, then the lots with the least village-ness. */
function fringeLots(lots) {
  return lots.slice().sort((a, b) => (a.family === 'farmhouse' ? 0 : 1) - (b.family === 'farmhouse' ? 0 : 1) || a.score - b.score || a.slot - b.slot);
}

function placeOrchard(rules, K, ctx, W, used) {
  const { mask, ground, lots } = W, cols = K.grid[0], rows = K.grid[1], sp = K.spacing;
  if (!ctx.treeRules || !ctx.pool.has('tree')) return null;
  const ext = [(cols - 1) * sp + 2 * K.margin, (rows - 1) * sp + 2 * K.margin];
  const probe = (x, z) => !mask.blocked(x, z, K.margin, { lots: true, zones: false, spurs: true }) && ground.slope(x, z) <= K.slope;
  for (const lot of fringeLots(lots)) {
    const spot = fringeSpot(rules, W, lot, ext, K.gap, probe, used);
    if (!spot) continue;
    const trees = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const u = (c - (cols - 1) / 2) * sp, v = (r - (rows - 1) / 2) * sp;
      const x = r4(spot.x + spot.u[0] * u + spot.v[0] * v), z = r4(spot.z + spot.u[1] * u + spot.v[1] * v), i = r * cols + c;
      const plan = generateTree(ctx.treeRules, { species: K.tree, key: `${ctx.seed}|orchard|${i}` }), s = K.scale;
      trees.push({ x, z, k: (i * 23 + 5) % 64, s, tree: plan, trunk: r4(plan.trunk * s), height: r4(plan.clear * s), crown: r4(plan.crown * s), y: 0 });
    }
    // The hook stands a metre off the edge that faces the lane; the spur starts there and keeps off the plot.
    const R = { x0: r4(spot.x - Math.max(spot.hu, spot.hv)), x1: r4(spot.x + Math.max(spot.hu, spot.hv)), z0: r4(spot.z - Math.max(spot.hu, spot.hv)), z1: r4(spot.z + Math.max(spot.hu, spot.hv)) };
    const hk = plotHook(W, spot, R, lot);
    const L = { kind: 'orchard', id: 'orchard', x: hk.x, z: hk.z, front: hk.front, trees, lot: lot.slot, rect: R, centre: [spot.x, spot.z] };
    claim(rules, W, L, K.pad, K.clear, null, hk.avoid);
    for (const t of trees) mask.reserved.push({ id: 'lm:orchard-tree', x: t.x, z: t.z, r: K.margin, spur: false });
    return L;
  }
  return null;
}

function placeFarm(rules, K, ctx, W, used) {
  const { mask, ground, lots } = W, ext = K.size;
  if (!ctx.pool.has(rules.landmarks.prop ?? 'landmark')) return null;
  const probe = (x, z) => !mask.blocked(x, z, 0.6, { lots: true, zones: false, spurs: true });
  for (const lot of fringeLots(lots)) {
    const spot = fringeSpot(rules, W, lot, ext, K.gap, probe, used);
    if (!spot) continue;
    // The plot's axis-aligned bound is levelled (a slab, like a lot); refused when the ground spans too much.
    const R = { x0: r4(spot.x - Math.max(spot.hu, spot.hv)), x1: r4(spot.x + Math.max(spot.hu, spot.hv)), z0: r4(spot.z - Math.max(spot.hu, spot.hv)), z1: r4(spot.z + Math.max(spot.hu, spot.hv)) };
    const st = rectStats(ground, R);
    if (st.hi - st.lo > K.range) continue;
    const hk = plotHook(W, spot, R, lot), level = r4(st.mean);
    // The plot is levelled after the lots (levelLandmarks: a slab like a lot's, its flat top reaching past the hook,
    // so the spur meets the plot's own level); the plot part faces its hook (the entrance) and stands at the centre.
    const G = { x0: r4(Math.min(R.x0, hk.x - 0.5)), x1: r4(Math.max(R.x1, hk.x + 0.5)), z0: r4(Math.min(R.z0, hk.z - 0.5)), z1: r4(Math.max(R.z1, hk.z + 0.5)) };
    const L = { kind: 'farm', id: 'farm', x: hk.x, z: hk.z, front: hk.front, part: K.part, rect: R, slab: G, level, lot: lot.slot, centre: [spot.x, spot.z] };
    claim(rules, W, L, K.pad, K.clear, null, hk.avoid);
    mask.reserved.push({ id: 'lm:farm-plot', x: spot.x, z: spot.z, r: Math.max(spot.hu, spot.hv) + 0.5, spur: false });
    return L;
  }
  return null;
}

/**
 * @param {object} rules  the pack's `world` block (with `landmarks`)
 * @param {{seed: string, treeRules: object|null, pool: Set<string>}} ctx
 * @param {object} W  the layout so far: lanes, square, spurs, mask, ground, pads, water, lots, walks, reserved
 * @returns {object[]} the landmarks, each with its hook filled from the rules
 */
export function planLandmarks(rules, ctx, W) {
  const R = rules.landmarks, K = R.kinds, rng = stream(ctx.seed, 'landmarks'), out = [];
  const windmill = K.windmill ? placeWindmill(rules, K.windmill, ctx, W) : null;
  if (windmill) out.push(windmill);
  const watermill = K.watermill ? placeWatermill(rules, K.watermill, ctx, W) : null;
  if (watermill) out.push(watermill);
  out.push(...placeSquare(rules, K.well ?? null, K.market ?? null, ctx, W, rng, K.belltower ?? null));
  const lookout = K.lookout ? placeLookout(rules, K.lookout, ctx, W, windmill) : null;
  if (lookout) out.push(lookout);
  const used = out.map(l => ({ x: l.x, z: l.z, r: l.clear ?? 2 }));
  const orchard = K.orchard ? placeOrchard(rules, K.orchard, ctx, W, used) : null;
  if (orchard) { out.push(orchard); used.push({ x: orchard.centre[0], z: orchard.centre[1], r: Math.max(orchard.rect.x1 - orchard.rect.x0, orchard.rect.z1 - orchard.rect.z0) / 2 }); }
  const farm = K.farm ? placeFarm(rules, K.farm, ctx, W, used) : null;
  if (farm) out.push(farm);
  for (const L of out) {
    const k = K[L.kind];
    L.hook = { ...k.hook };
    if (k.life) L.life = k.life.slice();
    L.collision = k.collision ?? null;
    L.k = kNear(L.front[0], L.front[1]);
  }
  return out;
}

/** The farm plots' slabs, after the lots (a plot beside a lot keeps its level over the lot's skirt) and before the pads. */
export function levelLandmarks(rules, g, landmarks) {
  for (const L of landmarks) if (L.slab) slab(g, L.slab, 0.3, rules.terrain.lots.skirt, L.level);
}

/**
 * Heights once the water is carved: every landmark's hook on its pad, a plot part at its slab's level, the
 * wheel's axle on the water it dips into.
 */
export function finishLandmarks(rules, g, water, landmarks) {
  const K = rules.landmarks.kinds, B = water?.brook;
  for (const L of landmarks) {
    L.y = r4(L.pad ? L.h : g.sample(L.x, L.z));
    if (L.level !== undefined) L.plot = { x: L.centre[0], z: L.centre[1], y: L.level };
    // The orchard's trees stand on the finished ground (the pads and slabs around them are settled by now).
    for (const t of L.trees ?? []) t.y = r4(g.low(t.x, t.z, t.trunk));
    if (L.wheel && B) {
      const pr = polyProject(L.wheel.x, L.wheel.z, B.pts), s = B.surface[pr.i - 1] + (B.surface[pr.i] - B.surface[pr.i - 1]) * pr.t;
      L.wheel.y = r4(s + K.watermill.wheel.r - K.watermill.wheel.dip - L.y);
    }
  }
}

/**
 * The landmarks as route points of interest (world/routeGraph.js). `stand` is where a visitor stands: in front of
 * a landmark that collides (past its blocker, facing it), at the hook itself for a plot.
 */
export function landmarkPois(landmarks) {
  return landmarks.map(L => {
    // The engine stamps a yawed box as its world-aligned bound (half sizes summed at worst) on a half-metre grid.
    const c = L.collision, reach = c ? (c.circle ? c.circle + 1.3 : c.box[0] + c.box[1] + 1.1) : 0;
    return { id: L.id, kind: L.kind, x: L.x, z: L.z, hook: L.hook, life: L.life, keeper: L.keeper ?? null, lane: L.lane, pad: L.pad ?? 0,
      stand: reach ? [r4(L.x + L.front[0] * reach), r4(L.z + L.front[1] * reach)] : [L.x, L.z] };
  });
}

/** The oriented rectangles the water carve and the bank stones leave alone (the mill house on its bank). */
export function landmarkKeeps(landmarks) {
  return landmarks.filter(L => L.kind === 'watermill').map(L => ({ x: L.x, z: L.z, f: L.front, hw: L.hw + 0.1, hd: L.hd + 0.1 }));
}

/** Sanity of the landmark rules against the parts index and the tree species; [] when fine. */
export function validateLandmarkRules(R, parts = null, trees = null) {
  const errors = [];
  if (!R || typeof R !== 'object') return ['landmarks: missing'];
  for (const key of ['grade', 'luck', 'apart']) if (!(R[key] >= 0)) errors.push(`landmarks.${key}: missing`);
  if (!Array.isArray(R.rim) || R.rim.length !== 2 || !(R.rim[0] < R.rim[1])) errors.push('landmarks.rim: two rising bounds');
  if (!Array.isArray(R.keepers) || !R.keepers.length) errors.push('landmarks.keepers: a family list');
  for (const [kind, k] of Object.entries(R.kinds ?? {})) {
    if (!ORDER.includes(kind)) errors.push(`landmarks.kinds.${kind}: unknown kind`);
    if (!k.hook || !['visit', 'interact', 'deliver'].includes(k.hook.type) || typeof k.hook.label !== 'string') errors.push(`landmarks.kinds.${kind}.hook: type and label`);
    if (k.hook?.type === 'deliver' && !Array.isArray(k.hook.takes)) errors.push(`landmarks.kinds.${kind}.hook.takes: a list`);
    for (const p of [...(k.parts ?? []), ...(k.part ? [k.part] : [])]) if (parts && !parts[p]) errors.push(`landmarks.kinds.${kind}: part "${p}" is not in the library`);
    if (k.tree && trees && !trees.species?.[k.tree]) errors.push(`landmarks.kinds.${kind}: species "${k.tree}" is not in the tree rules`);
    if (k.collision && !(k.collision.circle > 0 || (Array.isArray(k.collision.box) && k.collision.box.length === 2))) errors.push(`landmarks.kinds.${kind}.collision: a circle or a box`);
    if (['windmill', 'lookout', 'watermill'].includes(kind) && !(k.pad > 0 && k.clear >= k.pad)) errors.push(`landmarks.kinds.${kind}: pad and clear`);
    if (['orchard', 'farm'].includes(kind) && !(k.pad >= 0 && k.clear >= k.pad)) errors.push(`landmarks.kinds.${kind}: pad and clear`);
    if (kind === 'belltower' && !(k.at > 0 && k.clear >= 0 && k.slide >= 0 && k.collision?.circle > 0)) errors.push(`landmarks.kinds.${kind}: at, clear, slide and a collision circle`);
  }
  return errors;
}
