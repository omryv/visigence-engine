/**
 * Write tools/test/fixtures/kernel-ground.json: Arcade levels' ground from their seeds' Visigenesis worlds
 * (src/world/kernelGround.js), inputs and output, for the two suites that read it.
 *
 *   tools/test/test-kernel-ground.mjs   rebuilds every entry from its inputs and demands the same heights,
 *                                       so a change anywhere in the kernel that moves this ground is caught;
 *   the world fixtures                  tools/blender/v2/arcade/world_grammar.py lays villages out on these
 *                                       reliefs and tools/test/test-world-placement.mjs holds the JS to them,
 *                                       so both ports shape the kernel's ground alike.
 *
 * The cases are real missions: each genre's template (src/world/missionCard.js quickMission) compiled on its
 * seed, its pads read off the compiled level, exactly as src/world/shooterProject.js hands them over.
 *
 * Run from the repository root, then regenerate the world fixtures (their headers give the commands):
 *     node tools/build/kernel-ground-fixtures.mjs
 */
import fs from 'node:fs';
import { compileShooterProject } from '../../src/world/shooterProject.js';
import { quickMission } from '../../src/world/missionCard.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { kernelGround, groundInputs } from '../../src/world/kernelGround.js';

const OUT = 'tools/test/fixtures/kernel-ground.json';
const CASES = [['K7QN-3F2A-9XBD', 'shooter'], ['HOUS-E5AR-EFUN', 'action'], ['K7QN-3F2A-9XBD', 'arena']];

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json'));
const pack = resolvePack(source, CATALOG.arcade.measurements);
const out = [];
for (const [seed, genre] of CASES) {
  const level = compileShooterProject({ ...quickMission('arcade', seed, genre), ground: 'village' }, pack);
  const inputs = groundInputs(level.project, level.blueprint, level.placements, source.world);
  const g = kernelGround(inputs);
  if (!g.ok) throw new Error(`${seed} ${genre}: ${g.reason}`);
  out.push({ case: `${seed} ${genre}`, inputs, heightHash: g.heightHash, site: g.site, frame: g.frame, res: g.res, heights: g.heights });
}
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`${OUT}: ${out.length} grounds (${out.map(o => `${o.case} ${o.heightHash}`).join(', ')})`);
