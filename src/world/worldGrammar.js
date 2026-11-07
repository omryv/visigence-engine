/**
 * WORLD GRAMMAR: a seeded village layout for an open Arcade level. No AI, no network: the rules in the
 * pack (`packs/<theme>/pack.json`, `world`), three noise fields and a few PRNG streams turn the mission's
 * reserved places into a village that stays navigable.
 *
 * It runs in the order a surveyor would:
 *
 *   1. fields     village-ness (a radial fall-off from the square plus noise), forest density (noise, thinned
 *                 where the village is and thickened toward the rim) and moisture (noise). Every later choice
 *                 reads them, so houses, groves, rocks and flowers agree about where the village is.
 *   2. paths      a spine down the centre lane, cross lanes and a village square, each wobbled by noise; the
 *                 mission's places (spawn, pads, gates, cover) get a spur to the spine. Paths are corridors
 *                 nothing may stand in, so every place stays reachable by construction.
 *   3. lots       house lots walked along the lanes and along the avenue's tree line, sized per family
 *                 (`houses.lots`), taken where village-ness passes a threshold, the family favoured by it
 *                 (townhouses near the square, farmhouses at the fringe); a plan from the house grammar; a
 *                 fence along the front with a gap at the door; a walk with stepping stones to the lane.
 *   4. clearings  wildlife zones: open meadow away from village and forest.
 *   5. scatter    Poisson-disc sampling with a radius per class (Bridson's algorithm; a candidate the fields
 *                 refuse still carries the front as a ghost, so sparse regions stay covered), thinned to the
 *                 class cap by a per-point roll so the survivors stay spread out. A tree class grows each
 *                 point's tree from the tree grammar as it is placed: the plan's trunk radius is the point's
 *                 collider and its crown radius (times `crownFoot`) the CANOPY footprint later trees and rocks
 *                 keep clear of, while flora keeps only the ground footprint (a bush may stand under an oak).
 *   6. pickups and signposts on the lane verges.
 *
 * `layoutWorld` returns plain data: lanes, the square, lots (with their house plans), fences, walks, scatter
 * points, zones, pickups and signs, in engine axes (x right, z toward the spawn), with yaws as unit `front`
 * vectors so nothing needs trigonometry. The Blender preview (tools/blender/v2/arcade/world_grammar.py) is a
 * line-for-line port and tools/test/test-world-placement.mjs holds both to identical output through
 * `worldDigest`.
 *
 * PARITY RULES: no trigonometry (directions come from DIRS64 and unit vectors); numbers leave through r4
 * (floor(x + 0.5)); each stage draws from its own stream in a fixed order whatever branch is taken; integer
 * loop counters, never accumulated floats.
 */
import { hashSeed } from '../kernel/seed.js';
import { clamp01, choose } from './grammarCore.js';
import { generateHouse } from './houseGrammar.js';
import { generateTree, treeDigest } from './treeGrammar.js';
import { r4, sq, layoutStream, hash3, vnoise, fbm, favorAt, polyDist, polyAt, polyLength, polyNearest, rectCircle, rectRect, rectHas,
  PointHash, poissonDisc, unreachable } from './layoutCore.js';
import { makeGround, gradeLanes, padTargets, joinPad, rampSpurs, planPonds, planBrook, waterEdge, waterBlocks, waterRect,
  rectStats, levelLots, rampWalks, levelPads, carveWater, shoreDressing, finishTerrain, gridHash } from './worldTerrain.js';
import { planLandmarks, levelLandmarks, finishLandmarks, landmarkPois, landmarkKeeps, validateLandmarkRules } from './worldLandmarks.js';
import { chainRoute } from './routeGraph.js';

export const WORLD_GRAMMAR_VERSION = 3;

// ---------------------------------------------------------------- noise

// The lattice hash, value noise, fbm and the reachability proof are theme-neutral (world/layoutCore.js); re-exported
// for the Arcade modules and tests that import them from here.
export { hash3, vnoise, fbm, unreachable };

/** The three fields of one seed: village(x, z), forest(x, z), moisture(x, z), each in [0, 1]. */
export function worldFields(rules, seed) {
  const F = rules.fields, S = rules.paths.square;
  const sv = hashSeed(`${seed}:world:village`), sf = hashSeed(`${seed}:world:forest`), sm = hashSeed(`${seed}:world:moisture`);
  const village = (x, z) => {
    const d = Math.sqrt(x * x + sq(z - S.z)), radial = clamp01(1 - d / F.village.radius);
    return clamp01(F.village.radial * radial + (1 - F.village.radial) * fbm(x, z, sv, F.village));
  };
  const forest = (x, z) => {
    const e = F.forest.edge, edge = clamp01((Math.max(Math.abs(x), Math.abs(z)) - e[0]) / (e[1] - e[0]));
    return clamp01(fbm(x, z, sf, F.forest) * (1 - F.forest.clearing * village(x, z)) + F.forest.rim * edge);
  };
  const moisture = (x, z) => fbm(x, z, sm, F.moisture);
  return { village, forest, moisture };
}

