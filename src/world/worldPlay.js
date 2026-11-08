/**
 * PLAY ON THE WORLD: the editor's mission played on the world the editor holds, where it was set up, at the world's
 * own scale, drawn by the world engine.
 *
 * A mission has always played on a level: the village of src/world/shooterProject.js, 80 m across, its ground cut from
 * a site of the seed's world at 1:8 (world/kernelGround.js). That is still what Mission and Level edit and what an
 * exported game is. Play in the editor's World view is the other thing: the player stands on the world itself, the one
 * on screen, with its terrain, its sea and rivers, its sky and weather and every building the author placed, and the
 * mission's people and things are brought there.
 *
 * The game's simulation (src/game/Game.js) needs three things of a place, and this module makes each from the world:
 *
 *   the ground    a height field (sim/Terrain.js) sampled from the world engine's own ground every PLAY_CELL metres,
 *                 raised onto any floor a body would step up onto (a plinth, a doorstep); water depth only where the
 *                 sea reaches (kernel/water/flood.js), so a dry hollow below the waterline is dry here too;
 *   the grid      where a body can stand and get to: standable ground (slope, water) that no wall of a placed building
 *                 stands on at foot height, flooded from the start by steps no higher than the body climbs
 *                 (world/navgrid.js reads it the same way);
 *   the start     the editor's spawn marker, or where the level ground found the best site.
 *
 * The area is PLAY_SIZE metres of the world, centred on the level's own origin, which is placed so that the level's
 * start lands on the start chosen on the world. The mission's own things (its pads, gates, cover, pickups and
 * whatever the Level editor placed) keep their places relative to that start, the village's scenery does not come
 * (the world has its own), and a thing whose place on the world is in water, in a wall or out of reach moves to the
 * nearest place that is not, or is left out when it is only cover.
 *
 * Pure: no three, no DOM, no clock, no randomness. The world is read through the functions handed in, so the same
 * world gives the same area, and the node tests hand in a world of their own (tools/test/test-world-play.mjs).
 */
import { Terrain } from '../sim/Terrain.js';
import { gridModuleFor } from './navgrid.js';

/** The edge of the play area, world metres. Twice the village: the mission's places and room round them. */
export const PLAY_SIZE = 160;
/** The ground's sample step and the nav grid's cell, metres (the village level's grid is 0.5 m too). */
export const PLAY_CELL = 0.5;
/** Cells kept unwalkable round the rim, so nothing stands half outside the area. */
export const PLAY_RIM = 3;
/** How far a misplaced mission thing may move to find standing room, metres. */
export const PLAY_REACH = 24;

/**
 * What a world is to this module, in world metres.
 * @typedef {object} PlayWorld
 * @property {(x: number, z: number) => number} ground            the ground's height
 * @property {(x: number, z: number, feetY: number) => number} [floor]  the top of a floor a body standing at feetY
 *   steps onto here, or -Infinity (genesis/player/collide.js surfaceAt)
 * @property {(x: number, z: number, feetY: number) => boolean} [blocked]  a wall at foot-to-head height here
 *   (collide.js blocked)
 * @property {(x: number, z: number) => boolean} [wet]           the sea reaches here (kernel/water/flood.js wetAt)
 * @property {number} waterLevel                                   the waterline, or -Infinity with the water off
 */

/**
 * The play area: the ground and where a body may stand, for PLAY_SIZE metres round `origin`.
 *
 * @param {PlayWorld} world
 * @param {{x: number, z: number}} origin  where the area's centre (the level's (0, 0)) is on the world
 * @param {{maxSlope: number, stepUp: number, wadeDepth: number, slopeEps?: number}} traversal  what a body manages
 * @returns {{terrain: Terrain, local: Uint8Array, n: number, cell: number, size: number, origin: {x: number, z: number}}}
 *   the terrain in LEVEL coordinates (world minus origin; heights are the world's), and the cells standable on their own
 */
