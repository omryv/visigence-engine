/**
 * KERNEL GROUND: an Arcade level stood on a site of its seed's own Visigenesis world.
 *
 * Every project has a seed, and every seed is a world: src/kernel/presets.js makeParams({ seed }) is the
 * whole of it, the 4 km plate the repository's kernel grows for that seed (src/kernel/terrain/heightfield.js).
 * Until now the Arcade village grew hills of its own instead (world/worldTerrain.js reliefField), so the
 * same seed was one place on visigenesis.com and another in a game. This module is the bridge: it finds a
 * site on the seed's world, asks the kernel to make the ground there meet what the mission needs of it,
 * and hands the village that ground as its relief. The village still does everything it did on top of its
 * own hills (lanes cut in at an easy grade, lots and pads levelled, ponds and the brook carved), and the
 * Python port does the same on the same grid, because the grid is data both ports read.
 *
 * ---------------------------------------------------------------------------
 * THE SITE, AND THE SCALE
 * ---------------------------------------------------------------------------
 * The site is SITE_SCALE times the level on the plate: an 80 m level is 640 m of world, played at 1:8.
 * Eight is not a taste. It is the smallest scale at which the kernel holds a mission's pads and points to
 * 0.05 m (world/missionIntent.js PLAYABLE_SCALE, measured), and it is the kernel's canonical lattice step on
 * its default plate (4096 m / 512 = 8 m, src/kernel/terrain/canonical.js), so with the site's centre on a
 * multiple of SITE_GRID every metre of the level's 1 m grid lands on a vertex of the world's canonical
 * grid. At 1:8 the plate's finest octave (about 72 m) reads as hills nine metres apart and a site's relief at an
 * eighth of its height.
 *
 * The site comes from a fixed scan in a fixed order (ties to the first). Centres every SITE_STRIDE metres
 * inside the plate's coastal falloff (heightfield.js EDGE_START) are surveyed on a SITE_GRID lattice; a
 * centre qualifies when the whole site stands SITE_DRY metres above the sea and no survey step is steeper
 * than SITE_SLOPE, and the score prefers relief near SITE_RELIEF and a rim that stands over its core (a
 * hollow, so the village's brook runs down to the square). The SITE_SHORTLIST best are surveyed again at
 * SITE_FINE, because a 40 m lattice steps over the slopes a 1 m level meets, and that survey ranks them.
 * The mission is then solved on the first of the ranking where its ground costs no more than SITE_NATS
 * and every statement is met, trying at most SITE_TRIES. A world with no such site (one that is mostly
 * sea) has none: the result is `ok: false` with the reason, and the caller keeps the village's own ground
 * and says why. Measured on 60 seeds with a station, a fight at the square and the way out: 41 had a
 * site, 3 of those on a second or third try; 42 ms a world at the median, 247 ms at worst; the solve cost
 * 30 nats at the median and 142 at worst.
 *
 * WHY SO MUCH RELIEF. Meeting a mission flattens more than its pads: one floor under every place it stands
 * and a corridor between them is a statement about the whole site, and the kernel's least improbable way to
 * make it true lowers the site's relief everywhere, by about half (measured: the spread of heights, as a
 * standard deviation, from 1.7 m to 0.9 m at the median). So the scan asks for sites with twice the relief
 * the village's own hills have, and what the mission leaves is about as much as they had: measured over the
 * shooter and arena cards on 20 seeds, a finished level's heights spread 0.97 m on a world against 1.18 m on
 * the village's own hills.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MISSION ASKS, AND THE FLOOR
 * ---------------------------------------------------------------------------
 * The caller hands the steps whose places are fixed before the village is laid out (world/missionIntent.js
 * reads `sites` and `at` as given): the stations and barricades at their pads, a fight at the village
 * square, the way out. A `reach` checkpoint moves to a landmark after the layout and a `collect` drop is
 * laid along a lane after it, so neither can ask anything of the ground, and neither is handed in.
 * Every statement stands at one FLOOR (missionIntent.js says why one): the median of the unconditioned
 * world's heights at the spawn and at every place the mission stands, rounded to the centimetre, so the
 * kernel bends the site as little as the mission allows. The level's heights are then
 *
 *     h(x, z) = (H(originX + 8x, originZ + 8z) − floor) / 8      metres, rounded to 0.1 mm (r4)
 *
 * with H the CONDITIONED sampler: the floor is the level's zero, a pad stands at 0, and a slope on the
 * level is the slope on the plate (a similarity, so the body's maxSlope means one thing on both).
 *
 * It is the world's ANALYTIC ground, before erosion. The canonical ground (src/kernel/terrain/ground.js) is
 * that ground eroded on the whole 513² plate, which costs half a second per world and cannot be cut down
 * to a site, because droplets travel. Measured at two seeds' sites, erosion moves a level's ground by 9 to
 * 11 cm on average and by 0.5 to 0.7 m where it cuts deepest; the claim made here is the exact one (the
 * analytic ground, conditioned), and `heightHash` pins it.
 *
 * Pure: no three, no DOM, no clock, no Math.random. The same inputs give the same ground, bit for bit.
 */
