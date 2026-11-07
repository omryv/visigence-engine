/**
 * Node test for prop placement — the step that turns walkable ground into a level.
 *
 * Nothing here imports three, so it runs under bare node against the real pack and the
 * real nav grid.
 *
 * WHAT IS ACTUALLY AT RISK:
 *
 *   FINISHABLE   props are solid. A crate dropped in the one corridor to an objective
 *                makes a level that looks fine and cannot be completed. The nav flood
 *                proved the ground was connected BEFORE anything was placed on it, and
 *                none of that proof survives placing things. So the flood is re-run with
 *                the props in it, and this is the check that it was.
 *   NO OVERLAP   two props in the same place read as one broken prop.
 *   ON GROUND    a placement off the walkable mask is a crate inside a cliff.
 *   SPREAD       objectives are chosen by farthest-point sampling so the mission crosses
 *                the level. If they cluster, the level is a corridor with a long walk in.
 *   DETERMINISM  same spec, same level — the product's whole claim, reaching the last
 *                stage of the bake.
 *
 * Run:  node tools/test/test-placement.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpec } from '../../src/world/buildSpec.js';
import { bakeHeightField } from '../../src/kernel/terrain/heightfield.js';
import { bakeNavGrid } from '../../src/world/navgrid.js';
import { Terrain } from '../../src/sim/Terrain.js';
import { resolvePack } from '../../src/world/pack.js';
import { placeProps, verifyReachable, SPAWN_CLEARANCE } from '../../src/world/placement.js';
import { inspectGlb } from '../build/inspect-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

/**
 * This repository's contract has always been that it carries no art (see README). A
 * clone without assets/ should get a green suite and a clear note, not a red one — the
 * pack layer is only untestable here, not broken.
 */
if (!fs.existsSync(path.join(ROOT, 'assets'))) {
  console.log('SKIP: no assets/ in this checkout, so there is no art to check a pack against.');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/arcade/pack.json'), 'utf8'));
const measured = {};
for (const m of new Set([...JSON.stringify(manifest).matchAll(/"([^"]+\.glb)"/g)].map((x) => x[1]))) {
  const abs = path.join(ROOT, m);
  if (fs.existsSync(abs)) measured[m] = inspectGlb(abs);
}
const pack = resolvePack(manifest, measured);

function build(recipe, seed, encounters) {
  const spec = resolveSpec({ pack: 'arcade', world: { recipe, seed }, encounters });
  const terrain = new Terrain(bakeHeightField(spec.world, spec.bake.heightRes), spec.traversal);
  const nav = bakeNavGrid(terrain, { gridN: spec.bake.gridN, traversal: spec.traversal });
  return { spec, terrain, nav, out: placeProps({ nav, pack, terrain, seed, encounters: spec.encounters }) };
}

const SEED = 'K7QN-3F2A-9XBD';
const a = build('badlands', SEED, { objectives: 3, coverDensity: 1 });

console.log('\nit places something');
check('props were placed', a.out.placements.length > 20, `${a.out.placements.length}`);
check('the asked-for objectives exist', a.out.objectives.length === 3, `${a.out.objectives.length}`);
check('every placement names a prop in the pack',
  a.out.placements.every((p) => pack.props.some((q) => q.id === p.id)));
check('every placement has a finite position',
  a.out.placements.every((p) => [p.x, p.y, p.z, p.yaw, p.scale].every(Number.isFinite)));

console.log('\nit places them on ground the player can reach');
check('every placement sits on a walkable cell',
  a.out.placements.every((p) => a.nav.walkable[p.cell] === 1),
  `${a.out.placements.filter((p) => !a.nav.walkable[p.cell]).length} off-mask`);
check('every placement sits at its own ground height',
  a.out.placements.every((p) => Math.abs(p.y - a.terrain.heightAt(p.x, p.z)) < 1e-2));
const nearSpawn = a.out.placements.filter((p) => {
  const s = a.nav.spawn;
  return Math.hypot(p.x - s.x, p.z - s.z) < SPAWN_CLEARANCE && p.role === 'cover';
});
check('no cover is dumped on top of the spawn', nearSpawn.length === 0, `${nearSpawn.length} within ${SPAWN_CLEARANCE} m`);

console.log('\nnothing overlaps');
let worstGap = Infinity, overlaps = 0;
for (let i = 0; i < a.out.placements.length; i++) {
  for (let j = i + 1; j < a.out.placements.length; j++) {
    const p = a.out.placements[i], q = a.out.placements[j];
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    const need = p.radius + q.radius;
    worstGap = Math.min(worstGap, d - need);
    if (d < need) overlaps++;
  }
}
check('no two props intersect', overlaps === 0,
  `${overlaps} overlapping pairs, worst gap ${worstGap.toFixed(2)} m`);

console.log('\nthe level is still finishable');
check('every objective is reachable from the spawn with the props in place',
  a.out.allObjectivesReachable);
const verdict = verifyReachable({ nav: a.nav, occupied: a.out.occupied, objectives: a.out.objectives });
check('re-verifying agrees', verdict.allReachable, `${verdict.unreached.length} unreached`);
check('props did not swallow the map',
  a.out.reachableAfter > a.nav.reachable * 0.3,
  `${a.out.reachableAfter} of ${a.nav.reachable} cells still open`);

console.log('\nobjectives cross the level');
const obj = a.out.objectives;
let minPair = Infinity;
for (let i = 0; i < obj.length; i++) {
  for (let j = i + 1; j < obj.length; j++) {
    minPair = Math.min(minPair, Math.hypot(obj[i].x - obj[j].x, obj[i].z - obj[j].z));
  }
}
check('objectives are not clustered', minPair > 40, `closest pair ${minPair.toFixed(1)} m`);
const toSpawn = Math.min(...obj.map((o) => Math.hypot(o.x - a.nav.spawn.x, o.z - a.nav.spawn.z)));
check('the nearest objective is a walk away', toSpawn > 25, `${toSpawn.toFixed(1)} m`);

console.log('\ndeterminism');
const again = build('badlands', SEED, { objectives: 3, coverDensity: 1 });
check('the same spec places the same props',
  JSON.stringify(again.out.placements) === JSON.stringify(a.out.placements),
  `${again.out.placements.length} vs ${a.out.placements.length}`);
const other = build('badlands', 'ZZZZ-ZZZZ-ZZZZ', { objectives: 3, coverDensity: 1 });
check('a different seed places different props',
  JSON.stringify(other.out.placements) !== JSON.stringify(a.out.placements));

console.log('\nthe spec actually controls it');
const bare = build('badlands', SEED, { objectives: 2, coverDensity: 0 });
check('coverDensity 0 places no cover',
  bare.out.placements.every((p) => p.role !== 'cover'),
  `${bare.out.placements.filter((p) => p.role === 'cover').length} cover`);
check('and the objective count is honoured', bare.out.objectives.length === 2);
const dense = build('badlands', SEED, { objectives: 3, coverDensity: 2 });
check('more density places more cover', dense.out.placements.length > a.out.placements.length,
  `${dense.out.placements.length} vs ${a.out.placements.length}`);

console.log('\nevery recipe in the pack can be built');
for (const recipe of pack.terrain.recipes) {
  const r = build(recipe, SEED, { objectives: 3, coverDensity: 1 });
  check(`${recipe}: ${r.out.placements.length} props, objectives reachable`,
    r.out.allObjectivesReachable && r.out.objectives.length > 0,
    `${r.out.objectives.length} objectives`);
}

console.log(failures ? `\nFAILED: ${failures}` : '\nAll placement checks passed.');
process.exit(failures ? 1 : 0);