// ---------------------------------------------------------------- geometry

const stream = (seed, name) => layoutStream(seed, 'world', name);

/** Every place a corridor or a reserved circle claims: the mask everything else is placed against. */
function makeMask(rules, lanes, square, reserved, spurs) {
  const P = rules.paths;
  return {
    lanes, square, reserved, spurs, lots: [], zones: [], water: null,
    /**
     * True when (x, z) with a footprint of `pad` may not stand here (`wet`: reeds may stand in the shallows;
     * `water: 'ponds'`: only the ponds count, for a thing that means to stand on the brook's bank).
     */
    blocked(x, z, pad = 0, { lots = true, zones = false, spurs = true, wet = false, water = true } = {}) {
      if (water && this.water && waterBlocks(rules, water === 'ponds' ? { ponds: this.water.ponds, brook: null } : this.water, x, z, pad, wet)) return true;
      for (const c of reserved) if (sq(x - c.x) + sq(z - c.z) < sq(c.r + pad)) return true;
      if (sq(x - square.x) + sq(z - square.z) < sq(square.r + P.verge + pad)) return true;
      for (const l of lanes) if (polyDist(x, z, l.pts) < l.w / 2 + P.verge + pad) return true;
      if (spurs) for (const s of this.spurs) if (polyDist(x, z, s.pts) < s.w / 2 + pad) return true;
      if (lots) for (const L of this.lots) if (rectHas(L.rect, x, z, rules.houses.margin + pad)) return true;
      if (zones) for (const zn of this.zones) if (sq(x - zn.x) + sq(z - zn.z) < sq(zn.r + pad)) return true;
      return false;
    },
  };
}

// ---------------------------------------------------------------- 2. paths

function makeLanes(rules, seed) {
  const P = rules.paths, ws = hashSeed(`${seed}:world:wobble`), out = [];
  const n = Math.floor((P.spine[0] - P.spine[1]) / P.step + 0.5), pts = [];
  for (let i = 0; i <= n; i++) {
    const z = P.spine[0] - i * P.step;
    pts.push([r4(P.wobble * (2 * vnoise(z / P.wobbleScale + 3.1, 0.5, ws) - 1)), r4(z)]);
  }
  out.push({ id: 'spine', axis: 'z', w: P.width, base: 0, pts });
  const m = Math.floor((2 * P.laneEnd) / P.step + 0.5);
  for (let li = 0; li < P.lanes.length; li++) {
    const z0 = P.lanes[li], lp = [];
    for (let i = 0; i <= m; i++) {
      const x = -P.laneEnd + i * P.step;
      lp.push([r4(x), r4(z0 + P.wobble * (2 * vnoise(x / P.wobbleScale + 7.7 * (li + 1), 2.5, ws) - 1))]);
    }
    out.push({ id: `lane${li}`, axis: 'x', w: P.laneWidth, base: z0, pts: lp });
  }
  return out;
}

/** A straight spur from a reserved place to the nearest point of the nearest lane, so it stays reachable. */
function makeSpurs(rules, lanes, reserved) {
  const out = [];
  for (const c of reserved) {
    if (!c.spur) continue;
    let best = null, bd = Infinity;
    for (const l of lanes) { const p = polyNearest(c.x, c.z, l.pts), d = Math.sqrt(sq(p[0] - c.x) + sq(p[1] - c.z)); if (d < bd) { bd = d; best = p; } }
    if (best && bd > 0.5) out.push({ id: c.id, w: rules.paths.spur, pts: [[r4(c.x), r4(c.z)], [r4(best[0]), r4(best[1])]] });
  }
  return out;
}

// ---------------------------------------------------------------- 3. lots

function doorU(plan) {
  // A walled courtyard is entered by its gateway, which stands on the door's line.
  if (plan.court?.gate) return plan.court.gate.u;
  for (const w of plan.walls) if (w.b === 0 && w.face === '-y') for (const c of w.cells) if (c.kind === 'door') return c.u;
  for (const r of plan.rings ?? []) for (const c of r.cells) if (c.kind === 'door') return 0;
  return 0;
}