import { makeParams, mergeParams } from '../kernel/presets.js';
import { SculptLayer } from '../kernel/terrain/sculpt.js';
import { createHeightSampler, EDGE_START } from '../kernel/terrain/heightfield.js';
import { terrainParameterHash, hex } from '../kernel/terrain/fingerprint.js';
import { compileMissionIntent, PLAYABLE_SCALE } from './missionIntent.js';
import { r4, gridHash } from './layoutCore.js';
import { DEFAULT_START } from './level/edits.js';

/**
 * THE WORLD A LEVEL IS CUT FROM. By default the seed's own (makeParams({ seed })). A project can carry instead the
 * params of a world made in World mode (`worldParams`: its terrain and water, as the world editor holds them): a
 * named world's grammar, its own intent, its sculpt strokes. Merged over the seed's defaults exactly as the world
 * editor reads a world file, so the level stands on the ground the editor showed.
 */
export function worldParamsFor(seed, patch = null) {
  const base = makeParams({ seed });
  return patch ? mergeParams(base, patch) : base;
}

/**
 * The world's height sampler, as the world editor draws it: the kernel's sampler (the world's own intent in it), plus
 * its sculpt layer replayed over that base (src/kernel/terrain/sculpt.js SculptLayer, the editor's own replay).
 */
function worldSampler(params) {
  const base = createHeightSampler(params);
  const strokes = params.terrain?.sculpt;
  if (!Array.isArray(strokes) || !strokes.length) return base;
  const layer = new SculptLayer({ size: params.terrain.size });
  layer.replay(strokes, base);
  const h = (x, z) => base(x, z) + layer.offsetAt(x, z);
  h.conditioning = base.conditioning;
  return h;
}

/** Bump when a change makes the same inputs give a different ground. */
export const KERNEL_GROUND_VERSION = 1;
/** Plate metres per level metre (the header says why eight). */
export const SITE_SCALE = PLAYABLE_SCALE;
/** The first survey's lattice, plate metres: a multiple of the canonical step, so a site's centre is on it too. */
export const SITE_GRID = 40;
/** The second survey's lattice, plate metres: the best few sites of the first, measured again this finely. */
export const SITE_FINE = 16;
/** How many of the first survey's best sites the second measures. */
export const SITE_SHORTLIST = 8;
/** Candidate centres are this far apart, plate metres. */
export const SITE_STRIDE = 80;
/** How far above the sea every surveyed point of a site must stand, plate metres. */
export const SITE_DRY = 4;
/** The steepest survey step a site may have, rise over run. */
export const SITE_SLOPE = 0.6;
/** The relief a site is scored toward, plate metres (twelve level metres at 1:8, before the mission bends it). */
export const SITE_RELIEF = 96;
/** How much a rim standing over its core may add to a site's score, plate metres. */
export const SITE_HOLLOW = 24;
/**
 * The most a site's ground may cost the mission, in the kernel's own currency: the nats of surprise the correction
 * injects (terrain/condition.js). A mission costs a typical site 5 to 60; a site where it costs more is one where the
 * solve had to fight the ground (measured: 710 and 11,680 at two sites against the plate's coastal falloff), so the next
 * site of the ranking is tried instead, up to SITE_TRIES of them.
 */
