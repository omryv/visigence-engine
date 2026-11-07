/**
 * THE MISSION THE WORLD EDITOR PLAYS: the editor's game settings and its world, as one link, and back.
 *
 * The world editor (world.html) is the one editor: the world is made there and the game is set up and played there.
 * Its Play runs the game runtime (index.html, the same document an exported game is) inside the editor page, and
 * hands it the mission in the runtime's address:
 *
 *   /?embed=world&genre=shooter&look=arcade&difficulty=normal&enemies=6&site=120,-340#world=<worldLink>
 *
 * The world travels exactly as src/world/worldLink.js carries it (its seed, terrain and water, in the fragment, so a
 * browser never sends it anywhere); the settings are the query. `site` is optional: where on the world the mission
 * stands, world metres (the editor's spawn marker). Without it the level ground finds the best site itself
 * (src/world/kernelGround.js).
 *
 * Pure: no DOM, no storage, no randomness. The same link is the same mission.
 */
import { worldMission, MISSION_WORLDS } from './missionCard.js';
import { GENRES, DEFAULT_GENRE } from '../genres/registry.js';
import { encodeWorldLink, worldFromLocation } from './worldLink.js';
import { resolveProject } from './shooterProject.js';

export const EDITOR_EMBED = 'world';
export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
export const MAX_ENEMIES = 12;
/** What the editor's Game panel starts on. `enemies: null` is the genre's own count. */
export const MISSION_DEFAULTS = Object.freeze({ genre: DEFAULT_GENRE, look: 'arcade', difficulty: 'normal', enemies: null, site: null });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The settings, checked: throws saying which one is wrong. */
export function checkSettings(s) {
  const out = { ...MISSION_DEFAULTS, ...s };
  if (!GENRES[out.genre]) throw new Error(`genre "${out.genre}" is not one of ${Object.keys(GENRES).join(', ')}`);
  if (!MISSION_WORLDS[out.look]) throw new Error(`look "${out.look}" is not one of ${Object.keys(MISSION_WORLDS).join(', ')}`);
  if (!DIFFICULTIES.includes(out.difficulty)) throw new Error(`difficulty "${out.difficulty}" is not one of ${DIFFICULTIES.join(', ')}`);
  if (out.enemies !== null && !(Number.isInteger(out.enemies) && out.enemies >= 1 && out.enemies <= MAX_ENEMIES)) throw new Error(`enemies ${out.enemies} is not a whole number from 1 to ${MAX_ENEMIES}`);
  if (out.site !== null && !(finite(out.site?.x) && finite(out.site?.z))) throw new Error('the mission site is not a point on the world');
  return out;
}

/** The runtime address (path, query and fragment) that plays these settings on this world. */
export function editorMissionURL({ seed, name = null, worldParams, settings }) {
  const s = checkSettings(settings);
  const q = new URLSearchParams({ embed: EDITOR_EMBED, genre: s.genre, look: s.look, difficulty: s.difficulty });
  if (s.enemies !== null) q.set('enemies', String(s.enemies));
  if (s.site) q.set('site', `${Math.round(s.site.x * 10) / 10},${Math.round(s.site.z * 10) / 10}`);
  return `/?${q}#world=${encodeWorldLink({ seed, name, worldParams })}`;
}

/**
 * The mission a runtime address names, or null when it is not an editor's (no `embed=world`). An address that is an
 * editor's but cannot be read comes back as `{ error }`, so the runtime says why instead of playing something else.
 *
 * @param {{search: string, hash: string}} loc
 * @returns {null | {project: object, world: object, settings: object} | {error: string}}
 */
export function missionFromEditor(loc) {
  const q = new URLSearchParams(loc?.search ?? '');
  if (q.get('embed') !== EDITOR_EMBED) return null;
  const { world, error } = worldFromLocation(loc);
  if (!world) return { error: error ?? 'the editor sent no world' };
  try {
    const siteText = q.get('site');
    const site = siteText === null ? null : (() => {
      const [x, z] = siteText.split(',').map(Number);
      return { x, z };
    })();
    const enemiesText = q.get('enemies');
    const settings = checkSettings({
      genre: q.get('genre') ?? MISSION_DEFAULTS.genre,
      look: q.get('look') ?? MISSION_DEFAULTS.look,
      difficulty: q.get('difficulty') ?? MISSION_DEFAULTS.difficulty,
      enemies: enemiesText === null ? null : Number(enemiesText),
      site,
    });
    const base = worldMission(settings.look, world.seed, settings.genre);
    const project = resolveProject({
      ...base,
      difficulty: settings.difficulty,
      ...(settings.enemies !== null ? { enemyCount: settings.enemies } : {}),
      worldParams: world.worldParams,
      ...(settings.site ? { worldSite: settings.site } : {}),
    });
    return { project, world, settings };
  } catch (e) {
    return { error: e.message };
  }
}