export function playArea(world, origin, traversal, { size = PLAY_SIZE, cell = PLAY_CELL } = {}) {
  if (!(Number.isFinite(origin?.x) && Number.isFinite(origin?.z))) throw new Error('playArea: the origin is not a point on the world');
  const half = size / 2, res = Math.round(size / cell) + 1, level = world.waterLevel;
  const heights = new Float32Array(res * res), depth = new Float32Array(res * res);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const wx = origin.x - half + i * cell, wz = origin.z - half + j * cell;
      const g = world.ground(wx, wz);
      // A floor within a step of the ground (a plinth, a deck, a doorstep) is what the feet stand on.
      const f = world.floor ? world.floor(wx, wz, g) : -Infinity;
      const h = f > g ? f : g, at = j * res + i;
      heights[at] = h;
      depth[at] = Number.isFinite(level) && level > g && (!world.wet || world.wet(wx, wz)) ? level - g : 0;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  const terrain = new Terrain({ res, size, data: heights, min, max },
    { ...traversal, waterLevel: Number.isFinite(level) ? level : -1e9, depth: { res, size, data: depth } });
  const n = Math.round(size / cell), local = new Uint8Array(n * n);
  // A wall touching any part of a cell blocks it: the circle round the cell's square.
  const r = cell * Math.SQRT1_2;
  for (let j = PLAY_RIM; j < n - PLAY_RIM; j++) {
    for (let i = PLAY_RIM; i < n - PLAY_RIM; i++) {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      if (!terrain.standableAt(x, z)) continue;
      if (world.blocked && world.blocked(origin.x + x, origin.z + z, terrain.heightAt(x, z), r)) continue;
      local[j * n + i] = 1;
    }
  }
  return { terrain, local, n, cell, size, origin: { x: origin.x, z: origin.z } };
}

const cellOf = (area, x, z) => {
  const i = Math.floor((x + area.size / 2) / area.cell), j = Math.floor((z + area.size / 2) / area.cell);
  return i < 0 || j < 0 || i >= area.n || j >= area.n ? -1 : j * area.n + i;
};
const centreOf = (area, idx) => {
  const i = idx % area.n, j = (idx - i) / area.n;
  return { x: -area.size / 2 + (i + 0.5) * area.cell, z: -area.size / 2 + (j + 0.5) * area.cell };
};

/** The nearest cell of `mask` to (x, z) within `reach` metres, in a fixed order (ties to the first), or null. */
export function nearestCell(area, mask, x, z, reach = PLAY_REACH) {
  const at = cellOf(area, x, z);
  if (at >= 0 && mask[at]) return centreOf(area, at);
  const ci = Math.floor((x + area.size / 2) / area.cell), cj = Math.floor((z + area.size / 2) / area.cell);
  const R = Math.ceil(reach / area.cell);
  for (let k = 1; k <= R; k++) {
    let best = -1, bestD = Infinity;
    for (let j = cj - k; j <= cj + k; j++) {
      for (let i = ci - k; i <= ci + k; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== k) continue;
        if (i < 0 || j < 0 || i >= area.n || j >= area.n) continue;
        const idx = j * area.n + i;
        if (!mask[idx]) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bestD) { bestD = d; best = idx; }
      }
    }
    if (best >= 0) return centreOf(area, best);
  }
  return null;
}

/** Everything reachable from `from` by steps no higher than `stepUp`, as a new mask. */
export function reachFrom(area, local, from, stepUp) {
  const n = area.n, out = new Uint8Array(n * n), start = cellOf(area, from.x, from.z);
  if (start < 0 || !local[start]) return { walkable: out, reachable: 0 };
  const h = new Float32Array(n * n);
  for (let idx = 0; idx < n * n; idx++) if (local[idx]) { const c = centreOf(area, idx); h[idx] = area.terrain.heightAt(c.x, c.z); }
  const queue = new Int32Array(n * n);
  let head = 0, tail = 0;
  out[start] = 1; queue[tail++] = start;
  while (head < tail) {
    const idx = queue[head++], i = idx % n, j = (idx - i) / n;
    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? -1 : d === 1 ? 1 : 0), nj = j + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const m = nj * n + ni;
      if (out[m] || !local[m] || Math.abs(h[m] - h[idx]) > stepUp) continue;
      out[m] = 1; queue[tail++] = m;
    }
  }
  return { walkable: out, reachable: tail };
}

/** Cover and dressing: left out where the world has no room for it, rather than moved. */
const isCover = (p) => !p.stepId && !p.interaction && !p.pickup && !/^(checkpoint|respawn|gear)$/.test(p.role ?? '') && !p.entity;
/** The placement a record belongs to (a house's blocks, a tree's trunk, a gate's padlock), by key. */
const ownerKey = (p) => p.parent ?? (p.lockOf != null ? `entity:${p.lockOf}` : null);

/**
 * The compiled level (shooterProject.js compileShooterProject), brought onto the world.
 *
 * @param {object} level   what compileShooterProject returned for the editor's mission
 * @param {PlayWorld} world
 * @param {{x: number, z: number}} start   where on the world the player starts, world metres
 * @param {object} traversal               what a body manages (the pack's world.terrain.traversal, as Terrain reads it)
 * @returns {object} a level Game takes (`new Game({ level })`), its coordinates the area's (world minus `playArea.origin`),
 *   with `playArea` ({origin, size, cell, moved, dropped, reachable}) saying where it is and what had to give way
 */