export const SITE_NATS = 150;
export const SITE_TRIES = 3;
/** A statement met is one the ground meets to this, plate metres (js/author.js MET_TOLERANCE). */
export const SITE_MET = 0.05;
/** The objectives whose places are fixed before the layout, and what each hands the kernel. */
const AT_PADS = new Set(['activate', 'override', 'barricade']);
const COMBAT = new Set(['waves', 'eliminate', 'boss', 'survive']);

/**
 * One site measured on a square lattice of (2k+1)² points `step` metres apart: `at(i, j)` is the height i, j steps
 * from its centre. Its lowest and highest point, its steepest step, how far its rim (the outer quarter) stands over
 * its core (the inner half), and the score the header describes; `ok` when it is dry and gentle enough to stand on.
 */
function measure(at, k, step) {
  const core = Math.floor(k / 2), rimFrom = k - Math.floor(k / 4);
  let lo = Infinity, hi = -Infinity, slope = 0, coreSum = 0, coreN = 0, rimSum = 0, rimN = 0;
  for (let j = -k; j <= k; j++) for (let i = -k; i <= k; i++) {
    const v = at(i, j);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (i < k && j < k) {
      const sx = (at(i + 1, j) - v) / step, sz = (at(i, j + 1) - v) / step;
      slope = Math.max(slope, Math.sqrt(sx * sx + sz * sz));
    }
    const ring = Math.max(Math.abs(i), Math.abs(j));
    if (ring <= core) { coreSum += v; coreN++; } else if (ring >= rimFrom) { rimSum += v; rimN++; }
  }
  const relief = hi - lo, hollow = rimSum / rimN - coreSum / coreN;
  const score = Math.min(Math.max(hollow, 0), SITE_HOLLOW) - Math.abs(relief - SITE_RELIEF) / 2;
  return { lo, hi, relief, hollow, slope, score, dry: lo > SITE_DRY, ok: lo > SITE_DRY && slope <= SITE_SLOPE };
}

/**
 * The sites of the scan (header), best first; empty when the world has none. Two surveys: every candidate on the
 * SITE_GRID lattice (one grid of the whole plate, shared), then the SITE_SHORTLIST best of those again at
 * SITE_FINE, because a 40 m lattice steps over the 8 m slopes a level's grid will meet. The fine survey ranks;
 * ties go to the first in scan order, in both.
 *
 * @param {(x: number, z: number) => number} height  the world's UNCONDITIONED sampler
 * @param {{size: number}} plate                      the plate (params.terrain)
 * @param {number} span                               the site's edge, plate metres
 * @returns {{sites: {x: number, z: number, lo: number, hi: number, relief: number, hollow: number, slope: number, score: number}[], candidates: number, dry: number}}
 */
export function rankSites(height, plate, span) {
  const G = SITE_GRID, k = Math.round(span / 2 / G);
  const lim = EDGE_START * plate.size / 2 - span / 2;
  const n = Math.floor(lim / G), R = 2 * (n + k) + 1, off = -(n + k) * G;
  const grid = new Float64Array(R * R);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) grid[j * R + i] = height(off + i * G, off + j * G);
  const step = Math.max(1, Math.round(SITE_STRIDE / G));
  const passed = [];
  let candidates = 0, dry = 0;
  for (let cj = k; cj < R - k; cj += step) for (let ci = k; ci < R - k; ci += step) {
    candidates++;
    const m = measure((i, j) => grid[(cj + j) * R + ci + i], k, G);
    if (m.dry) dry++;
    if (m.ok) passed.push({ x: off + ci * G, z: off + cj * G, order: passed.length, score: m.score });
  }
  passed.sort((a, b) => b.score - a.score || a.order - b.order);
  const kf = Math.round(span / 2 / SITE_FINE), round = v => Math.round(v * 100) / 100;
  const sites = [];
  for (const c of passed.slice(0, SITE_SHORTLIST)) {
    const m = measure((i, j) => height(c.x + i * SITE_FINE, c.z + j * SITE_FINE), kf, SITE_FINE);
    if (m.ok) sites.push({ x: c.x, z: c.z, lo: round(m.lo), hi: round(m.hi), relief: round(m.relief), hollow: round(m.hollow), slope: round(m.slope), score: m.score, order: sites.length });
  }
  sites.sort((a, b) => b.score - a.score || a.order - b.order);
  return { sites: sites.map(({ order, score, ...site }) => ({ ...site, score: round(score) })), candidates, dry };
}

