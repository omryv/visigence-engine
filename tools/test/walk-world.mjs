/**
 * WALK THE BAKED WORLD, AND SAY WHETHER IT IS A PLACE.
 *
 *   node --import ./tools/lib/_three-real-hook.mjs tools/test/walk-world.mjs
 *   node --import ./tools/lib/_three-real-hook.mjs tools/test/walk-world.mjs --recipe alpine
 *
 * Everything before this ran the pipeline and looked at the result. This DRIVES it: the
 * real `sim/PlayerController`, on the real `sim/CollisionSystem`, over the real baked
 * `sim/Terrain`, at the real fixed step, with synthetic input. No mock stands in for
 * anything, because every fault worth finding here lives in the seam between two of
 * those and a mock is exactly where a seam goes missing.
 *
 * The idea is borrowed from the repository kernel's own `tools/walk-world.mjs`, which argues that
 * a graph can certify every room has a door and the building can still be one you cannot
 * enter — so the only honest test is to walk it. The same argument applies here with the
 * pieces swapped: the baker's flood fill certifies that a cell is reachable cell-to-cell
 * at `stepUp`, and the player does not move cell-to-cell. It moves 7 cm per tick through
 * continuous space under acceleration, sliding along blocked cells. Whether THAT body
 * can cross THAT ground is a different question, and this is the only thing that asks it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY EACH ONE IS A REAL FAILURE MODE
 * ---------------------------------------------------------------------------
 *   GROUNDED      the player never falls through the world and never floats. Both are
 *                 silent: falling reads as a loading bug, floating as bad animation.
 *   IN BOUNDS     every position the player occupies is an OPEN cell of the collision
 *                 grid. This is the baker-versus-runtime agreement test: the mask was
 *                 baked from slope, depth and reach, and if the body can stand somewhere
 *                 the mask calls solid, the two halves have drifted.
 *   STEP          the largest single-tick rise. The controller has NO step limit — it
 *                 snaps to ground height — so it relies entirely on the mask to never
 *                 offer it a wall. If this approaches `stepUp` the player is climbing
 *                 terrain the flood fill thought it had excluded.
 *   PROGRESS      full forward input actually moves the body. A player wedged on a slope
 *                 or oscillating against a cell boundary reads as "the controls broke".
 *   FINITE        no NaN in position or velocity. One NaN ends the simulation silently.
 *   DETERMINISM   the same inputs from the same spawn produce a bit-identical path. This
 *                 is the product's core claim reaching all the way into the simulation,
 *                 and it is the precondition for replay, for netcode and for a bug ever
 *                 being reproducible from a seed.
 */

import { PerspectiveCamera } from 'three/webgpu';
import { CollisionSystem } from '../../src/sim/CollisionSystem.js';
import { Terrain, terrainFromBaked } from '../../src/sim/Terrain.js';
import { Game } from '../../src/game/Game.js';
import { resolveSpec } from '../../src/world/buildSpec.js';
import { bakeHeightField } from '../../src/kernel/terrain/heightfield.js';
import { bakeNavGrid, gridModuleFor } from '../../src/world/navgrid.js';
import { FIXED_STEP, PLAYER } from '../../src/config/gameplay.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const recipe = flag('recipe', 'highlands');
const seed = flag('seed', 'K7QN-3F2A-9XBD');
const HEADINGS = Number(flag('headings', '16'));
const SECONDS = Number(flag('seconds', '12'));
const STEPS = Math.round(SECONDS / FIXED_STEP);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

/* ── bake the same world the game would load ────────────────────────────── */

const spec = resolveSpec({ world: { recipe, seed } });
const field = bakeHeightField(spec.world, spec.bake.heightRes);
const terrain = new Terrain(field, spec.traversal);

/**
 * The nav grid, from the one implementation all three consumers share
 * (src/world/navgrid.js). Rebuilt here rather than read from a generated module so the
 * walk has no build step of its own and cannot go stale against a spec.
 */
const nav = bakeNavGrid(terrain, { gridN: spec.bake.gridN, traversal: spec.traversal });
const collision = new CollisionSystem(gridModuleFor(nav, spec.world.terrain.size));
const size = spec.world.terrain.size;
const trav = spec.traversal;

const SPAWN = { position: { x: nav.spawn.x, z: nav.spawn.z }, yaw: 0, pitch: 0 };

console.log(`\n${recipe} / ${seed}  ->  spec ${spec.specHash}`);
console.log(`${size} m world, ${nav.gridN}² grid (${nav.cell.toFixed(3)} m cells), ${nav.reachable} reachable cells`);
console.log(`walking ${HEADINGS} headings x ${SECONDS}s @ ${(1 / FIXED_STEP).toFixed(0)} Hz `
  + `= ${(HEADINGS * STEPS).toLocaleString()} fixed steps`);
console.log(`body: radius ${PLAYER.radius} m, walkSpeed ${PLAYER.walkSpeed} m/s, `
  + `spec stepUp ${trav.stepUp} m, maxSlope ${trav.maxSlope}\n`);

/* ── the walk ───────────────────────────────────────────────────────────── */

