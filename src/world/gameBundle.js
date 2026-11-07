import { CATALOG } from './catalog.js';
import { compileBlueprint } from './blueprint.js';
import { genreOf } from '../genres/registry.js';
import { grenadeModel } from './pack.js';
import { entityPropIds } from './level/apply.js';
import { isGame, levelProject } from './level/game.js';
/**
 * Restrict the downloadable game to assets from sources actually connected to its output, plus what its levels'
 * placed things are built from, a collect step's honey and the genre's own gear (the action hero's staff).
 * A game of levels (format 4) carries what any of its levels uses.
 */
export function gameBundle(project,source){
 if(isGame(project)){
  const parts=project.levels.map((_,i)=>gameBundle(levelProject(project,i),source));
  const used=new Set(parts.flatMap(q=>q.pack.props.map(p=>p.id)));
  const pack={...source,characters:Object.assign({},...parts.map(p=>p.pack.characters)),weapons:Object.assign({},...parts.map(p=>p.pack.weapons)),props:source.props.filter(p=>used.has(p.id))};
  return {pack,assets:[...new Set(parts.flatMap(p=>p.assets))]};
 }
 const genre=genreOf(project),{pools,mission}=compileBlueprint(project.blueprint,CATALOG[project.theme],{genre});
 const characterIds=new Set(['player',...pools.enemies]);
 const propIds=new Set([...pools.props,...pools.doors,...entityPropIds(project.edits),...(genre.gear??[])]);
 if(mission.some(s=>s.objective==='collect'))propIds.add('honeyDrop');
 for(const prop of source.props)if(propIds.has(prop.id)&&prop.opensTo)propIds.add(prop.opensTo);
 const pack={...source,characters:Object.fromEntries(Object.entries(source.characters).filter(([id])=>characterIds.has(id))),weapons:Object.fromEntries(Object.entries(source.weapons).filter(([id])=>pools.weapons.includes(id))),props:source.props.filter(p=>propIds.has(p.id))};
 const assets=new Set([...Object.values(pack.characters),...Object.values(pack.weapons),...pack.props].map(a=>a.model));
 for(const w of Object.values(pack.weapons))if(w.viewmodel)assets.add(w.viewmodel);
 for(const id of pools.world){
  const kit=CATALOG[project.theme].world.find(w=>w.id===id);assets.add(kit.model);for(const model of kit.decorations??[])assets.add(model);
  // A biome world (the desert oasis, the snow village) swaps in its own models for the props it restyles, and its own
  // part libraries: the ones this game uses ship with it.
  const biome=kit.biome?source.biomes?.[kit.biome]:null;
  if(biome){
   for(const [pid,over] of Object.entries(biome.props??{}))if(propIds.has(pid)&&over.model)assets.add(over.model);
   for(const [key,value] of Object.entries(biome))if(key!=='props')for(const path of runtimeAssets(value))assets.add(path);
  }
 }
 for(const sound of Object.values(pack.sounds??{}))assets.add(sound.file);
 assets.add(grenadeModel(source));
 return {pack,assets:[...assets]};
}
/** Every runtime asset a piece of pack data names (models, textures, sounds), leaving out the catalogue's card pictures. */
function runtimeAssets(value,out=[]){
 if(typeof value==='string'){if(/^assets\/.+\.(glb|ktx2|png|jpe?g|webp|mp3|ogg)$/.test(value))out.push(value);}
 else if(Array.isArray(value))for(const v of value)runtimeAssets(v,out);
 else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))if(k!=='preview')runtimeAssets(v,out);
 return out;
}