/**
 * A site the author chose (the world editor's spawn marker), measured by the same rules as a scanned one: on the plate
 * with the site's whole square inside the edge falloff, dry and gentle enough to stand on. Returns the site in
 * rankSites' shape, or why it cannot be one.
 *
 * @param {(x: number, z: number) => number} height  the world's UNCONDITIONED sampler
 * @param {{size: number}} plate
 * @param {number} span                               the site's edge, plate metres
 * @param {{x: number, z: number}} at                 its centre, plate metres
 * @returns {{site: object} | {reason: string}}
 */
export function measureSite(height, plate, span, at) {
  const lim = EDGE_START * plate.size / 2 - span / 2;
  if (!(Math.abs(at.x) <= lim && Math.abs(at.z) <= lim)) {
    return { reason: `the site at (${Math.round(at.x)}, ${Math.round(at.z)}) is too near the edge of the world: a ${span} m site's centre must be within ${Math.round(lim)} m of the middle` };
  }
  const kf = Math.round(span / 2 / SITE_FINE), round = v => Math.round(v * 100) / 100;
  const m = measure((i, j) => height(at.x + i * SITE_FINE, at.z + j * SITE_FINE), kf, SITE_FINE);
  if (!m.ok) {
    return { reason: !m.dry
      ? `the site at (${Math.round(at.x)}, ${Math.round(at.z)}) reaches the water: every point of its ${span} m must stand ${SITE_DRY} m above the sea`
      : `the site at (${Math.round(at.x)}, ${Math.round(at.z)}) is too steep: a grade of ${round(m.slope)}, where ${SITE_SLOPE} is the most` };
  }
  return { site: { x: at.x, z: at.z, lo: round(m.lo), hi: round(m.hi), relief: round(m.relief), hollow: round(m.hollow), slope: round(m.slope), score: round(m.score), placed: true } };
}

/** The best site of the scan, or null: rankSites' first. */
export function findSite(height, plate, span) {
  return rankSites(height, plate, span).sites[0] ?? null;
}

/** The steps of a compiled mission the kernel can be told about before the layout (header), with their places. */
export function groundSteps(mission, { places = [], square }) {
  const out = [];
  for (const step of mission ?? []) {
    if (AT_PADS.has(step.objective)) {
      const sites = places.filter(p => p.step === step.id).map(p => [p.x, p.z]);
      if (sites.length) out.push({ id: step.id, objective: step.objective, count: sites.length, sites });
    } else if (COMBAT.has(step.objective)) {
      out.push({ id: step.id, objective: step.objective, count: 1, at: [square.x, square.z] });
    } else if (step.objective === 'extract') {
      out.push({ id: step.id, objective: 'extract', count: 1 });
    }
  }
  return out;
}

/**
 * kernelGround's inputs for a level being compiled (world/shooterProject.js), from the generator's own choices
 * only: the project's seed, the mission, the pads where the compiler put them and the default start. A hand
 * edit is never among them (world/level/apply.js says why for the village), so moving a barrel never re-solves
 * the world, and these inputs are the whole cache key.
 *
 * @param {{seed: string}} project       resolved
 * @param {{mission: object[]}} blueprint compiled
 * @param {object[]} placements           the compiler's records so far: a station or a barricade carries
 *                                        `stepId` and `interaction`; a checkpoint carries no interaction
 * @param {object} rules                  the pack's `world` block (size, terrain grid and traversal, square)
 */
