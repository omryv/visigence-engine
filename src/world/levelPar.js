/**
 * PAR: how long a compiled level's mission takes to walk, by the repository kernel's own reckoning.
 *
 * src/kernel/core/terrain-reach.js floods a height field with one player body (src/kernel/core/controller.js: what it can
 * stand on, how deep it wades, how fast it walks, Naismith's rule for the climbing) and times the shortest walk
 * between two points. Here the field is the level's FINISHED ground (the heights the player stands on, after the
 * village has levelled its lots and carved its water, world/worldTerrain.js) and the body is this game's: its walk
 * speed (config/gameplay.js PLAYER), and the slope, step and wading depth the level was baked with. The mission is
 * walked in its own order: from the start to every place each step stands at (stations, barricades, checkpoints,
 * drops), nearest first within a step, and back to the extraction point.
 *
 * What the kernel does not see is what stands on the ground: houses, fences, cover. So par is a lower bound on the
 * walk, the route a body would take over open ground, and an objective the kernel cannot reach is one no path
 * through the village could reach either. The game's own nav grid (sim/CollisionSystem.js findPath) is the other
 * walker, with the blockers; tools/test/test-kernel-ground.mjs holds the two to agreeing.
 *
 * Pure: no three, no DOM. Cheap: one flood per leg over the level's 81² grid.
 */
import { CONTROLLER } from '../kernel/core/controller.js';
import { parRoute } from '../kernel/core/terrain-reach.js';
import { PLAYER } from '../config/gameplay.js';

/** The kernel's body, as this game's player: its walk and the traversal the level was baked with. */
export function gameBody(traversal) {
  return { ...CONTROLLER, walk: PLAYER.walkSpeed, maxSlope: traversal.maxSlope, stepUp: traversal.stepUp, wadeDepth: traversal.wade };
}

/**
 * The level's ground as the kernel reads a field: its heights, with every vertex under water deeper than the body
 * wades left out (NaN: terrain-reach.js refuses a cell it cannot read, and the slope beside it), so a pond's deep
 * centre is no more walkable to the kernel than to the nav grid. And `dry`: a wet mask with nothing in it, because
 * the walker reads a cell below its `level` as sea when it is given no mask, and a level's zero is its floor, not a
 * sea (a world's ground stands metres below the floor in its hollows); its only water is the ponds and the brook,
 * already left out.
 */
export function levelField(terrain, wade) {
  const { res, size, heights, depth } = terrain, data = new Float32Array(res * res);
  for (let i = 0; i < data.length; i++) data[i] = depth && depth[i] > wade ? NaN : heights[i];
  return { res, size, data, dry: new Uint8Array(res * res) };
}

/**
 * Par for a compiled level (world/shooterProject.js compileShooterProject), or null for a level with no relief.
 *
 * @param {object} level  compiled; reads `world.terrain`, `blueprint.mission`, `placements`, `spawn`, `extraction`
 * @param {{maxSlope: number, stepUp: number, wade: number}} traversal  the pack's `world.terrain.traversal`
 * @returns {null|{seconds: number|null, metres: number|null, legs: {step: string|null, objective: string, to: number[], seconds: number|null, metres: number|null, verdict: string}[], body: object}}
 *   `seconds` is null when any leg has no route
 */
export function levelPar(level, traversal) {
  const T = level.world?.terrain;
  if (!T) return null;
  const body = gameBody(traversal), field = levelField(T, body.wadeDepth);
  const legs = [];
  let at = [level.spawn.position.x, level.spawn.position.z];
  const walk = (to, step, objective) => {
    const r = parRoute(field, at, to, { controller: body, wet: field.dry });
    legs.push({ step, objective, to, seconds: r.parSeconds === null ? null : Math.round(r.parSeconds * 10) / 10,
      metres: r.distance === null ? null : Math.round(r.distance * 10) / 10, verdict: r.verdict });
    at = to;
  };
  for (const step of level.blueprint?.mission ?? []) {
    if (step.objective === 'extract') continue;
    const places = level.placements.filter(p => p.stepId === step.id && !p.collisionOnly).map(p => [p.x, p.z]);
    // Nearest first, from wherever the walk stands: the order a player takes a step's places in.
    while (places.length) {
      let k = 0;
      for (let i = 1; i < places.length; i++) if (Math.hypot(places[i][0] - at[0], places[i][1] - at[1]) < Math.hypot(places[k][0] - at[0], places[k][1] - at[1])) k = i;
      walk(places.splice(k, 1)[0], step.id, step.objective);
    }
  }
  const out = level.extraction ?? level.spawn.position;
  const extract = level.blueprint?.mission?.find(s => s.objective === 'extract');
  if (legs.length) walk([out.x, out.z], extract?.id ?? null, 'extract');
  // A mission that stands nowhere (an arena's waves in the square) has no legs and a par of nothing to walk.
  const met = legs.every(l => l.seconds !== null);
  const sum = key => Math.round(legs.reduce((s, l) => s + l[key], 0) * 10) / 10;
  return { seconds: met ? sum('seconds') : null, metres: met ? sum('metres') : null, legs,
    body: { walk: body.walk, maxSlope: body.maxSlope, wadeDepth: body.wadeDepth, climb: body.climb.rule } };
}
