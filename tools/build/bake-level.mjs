/**
 * BAKE A BUILD SPEC INTO A LEVEL. This is the compiler.
 *
 *   node tools/build/bake-level.mjs                        # the default spec
 *   node tools/build/bake-level.mjs my.build.json          # a spec from disk
 *   node tools/build/bake-level.mjs --seed K7QN-3F2A-9XBD --recipe alpine
 *   node tools/build/bake-level.mjs --out src/world/levels/alpine.generated.js
 *
 * In goes a couple of kilobytes of choices; out comes the module `CollisionSystem` and
 * `Terrain` read. Nothing between the two is a model, a service or a network call — it
 * is arithmetic over a seed, and the same spec produces byte-identical output on any
 * machine. That is what makes a "generation" cost nothing to serve twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ACTUALLY DECIDES
 * ---------------------------------------------------------------------------
 * Two products, from one height field:
 *
 *   HEIGHT_PACKED     the field itself, Float32 -> base64. What the player stands on.
 *   WALKABLE_PACKED   one bit per grid cell: can a player be here at all. What
 *                     `CollisionSystem` has always unpacked, unchanged.
 *
 * A cell is walkable when the ground under it is not too steep and not under more water
 * than you can wade — and then, crucially, when it is REACHABLE. Slope and depth are
 * local tests and they will happily declare a flat shelf halfway up a cliff walkable,
 * because nothing about that shelf is steep. It is just somewhere no player can get to.
 *
 * So the last pass is a flood fill from the spawn over cells a player can actually STEP
 * between — neighbour to neighbour, rejecting any rise greater than `traversal.stepUp`.
 * Everything the flood does not reach is cleared. This is the same argument
 * the repository kernel makes in `src/kernel/core/reach.js`: a graph can certify that every
 * room has a door and the geometry can still be a building you cannot enter, so the
 * only honest test is to walk it. The flood is that walk, done once, offline.
 *
 * ---------------------------------------------------------------------------
 * AND WHAT IT REFUSES
 * ---------------------------------------------------------------------------
 * It exits non-zero when the level it just baked is not playable: no reachable ground,
 * or so little of it that the spec produced a world nobody can move in. A baker that
 * silently emits an unplayable level is worse than one that fails, because the failure
 * then surfaces in front of a player instead of in front of a build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpec, parseSpec, TERRAIN_RECIPES } from '../../src/world/buildSpec.js';
import { createHeightSampler, bakeHeightField } from '../../src/kernel/terrain/heightfield.js';
import { Terrain } from '../../src/sim/Terrain.js';
import { bakeNavGrid, packBits } from '../../src/world/navgrid.js';
import { resolvePack } from '../../src/world/pack.js';
import { placeProps } from '../../src/world/placement.js';
import { inspectGlb } from './inspect-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ─────────────────────────────── arguments ─────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const specFile = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

let spec;
if (specFile && fs.existsSync(path.resolve(ROOT, specFile))) {
  spec = parseSpec(fs.readFileSync(path.resolve(ROOT, specFile), 'utf8'));
} else {
  const world = {};
  if (flag('seed')) world.seed = flag('seed');
  if (flag('recipe')) world.recipe = flag('recipe');
  spec = resolveSpec(Object.keys(world).length ? { world } : {});
}

const outPath = flag('out')
  || `src/world/levels/${spec.world.recipe}-${spec.specHash}.generated.js`;

/* ──────────────────────────────── the bake ─────────────────────────────── */

const t0 = Date.now();
const { gridN, heightRes } = spec.bake;
const { size } = spec.world.terrain;
const trav = spec.traversal;

console.log(`spec  ${spec.world.recipe} / ${spec.world.seed} -> ${spec.specHash}`);
console.log(`world ${size} m across, ${gridN}x${gridN} nav grid (${(size / gridN).toFixed(3)} m cells), ${heightRes}^2 height field`);

const analytic = createHeightSampler(spec.world);
const field = bakeHeightField(spec.world, heightRes, analytic);
const terrain = new Terrain(field, trav);
console.log(`relief ${field.min.toFixed(1)} m to ${field.max.toFixed(1)} m`);

/**
 * The nav grid. One implementation, shared with the walker and the browser preview —
 * see src/world/navgrid.js for why a second copy of this is a second opinion about what
 * is walkable.
 */
const nav = bakeNavGrid(terrain, { gridN, traversal: trav });
const cell = nav.cell;
const originX = nav.origin.x;
const originZ = nav.origin.z;
const { walkable, heights: height, localCount, reachable: reach, stranded } = nav;

console.log(`pass 1  ${localCount} of ${gridN * gridN} cells are flat enough and dry enough`);
if (nav.spawnIndex < 0) {
  console.error('FAILED: no cell in this world is standable. The spec is unplayable.');
  process.exit(1);
}
console.log(`pass 2  ${reach} reachable from the centre (${stranded} stranded and cleared)`);

/* ────────────────────────────── the verdict ───────────────── */

