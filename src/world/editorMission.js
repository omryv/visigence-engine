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
 * This module is the address: what the editor needs to make one, light enough to load with the editor. Reading an
 * address, and making the settings or an edited mission into a project, is world/editorProject.js, which loads the
 * mission compiler.
 *
 * Pure: no DOM, no storage, no randomness. The same link is the same mission.
 */
import { MISSION_WORLDS } from './missionWorlds.js';
import { GENRES, DEFAULT_GENRE } from '../genres/registry.js';
import { encodeWorldLink } from './worldLink.js';

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
