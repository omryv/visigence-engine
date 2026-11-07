import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group,PerspectiveCamera } from 'three/webgpu';
import { CATALOG } from '../../src/world/catalog.js';
import { compileBlueprint,connectBlueprint,OBJECTIVE_KINDS } from '../../src/world/blueprint.js';
import { resolveProject,compileShooterProject,enemyTypesForProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { gameBundle } from '../../src/world/gameBundle.js';
import { Game } from '../../src/game/Game.js';
import { WeaponController } from '../../src/weapons/WeaponController.js';
import { PackViewmodel } from '../../src/viewmodel/PackViewmodel.js';
const effect=Object.fromEntries(['muzzleFlash','pulseLight','enemyHit','barricadeHit','impact','ricochet'].map(k=>[k,()=>{}]));
for(const theme of Object.keys(CATALOG)){
 const catalog=CATALOG[theme],project=resolveProject({theme,weapon:'assault'}),source=JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`));
 const initial=compileBlueprint(project.blueprint,catalog);assert.equal(initial.mission.length,2);
 const disconnected=structuredClone(project.blueprint);disconnected.edges=disconnected.edges.filter(e=>e.input!=='enemies');assert.deepEqual(compileBlueprint(disconnected,catalog).pools.enemies,[]);
 const exported=gameBundle({...project,blueprint:disconnected},source);assert.deepEqual(Object.keys(exported.pack.characters),['player']);
 assert.throws(()=>connectBlueprint(project.blueprint,{from:'weapons',out:'weapons',to:'generator',input:'doors'}),/different/);
 const broken=structuredClone(project.blueprint);broken.edges=broken.edges.filter(e=>e.to!=='output');assert.throws(()=>compileBlueprint(broken,catalog),/output/);
 const graph=structuredClone(project.blueprint);graph.nodes=graph.nodes.filter(n=>n.kind!=='objective');graph.edges=graph.edges.filter(e=>!['start','complete'].includes(e.out));
 graph.nodes.find(n=>n.kind==='enemies').items=catalog.enemies.map(e=>e.id);
 // A theme without an enemy roster yet (Arcade) runs every hands-and-tools objective; combat steps need enemies.
 const combat=catalog.enemies.length>0;
 const sequence=['override','activate','barricade','reach',...(combat?['waves','boss','eliminate']:[]),'extract'];
 sequence.forEach((kind,i)=>{graph.nodes.push({id:`step-${i}`,kind:'objective',objective:kind,count:kind==='waves'?2:1,duration:.5,x:560,y:i*150});graph.edges.push({from:i?`step-${i-1}`:'generator',out:i?'complete':'start',to:`step-${i}`,input:'start'});});
 graph.edges.push({from:`step-${sequence.length-1}`,out:'complete',to:'output',input:'mission'});
 project.blueprint=graph;
 const pack=resolvePack(source,catalog.measurements),level=compileShooterProject(project,pack);
 assert.deepEqual(level.placements,compileShooterProject(project,pack).placements,'same blueprint and seed produce the same world');
 const camera=new PerspectiveCamera(),g=new Game({level,camera,enemyTypes:enemyTypesForProject(project),createSystems:game=>{
  const weapons=new WeaponController({player:game.player,collision:game.collision,viewmodel:new PackViewmodel(camera),effects:{vfx:effect}});
  for(const id of ['assault','sidearm']){const mount=new Group(),muzzle=new Group();mount.add(muzzle);weapons.addWeapon(id,{mount,muzzle},{},pack.weapons[id].archetype);}
  weapons.equip('assault',true);return {weapons};
 }});
 g.start();let guard=0;
 while(!g.objectives.complete&&guard++<8000){
  const step=g.objectives.current;
  const targets=g.objectives.targets.filter(t=>t.record.stepId===step.id);
  if(['activate','override'].includes(step.objective)){
   const target=targets.find(t=>!t.complete);
   if(target){const r=target.radius+.65;const approach=[[0,1],[0,-1],[1,0],[-1,0]].find(([x,z])=>g.collision.isFree(target.anchor.x+x*r,target.anchor.z+z*r,.36)&&g.collision.hasLineOfSight(target.anchor.x+x*r,target.anchor.z+z*r,target.anchor.x,target.anchor.z,false,target.blockerId));assert(approach,`${theme}: reachable ${step.objective}`);
    g.player.position.set(target.anchor.x+approach[0]*r,0,target.anchor.z+approach[1]*r);g.player.yaw=Math.atan2(approach[0],approach[1]);g.player.pitch=Math.atan2(target.height*.5-g.player.eyeHeight,r);g.player.prevPosition.copy(g.player.position);g.step({interact:true});
   }else g.step();
  }else if(step.objective==='barricade'){
   const target=targets[0];g.objectives.damage(target.blockerId,200);g.step();assert(target.complete);
  }else if(['waves','boss','eliminate'].includes(step.objective)){
   for(const e of g.enemies.enemies)if(e.alive)g.enemies.damage(e,100000);g.step();
  }else{const t=step.objective==='reach'?level.placements.find(p=>p.stepId===step.id):level.spawn.position;g.player.position.set(t.x,0,t.z);g.player.prevPosition.copy(g.player.position);g.step();}
 }
 assert.equal(g.state.current,'VICTORY',`${theme}: all ${sequence.length} objective types complete through the runtime`);
 if(combat)assert(g.kills>=13,'two waves and a heavy encounter were spawned and killed');
 g.restart();assert.equal(g.objectives.index,0);assert(g.objectives.targets.every(t=>!t.complete));assert.equal(g.weapons.hudState.mag,30);
 g.step({weapon:'sidearm'});for(let i=0;i<120;i++)g.step();assert.equal(g.weapons.hudState.id,'sidearm','weapon switching selects an independent inventory entry');
 g.dispose();
 console.log(`${theme}: connected pools, export filtering, all mission steps, encounters, restart and inventory passed`);
}
// Every world kit and route algorithm is exercised with the full compatible prop pool.
for(const [theme,catalog]of Object.entries(CATALOG))for(const kit of catalog.world)for(const seed of ['layout-a','layout-b','layout-c']){
 const p=resolveProject({theme,seed});p.blueprint.nodes.find(n=>n.kind==='world').items=[kit.id];p.blueprint.nodes.find(n=>n.kind==='props').items=catalog.props.map(a=>a.id);
 const pack=resolvePack(JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`)),catalog.measurements),level=compileShooterProject(p,pack),g=new Game({level});
 for(const target of g.objectives.stations){const r=target.radius+.65;assert([[0,1],[0,-1],[1,0],[-1,0]].some(([x,z])=>g.collision.isFree(target.anchor.x+x*r,target.anchor.z+z*r,.36)&&g.collision.findPath(0,28,target.anchor.x+x*r,target.anchor.z+z*r,.36)),`${theme}/${kit.id}/${seed}: usable objective approach`);}
 for(const supply of g.supplies.items.filter(i=>i.record.pickup==='health')){g.player.health=40;g.player.position.set(supply.record.x,0,supply.record.z);g.supplies.fixedUpdate();assert(g.player.health>40);assert(supply.taken);g.supplies.reset();assert(!supply.taken);}
 g.dispose();
}
console.log('All world kits × route algorithms × three seeds retain reachable objectives with the full prop pool; supplies replenish and reset');

// Selecting among several world assets must draw once, not once per find() candidate.
for(const theme of ['arcade'])for(let seed=0;seed<40;seed++){
 const project=resolveProject({theme,seed:'mixed-'+seed});
 project.blueprint.nodes.find(n=>n.kind==='world').items=CATALOG[theme].world.map(w=>w.id);
 const pack=resolvePack(JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`)),CATALOG[theme].measurements);
 const level=compileShooterProject(project,pack);
 assert(level.worldKit&&level.buildings.every(b=>b.buildingModel),'mixed world pools always resolve selected assets');
}
