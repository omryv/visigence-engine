/**
 * A GAME: game-wide choices plus an ordered list of levels (project format 4, docs/PROJECT_FORMAT.md).
 *
 * The runtime has always compiled one mission: a flat project (`resolveProject`, `compileShooterProject`,
 * `ShooterSession.build`). That stays true. A game is a thin document over it: the fields every level shares
 * (genre, difficulty, weapons, look, publishing) at the top, and per level the fields that make a level (its seed,
 * light, mission graph, encounter and hand edits). `levelProject(game, i)` flattens level i back into the flat
 * project the runtime compiles, so nothing below the studio learns what a level list is.
 *
 * A flat project (what format 3 wrote, what links and older saves hold) is a one-level game; `liftToGame` makes
 * that explicit. Pure data, no three, no DOM.
 */
import { createEdits } from './edits.js';

/** Fields that belong to one level. Everything else a flat project carries belongs to the game. */
export const LEVEL_KEYS = ['seed', 'lighting', 'blueprint', 'enemyCount', 'behavior', 'cover', 'objectives', 'missionProfile', 'edits'];
export const MAX_LEVELS = 8;
export const LEVEL_NAME_MAX = 40;
export const PUBLISH_DEFAULTS = Object.freeze({ adBreaks: false, rewardedContinue: false, showCredits: true });

export const isGame = doc => !!doc && Array.isArray(doc.levels);

const pick = (doc, keys) => Object.fromEntries(keys.filter(k => doc[k] !== undefined).map(k => [k, doc[k]]));
const omit = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/** A flat project as a one-level game. A document that already has levels is returned as it is. */
export function liftToGame(doc) {
  if (isGame(doc)) return doc;
  const level = { id: 'l1', name: 'Level 1', ...pick(doc, LEVEL_KEYS) };
  return { ...omit(doc, LEVEL_KEYS), levels: [level] };
}

/** Level i of a game as the flat project the runtime compiles. */
export function levelProject(game, index = 0) {
  const level = game.levels[Math.max(0, Math.min(game.levels.length - 1, index))];
  const { levels, ...shared } = game;
  return { ...shared, ...pick(level, LEVEL_KEYS) };
}

/**
 * Apply a flat patch (what the studio's forms and the graph produce) to level i: level fields go to the level,
 * the rest to the game. Returns a new game; the old one is untouched, which is what undo keeps.
 */
export function patchGame(game, index, patch) {
  const levelPatch = pick(patch, LEVEL_KEYS), gamePatch = omit(patch, LEVEL_KEYS);
  const levels = Object.keys(levelPatch).length ? game.levels.map((l, i) => i === index ? { ...l, ...levelPatch } : l) : game.levels;
  return { ...game, ...gamePatch, levels };
}

export function nextLevelId(game) {
  const used = new Set(game.levels.map(l => l.id));
  let n = game.levels.length + 1;
  while (used.has(`l${n}`)) n++;
  return `l${n}`;
}

/** A new level after `index`: the same graph and light as its neighbour, a seed of its own, no edits. */
export function addLevel(game, index, seed) {
  if (game.levels.length >= MAX_LEVELS) throw Error(`A game holds up to ${MAX_LEVELS} levels`);
  const from = game.levels[index] ?? game.levels.at(-1);
  const level = { ...structuredClone(from), id: nextLevelId(game), name: `Level ${game.levels.length + 1}`, seed, edits: createEdits() };
  const levels = [...game.levels];
  levels.splice(index + 1, 0, level);
  return { ...game, levels };
}

export function duplicateLevel(game, index) {
  if (game.levels.length >= MAX_LEVELS) throw Error(`A game holds up to ${MAX_LEVELS} levels`);
  const copy = { ...structuredClone(game.levels[index]), id: nextLevelId(game) };
  copy.name = `${game.levels[index].name} copy`.slice(0, LEVEL_NAME_MAX);
  const levels = [...game.levels];
  levels.splice(index + 1, 0, copy);
  return { ...game, levels };
}

export function removeLevel(game, index) {
  if (game.levels.length <= 1) throw Error('A game keeps at least one level');
  return { ...game, levels: game.levels.filter((_, i) => i !== index) };
}

export function moveLevel(game, from, to) {
  const levels = [...game.levels];
  const [level] = levels.splice(from, 1);
  levels.splice(Math.max(0, Math.min(levels.length, to)), 0, level);
  return { ...game, levels };
}

export function normalizePublish(value) {
  const v = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(PUBLISH_DEFAULTS).map(([k, d]) => [k, typeof v[k] === 'boolean' ? v[k] : d]));
}

/** Level names and ids, checked; the per-level fields are the flat project's and are resolved with it. */
export function normalizeLevelMeta(level, index) {
  if (!level || typeof level !== 'object') throw Error(`levels[${index}]: expected a level object`);
  const id = typeof level.id === 'string' && /^[a-z0-9]{1,12}$/.test(level.id) ? level.id : `l${index + 1}`;
  const name = String(level.name ?? '').trim().slice(0, LEVEL_NAME_MAX) || `Level ${index + 1}`;
  return { id, name };
}