function makeLots(rules, ctx, lanes, mask, fields, ground) {
  const H = rules.houses, P = rules.paths, rng = stream(ctx.seed, 'lots'), families = Object.entries(ctx.mix ?? {});
  const bound = rules.size / 2 - rules.margin;
  const found = [];
  if (!families.length || !ctx.houseRules) return found;
  for (const lane of lanes) for (const side of [-1, 1]) {
    const len = polyLength(lane.pts), setback = lane.id === 'spine' ? H.setback.spine : H.setback.lane;
    let u = 1.5;
    while (u < len - 1.5) {
      // Every candidate draws the same two numbers: the family roll and the taking roll.
      const rf = rng(), rt = rng(), at = polyAt(lane.pts, u);
      // The lane's normal on this side (the lane runs along its axis; wobble only shifts it).
      const nx = lane.axis === 'z' ? side : 0, nz = lane.axis === 'x' ? side : 0;
      const off = lane.w / 2 + P.verge + setback;
      // First a family, favoured by village-ness at the lot's rough centre; then the lot it needs.
      const ox = lane.axis === 'z' ? lane.base : at.x, oz = lane.axis === 'x' ? lane.base : at.z;
      const px = ox + nx * (off + 6), pz = oz + nz * (off + 6), v = fields.village(px, pz);
      const family = choose(rf, families, ([f, w]) => w * Math.max(0.05, 1 + (H.near[f] ?? 0) * (2 * v - 1)))[0];
      const [lw, ld] = H.lots[family] ?? [rules.lot?.w ?? 7.6, rules.lot?.d ?? 10];
      const cx = ox + nx * (off + ld / 2), cz = oz + nz * (off + ld / 2);
      const hw = lane.axis === 'x' ? lw / 2 : ld / 2, hd = lane.axis === 'x' ? ld / 2 : lw / 2;
      const rect = { x0: r4(cx - hw), x1: r4(cx + hw), z0: r4(cz - hd), z1: r4(cz + hd) };
      let ok = v >= H.threshold && rt < v + 0.15;
      if (ok && (rect.x0 < -bound || rect.x1 > bound || rect.z0 < -bound || rect.z1 > bound)) ok = false;
      if (ok && lane.id !== 'spine' && (rect.x0 < P.avenue && rect.x1 > -P.avenue)) ok = false;
      if (ok) for (const c of mask.reserved) if (rectCircle(rect, c.x, c.z, c.r + H.margin)) { ok = false; break; }
      if (ok && rectCircle(rect, mask.square.x, mask.square.z, mask.square.r + P.verge + H.margin)) ok = false;
      if (ok) for (const L of found) if (rectRect(rect, L.rect, H.gap)) { ok = false; break; }
      // No lane may cross the lot (its own lane runs along the front, outside the rect).
      if (ok) {
        const m = H.margin;
        outer: for (const l of lanes) for (let k = 0; k <= 8; k++) {
          const t = k / 8, edge = [[rect.x0 + (rect.x1 - rect.x0) * t, rect.z0], [rect.x0 + (rect.x1 - rect.x0) * t, rect.z1], [rect.x0, rect.z0 + (rect.z1 - rect.z0) * t], [rect.x1, rect.z0 + (rect.z1 - rect.z0) * t]];
          for (const [ex, ez] of edge) if (polyDist(ex, ez, l.pts) < l.w / 2 + P.verge + m) { ok = false; break outer; }
        }
      }
      if (ok) for (const s of mask.spurs) for (let k = 0; k <= 8; k++) { const t = k / 8; if (rectHas(rect, s.pts[0][0] + (s.pts[1][0] - s.pts[0][0]) * t, s.pts[0][1] + (s.pts[1][1] - s.pts[0][1]) * t, s.w / 2 + H.margin)) { ok = false; break; } }
      // Water keeps its distance; on relief, a lot whose ground spans too much is refused, the rest are levelled to their mean.
      if (ok && mask.water && waterRect(rules, mask.water, rect, H.margin)) ok = false;
      let y = 0;
      if (ok && ground) { const st = rectStats(ground, rect); if (st.hi - st.lo > rules.terrain.lots.range) ok = false; else y = r4(st.mean); }
      if (!ok) { u += 2; continue; }
      // The front faces the lane: -normal. Lot X in the world is (fz, -fx).
      const fx = -nx, fz = -nz;
      found.push({ index: found.length, lane: lane.id, family, x: r4(cx), z: r4(cz), w: lw, d: ld, front: [fx, fz], rect, score: r4(v), setback, y });
      u += lw + H.gap;
    }
  }
  // Thin to the cap by village-ness (the square's neighbours first), then restore lane order.
  const kept = found.slice().sort((a, b) => b.score - a.score || a.index - b.index).slice(0, H.max).sort((a, b) => a.index - b.index);
  return kept.map((L, i) => {
    const plan = generateHouse(ctx.houseRules, { family: L.family, key: `${ctx.seed}|lot${L.index}`, lot: { w: L.w, d: L.d } });
    return { ...L, slot: i, key: plan.key, door: r4(doorU(plan)), plan };
  });
}