/** One heading, from the spawn, full forward input. Returns what happened. */
function walk(headingIndex, { record = false } = {}) {
  const camera = new PerspectiveCamera(60, 1.6, 0.1, 1000);
  const game = new Game({ camera, level: { spec, terrain, grid: gridModuleFor(nav, size), spawn: SPAWN } });
  game.start();
  const player = game.player;
  player.yaw = (headingIndex / HEADINGS) * Math.PI * 2;

  const move = { x: 0, y: 1 };
  const out = {
    fellThrough: 0, floated: 0, offMask: 0, nonFinite: 0,
    maxRise: 0, maxDrop: 0, distance: 0, netDistance: 0,
    stalledTicks: 0, path: record ? [] : null,
    minY: Infinity, maxY: -Infinity,
  };

  let px = player.position.x, pz = player.position.z, py = player.position.y;
  const x0 = px, z0 = pz;

  for (let s = 0; s < STEPS; s++) {
    game.step({ move });
    const { x, y, z } = player.position;

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
      || !Number.isFinite(player.velocity.y)) { out.nonFinite++; break; }

    const ground = terrain.heightAt(x, z);
    // Falling through: below the world's own floor by more than a body.
    if (y < terrain.min - 1) out.fellThrough++;
    // Floating: reported grounded while measurably above the ground.
    if (player.grounded && y - ground > 0.05) out.floated++;
    // The agreement test: is the body inside a cell the mask calls open?
    if (!collision.isOpenAt(x, z)) out.offMask++;

    const dy = y - py;
    if (dy > out.maxRise) out.maxRise = dy;
    if (dy < out.maxDrop) out.maxDrop = dy;
    if (y < out.minY) out.minY = y;
    if (y > out.maxY) out.maxY = y;

    const stepDist = Math.hypot(x - px, z - pz);
    out.distance += stepDist;
    // Stalled: full forward input producing less than a tenth of walk speed.
    if (stepDist < PLAYER.walkSpeed * FIXED_STEP * 0.1) out.stalledTicks++;

    if (record) out.path.push([+x.toFixed(6), +y.toFixed(6), +z.toFixed(6)]);
    px = x; py = y; pz = z;
  }

  out.netDistance = Math.hypot(px - x0, pz - z0);
  out.final = [px, py, pz];
  /**
   * WHY DID IT STOP? Probe the mask straight ahead of where the body finished.
   *
   * This distinction is the difference between testing the engine and testing the world.
   * "Every heading travelled more than 2 m" sounds like an engine property and is not
   * one: `alpine` has 8,447 reachable cells out of 102,400, so several headings out of
   * the spawn face a cliff within a metre, and a body that refuses to walk into a cliff
   * is the engine WORKING. Measured on alpine, the correlation is exact — every heading
   * that ran the full distance had open ground ahead of it and every heading that
   * stopped had closed cells at 0.5, 1 and 2 m.
   *
   * So the fault is not "stopped". The fault is "stopped with somewhere to go".
   */
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  out.wayAhead = [0.5, 1.0, 2.0].some((d) => collision.isOpenAt(px + fx * d, pz + fz * d));
  game.dispose();
  return out;
}

const runs = [];
for (let h = 0; h < HEADINGS; h++) runs.push(walk(h));

const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
const worst = (f) => runs.reduce((a, r) => Math.max(a, f(r)), 0);
const totalTicks = HEADINGS * STEPS;

console.log('integrity');
check('the player never fell through the world', sum((r) => r.fellThrough) === 0,
  `${sum((r) => r.fellThrough)} ticks below the floor`);
check('the player never floated while grounded', sum((r) => r.floated) === 0,
  `${sum((r) => r.floated)} ticks`);
check('position and velocity stayed finite', sum((r) => r.nonFinite) === 0);
check('the body never left the walkable mask', sum((r) => r.offMask) === 0,
  `${sum((r) => r.offMask)} of ${totalTicks.toLocaleString()} ticks outside an open cell`);

console.log('\ntraversal');
const stopped = runs.filter((r) => r.netDistance <= 2);
const wedged = stopped.filter((r) => r.wayAhead);
check('nothing stopped while it still had somewhere to go', wedged.length === 0,
  `${wedged.length} heading(s) stalled with open ground ahead`);
if (stopped.length) {
  console.log(`  ..   ${stopped.length}/${HEADINGS} heading(s) blocked within 2 m, all of them `
    + `against closed cells — this world is cramped, not broken`);
}
const stallPct = (sum((r) => r.stalledTicks) / totalTicks) * 100;
check('the body is not wedged most of the time', stallPct < 35,
  `${stallPct.toFixed(1)}% of ticks moved less than a tenth of walk speed`);
const meanNet = sum((r) => r.netDistance) / HEADINGS;
const ideal = PLAYER.walkSpeed * SECONDS;
console.log(`  ..   mean net displacement ${meanNet.toFixed(1)} m of a possible ${ideal.toFixed(0)} m `
  + `(${((meanNet / ideal) * 100).toFixed(0)}% — the rest is terrain, not a fault)`);

console.log('\nstep');
const rise = worst((r) => r.maxRise);
check('no single tick climbed more than the spec allows', rise <= trav.stepUp,
  `worst single-tick rise ${rise.toFixed(4)} m vs stepUp ${trav.stepUp} m`);
console.log(`  ..   worst rise ${(rise * 1000).toFixed(1)} mm, worst drop `
  + `${(Math.min(...runs.map((r) => r.maxDrop)) * 1000).toFixed(1)} mm per tick`);
console.log(`  ..   altitude range walked: `
  + `${Math.min(...runs.map((r) => r.minY)).toFixed(1)} m to `
  + `${Math.max(...runs.map((r) => r.maxY)).toFixed(1)} m`);

console.log('\ndeterminism');
const a = walk(0, { record: true });
const b = walk(0, { record: true });
check('the same heading walks a bit-identical path twice',
  JSON.stringify(a.path) === JSON.stringify(b.path),
  `${a.path.length} vs ${b.path.length} samples`);
check('and lands on exactly the same spot',
  a.final.every((v, i) => v === b.final[i]),
  `${a.final.map((v) => v.toFixed(6))} vs ${b.final.map((v) => v.toFixed(6))}`);

console.log(failures
  ? `\nFAILED: ${failures}`
  : `\nThe engine walks. ${totalTicks.toLocaleString()} fixed steps, no faults.`);
process.exit(failures ? 1 : 0);