export function groundInputs(project, blueprint, placements, rules) {
  const places = placements.filter(p => p.stepId && p.interaction).map(p => ({ step: p.stepId, x: p.x, z: p.z }));
  return {
    seed: project.seed, size: rules.size, cell: rules.terrain.grid, worldParams: project.worldParams ?? null,
    worldSite: project.worldSite ?? null,
    steps: groundSteps(blueprint.mission, { places, square: { x: 0, z: rules.paths.square.z } }),
    spawn: { x: DEFAULT_START.x, z: DEFAULT_START.z }, maxSlope: rules.terrain.traversal.maxSlope,
  };
}

const median = values => {
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * The level's ground, from its seed's world.
 *
 * @param {object} o
 * @param {string} o.seed                  the project's seed (normalised), which names the world
 * @param {number} o.size                  the level's edge, metres (the village's `size`)
 * @param {number} o.cell                  the level's grid step, metres (the village's `terrain.grid`)
 * @param {object[]} o.steps               groundSteps' output
 * @param {{x: number, z: number}} o.spawn the player's start, level metres
 * @param {number} o.maxSlope              the body's steepest stand (the village's traversal)
 * @param {object|null} [o.worldParams]    the world's terrain and water, when it is not the seed's plain world
 * @param {{x: number, z: number}|null} [o.worldSite]  where on the world the mission stands (plate metres), when
 *                                         the author chose; null to scan for the best site
 * @returns {{ok: true, version: number, res: number, size: number, cell: number, heights: number[], min: number, max: number,
 *   heightHash: string, world: object, site: object, frame: object, intent: object, conditioning: object}
 *   | {ok: false, version: number, reason: string, world: object}}
 */
