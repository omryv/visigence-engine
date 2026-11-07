/**
 * The runtime side of the genre table: what each genre builds and how it plays.
 *
 * genres/registry.js is the data (pools, objectives, cameras) and imports no three; this
 * module maps a genre id to its rules object, which the session consults at two points:
 *
 *   createSystems(session, game, {pools, project})  the systems handed to Game's bag
 *   input(session, rawInput)                          the fixed-step input, genre-shaped
 *
 * plus `view` ('first', 'follow' or 'overhead'), `pointerLock`, and for the genres that show
 * the hero `createPlayerVisual` (its model and clips) and `updateCamera` (where the camera goes).
 */
import { shooterRules } from './shooter/rules.js';
import { explorationRules } from './exploration/rules.js';
import { actionRules } from './action/rules.js';
import { arenaRules } from './arena/rules.js';
import { collectRules } from './collect/rules.js';

const RULES = { shooter: shooterRules, exploration: explorationRules, action: actionRules, arena: arenaRules, collect: collectRules };

export function rulesFor(genreId) {
  const rules = RULES[genreId];
  if (!rules) throw new Error(`No runtime rules for genre "${genreId}"`);
  return rules;
}
