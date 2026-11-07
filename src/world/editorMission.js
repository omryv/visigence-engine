/**
 * THE MISSION THE WORLD EDITOR PLAYS: the editor's game settings and its world, as one link, and back.
 *
 * The world editor (index.html, the page at /) is the one editor: the world is made there and the game is set up and played there.
 * Its Play runs the game runtime (game.html, the document an exported game is) inside the editor page, and hands it
 * the mission in the runtime's address:
 *
 *   /game.html?embed=world&genre=shooter&look=arcade&difficulty=normal&enemies=6&site=120,-340#world=<worldLink>
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
import { resolveProject, resolveGame } from './shooterProject.js';
import { levelProject } from './level/game.js';

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

/** Where a workspace of the editor runs: the mission graph (Remix) or the level editor (Build), in the runtime document. */
export const WORKSPACES = Object.freeze(['remix', 'build']);
/** The most an edited mission may weigh in a link, bytes of JSON. */
export const MISSION_MAX_BYTES = 4 * 1024 * 1024;

const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** The mission the settings make on a world: the look's mission for the world's seed and the genre, as set. */
export function settingsMission(settings, world) {
  const s = checkSettings(settings);
  return resolveProject({
    ...worldMission(s.look, world.seed, s.genre),
    difficulty: s.difficulty,
    ...(s.enemies !== null ? { enemyCount: s.enemies } : {}),
    worldParams: world.worldParams,
    ...(s.site ? { worldSite: s.site } : {}),
  });
}

/**
 * A mission (a project, or a game of levels) put on the editor's world: every level stands on its seed, its terrain
 * and water, and at its site when one is chosen. The world is the editor's to say, whatever the mission carried.
 */
export function onWorld(mission, world, site = null) {
  const ground = { seed: world.seed, worldParams: world.worldParams, worldSite: site ?? null, ground: 'world' };
  if (Array.isArray(mission?.levels)) return resolveGame({ ...mission, ground: 'world', levels: mission.levels.map((l) => ({ ...l, ...ground })) });
  return resolveProject({ ...mission, ...ground });
}

/**
 * The runtime address (path, query and fragment) for the editor's mission on this world: played (no workspace), or
 * opened in a workspace. `mission` is the mission as the workspaces last edited it; without one, the settings make it.
 */
export function editorMissionURL({ seed, name = null, worldParams, settings, mission = null, workspace = null }) {
  const s = checkSettings(settings);
  if (workspace !== null && !WORKSPACES.includes(workspace)) throw new Error(`workspace "${workspace}" is not one of ${WORKSPACES.join(', ')}`);
  const q = new URLSearchParams({ embed: EDITOR_EMBED });
  if (workspace) q.set('workspace', workspace);
  q.set('genre', s.genre); q.set('look', s.look); q.set('difficulty', s.difficulty);
  if (s.enemies !== null) q.set('enemies', String(s.enemies));
  if (s.site) q.set('site', `${Math.round(s.site.x * 10) / 10},${Math.round(s.site.z * 10) / 10}`);
  let hash = `world=${encodeWorldLink({ seed, name, worldParams })}`;
  if (mission) {
    const text = JSON.stringify(mission);
    if (text.length > MISSION_MAX_BYTES) throw new Error(`the mission is over ${MISSION_MAX_BYTES / 1024 / 1024} MB`);
    hash += `&mission=${toB64(text)}`;
  }
  return `/game.html?${q}#${hash}`;
}

/**
 * The mission a runtime address names, or null when it is not an editor's (no `embed=world`). An address that is an
 * editor's but cannot be read comes back as `{ error }`, so the runtime says why instead of playing something else.
 *
 * @param {{search: string, hash: string}} loc
 * @returns {null | {project: object, game: object|null, world: object, settings: object, workspace: string|null} | {error: string}}
 */
export function missionFromEditor(loc) {
  const q = new URLSearchParams(loc?.search ?? '');
  if (q.get('embed') !== EDITOR_EMBED) return null;
  const { world, error } = worldFromLocation(loc);
  if (!world) return { error: error ?? 'the editor sent no world' };
  try {
    const workspace = q.get('workspace');
    if (workspace !== null && !WORKSPACES.includes(workspace)) throw new Error(`workspace "${workspace}" is not one of ${WORKSPACES.join(', ')}`);
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
    const m = /(?:^#|&)mission=([^&]*)/.exec(loc?.hash ?? '');
    let doc = null;
    if (m) {
      if (m[1].length > MISSION_MAX_BYTES * 2) throw new Error('the mission in the link is too large');
      try { doc = JSON.parse(fromB64(decodeURIComponent(m[1]))); } catch { throw new Error('the mission in the link cannot be read'); }
    }
    const placed = doc ? onWorld(doc, world, settings.site) : settingsMission(settings, world);
    const game = Array.isArray(placed.levels) ? placed : null;
    const project = game ? resolveProject(levelProject(game, 0)) : placed;
    return { project, game, world, settings, workspace };
  } catch (e) {
    return { error: e.message };
  }
}
