/** Shared in-memory compiler. File loading and rendering belong to the caller. */
import { resolveSpec } from './buildSpec.js';
import { bakeHeightField } from '../kernel/terrain/heightfield.js';
import { bakeNavGrid, gridModuleFor } from './navgrid.js';
import { placeProps } from './placement.js';
import { Terrain, terrainFromBaked } from '../sim/Terrain.js';

export function compileLevel(input = {}, { pack = null } = {}) {
  const spec = resolveSpec(input);
  if (spec.pack && pack?.id !== spec.pack) {
    throw new Error(`Load and resolve pack "${spec.pack}" before compiling this level`);
  }
  const terrain = new Terrain(bakeHeightField(spec.world, spec.bake.heightRes), spec.traversal);
  const nav = bakeNavGrid(terrain, { gridN: spec.bake.gridN, traversal: spec.traversal });
  if (!nav.spawn) throw new Error('Level has no reachable spawn');
  const placed = pack ? placeProps({ nav, pack, terrain, seed: spec.world.seed,
    encounters: spec.encounters }) : { placements: [], allObjectivesReachable: true };
  if (!placed.allObjectivesReachable) throw new Error('Level has unreachable objectives');
  return { spec, terrain, nav, grid: gridModuleFor(nav, terrain.size),
    spawn: { position: { ...nav.spawn }, yaw: 0, pitch: 0 }, placements: placed.placements };
}

/** Consume the existing baker's module exports without regenerating its world. */
export function levelFromBaked(baked) {
  return { spec: baked.SPEC, terrain: terrainFromBaked(baked, baked.SPEC?.traversal),
    grid: baked, spawn: baked.SPAWN, placements: baked.PLACEMENTS ?? [] };
}
