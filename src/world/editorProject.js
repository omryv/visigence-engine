/**
 * THE EDITOR'S MISSION, MADE: the settings' mission or the edited one, on the editor's world, as a project. The runtime
 * reads it out of its address (missionFromEditor: world/editorMission.js writes the address), and the editor's own Play
 * makes it here directly (editorProject: editor/world/play.js plays it on the world).
 *
 * Apart from the address because this half loads the mission compiler, and an editor that never plays never needs it:
 * the editor loads this with the game, on the first Play (tools/test/measure-load.mjs).
 *
 * Pure: no DOM, no storage, no randomness.
 */
import { checkSettings, EDITOR_EMBED, WORKSPACES, MISSION_DEFAULTS, MISSION_MAX_BYTES } from './editorMission.js';
import { worldMission } from './missionCard.js';
import { worldFromLocation } from './worldLink.js';
import { resolveProject, resolveGame } from './shooterProject.js';
import { levelProject } from './level/game.js';

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

/** Level `index` of the editor's mission on its world, and how many levels the mission has. */
export function editorProject({ seed, name = null, worldParams, settings, mission = null, index = 0 }) {
  const s = checkSettings(settings), world = { seed, name, worldParams };
  const placed = mission ? onWorld(mission, world, s.site) : settingsMission(s, world);
  if (!Array.isArray(placed.levels)) return { project: placed, levels: 1 };
  if (!(Number.isInteger(index) && index >= 0 && index < placed.levels.length)) throw new Error(`the mission has no level ${index + 1}`);
  return { project: resolveProject(levelProject(placed, index)), levels: placed.levels.length };
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
