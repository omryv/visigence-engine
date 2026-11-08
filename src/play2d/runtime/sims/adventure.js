/**
 * Adventure: explore a top-down world. Villagers talk, chests open, crates push, levers and
 * plates drive gates, keys unlock them, warp flowers connect far corners, and a night level
 * can go dark around a pool of lantern light. The engine is shared with the arena
 * (topdown.js); this module only names the genre.
 */
import { createTopdownSim } from './topdown.js';

export function createAdventureSim(project, levelIndex = 0, opts = {}) {
  return createTopdownSim(project, levelIndex, opts, 'adventure');
}