export function kernelGround({ seed, size, cell, steps, spawn, maxSlope, worldParams = null, worldSite = null }) {
  const params = worldParamsFor(seed, worldParams);
  const plain = worldSampler(params);
  const world = { seed: params.seed, size: params.terrain.size, parameterHash: hex(terrainParameterHash(params)),
    ...(worldParams ? { params: worldParams } : {}) };
  // A world that states its own ground (a named world's intent) keeps every statement; the mission's are added.
  const own = Array.isArray(params.terrain.intent) ? params.terrain.intent : [];
  const span = size * SITE_SCALE;
  /* A chosen site is measured, not scanned for: it is the only candidate, and a site the rules refuse is refused by
     name rather than swapped silently for another place on the world. */
  let ranked;
  if (worldSite) {
    const chosen = measureSite(plain, params.terrain, span, worldSite);
    if (!chosen.site) return { ok: false, version: KERNEL_GROUND_VERSION, world, reason: chosen.reason };
    ranked = { sites: [chosen.site], candidates: 1, dry: 1 };
  } else ranked = rankSites(plain, params.terrain, span);
  if (!ranked.sites.length) {
    return { ok: false, version: KERNEL_GROUND_VERSION, world,
      reason: `no ${span} m site on this world stands ${SITE_DRY} m clear of the sea at a grade under ${SITE_SLOPE}` };
  }
  // The first site of the ranking the mission's ground costs no more than SITE_NATS, converged and met. On a world
  // that states its own ground the solve meets the world's statements and the mission's together, and the mission is
  // charged only its own share (the joint cost less the world's alone, which is 0 on a seed's plain world).
  const ownNats = plain.conditioning?.nats ?? 0;
  const tried = [];
  let site = null, frame = null, mission = null, conditioned = null, H = null;
  for (const candidate of ranked.sites.slice(0, SITE_TRIES)) {
    const toPlate = (x, z) => [candidate.x + x * SITE_SCALE, candidate.z + z * SITE_SCALE];
    const stands = [[spawn.x, spawn.z], ...steps.flatMap(s => s.sites ?? (s.at ? [s.at] : []))];
    const floor = Math.round(median(stands.map(([x, z]) => plain(...toPlate(x, z)))) * 100) / 100;
    const f = { originX: candidate.x, originZ: candidate.z, rotation: 0, scale: SITE_SCALE, h: floor, size: params.terrain.size };
    const m = compileMissionIntent({ mission: steps }, { frame: f, traversal: { maxSlope }, spawn: [spawn.x, spawn.z], seed });
    const cp = { ...params, terrain: { ...params.terrain, intent: [...own, ...m.intent] } };
    const h = m.intent.length ? worldSampler(cp) : plain, c = m.intent.length ? h.conditioning : null;
    const cost = c ? { nats: Math.round((c.nats - ownNats) * 100) / 100, miss: Math.round(c.miss * 1e4) / 1e4, converged: c.converged } : { nats: 0, miss: 0, converged: true };
    tried.push({ x: candidate.x, z: candidate.z, ...cost });
    if (cost.converged && cost.nats <= SITE_NATS && cost.miss <= SITE_MET) { site = candidate; frame = f; mission = m; conditioned = cp; H = h; break; }
  }
  if (!site) {
    return { ok: false, version: KERNEL_GROUND_VERSION, world, tried,
      reason: worldSite
        ? `the mission's ground costs more than ${SITE_NATS} nats, or misses, at the site chosen at (${Math.round(worldSite.x)}, ${Math.round(worldSite.z)})`
        : `the mission's ground costs more than ${SITE_NATS} nats, or misses, at each of this world's ${tried.length} best sites` };
  }
  const toPlate = (x, z) => [site.x + x * SITE_SCALE, site.z + z * SITE_SCALE];
  const floor = frame.h;
  const res = Math.floor(size / cell + 0.5) + 1, heights = new Array(res * res);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const v = r4((H(...toPlate(-size / 2 + i * cell, -size / 2 + j * cell)) - floor) / SITE_SCALE);
    heights[j * res + i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const c = mission.intent.length ? H.conditioning : null;
  return {
    ok: true, version: KERNEL_GROUND_VERSION, res, size, cell, heights, min, max, heightHash: hex(gridHash(heights)),
    world: { ...world, conditionedHash: hex(terrainParameterHash(conditioned)) },
    site: { ...site, candidates: ranked.candidates, dry: ranked.dry }, frame, tried,
    intent: { records: mission.intent, sources: mission.sources, rows: mission.rows, notes: mission.notes, maxGrade: mission.maxGrade },
    conditioning: c ? { nats: c.nats - ownNats, miss: c.miss, rows: c.rows, converged: c.converged, dropped: c.dropped,
      ...(ownNats ? { worldNats: ownNats } : {}) } : null,
  };
}

/**
 * THE WORLD AROUND THE LEVEL. A level on its world is 640 m of a 4 km plate, and the rest of the plate is still
 * there: the hills past the rim, the coast, the sea. This is that world at the level's own scale, for a renderer to
 * draw past the meadow (render/ArcadeGround.js): the same conditioned sampler the level's heights came from,
 * through the same map, so the ground past the rim is the ground the level was cut from, and its sea.
 *
 * @param {{world: {seed: string}, frame: {originX: number, originZ: number, scale: number, h: number}, intent: {records: object[]}}} report
 *   a level's `ground` when its kind is 'world' (world/shooterProject.js), or kernelGround's own result
 * @returns {{height: (x: number, z: number) => number, sea: number, plate: {x0: number, x1: number, z0: number, z1: number}}}
 *   height in level metres at a level (x, z); the world's sea level in level metres; the plate's edges in level
 *   metres (past them is open sea)
 */
export function worldAround(report) {
  const params = worldParamsFor(report.world.seed, report.world.params ?? null), records = report.intent?.records ?? [];
  if (!Array.isArray(records)) throw new TypeError('worldAround: the ground report carries no intent records');
  const own = Array.isArray(params.terrain.intent) ? params.terrain.intent : [];
  const H = worldSampler(records.length ? { ...params, terrain: { ...params.terrain, intent: [...own, ...records] } } : params);
  const { originX, originZ, scale, h: floor } = report.frame, half = params.terrain.size / 2;
  const water = Number.isFinite(params.water?.level) ? params.water.level : 0;
  return {
    height: (x, z) => (H(originX + x * scale, originZ + z * scale) - floor) / scale,
    sea: (water - floor) / scale,
    plate: { x0: (-half - originX) / scale, x1: (half - originX) / scale, z0: (-half - originZ) / scale, z1: (half - originZ) / scale },
  };
}