/** Fences along the lot fronts with a gap at the door, and a walk (with stepping stones) from the door to the lane. */
function makeYards(rules, lots, lanes, pool) {
  const F = rules.fences, H = rules.houses, fences = [], walks = [], stones = [];
  let budget = F.max;
  for (const L of lots) {
    const [fx, fz] = L.front, tx = fz, tz = -fx;   // lot +X in the world
    const ex = L.x + fx * (L.d / 2 + F.out), ez = L.z + fz * (L.d / 2 + F.out);
    const dx = L.x + tx * L.door + fx * L.d / 2, dz = L.z + tz * L.door + fz * L.d / 2;
    // The walk: from the door to the nearest point of the lot's lane.
    const lane = lanes.find(l => l.id === L.lane), near = polyNearest(dx, dz, lane.pts);
    walks.push({ lot: L.slot, w: H.walk, pts: [[r4(dx), r4(dz)], [r4(near[0]), r4(near[1])]] });
    const wl = Math.sqrt(sq(near[0] - dx) + sq(near[1] - dz)), n = Math.min(H.stones, Math.floor((wl - F.out) / 0.85));
    if (pool.has('nature')) for (let i = 1; i <= n; i++) {
      const t = (F.out + 0.7 + (i - 1) * 0.85) / wl;
      stones.push({ lot: L.slot, part: 'stone.step', x: r4(dx + (near[0] - dx) * t), z: r4(dz + (near[1] - dz) * t), k: (L.slot * 7 + i * 13) % 64, s: 1, lod: 1 });
    }
    if (!pool.has('fence')) continue;
    // Pieces from each corner inward, stopping short of the door gap.
    for (const side of [-1, 1]) {
      const from = side * L.w / 2, to = L.door + side * F.gap / 2;
      const span = (from - to) * side;
      const count = Math.floor(span / F.length);
      for (let i = 0; i < count && budget > 0; i++) {
        const u = from - side * (F.length / 2 + i * F.length);
        fences.push({ lot: L.slot, x: r4(ex + tx * u), z: r4(ez + tz * u), front: [fx, fz] });
        budget--;
      }
    }
  }
  return { fences, walks, stones };
}

// ---------------------------------------------------------------- 4/5. Poisson-disc scatter

/** Poisson-disc sampling for one class (world/layoutCore.js) against the village's mask and fields. */
function poisson(rules, cls, seed, mask, fields, placed, opts) {
  return poissonDisc({
    rng: stream(seed, `scatter:${cls.id}`), bound: rules.size / 2 - rules.margin, r: cls.r, foot: cls.foot ?? cls.r / 2,
    // a `canopy` class (trees, rocks) keeps clear of earlier crowns too; flora only of their ground footprints
    canopy: !!(cls.canopy || cls.tree), max: cls.max, placed,
    refuse: (x, z, roll) => mask.blocked(x, z, cls.pad ?? cls.foot ?? 0.5, opts) || (cls.avenue === false && Math.abs(x) < rules.paths.avenue)
      || (cls.slope !== undefined && opts.ground && opts.ground.slope(x, z) > cls.slope)
      || roll >= clamp01((cls.base ?? 1) * favorAt(cls.favor, fields, x, z)),
  });
}

