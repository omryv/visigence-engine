import { GENRE_LEVELS } from './genreContent.js';
import { normalizePresentation } from './presentation.js';
import { normalizeImportedProps, placeImportedProps } from './importedProps.js';
import { CATALOG } from './catalog.js';
import { createBlueprint, normalizeBlueprint, compileBlueprint } from './blueprint.js';
import { Terrain } from '../sim/Terrain.js';
import { gridModuleFor, bakeNavGrid } from './navgrid.js';
import { channelRng, normalizeSeed } from '../kernel/seed.js';
import { generateHouse } from './houseGrammar.js';
import { layoutWorld } from './worldGrammar.js';
import { biomePack } from './pack.js';
import { choose } from './grammarCore.js';
import { polyAt, polyLength } from './layoutCore.js';
import { kernelGround, groundInputs } from './kernelGround.js';
import { ENEMY_TYPES } from '../config/gameplay.js';
import { assertProjectShape, ProjectFormatError } from './projectSchema.js';
import { GENRES, GENRE_IDS, DEFAULT_GENRE, CAMERAS } from '../genres/registry.js';
import { normalizeEdits, startOf, DEFAULT_START } from './level/edits.js';
import { decodeRegions } from './level/regions.js';
import { villageKey, uniqueKeys, applyOverrides, clearPaths, clearAround, clearRadius, applyNoGo, spawnZonePoints, houseBlocks, entityPlacements } from './level/apply.js';
import { isGame, liftToGame, levelProject, normalizeLevelMeta, normalizePublish, LEVEL_KEYS, MAX_LEVELS } from './level/game.js';

export const PROJECT_DEFAULTS = {
  name: 'Untitled Shooter Project', genre: DEFAULT_GENRE, theme: 'arcade',
  difficulty: 'normal', enemyCount: 6, behavior: 'guard', objectives: 3, cover: 'balanced',
  frameRate: 60, weapon: 'assault', quality: 'quality', camera: 'first', lighting: 'night', palette: 'cyan',
  seed: 'K7QN-3F2A-9XBD', ground: 'village',
};
export const THEMES = { arcade: 'Arcade' };
/**
 * THE GROUND a level stands on. `world`: a site of its seed's own Visigenesis world, bent by the kernel to meet the
 * mission (world/kernelGround.js), the one world the seed is everywhere else in the repository. `village`: the
 * village's own hills (world/worldTerrain.js reliefField), which is what every project built before this field
 * existed, so a project that says nothing builds `village` and keeps the world it was saved with. A new project
 * says `world` (NEW_PROJECT_GROUND: the studio's new project, the mission cards).
 */
export const GROUNDS = ['village', 'world'];
export const NEW_PROJECT_GROUND = 'world';
/**
 * Retired choices that saved projects, downloads and mission links may still carry. They
 * are mapped onto what ships rather than refused: the engine is first-person only, and the
 * adventure and tactical genres and their authored mission profiles are gone. Arcade is the
 * one theme; a project naming any other is refused.
 */
const RETIRED = {
  camera: { third: 'first', tactical: 'first' }, genre: { adventure: DEFAULT_GENRE, tactical: DEFAULT_GENRE },
  missionProfile: { 'district-v1': null, 'relic-v1': null, 'uplink-v1': null },
};
/** Retired asset ids a saved blueprint may still name, mapped onto the asset that replaced them. */
const RETIRED_ITEMS = { supplyBarrel: 'crystalShrine', cottage: 'house', oak: 'tree', pine: 'tree', sapling: 'tree' };