const MIN_PLAYABLE_CELLS = 2000;
const MIN_PLAYABLE_FRACTION = 0.02;
const fraction = reach / (gridN * gridN);
if (reach < MIN_PLAYABLE_CELLS || fraction < MIN_PLAYABLE_FRACTION) {
  console.error(
    `FAILED: only ${reach} cells (${(fraction * 100).toFixed(2)}%) are reachable — ` +
    `below the ${MIN_PLAYABLE_CELLS}-cell / ${MIN_PLAYABLE_FRACTION * 100}% floor. ` +
    `This spec bakes a world there is nowhere to play in.`);
  process.exit(1);
}

/* ────────────────────────── the pack, and what it puts down ────────────── */

/**
 * The first click. A spec with no pack bakes bare ground, which is what every spec built
 * before packs existed asks for by saying nothing.
 */
let pack = null;
let placed = { placements: [], objectives: [], rejected: [], allObjectivesReachable: true };
if (spec.pack) {
  const manifestPath = path.join(ROOT, 'packs', spec.pack, 'pack.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`FAILED: spec names pack "${spec.pack}" but ${path.relative(ROOT, manifestPath)} does not exist.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Measured from the files, so a re-exported asset changes the scale rather than
  // silently disagreeing with a number written down months ago.
  const measured = {};
  for (const a of new Set([...JSON.stringify(manifest).matchAll(/"([^"]+\.glb)"/g)].map((m) => m[1]))) {
    const abs = path.join(ROOT, a);
    if (fs.existsSync(abs)) measured[a] = inspectGlb(abs);
  }
  pack = resolvePack(manifest, measured);
  console.log(`pack  ${pack.label} — ${Object.keys(pack.weapons).length} weapons, ${pack.props.length} props`);

  placed = placeProps({ nav, pack, terrain, seed: spec.world.seed, encounters: spec.encounters });
  console.log(`props ${placed.placements.length} placed `
    + `(${placed.objectives.length} objectives, `
    + `${placed.placements.length - placed.objectives.length} cover)`
    + (placed.rejected.length ? `, ${placed.rejected.length} rejected` : ''));

  if (!placed.allObjectivesReachable) {
    console.error('FAILED: an objective is not reachable from the spawn even after clearing props.');
    process.exit(1);
  }
}

/* ──────────────────────────────── emit ─────────────────────────────────── */

const spawn = {
  x: +nav.spawn.x.toFixed(4), y: +nav.spawn.y.toFixed(4), z: +nav.spawn.z.toFixed(4),
};

const out = `/**
 * GENERATED by tools/build/bake-level.mjs — do not edit.
 *
 * Rebuild:  node tools/build/bake-level.mjs --seed ${spec.world.seed} --recipe ${spec.world.recipe}
 *
 * This module is the shape \`CollisionSystem\` and \`Terrain\` read. It carries no
 * geometry and no art: the ground is a height field and the navigation is one bit per
 * cell, both derived from the spec below and reproducible from it alone.
 */

/** The spec this was baked from. Same spec in, byte-identical module out. */
export const SPEC = ${JSON.stringify(spec, null, 2).replace(/\n/g, '\n')};

export const SPEC_HASH = ${JSON.stringify(spec.specHash)};

/* ── what CollisionSystem reads ─────────────────────────────────────────── */
export const WORLD_SCALE = ${size};
export const GRID_N = ${gridN};
export const CELL_SIZE = ${size / gridN};
export const GRID_ORIGIN = { x: ${originX}, z: ${originZ} };
export const WORLD_SCALE_Y = ${Math.ceil(Math.max(Math.abs(field.min), Math.abs(field.max)) * 2)};
export const WALL_HEIGHT = ${(+(field.max - field.min).toFixed(4))};
export const MAZE_BOUNDS = { min: { x: -0.5, z: -0.5 }, max: { x: 0.5, z: 0.5 } };
export const WALKABLE_PACKED = '${packBits(walkable)}';

/* ── what Terrain reads ─────────────────────────────────────────────────── */
export const HEIGHT_RES = ${heightRes};
export const HEIGHT_PACKED = '${Buffer.from(field.data.buffer).toString('base64')}';

/* ── where to put the player ────────────────────────────────────────────── */
export const SPAWN = { position: ${JSON.stringify(spawn)}, yaw: 0, pitch: 0 };

/* ── what the pack put on the ground ────────────────────────────────────── */
export const PACK = ${pack ? JSON.stringify(pack.id) : 'null'};
export const PLACEMENTS = ${JSON.stringify(placed.placements)};
export const OBJECTIVES = ${JSON.stringify(placed.objectives.map((o) => o.objectiveIndex))};

/** Bake statistics, for the record rather than for the runtime. */
export const BAKE = {
  reachableCells: ${reach},
  reachableFraction: ${+fraction.toFixed(5)},
  strandedCells: ${stranded},
  placements: ${placed.placements.length},
  objectives: ${placed.objectives.length},
  rejectedPlacements: ${placed.rejected.length},
  minHeight: ${+field.min.toFixed(4)},
  maxHeight: ${+field.max.toFixed(4)},
};
`;

const abs = path.resolve(ROOT, outPath);
fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.writeFileSync(abs, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`wrote ${outPath} (${kb} KB) in ${Date.now() - t0} ms`);
console.log(`spawn at ${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}, ${spawn.z.toFixed(1)}`);