function makeScatter(rules, ctx, mask, fields) {
  const placed = new PointHash(), scatter = [], g = ctx.ground, lean = rules.terrain?.lean;
  placed.fmax = 0;
  for (const cls of rules.classes) {
    if (cls.prop && !ctx.pool.has(cls.prop)) continue;
    if (cls.parts && !ctx.pool.has('nature')) continue;
    if (cls.tree && !(ctx.pool.has('tree') && ctx.treeRules)) continue;
    const pts = poisson(rules, cls, ctx.seed, mask, fields, placed, { lots: true, zones: !!cls.zones, spurs: true, wet: !!cls.wet, ground: g });
    const foot = cls.foot ?? cls.r / 2;
    placed.fmax = Math.max(placed.fmax, foot);
    let n = 0;
    for (const p of pts) {
      const item = { cls: cls.id, x: p.x, z: p.z, k: p.k, s: p.s, lod: cls.lod ?? 0 };
      let canopy = foot;
      if (cls.tree) {
        // This point's own tree (world/treeGrammar.js): its real trunk is the collider, its crown the canopy footprint.
        const plan = generateTree(ctx.treeRules, { species: cls.tree, key: `${ctx.seed}|${cls.id}|${n}` });
        n++;
        item.tree = plan; item.trunk = r4(plan.trunk * p.s); item.height = r4(plan.clear * p.s); item.crown = r4(plan.crown * p.s);
        canopy = Math.max(foot, r4(item.crown * (rules.crownFoot ?? 0.6)));
      } else if (cls.prop) { item.prop = cls.prop; if (cls.trunk) { item.trunk = r4(cls.trunk * p.s); item.height = cls.height ?? 2; } }
      else item.part = cls.parts[p.k % cls.parts.length];
      if (cls.tint) item.tint = true;
      // On relief everything stands on the lowest ground under its footprint (a trunk never floats downhill).
      item.y = g ? r4(g.low(p.x, p.z, item.trunk ?? (cls.prop ? Math.min(foot * 0.5, 0.45) : 0.2))) : 0;
      // A leaning class (willows) tips toward the nearest water it stands over.
      if (cls.lean && lean && mask.water) {
        const w = waterEdge(mask.water, p.x, p.z), dx = w.x - p.x, dz = w.z - p.z, l = Math.sqrt(dx * dx + dz * dz);
        if (w.e < lean.range && l > 0) item.lean = [r4(dx / l), r4(dz / l), r4(lean.max * (1 - Math.max(0, w.e) / lean.range))];
      }
      placed.add(p.x, p.z, foot, canopy);
      placed.fmax = Math.max(placed.fmax, canopy);
      scatter.push(item);
    }
  }
  return scatter;
}

function makeZones(rules, ctx, mask, fields) {
  const W = rules.wildlife;
  if (!W) return [];
  const cls = { id: 'wildlife', r: W.r, foot: W.foot ?? W.zone, max: W.max, base: W.base, favor: W.favor, pad: W.pad ?? W.zone, slope: W.slope };
  return poisson(rules, cls, ctx.seed, mask, fields, Object.assign(new PointHash(), { fmax: 0 }), { lots: true, zones: false, spurs: true, ground: ctx.ground }).map(p => ({ x: p.x, z: p.z, r: W.zone }));
}

// ---------------------------------------------------------------- 6. pickups and signs

function makePickups(rules, ctx, lanes, mask) {
  const K = rules.pickups, rng = stream(ctx.seed, 'pickups'), out = [];
  const kinds = ctx.pickups ?? [];
  for (const id of kinds) for (let i = 0; i < K.each; i++) {
    let done = false;
    for (let t = 0; t < 24 && !done; t++) {
      const li = Math.floor(rng() * lanes.length), lane = lanes[li], u = rng() * polyLength(lane.pts), side = rng() < 0.5 ? -1 : 1;
      const at = polyAt(lane.pts, u), nx = lane.axis === 'z' ? side : 0, nz = lane.axis === 'x' ? side : 0;
      const x = r4(at.x + nx * (lane.w / 2 + K.offset)), z = r4(at.z + nz * (lane.w / 2 + K.offset));
      if (mask.blocked(x, z, 0, { lots: true, zones: false, spurs: false })) continue;
      if (Math.abs(x) > rules.size / 2 - rules.margin || Math.abs(z) > rules.size / 2 - rules.margin) continue;
      if (out.some(p => sq(p.x - x) + sq(p.z - z) < sq(K.apart))) continue;
      out.push({ id, x, z }); done = true;
    }
  }
  return out;
}

function makeSigns(rules, ctx, lanes, mask) {
  const S = rules.signs, out = [];
  if (!S || !ctx.pool.has('nature')) return out;
  const spine = lanes[0], rng = stream(ctx.seed, 'signs');
  for (const lane of lanes.slice(1)) {
    const side = rng() < 0.5 ? -1 : 1, spinRoll = rng();
    // The junction: the lane point nearest the spine's crossing, offset to a verge corner.
    const c = polyNearest(0, lane.pts[0][1], spine.pts), at = polyNearest(c[0], c[1], lane.pts);
    const x = r4(at[0] + side * (spine.w / 2 + S.offset)), z = r4(at[1] - (lane.w / 2 + S.offset));
    if (mask.blocked(x, z, 0, { lots: true, zones: false, spurs: false })) continue;
    if (sq(x - mask.square.x) + sq(z - mask.square.z) < sq(mask.square.r + 1)) continue;
    out.push({ part: S.part, x, z, k: Math.floor(spinRoll * 4) * 16 % 64, s: 1, lod: 0 });
  }
  return out;
}

