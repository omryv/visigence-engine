import { authorGenreMission } from './genreContent.js';
import { resolveProject, NEW_PROJECT_GROUND } from './shooterProject.js';
import { GENRES, DEFAULT_GENRE } from '../genres/registry.js';
// Presentation catalog: add worlds here without changing the launcher layout.
// Gameplay modes are separate from world art and lighting.
export const MISSION_THEMES = {
  arcade: { title: 'Arcade', description: 'A bright pastel village. Chunky toon worlds for any genre.', time: 'Sunny day', lighting: 'dawn', accent: '#ff9aa6', position: '50%', focus: '50% 50%', index: 1, art: '/assets/v2/arcade/arcade-lookdev-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
};
/** The launcher and studio palette a theme opens with. */
export const THEME_PALETTE = { arcade: 'violet' };
/**
 * The launcher's worlds: each a theme and one of its environments (world/catalog.js `world`, the studio's
 * Environments), with its own card art. The meadow is the theme's own village; the desert and the snow village are
 * its biomes.
 */
export const MISSION_WORLDS = {
  arcade: { ...MISSION_THEMES.arcade, theme: 'arcade', world: null, title: 'Meadow village', description: 'A bright pastel village of cottages, blossom and a brook.' },
  desert: { theme: 'arcade', world: 'desert', title: 'Desert oasis', description: 'Plaster houses and domes, palms round the water, a striped market.', time: 'Sunny day', lighting: 'dawn', accent: '#f0b04a', position: '50%', focus: '50% 50%', index: 2, art: '/assets/v2/arcade/arcade-desert-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
  snow: { theme: 'arcade', world: 'snow', title: 'Snow village', description: 'Log cabins under thick snow, a bell tower over the square, a frozen pond.', time: 'Sunny day', lighting: 'dawn', accent: '#8cc4f2', position: '50%', focus: '50% 50%', index: 3, art: '/assets/v2/arcade/arcade-snow-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
};
/** The launcher world a project is in: its theme and the first biome in its world pool (the theme's own village if none). */
export function missionWorld(project) {
  const items = project?.blueprint?.nodes?.find(n => n.kind === 'world')?.items ?? [];
  const hit = Object.entries(MISSION_WORLDS).find(([, w]) => w.theme === project?.theme && w.world && items.includes(w.world));
  return hit ? hit[0] : (Object.entries(MISSION_WORLDS).find(([, w]) => w.theme === project?.theme && !w.world)?.[0] ?? 'arcade');
}
/** The launcher's ready-made mission in one of its worlds: the theme's mission with its environment in the world pool. */
export function worldMission(world = 'arcade', seed = 'K7QN-3F2A-9XBD', genre = DEFAULT_GENRE) {
  const w = MISSION_WORLDS[world];
  if (!w) throw Error('Unknown mission world');
  const p = quickMission(w.theme, seed, genre);
  if (w.world) { const pool = p.blueprint.nodes.find(n => n.kind === 'world'); if (pool) pool.items = [w.world]; }
  return p;
}
/**
 * The launcher's ready-made mission for a world and a genre. Exploration has an authored
 * survey route, using an editable Studio objective graph.
 */
export function quickMission(theme = 'arcade', seed = 'K7QN-3F2A-9XBD', genre = DEFAULT_GENRE) {
  const t = MISSION_THEMES[theme], g = GENRES[genre];
  if (!t) throw Error('Unknown mission theme');
  if (!g) throw Error('Unknown genre');
  // Named by its genre, as the level editor's templates are ("Arena shooter"); the world is where it takes place, and
  // it stands on its seed's Visigenesis world (world/kernelGround.js).
  const p = resolveProject({ theme, seed, genre, ground: NEW_PROJECT_GROUND, name: g.label, lighting: t.lighting, palette: THEME_PALETTE[theme] ?? 'cyan', camera: g.cameras[0], quality: 'balanced', difficulty: 'easy', enemyCount: g.preset.enemyCount, behavior: g.preset.behavior, objectives: 1, cover: 'light' });
  const activate = p.blueprint.nodes.find(n => n.objective === 'activate'); activate.duration = 1.5;
  authorGenreMission(p);
  return p;
}
export function missionKey(project) {
  const {name,quality,frameRate,camera,presentation,missionProfile,...rules}=project;
  if(missionProfile)rules.missionProfile=missionProfile;
  return JSON.stringify({...rules,blueprint:{...rules.blueprint,nodes:rules.blueprint.nodes.map(({x,y,...n})=>n)}});
}
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const tenths=Math.round(seconds*10);
  return `${Math.floor(tenths/600)}:${((tenths%600)/10).toFixed(1).padStart(4,'0')}`;
}
export function bestTime(project) { try { return JSON.parse((localStorage.getItem('visigames.records.v1') ?? localStorage.getItem('vsight.records.v1')) ?? '{}')[missionKey(project)] ?? null; } catch { return null; } }
export function recordTime(project, seconds) {
  const previous=bestTime(project); if (!Number.isFinite(seconds) || seconds <= 0 || (previous !== null && previous <= seconds)) return previous;
  try { const records=JSON.parse((localStorage.getItem('visigames.records.v1') ?? localStorage.getItem('vsight.records.v1'))??'{}'); records[missionKey(project)]=seconds; localStorage.setItem('visigames.records.v1',JSON.stringify(records)); } catch { /* Private browsing still shows this run. */ }
  return seconds;
}

export function challengeURL(project, base, best = null) {
  if(project.importedProps?.length||project.presentation?.artwork||project.presentation?.logo)throw Error('This mission uses local custom assets. Download the game ZIP to share the playable world, or save its mission card.');
  const url=new URL(base);url.search='';url.hash='';
  url.searchParams.set('mission',btoa(unescape(encodeURIComponent(JSON.stringify(project)))));
  if(Number.isFinite(best)&&best>0)url.searchParams.set('beat',best.toFixed(3));
  return url.href;
}
