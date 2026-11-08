/**
 * Arena shooter: twin-stick waves in a walled arena. Burrows release critters in waves,
 * bushes and crates break under fire, King Slime splits as it weakens. The engine is shared
 * with the adventure (topdown.js); this module only names the genre.
 */
import { createTopdownSim } from './topdown.js';

export function createArenaSim(project, levelIndex = 0, opts = {}) {
  return createTopdownSim(project, levelIndex, opts, 'arena');
}