// ---------------------------------------------------------------- the layout

/**
 * @param {object} rules  the pack's `world` block
 * @param {object} ctx
 * @param {string|number} ctx.seed
 * @param {{id: string, x: number, z: number, r: number, spur?: boolean}[]} ctx.reserved  places to keep clear
 * @param {Set<string>|string[]} ctx.pool  the prop ids the blueprint connected (classes whose prop is missing are skipped)
 * @param {object} [ctx.houseRules]  the pack's `houses` block (no houses without it)
 * @param {object} [ctx.treeRules]  the pack's `trees` block (no trees without it)
 * @param {Record<string, number>} [ctx.mix]  family weights (defaults to houseRules.mix)
 * @param {string[]} [ctx.pickups]  pickup prop ids to lay along the lanes
 * @param {{res: number, heights: number[]}} [ctx.relief]  the ground's relief on the terrain grid, when it is not
 *   the village's own hills (world/kernelGround.js: the seed's Visigenesis world)
 */
export function layoutWorld(rules, ctx) {
  const seed = String(ctx.seed), pool = ctx.pool instanceof Set ? ctx.pool : new Set(ctx.pool ?? []);
  const houseRules = ctx.houseRules ?? null, mix = ctx.mix ?? houseRules?.mix ?? {};
  const reserved = (ctx.reserved ?? []).map(c => ({ id: c.id, x: r4(c.x), z: r4(c.z), r: c.r, spur: !!c.spur }));
  const fields = worldFields(rules, seed);
  const lanes = makeLanes(rules, seed);
  const square = { x: 0, z: rules.paths.square.z, r: rules.paths.square.r };
  const spurs = makeSpurs(rules, lanes, reserved);
  const mask = makeMask(rules, lanes, square, reserved, spurs);
  // Relief (world/worldTerrain.js): the hills, the lanes cut in at an easy grade, the spurs ramped, the water planned.
  const T = rules.terrain, ground = T ? makeGround(rules, seed, fields, ctx.relief ?? null) : null;
  let pads = [], water = null;
  if (ground) {
    const hs = gradeLanes(rules, ground, lanes, square);
    pads = padTargets(rules, ground, reserved, square, hs);
    rampSpurs(rules, ground, spurs);
  }
  const lots = pool.has('house') ? makeLots(rules, { seed, mix, houseRules }, lanes, mask, fields, ground) : [];
  mask.lots = lots;
  // A bell tower (the snow village's) takes the lot nearest the square before the water and the yards: its house
  // gives way, its ground is still levelled like a lot's, and the lot stays claimed.
  let towerLot = null;
  if (ground && rules.landmarks?.kinds?.belltower && pool.has(rules.landmarks.prop ?? 'landmark') && lots.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < lots.length; i++) { const d = sq(lots[i].x - square.x) + sq(lots[i].z - square.z); if (d < bd) { bd = d; bi = i; } }
    towerLot = lots.splice(bi, 1)[0];
    reserved.push({ id: 'lm:belltower-lot', x: towerLot.x, z: towerLot.z, r: r4(Math.max(towerLot.w, towerLot.d) / 2), spur: false });
  }
  if (ground) {
    // The water comes after the lots, so the houses keep theirs: ponds settle on the wet ground the village left,
    // and the brook winds between the lots (their walks ford it).
    mask.water = water = { ponds: planPonds(rules, seed, fields, mask), brook: null };
    water.brook = planBrook(rules, seed, fields, mask, ground, lanes, spurs, square, water.ponds, lots);
    // The pool stands on level ground, one with the square's pad (or its neighbour's) when it touches one.
    const bs = water.brook?.basin;
    if (bs) joinPad(rules, pads, { x: bs.x, z: bs.z, r: r4(bs.r + 1.4), h: r4(ground.sample(bs.x, bs.z)) });
    // Two shore fields: `shore` reaches a few metres inland (willows), `bank` only the water's edge (reeds).
    fields.shore = (x, z) => clamp01(1 - waterEdge(water, x, z).e / T.shore);
    fields.bank = (x, z) => clamp01(1 - waterEdge(water, x, z).e / T.bank);
  }
  const yards = makeYards(rules, lots, lanes, pool);
  // Landmarks (world/worldLandmarks.js) read the relief, the brook, the square and the lots, and claim their pads,
  // spurs and clearance before the scatter; the route graph chains them from the spawn.
  const landmarks = ground && rules.landmarks && pool.has(rules.landmarks.prop ?? 'landmark')
    ? planLandmarks(rules, { seed, treeRules: ctx.treeRules ?? null, pool }, { lanes, square, spurs, mask, fields, ground, pads, water, lots, walks: yards.walks, reserved, towerLot }) : [];
  const spawn = reserved.find(c => c.id === 'spawn') ?? { x: 0, z: 28 };
  const route = landmarks.length ? chainRoute(landmarkPois(landmarks), spawn) : null;
  let terrain = null, shore = [];
  if (ground) {
    // Lots and their walks levelled, the farm plot's slab, then every pad (they win), then the water carved into
    // the finished ground (the mill house's rectangle kept).
    levelLots(rules, ground, towerLot ? [...lots, towerLot] : lots);
    rampWalks(rules, ground, yards.walks, lots);
    levelLandmarks(rules, ground, landmarks);
    levelPads(rules, ground, pads);
    water.keep = landmarkKeeps(landmarks);
    const surface = carveWater(rules, ground, water, lanes);
    shore = pool.has('nature') ? shoreDressing(rules, seed, ground, water, lanes, [...spurs, ...yards.walks]).flora : [];
    terrain = finishTerrain(ground, surface);
    finishLandmarks(rules, ground, water, landmarks);
    for (const f of yards.fences) f.y = r4(ground.low(f.x, f.z, 0.3));
    for (const s of yards.stones) s.y = r4(ground.sample(s.x, s.z));
  }
  const zones = makeZones(rules, { seed, ground }, mask, fields);
  mask.zones = zones;
  const scatter = makeScatter(rules, { seed, pool, treeRules: ctx.treeRules ?? null, ground }, mask, fields);
  const pickups = makePickups(rules, { seed, pickups: ctx.pickups }, lanes, mask);
  const signs = makeSigns(rules, { seed, pool }, lanes, mask);
  for (const p of [...pickups, ...signs]) p.y = ground ? r4(ground.sample(p.x, p.z)) : 0;
  return { version: WORLD_GRAMMAR_VERSION, seed, lanes, square, spurs, lots, fences: yards.fences, walks: yards.walks, stones: yards.stones, zones, scatter, pickups, signs,
    terrain, water, shore, landmarks, route };
}