export function worldLevel(level, world, start, traversal, opts = {}) {
  if (!(Number.isFinite(start?.x) && Number.isFinite(start?.z))) throw new Error('worldLevel: the start is not a point on the world');
  const s0 = level.spawn.position;
  const origin = { x: start.x - s0.x, z: start.z - s0.z };
  const area = playArea(world, origin, traversal, opts);
  // The start itself, moved onto standing room when the chosen spot is in water or a wall.
  const stand = nearestCell(area, area.local, s0.x, s0.z, area.size / 2);
  if (!stand) throw new Error(`there is no ground to stand on within ${area.size / 2} m of the start (${Math.round(start.x)}, ${Math.round(start.z)})`);
  const { walkable, reachable } = reachFrom(area, area.local, stand, traversal.stepUp);
  const T = area.terrain, moved = [], dropped = [];
  const seat = (p, x, z) => {
    const r = p.collision === 'circle' ? Math.min(p.radius || 0.3, 1.2) : p.collision === 'box' ? Math.min(p.halfX || 0.3, p.halfZ || 0.3, 1.2) : 0.3;
    const y = Math.min(T.heightAt(x, z), T.heightAt(x + r, z), T.heightAt(x - r, z), T.heightAt(x, z + r), T.heightAt(x, z - r));
    return { ...p, x: +x.toFixed(3), z: +z.toFixed(3), y: +y.toFixed(4) };
  };
  // The mission's own things (the village's scenery stays behind: the world has its own). A thing with an owner (a
  // placed house's blocks, a tree's trunk, a gate's padlock) goes where its owner went, or nowhere.
  const mine = level.placements.filter((p) => !p.village), placements = [], shift = new Map();
  for (const p of mine) {
    if (ownerKey(p)) continue;
    let at = { x: p.x, z: p.z };
    const idx = cellOf(area, p.x, p.z);
    if (idx < 0 || !walkable[idx]) {
      const near = isCover(p) ? null : nearestCell(area, walkable, p.x, p.z);
      if (!near) { dropped.push(p.key ?? p.id); if (p.key) shift.set(p.key, null); continue; }
      at = near; moved.push(p.key ?? p.id);
    }
    if (p.key) shift.set(p.key, { dx: at.x - p.x, dz: at.z - p.z });
    placements.push(seat(p, at.x, at.z));
  }
  for (const p of mine) {
    const owner = ownerKey(p);
    if (!owner) continue;
    const d = shift.get(owner);
    if (!d) continue;
    placements.push(seat(p, p.x + d.dx, p.z + d.dz));
  }
  const onWorld = (q) => { const c = nearestCell(area, walkable, q.x, q.z); return c ? { ...q, x: c.x, z: c.z, y: +T.heightAt(c.x, c.z).toFixed(4) } : null; };
  const ex = level.extraction;
  const extraction = ex && (ex.x !== s0.x || ex.z !== s0.z) ? onWorld(ex) ?? { ...stand, y: T.heightAt(stand.x, stand.z) } : { x: stand.x, y: +T.heightAt(stand.x, stand.z).toFixed(4), z: stand.z, key: ex?.key ?? null };
  const nav = { gridN: area.n, cell: area.cell, origin: { x: -area.size / 2, z: -area.size / 2 }, walkable };
  return {
    ...level,
    terrain: T,
    grid: gridModuleFor(nav, area.size),
    spawn: { ...level.spawn, position: { x: stand.x, y: +T.heightAt(stand.x, stand.z).toFixed(4), z: stand.z } },
    placements,
    buildings: [],
    world: null,
    extraction,
    spawnZones: (level.spawnZones ?? []).filter((z) => { const i = cellOf(area, z.x, z.z); return i >= 0 && walkable[i]; }),
    playArea: { origin, size: area.size, cell: area.cell, moved, dropped, reachable },
  };
}

/**
 * The world as the world engine answers it (src/genesis/Engine.js), for playArea and worldLevel. Kept here, beside
 * what reads it, so the editor and a test bench make the same world of the same engine.
 *
 * @param {{sampleHeight: Function, blockers?: object, water?: {flood: object}, params: object}} engine
 * @param {(flood: object, x: number, z: number) => boolean|null} wetAt  kernel/water/flood.js wetAt
 * @returns {PlayWorld}
 */
export function engineWorld(engine, wetAt) {
  const water = engine.params?.water ?? {};
  const B = engine.blockers;
  return {
    ground: (x, z) => engine.sampleHeight(x, z),
    floor: B ? (x, z, y) => B.surfaceAt(x, z, y, 0.05, null) : undefined,
    blocked: B ? (x, z, y, r = 0.35) => B.blocked(x, z, y, r, null) : undefined,
    wet: (x, z) => wetAt(engine.water?.flood ?? null, x, z) !== false,
    waterLevel: water.enabled === false ? -Infinity : (water.level || 0),
  };
}
