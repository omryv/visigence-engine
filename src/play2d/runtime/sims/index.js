/**
 * One door to every genre's simulation. `createSim(project, levelIndex, opts)` returns a sim
 * (see shared.js for the fields every genre fills) whose `step(input)` advances 1/60 s.
 *
 *   opts.spawn    { x, y } cell to start the player at (the editor's "play from here")
 *   opts.seed     overrides the level's own seed for critters' random choices
 *   opts.attempt  the retry number, mixed into the default seed
 */
import { createPlatformerSim } from './platformer.js';
import { createAdventureSim } from './adventure.js';
import { createArenaSim } from './arena.js';
import { createMazeSim } from './maze.js';
import { createPuzzleSim } from './puzzle.js';

const FACTORIES = {
  platformer: createPlatformerSim,
  adventure: createAdventureSim,
  arena: createArenaSim,
  maze: createMazeSim,
  puzzle: createPuzzleSim,
};

export function createSim(project, levelIndex = 0, opts = {}) {
  const make = FACTORIES[project.genre];
  if (!make) throw new Error(`No simulation for genre "${project.genre}"`);
  return make(project, levelIndex, opts);
}

export { emptyInput, STEP, starsFor, mazeDots } from './shared.js';