/** Everything but the house plans (the house fixtures hold those), compacted: what the Python port must reproduce. */
export function worldDigest(layout) {
  const pt = p => [p.x, p.z, p.k, p.s, p.lod, p.y ?? 0];
  const T = layout.terrain, W = layout.water, B = W?.brook;
  return {
    version: layout.version, seed: layout.seed,
    lanes: layout.lanes.map(l => [l.id, l.w, l.base, l.pts, l.h ?? null]), square: layout.square, spurs: layout.spurs.map(s => [s.id, s.w, s.pts]),
    lots: layout.lots.map(L => [L.index, L.slot, L.lane, L.family, L.x, L.z, L.w, L.d, L.front, L.score, L.setback, L.key, L.door, L.plan.dna, L.y ?? 0]),
    fences: layout.fences.map(f => [f.lot, f.x, f.z, f.front, f.y ?? 0]), walks: layout.walks.map(w => [w.lot, w.w, w.pts]),
    stones: layout.stones.map(s => [s.lot, s.part, ...pt(s)]), zones: layout.zones.map(z => [z.x, z.z, z.r]),
    scatter: layout.scatter.map(s => [s.cls, s.prop ?? s.part ?? s.tree.species, ...pt(s), s.trunk ?? null, s.height ?? null, s.tint ? 1 : 0, s.crown ?? null, s.tree ? treeDigest(s.tree).hash : null, s.lean ?? null]),
    pickups: layout.pickups.map(p => [p.id, p.x, p.z, p.y ?? 0]), signs: layout.signs.map(s => [s.part, ...pt(s)]),
    terrain: T ? [T.res, T.cell, T.min, T.max, gridHash(T.heights), gridHash(T.depth)] : null,
    ponds: W ? W.ponds.map(p => [p.x, p.z, p.r, p.reach, p.level, gridHash(p.radii)]) : null,
    brook: B ? [B.pts, B.surface, B.w, B.depth, B.bridges.map(b => [b.lane, b.x, b.z, b.front, b.reach, b.at]), [B.basin.x, B.basin.z, B.basin.r, B.basin.level, B.basin.y, B.basin.q]] : null,
    shore: (layout.shore ?? []).map(s => [s.kind, s.part, ...pt(s)]),
    landmarks: (layout.landmarks ?? []).map(L => [L.kind, L.id, L.x, L.z, L.front, L.k, L.pad ?? null, L.y ?? 0, L.spur ? L.spur.pts : null, L.lane ?? null, L.part ?? null, L.colors ?? null,
      L.keeper ?? null, L.wheel ?? null, L.rect ?? null, L.level ?? null, L.centre ?? null, (L.trees ?? []).map(t => [t.x, t.z, t.k, t.s, t.trunk, t.height, t.crown, t.y, treeDigest(t.tree).hash])]),
    route: layout.route ? [layout.route.start, layout.route.nodes.map(n => [n.kind, n.id, n.x, n.z, n.hook.type, n.hook.label, n.hook.item ?? null, n.hook.from ?? null, n.hook.gives ?? null, n.life ?? null, n.keeper ?? null, n.lane ?? null, n.stand ?? null]),
      layout.route.edges.map(e => [e.a, e.b, e.d, e.via])] : null,
  };
}