/** Only supported product choices enter a saved/exported project. */
export function resolveProject(input = {}) {
  // A game (format 4) handed where one mission is expected compiles its first level.
  if (isGame(input)) input = levelProject(input, 0);
  // Shape first, so every message below can assume the field is at least the right kind of thing.
  assertProjectShape(input);
  const retired = Object.entries(RETIRED).filter(([key, map]) => typeof input[key] === 'string' && Object.hasOwn(map, input[key]));
  if (retired.length) input = { ...input, ...Object.fromEntries(retired.map(([key, map]) => [key, map[input[key]]])) };
  const p = { ...PROJECT_DEFAULTS };
  for (const [key, values] of Object.entries({ genre: GENRE_IDS, theme: Object.keys(THEMES),
    difficulty: ['easy', 'normal', 'hard'], behavior: ['guard', 'hunt'], cover: ['light', 'balanced', 'dense'],
    weapon: CATALOG.arcade.weapons.map(w => w.id), camera: CAMERAS, lighting: ['night', 'dawn'],
    palette: ['cyan', 'violet', 'amber'], quality: ['performance','balanced','quality'], ground: GROUNDS })) {
    if (input[key] !== undefined && !values.includes(input[key])) throw new Error(`Unsupported ${key}: ${input[key]}`);
    if (input[key] !== undefined) p[key] = input[key];
  }
  if(!CATALOG[p.theme].weapons.some(w=>w.id===p.weapon))p.weapon='assault';
  // A genre plays from its own perspectives; switching genre coerces the camera rather than refusing the project.
  const genre=GENRES[p.genre];
  if(!genre.cameras.includes(p.camera))p.camera=genre.cameras[0];
  p.frameRate=Number(input.frameRate??60);
  if(![30,60].includes(p.frameRate))throw new Error('Frame rate must be 30 or 60');
  p.player = String(input.player ?? 'player');
  if(!['player',...CATALOG[p.theme].enemies.map(e=>e.id)].includes(p.player))p.player='player';
  p.name = String(input.name ?? p.name).trim().slice(0, 64) || p.name;
  // String(… ?? '') keeps a saved `seed: 0` the seed it was (see buildSpec.js resolveSpec).
  p.seed = normalizeSeed(String(input.seed ?? p.seed ?? '')) ?? p.seed;
  // The world a `ground: 'world'` level is cut from, when it was made in World mode (world/kernelGround.js
  // worldParamsFor): its terrain and water as the world editor holds them. Absent = the seed's own world.
  p.worldParams = normalizeWorldParams(input.worldParams);
  // Where on that world the mission stands, when the author chose (the world editor's spawn marker), plate metres.
  // Absent = the level ground scans the world for its best site.
  p.worldSite = normalizeWorldSite(input.worldSite);
  // A theme without an enemy roster plays with none, whatever the genre asks for.
  const c=CATALOG[p.theme],hostile=c.enemies.length>0;
  for (const [key, min, max] of [['enemyCount', p.genre==='exploration'||!hostile?0:1, hostile?12:0], ['objectives', 1, 4]]) {
    let n = key==='enemyCount'&&!hostile ? 0 : Number(input[key] ?? p[key]);
    // No enemies carried over from an enemy-free theme or genre (Arcade, an exploration route) takes this genre's preset rather than refusing the switch.
    if(key==='enemyCount'&&n===0&&min>0)n=genre.preset.enemyCount;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be ${min}–${max}`);
    p[key] = n;
  }
  // An open world kit (Arcade's meadow) takes its scenery from the dressing pool.
  const saved=input.blueprint?normalizeBlueprint(input.blueprint):null;
  if(saved)saved.nodes=saved.nodes.map(n=>n.items?{...n,items:[...new Set(n.items.map(id=>RETIRED_ITEMS[id]??id))]}:n);
  p.blueprint=saved??createBlueprint({world:[c.world[0].id],weapons:[p.weapon],enemies:c.enemies.filter(e=>!e.boss).slice(0,3).map(e=>e.id),doors:[c.doors.find(d=>d.opensTo)?.id??c.doors[0].id],props:c.props.filter(a=>['cover','barricade','objective','dressing'].includes(a.role)||a.pickup).map(a=>a.id)});
  if(!input.blueprint)p.blueprint.nodes.find(n=>n.objective==='activate').count=p.objectives;
  p.importedProps = normalizeImportedProps(input.importedProps);
  const profile=input.missionProfile??null;
  if(profile && !GENRE_LEVELS[profile])throw Error('Unknown mission profile');
  p.missionProfile = GENRE_LEVELS[profile]?.genre===p.genre?profile:null;
  p.presentation=normalizePresentation(input.presentation);
  p.settings=normalizeSettings(input.settings,genre);
  p.edits=normalizeEdits(input.edits);
  return p;
}

/** Game-wide play settings: how many lives a run starts with (a genre's own default when unset). */
export function normalizeSettings(value,genre=GENRES[DEFAULT_GENRE]){
  const lives=Math.round(Number(value?.lives));
  return {lives:Number.isFinite(lives)?Math.max(1,Math.min(9,lives)):genre.preset.lives??1};
}

/**
 * A game (format 4, world/level/game.js): the shared choices and every level, each level resolved through
 * `resolveProject` as the flat mission the runtime compiles. A flat project is a one-level game.
 */
export function resolveGame(input = {}) {
  assertProjectShape(input);
  const doc = liftToGame(input);
  if (!doc.levels.length || doc.levels.length > MAX_LEVELS) throw new ProjectFormatError('levels', `a game holds 1 to ${MAX_LEVELS} levels`);
  const levels = [], ids = new Set();
  let shared = null;
  for (const [i, level] of doc.levels.entries()) {
    const meta = normalizeLevelMeta(level, i);
    if (ids.has(meta.id)) { let n = i + 1; while (ids.has(`l${n}`)) n++; meta.id = `l${n}`; }
    ids.add(meta.id);
    let flat;
    try { flat = resolveProject(levelProject(doc, i)); } catch (error) { throw new ProjectFormatError(`levels[${i}]`, error.detail ?? error.message); }
    if (!shared) shared = Object.fromEntries(Object.entries(flat).filter(([k]) => !LEVEL_KEYS.includes(k)));
    levels.push({ ...meta, ...Object.fromEntries(LEVEL_KEYS.map(k => [k, flat[k]])) });
  }
  return { ...shared, publish: normalizePublish(doc.publish), levels };
}

export function enemyTypesForProject(project) {
  const entries=CATALOG[project.theme].enemies, scale={easy:.7,normal:1,hard:1.4}[project.difficulty],types={};
  for(const entry of entries){
    const base=ENEMY_TYPES[entry.archetype??'shambler'];
    // Critters fight with their bodies: every roster entry keeps its archetype's melee lunge.
    types[entry.id]={...base,id:entry.id,asset:entry.id,health:Math.round((entry.health??base.health)*scale),damage:Math.round(base.damage*scale),height:entry.height,radius:entry.radius??base.radius,chaseSpeed:(entry.speed??base.chaseSpeed)*(project.difficulty==='hard'?1.15:1)};
  }
  if(entries.length)types.sentinel={...types[entries[0].id]};
  return types;
}

/**
 * The village layout for a set of generator inputs, remembered: an editor recompiles its level on every hand edit,
 * and hand edits never change what the layout is given, so the few hundred milliseconds of noise fields, Poisson
 * sampling, relief and landmarks are paid once per seed and graph. Keyed by the rules object (a biome's differ)
 * and the inputs; a handful of entries each. The layout is only ever read after it is made.
 */
const LAYOUTS=new WeakMap();
function cachedLayout(rules,ctx){
  let cache=LAYOUTS.get(rules);if(!cache)LAYOUTS.set(rules,cache=new Map());
  const key=JSON.stringify([ctx.seed,ctx.reserved,[...ctx.pool],ctx.pickups,ctx.reliefKey??null]);
  let layout=cache.get(key);
  if(layout){cache.delete(key);cache.set(key,layout);return layout;}
  layout=layoutWorld(rules,ctx);cache.set(key,layout);
  if(cache.size>6)cache.delete(cache.keys().next().value);
  return layout;
}

/**
 * A level's ground from its seed's world (world/kernelGround.js), remembered like the layout: tens of milliseconds
 * of survey and solve, keyed by everything it reads (groundInputs), so an editor's hand edits never pay it twice.
 */
const GROUNDS_SOLVED=new Map();
function cachedGround(inputs){
  const key=JSON.stringify(inputs);
  let g=GROUNDS_SOLVED.get(key);
  if(g){GROUNDS_SOLVED.delete(key);GROUNDS_SOLVED.set(key,g);return g;}
  g=kernelGround(inputs);GROUNDS_SOLVED.set(key,g);
  if(GROUNDS_SOLVED.size>6)GROUNDS_SOLVED.delete(GROUNDS_SOLVED.keys().next().value);
  return g;
}
/** What a level says about its ground: small enough to ride on every compiled level, the heights left to the layout. */
function groundReport(project,g,reason=null){
  if(project.ground!=='world')return {kind:'village'};
  if(!g?.ok)return {kind:'village',asked:'world',reason:reason??g?.reason??'no ground',world:g?.world??null,...(g?.tried?{tried:g.tried}:{})};
  return {kind:'world',version:g.version,world:g.world,site:g.site,frame:g.frame,heightHash:g.heightHash,min:g.min,max:g.max,
    intent:{records:g.intent.records,rows:g.intent.rows,notes:g.intent.notes,sources:g.intent.sources},conditioning:g.conditioning};
}

/**
 * A world's params as a project carries them: its `terrain` and `water` blocks only (what decides the ground and the
 * sea; the sky, the palette and the placements are the world editor's business), plain JSON, bounded in size so a
 * project file stays a project file. `null` when absent.
 */
export const WORLD_PARAMS_MAX_BYTES = 512 * 1024;
/** A chosen site as a project carries it: `{ x, z }`, finite plate metres, to the decimetre; `null` when absent. */
export function normalizeWorldSite(input) {
  if (input == null) return null;
  const x = Number(input.x), z = Number(input.z);
  if (typeof input !== 'object' || !Number.isFinite(x) || !Number.isFinite(z)) throw new Error('worldSite must be { x, z } in metres');
  return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
}
export function normalizeWorldParams(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('worldParams must be an object');
  const out = {};
  for (const k of ['terrain', 'water']) {
    if (input[k] == null) continue;
    if (typeof input[k] !== 'object' || Array.isArray(input[k])) throw new Error(`worldParams.${k} must be an object`);
    out[k] = JSON.parse(JSON.stringify(input[k]));
  }
  if (!out.terrain) return null;
  if (JSON.stringify(out).length > WORLD_PARAMS_MAX_BYTES) throw new Error(`worldParams is over ${WORLD_PARAMS_MAX_BYTES / 1024} KB`);
  return out;
}

/** Seeded combat spaces assembled from the pack, with navigable streets and objective pads. */
export function compileShooterProject(input, pack) {
  const project = resolveProject(input);
  const blueprint=compileBlueprint(project.blueprint,CATALOG[project.theme],{genre:GENRES[project.genre]});
  const {pools,mission}=blueprint;
  if(pools.weapons.length&&!pools.weapons.includes(project.weapon))project.weapon=pools.weapons[0];
  const worldRng=channelRng(project.seed,'world-kit');
  const worldId=pools.world[Math.floor(worldRng()*pools.world.length)];
  const worldKit=CATALOG[project.theme].world.find(k=>k.id===worldId);
  // A world option with a biome (the desert oasis) grows its village from that biome of the pack: its own houses,
  // trees, flora, landmarks, ground and props (world/pack.js biomePack). The level carries the pack it was built from.
  pack = biomePack(pack, worldKit?.biome ?? null);
  if (pack.id !== project.theme) throw new Error('Project and asset pack do not match');
  const rng = channelRng(project.seed, 'shooter-layout');
  const size = 80, n = size*2, cell = size / n;
  // The level's hand edits (world/level/edits.js): a start of its own, placed things, changes to generated ones,
  // painted ground. With none, everything below compiles exactly what it always has.
  const edits = project.edits, start = startOf(edits), regions = decodeRegions(edits.regions);
  const startMoved = start.x !== DEFAULT_START.x || start.z !== DEFAULT_START.z;
  let terrain = new Terrain({ res: 2, size, min: 0, max: 0, data: new Float32Array(4) });
  const walkable = new Uint8Array(n * n);
  for (let z = 3; z < n - 3; z++) for (let x = 3; x < n - 3; x++) walkable[z * n + x] = 1;
  const placements = [], buildings = [];
  const availableCover=pools.props.filter(id=>['cover','barricade'].includes(pack.props.find(p=>p.id===id)?.role));
  const add = (id, x, z, yaw = 0, objectiveIndex) => {
    const asset = pack.props.find(p => p.id === id);
    if (!asset) throw new Error(`Missing pack prop: ${id}`);
    const p = { ...asset, x, y: 0, z, yaw, halfX: (asset.size?.[0] ?? asset.footprint) / 2,
      halfZ: (asset.size?.[2] ?? asset.footprint) / 2, radius: asset.footprint / 2 };
    if (objectiveIndex !== undefined) p.objectiveIndex = objectiveIndex;
    placements.push(p);
    return p;
  };
  const keyed = (p, key) => { p.key = key; return p; };
  // Reserve mission pads before scattering cover. Collision and rendering share these records.
  const sites=[...(GENRE_LEVELS[project.missionProfile]?.sites??[])];
  for(const z of [-27,-17,-7,10,20,29])for(const x of [-10,10])sites.push([x,z]);
  // Mission furniture stays outside the empty architectural shells.
  let site=0;
  for(const step of mission){
    if(!['activate','override','barricade','reach'].includes(step.objective))continue;
    const count=step.objective==='reach'?1:Math.min(step.count,4);
    for(let i=0;i<count;i++){
      if(site>=sites.length)throw Error('This world supports 12 interaction locations. Reduce station, door or barricade counts.');
      const [x,z]=sites[site];site++;
      if(step.objective==='reach'){placements.push({id:'checkpoint',model:null,role:'checkpoint',collision:'none',x,y:0,z,radius:2,height:0,stepId:step.id,key:`step:${step.id}:0`});continue;}
      const options=step.objective==='override'?pools.doors:step.objective==='barricade'?pools.props.filter(id=>pack.props.find(p=>p.id===id)?.role==='barricade'):pools.props.filter(id=>pack.props.find(p=>p.id===id)?.role==='objective');
      const id=options.length?options[Math.floor(rng()*options.length)]:(step.objective==='activate'?'console':null);
      if(!id)throw Error(`Select an asset for ${step.objective}`);
      add(id,x,z,0,step.objective==='activate'?site-1:undefined);
      Object.assign(placements.at(-1),{stepId:step.id,interaction:step.objective,holdTime:step.duration,key:`step:${step.id}:${i}`});
    }
  }
  const reserved=placements.filter(p=>p.stepId);
  for(let i=0;i<Math.min(3,pools.doors.length+1);i++){
    if(!pools.doors.length)break;const x=(i%2?-1:1)*12,z=-31+i*23;
    if(reserved.some(p=>Math.hypot(p.x-x,p.z-z)<4))continue;
    keyed(add(pools.doors[Math.floor(rng()*pools.doors.length)],x,z),`gate:${i}`);
    Object.assign(placements.at(-1),{interaction:'override',stepId:null,holdTime:2.2});
  }
  const coverRows = { light: 2, balanced: 4, dense: 6 }[project.cover];
  for(let i=0;i<coverRows;i++)for(const side of [-1,1]){
    if(!availableCover.length)continue;
    const id=availableCover[Math.floor(rng()*availableCover.length)],z=-26+i*9,x=side*(5+rng()*2);
    if(reserved.some(p=>Math.hypot(p.x-x,p.z-z)<4))continue;
    keyed(add(id,x,z,i%2?Math.PI/2:0),`cover:${i}:${side}`);
  }
  // Furnishings belong to the selected pool. A seeded distribution changes with every world seed.
  const dressing=pools.props.filter(id=>pack.props.find(p=>p.id===id)?.role==='dressing');
  // Generated houses (world/houseGrammar.js) draw their family and key from their own stream, so a village
  // never shifts the rest of the layout.
  const houseRng=channelRng(project.seed,'houses'),mix=Object.entries(pack.houses?.mix??{});
  let world=null,ground=groundReport(project,null,'this pack lays out no village to stand on a world');
  if(pack.world)world=placeVillage();
  else for(let i=0;i<Math.min(16,dressing.length*2);i++){
    const id=dressing[Math.floor(rng()*dressing.length)],x=(i%2?-1:1)*14,z=-30+Math.floor(i/2)*8;
    if(reserved.some(p=>Math.hypot(p.x-x,p.z-z)<4))continue;
    const yaw=i%2?Math.PI/2:-Math.PI/2;
    if(pack.props.find(p=>p.id===id)?.generator==='house'){addHouse(id,x,z,yaw,i,houseRng(),mix);continue;}
    keyed(add(id,x,z,yaw),`dress:${i}`);
  }
  // A house stands a metre further out than a tree, its front on the lane: the lot's -Y faces the centre line.
  function addHouse(id,x,z,yaw,slot,roll,mix){
    const family=mix.length?choose(roll,mix,([,w])=>w)[0]:Object.keys(pack.houses.families)[0];
    const plan=generateHouse(pack.houses,{family,key:`${project.seed}|${slot}`}),hx=x+Math.sign(x)*1;
    placeHouse(id,hx,z,yaw,plan);
  }
  function placeHouse(id,hx,z,yaw,plan,y=0){
    const house=keyed(add(id,hx,z,yaw),villageKey('house',hx,z));
    const [x0,x1,y0,y1,top]=plan.bounds;
    Object.assign(house,{house:plan,collision:'none',halfX:(x1-x0)/2,halfZ:(y1-y0)/2,radius:Math.hypot(x1-x0,y1-y0)/2,height:top,y});
    // One box per block (an L-shaped house leaves its corner open), turned with the house.
    placements.push(...houseBlocks(plan,hx,z,yaw,y,house.key));
  }
  /**
   * Arcade's village (world/worldGrammar.js): paths, lots, groves and clearings laid out by noise fields and
   * Poisson-disc sampling around the places the mission already claimed. Everything with collision is placed
   * for every tier alike (a replay must see one world); only visual flora carries a `lod` the renderer thins.
   */
  function placeVillage(){
    const W=pack.world,C=W.clear;
    // The layout sees only the generator's own inputs: the default start and where the mission put its pads, never
    // a hand edit (world/level/apply.js says why), so one moved barrel can never re-plan the village.
    const reservedPlaces=[{id:'spawn',x:DEFAULT_START.x,z:DEFAULT_START.z,r:C.spawn}];
    // Every pad site stays clear (a creator may add an objective later); only the used ones need a spur.
    for(const [x,z] of sites)reservedPlaces.push({id:'site',x,z,r:C.site});
    for(const p of placements){
      if(p.collisionOnly)continue;
      if(p.stepId||p.interaction)reservedPlaces.push({id:p.id,x:p.x,z:p.z,r:p.role==='gate'?C.gate:C.site,spur:true});
      else if(['cover','barricade'].includes(p.role))reservedPlaces.push({id:p.id,x:p.x,z:p.z,r:C.cover});
    }
    const pickups=dressing.filter(id=>pack.props.find(p=>p.id===id)?.pickup);
    // The ground (world/kernelGround.js): a site of the seed's Visigenesis world, bent to the mission's pads, when the
    // project asks for it and the world has one; the village's own hills otherwise, and the level says which and why.
    const solved=project.ground==='world'&&W.terrain?cachedGround(groundInputs(project,blueprint,placements,W)):null;
    ground=groundReport(project,solved,W.terrain?null:'this village has no relief to take from a world');
    const relief=solved?.ok?{res:solved.res,heights:solved.heights}:null;
    const layout=cachedLayout(W,{seed:project.seed,reserved:reservedPlaces,pool:pools.props,houseRules:pack.houses,treeRules:pack.trees,pickups,relief,reliefKey:relief?solved.heightHash:null});
    const yawOf=([fx,fz])=>Math.atan2(fx,fz),spin=k=>k*Math.PI/32;
    // Every village thing is marked, and keyed by what it is and where it stands (world/level/apply.js).
    const mark=(kind=null)=>{const p=placements.at(-1);p.village=true;if(kind)p.key=villageKey(kind,p.x,p.z);return p;};
    const flora=(s,kind='flora')=>{add('nature',s.x,s.z,spin(s.k));Object.assign(mark(kind),{part:s.part,scale:s.s,lod:s.lod,collision:'none',radius:0,halfX:0,halfZ:0,y:s.y??0});};
    // Relief (world/worldTerrain.js): the layout's height grid is the level's ground, and its water-depth grid is
    // what the nav grid refuses (a pond's deep centre); every village placement already carries its height.
    if(layout.terrain){
      const L=layout.terrain,V=W.terrain.traversal;
      terrain=new Terrain({res:L.res,size:L.size,data:Float32Array.from(L.heights),min:L.min,max:L.max},
        {maxSlope:V.maxSlope,stepUp:V.stepUp,wadeDepth:V.wade,slopeEps:V.slopeEps,depth:{res:L.res,size:L.size,data:Float32Array.from(L.depth)}});
    }
    // Everything the village places is marked, so the tests can tell it from the mission's own cover and pads.
    for(const L of layout.lots){placeHouse('house',L.x,L.z,yawOf(L.front),L.plan,L.y??0);for(const p of placements)if(p.house===L.plan||(p.id==='house-block'&&!p.village&&Math.hypot(p.x-L.x,p.z-L.z)<12))p.village=true;}
    for(const f of layout.fences){add('fence',f.x,f.z,yawOf(f.front));mark('fence').y=f.y??0;}
    for(const s of layout.scatter){
      if(s.part){flora(s,s.cls);continue;}
      if(s.tree){
        // A generated tree (world/treeGrammar.js): its plan rides on the placement; the session grows it. It is
        // walk-through except for its trunk: a circle blocker of the plan's real trunk radius, as tall as the trunk.
        const tree=add('tree',s.x,s.z,spin(s.k));Object.assign(mark(s.cls),{tree:s.tree,scale:s.s,crown:s.crown,lod:0,collision:'none',radius:0,halfX:0,halfZ:0,y:s.y??0});
        if(s.lean)tree.lean=s.lean;
        placements.push({id:'tree-trunk',model:null,role:'structureCollision',collisionOnly:true,collision:'circle',x:s.x,y:s.y??0,z:s.z,yaw:0,radius:s.trunk,halfX:s.trunk,halfZ:s.trunk,height:s.height,village:true,parent:tree.key});
        continue;
      }
      add(s.prop,s.x,s.z,spin(s.k));
      const p=mark(s.cls);p.scale*=s.s;p.halfX*=s.s;p.halfZ*=s.s;p.radius*=s.s;p.y=s.y??0;
      if(s.trunk)placements.push({id:'tree-trunk',model:null,role:'structureCollision',collisionOnly:true,collision:'circle',x:s.x,y:s.y??0,z:s.z,yaw:0,radius:s.trunk,halfX:s.trunk,halfZ:s.trunk,height:s.height,village:true,parent:p.key});
    }
    for(const s of layout.stones)flora(s,'stone');
    for(const s of layout.signs)flora(s,'sign');
    for(const p of layout.pickups){add(p.id,p.x,p.z);mark(p.id).y=p.y??0;}
    // Landmarks (world/worldLandmarks.js): each a part from the landmark library on its level pad, facing its
    // front, with its own collision record (a circle for the windmill and the well, a box for the rest); the
    // orchard is trees of the tree grammar with their trunk blockers, the farm plot a walkable part.
    const LM=W.landmarks;
    if(LM&&pools.props.includes(LM.prop??'landmark'))for(const L of layout.landmarks){
      const yaw=yawOf(L.front);
      if(L.part){
        // A plot part (the farm) stands at its slab's centre; every other part at the hook point, on its pad.
        const at=L.plot??L;
        add(LM.prop??'landmark',at.x,at.z,yaw);
        Object.assign(mark('landmark'),{landmark:{kind:L.kind,id:L.id,part:L.part,colors:L.colors??null,wheel:L.wheel??null,hook:L.hook},scale:1,collision:'none',radius:0,halfX:0,halfZ:0,y:at.y??0,lod:0});
      }
      // The landmark's blocks and orchard trunks follow it: taking the landmark out takes its collision too.
      const owner=L.part?placements.at(-1).key:null,c=L.collision;
      if(c?.circle)placements.push({id:'landmark-block',model:null,role:'structureCollision',collisionOnly:true,collision:'circle',x:L.x,y:L.y??0,z:L.z,yaw:0,radius:c.circle,halfX:c.circle,halfZ:c.circle,height:c.height??3,village:true,landmarkOf:L.kind,...(owner?{parent:owner}:{})});
      else if(c?.box)placements.push({id:'landmark-block',model:null,role:'structureCollision',collisionOnly:true,collision:'box',x:L.x,y:L.y??0,z:L.z,yaw,halfX:c.box[0],halfZ:c.box[1],height:c.height??3,radius:Math.hypot(c.box[0],c.box[1]),village:true,landmarkOf:L.kind,...(owner?{parent:owner}:{})});
      for(const t of L.trees??[]){
        const tree=add('tree',t.x,t.z,spin(t.k));Object.assign(mark('orchard'),{tree:t.tree,scale:t.s,crown:t.crown,lod:0,collision:'none',radius:0,halfX:0,halfZ:0,y:t.y??0,landmarkOf:L.kind});
        placements.push({id:'tree-trunk',model:null,role:'structureCollision',collisionOnly:true,collision:'circle',x:t.x,y:t.y??0,z:t.z,yaw:0,radius:t.trunk,halfX:t.trunk,halfZ:t.trunk,height:t.height,village:true,parent:tree.key});
      }
    }
    // The water's dressing (bank stones, fords, lily pads) and its two built pieces: a footbridge over every lane
    // crossing (its deck along the lane, standing on the lane's own ground) and the pool at the square. Both are
    // waded or walked over, so neither collides.
    if(pools.props.includes('nature')){
      for(const s of layout.shore)flora(s,'shore');
      const B=layout.water?.brook;
      if(B){
        for(const b of B.bridges){add('nature',b.x,b.z,Math.atan2(-b.front[1],b.front[0]));Object.assign(mark('bridge'),{part:W.terrain.bridge.part,scale:1,lod:0,collision:'none',radius:0,halfX:0,halfZ:0,y:+terrain.heightAt(b.x,b.z).toFixed(4)});}
        add('nature',B.basin.x,B.basin.z,0);Object.assign(mark('basin'),{part:B.basin.part,scale:1,lod:0,collision:'none',radius:0,halfX:0,halfZ:0,y:B.basin.y});
      }
    }
    return {lanes:layout.lanes,square:layout.square,spurs:layout.spurs,walks:layout.walks,zones:layout.zones,flowers:layout.scatter.filter(s=>s.tint).map(s=>({x:s.x,z:s.z,r:1.6*s.s})),
      terrain:layout.terrain,water:layout.water,landmarks:layout.landmarks.map(L=>({kind:L.kind,id:L.id,x:L.x,z:L.z,y:L.y??0,front:L.front,hook:L.hook,rect:L.rect??null})),route:layout.route};
  }
  // The route graph (world/routeGraph.js) is genre-neutral data any theme may ignore; Arcade's checkpoints use it:
  // a `reach` step's checkpoint moves to the next point of interest a visit is enough for (and that stands on a
  // level pad), in route order.
  if(world?.route){
    const visits=world.route.nodes.filter(n=>n.hook.type==='visit'&&(n.pad??0)>=2);
    let vi=0;
    for(const p of placements){
      if(p.role!=='checkpoint'||!visits.length)continue;
      const n=visits[vi%visits.length];vi++;
      p.x=n.stand?.[0]??n.x;p.z=n.stand?.[1]??n.z;p.route=n.index;
    }
  }
  // A collect step's honey drops, laid along the village's lanes at even steps (on dry ground, clear of the start and
  // the pads) and keyed per step, so the editor moves one like any mission pad. Without lanes they spiral out from
  // the centre. Both come from the layout alone, so a drop never moves because something else was edited.
  for(const step of mission){
    if(step.objective!=='collect')continue;
    for(const [i,at] of dropSpots(step.count).entries()){
      add('honeyDrop',at.x,at.z,0);
      Object.assign(placements.at(-1),{pickup:'collectible',stepId:step.id,key:`step:${step.id}:${i}`});
    }
  }
  function dropSpots(count){
    // Clear of the start, the pads, and anything solid (cover, a fence, a house's blocks, a trunk) by a body's width.
    const clear=[{x:DEFAULT_START.x,z:DEFAULT_START.z,r:4},...placements.filter(p=>p.stepId||p.interaction).map(p=>({x:p.x,z:p.z,r:2.5})),
      ...placements.filter(p=>['circle','box'].includes(p.collision)).map(p=>({x:p.x,z:p.z,r:(p.collision==='box'?Math.hypot(p.halfX||0,p.halfZ||0):p.radius||0)+0.8}))];
    const open=(x,z)=>!clear.some(c=>Math.hypot(x-c.x,z-c.z)<c.r)&&terrain.depthAt(x,z)<0.05&&!placements.some(p=>p.id==='honeyDrop'&&Math.hypot(x-p.x,z-p.z)<1.2);
    const along=[];
    for(const l of world?.lanes??[])for(let u=1,len=polyLength(l.pts);u<len-1;u+=1.5){const at=polyAt(l.pts,u);if(open(at.x,at.z))along.push({x:+at.x.toFixed(2),z:+at.z.toFixed(2)});}
    if(along.length>=count)return Array.from({length:count},(_,i)=>along[Math.floor((i+0.5)*along.length/count)]);
    const out=[];
    for(let i=0;out.length<count&&i<count*6;i++){
      const r=6+28*Math.sqrt((i+0.5)/(count*6)),a=i*2.39996,x=+(Math.sin(a)*r).toFixed(2),z=+(Math.cos(a)*r).toFixed(2);
      if(open(x,z))out.push({x,z});
    }
    return out;
  }
  // Now the hand edits (world/level/apply.js): generated things moved and removed by key, painted paths cleared,
  // placed things added, and the village's clutter cleared round everything the editor put somewhere new.
  uniqueKeys(placements);
  const applied=applyOverrides(placements,edits.overrides,k=>!k.startsWith('enemy:'));
  clearPaths(placements,regions);
  const before=placements.length;
  entityPlacements(edits,{pack,seed:project.seed,add,placements});
  const spots=edits.entities.filter(e=>!['enemy','trigger'].includes(e.type)).map(e=>({x:e.x,z:e.z,r:clearRadius(e,pack)}));
  for(const p of placements.slice(0,before))if(p.overridden&&!p.village)spots.push({x:p.x,z:p.z,r:p.role==='gate'?2.6:p.stepId?1.8:1.2});
  if(startMoved)spots.push({x:start.x,z:start.z,r:2.5});
  clearAround(placements,spots);
  placeImportedProps(project.importedProps, placements, {size,spawn:start});
  let spawnY=0;
  if(world?.terrain){
    // Everything the mission placed (pads, gates, cover, pickups of other kinds) stands on the lowest ground under
    // it; the nav grid keeps only what a body can stand on and reach (bakeNavGrid: slope, water depth, step height).
    for(const p of placements){
      if(p.village)continue;
      const r=p.collision==='circle'?Math.min(p.radius||.3,1.2):p.collision==='box'?Math.min(p.halfX||.3,p.halfZ||.3,1.2):.3;
      p.y=+Math.min(terrain.heightAt(p.x,p.z),terrain.heightAt(p.x+r,p.z),terrain.heightAt(p.x-r,p.z),terrain.heightAt(p.x,p.z+r),terrain.heightAt(p.x,p.z-r)).toFixed(4);
    }
    const V=pack.world.terrain.traversal,baked=bakeNavGrid(terrain,{gridN:n,traversal:{wadeDepth:V.wade,maxSlope:V.maxSlope,stepUp:V.stepUp}});
    for(let i=0;i<walkable.length;i++)walkable[i]=walkable[i]&&baked.walkable[i];
    spawnY=+terrain.heightAt(start.x,start.z).toFixed(4);
  }
  applyNoGo(walkable,n,size,regions);
  // The extraction point is the start unless the editor moved the extract step's marker.
  const extractStep=blueprint.mission.find(s=>s.objective==='extract'),extractKey=extractStep?`step:${extractStep.id}:0`:null;
  const moved=extractKey&&edits.overrides[extractKey]&&!edits.overrides[extractKey].removed?edits.overrides[extractKey]:null;
  if(moved)applied.add(extractKey);
  const extraction={x:moved?.x??start.x,z:moved?.z??start.z,key:extractKey};
  extraction.y=world?.terrain?+terrain.heightAt(extraction.x,extraction.z).toFixed(4):0;
  // Generated critters are placed by the session at run time (game/ShooterSession.js); their overrides ride along.
  const enemyOverrides=Object.fromEntries(Object.entries(edits.overrides).filter(([k])=>k.startsWith('enemy:')));
  const orphans=Object.keys(edits.overrides).filter(k=>!applied.has(k)&&!k.startsWith('enemy:'));
  const nav = { gridN: n, cell, origin: { x: -size / 2, z: -size / 2 }, walkable };
  return { project, spec: { world: { seed: project.seed }, pack: pack.id }, terrain,
    grid: gridModuleFor(nav, size), spawn: { position: { x: start.x, y: spawnY, z: start.z }, yaw: start.yaw, pitch: 0 },
    placements, buildings, blueprint, worldKit, world, pack, ground,
    edits, entities: edits.entities, wires: edits.wires, regions, spawnZones: spawnZonePoints(regions), extraction, enemyOverrides, orphans };
}