/** Sanity of the rules against the nature parts index and the tree rules; [] when fine. */
export function validateWorldRules(rules, parts = null, trees = null) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['world: missing'];
  if (!(rules.size > 0 && rules.margin >= 0)) errors.push('world.size/margin');
  if (rules.crownFoot !== undefined && !(rules.crownFoot >= 0)) errors.push('world.crownFoot');
  for (const f of ['village', 'forest', 'moisture']) if (!(rules.fields?.[f]?.scale > 0 && rules.fields[f].octaves >= 1)) errors.push(`world.fields.${f}`);
  const P = rules.paths;
  if (!(P?.width > 0 && P.laneWidth > 0 && P.step > 0 && Array.isArray(P.spine) && Array.isArray(P.lanes) && P.square?.r > 0)) errors.push('world.paths');
  for (const cls of rules.classes ?? []) {
    if (!(cls.r > 0 && cls.max >= 0)) errors.push(`world.classes.${cls.id}: r and max`);
    if (!cls.prop && !cls.parts?.length && !cls.tree) errors.push(`world.classes.${cls.id}: prop, parts or tree`);
    if (cls.tree && trees && !trees.species?.[cls.tree]) errors.push(`world.classes.${cls.id}: unknown tree species ${cls.tree}`);
    if (parts) for (const id of cls.parts ?? []) if (!parts[id]) errors.push(`world.classes.${cls.id}: unknown part ${id}`);
  }
  if (parts && rules.signs && !parts[rules.signs.part]) errors.push(`world.signs: unknown part ${rules.signs.part}`);
  const T = rules.terrain;
  if (T) {
    if (!(T.grid > 0 && T.lite >= T.grid && T.relief?.height >= 0 && T.relief.scale > 0 && T.lanes?.grade > 0)) errors.push('world.terrain: grid, lite, relief, lanes');
    if (!(T.ponds?.r?.[0] > 0 && T.ponds.r[1] >= T.ponds.r[0] && T.ponds.depth > 0 && T.ponds.shelf > 0)) errors.push('world.terrain.ponds');
    // The brook is optional (a desert's water is its oasis); when there is one it is waded.
    if (T.brook && !(T.brook.w > 0 && T.brook.depth > 0 && T.brook.depth < T.traversal.wade)) errors.push('world.terrain.brook: the brook is waded, so it must be shallower than the wading depth');
    if (T.brook && !(T.brook.fall >= 0)) errors.push('world.terrain.brook.fall: how far the spring must stand over the pool, metres (0 or more)');
    if (!T.ponds.frozen && !(T.ponds.depth > T.traversal.wade)) errors.push('world.terrain.ponds: a pond\'s centre must be deeper than the wading depth');
    if (T.ponds.frozen !== undefined && !(T.ponds.frozen > 0 && T.ponds.frozen < 0.2)) errors.push('world.terrain.ponds.frozen: the ice\'s depth over the ground, under 0.2 m');
    const needs = [...(T.brook ? [...(T.brook.stones ?? []), T.basin?.part, T.bridge?.part] : []), ...(T.ponds.lilies > 0 ? ['lily.pad', 'lily.bloom'] : []), 'stone.step'];
    if (parts) for (const id of needs) if (id && !parts[id]) errors.push(`world.terrain: unknown part ${id}`);
  }
  if (parts && rules.houses?.stones > 0 && !parts['stone.step']) errors.push('world.houses.stones: no stone.step part');
  for (const [f, lot] of Object.entries(rules.houses?.lots ?? {})) if (!(lot[0] > 0 && lot[1] > 0)) errors.push(`world.houses.lots.${f}`);
  // Landmarks (world/worldLandmarks.js) are validated against their own parts index by the pack, not the flora's.
  if (rules.landmarks) {
    if (!T) errors.push('world.landmarks: landmarks need the terrain (relief and water)');
    for (const e of validateLandmarkRules(rules.landmarks, null, trees)) errors.push(`world.${e}`);
  }
  return errors;
}
