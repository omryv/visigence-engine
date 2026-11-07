import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group, PerspectiveCamera } from 'three/webgpu';
import { resolveProject, compileShooterProject, enemyTypesForProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { Game } from '../../src/game/Game.js';
import { WeaponController } from '../../src/weapons/WeaponController.js';
import { PackViewmodel } from '../../src/viewmodel/PackViewmodel.js';
import { OBJECTIVE, FIXED_STEP } from '../../src/config/gameplay.js';
import { inspectGlb } from '../build/inspect-pack.mjs';

assert.throws(()=>resolveProject({theme:'missing'}),/Unsupported/);
assert.throws(()=>resolveProject({enemyCount:13}),/must be/);
assert.throws(()=>resolveProject({objectives:1.5}),/must be/);
assert.equal(resolveProject({theme:'arcade'}).weapon,'assault');
assert.throws(()=>resolveProject({theme:'arcade',weapon:'blaster'}),/Unsupported weapon/);
assert.throws(()=>resolveProject({theme:'futuristic'}),/Unsupported theme/);
assert(!Object.hasOwn(resolveProject({secret:'ignored'}),'secret'));
const fx=Object.fromEntries(['muzzleFlash','pulseLight','enemyHit','barricadeHit','impact','ricochet'].map(k=>[k,()=>{}]));
for(const theme of ['arcade']) {
  const manifest=JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`));
  const measured=Object.fromEntries([...Object.values(manifest.characters),...Object.values(manifest.weapons),...manifest.props].map(a=>[a.model,inspectGlb(a.model)]));
  const pack=resolvePack(manifest,measured);
  const project=resolveProject({theme,objectives:4,cover:'dense'});
  const level=compileShooterProject(project,pack);
  assert.deepEqual(level.placements,compileShooterProject(project,pack).placements);
  assert.notDeepEqual(level.placements,compileShooterProject({...project,seed:'another'},pack).placements);
  for (const cover of ['light','balanced','dense']) {
    const variant = compileShooterProject({...project,cover},pack);
    const probe = new Game({level:variant,camera:new PerspectiveCamera()});
    for (const station of probe.objectives.stations) {
      const distance = station.radius + .65;
      const approaches = [[0,1],[0,-1],[1,0],[-1,0]].map(([x,z]) => [station.anchor.x+x*distance,station.anchor.z+z*distance]);
      assert(approaches.some(([x,z]) => probe.collision.isFree(x,z,.36)
        && probe.collision.hasLineOfSight(x,z,station.anchor.x,station.anchor.z,false,station.blockerId)
        && probe.collision.findPath(variant.spawn.position.x,variant.spawn.position.z,x,z,.36)),
        `${theme}/${cover}: station ${station.id} has a reachable interaction position`);
    }
    probe.dispose();
  }
  const camera=new PerspectiveCamera();
  const g=new Game({level,camera,enemyTypes:enemyTypesForProject(project),createSystems:game=>{
    const mount=new Group(),muzzle=new Group();mount.add(muzzle);
    const w=new WeaponController({player:game.player,collision:game.collision,viewmodel:new PackViewmodel(camera),effects:{vfx:fx}});
    const id=project.weapon;w.addWeapon(id,{mount,muzzle},{},pack.weapons[id].archetype);w.equip(id,true);return {weapons:w};
  }});
  const spawn=level.spawn.position;
  assert(g.collision.isFree(spawn.x,spawn.z,.36));
  for(const p of level.placements.filter(p=>p.objectiveIndex!==undefined)) {
    assert(g.collision.findPath(spawn.x,spawn.z,p.x,p.z,1),`station ${p.objectiveIndex} reachable`);
  }
  const enemy=g.enemies.spawn('sentinel',{position:{x:0,z:23},authored:true});assert(enemy);
  // Aim at the critter's chest: it stands 5 m ahead and is far shorter than a person.
  g.start();g.player.pitch=Math.atan2(enemy.type.height*.5-g.player.eyeHeight,5);const initialAmmo=g.weapons.hudState.mag;
  for(let i=0;i<90;i++)g.step({fire:true});
  assert(g.weapons.shotsFired>0);assert(g.weapons.hudState.mag<initialAmmo);
  assert(enemy.health<enemy.type.health,`real weapon hits ${theme} enemy capsule (${enemy.health}/${enemy.type.health}, ${g.weapons.shotsFired} shots)`);
  g.step({reload:true});for(let i=0;i<240;i++)g.step();
  assert.equal(g.weapons.hudState.mag,initialAmmo,'reload transfers reserve ammunition');
  g.enemies.reset();
  for(const station of g.objectives.stations) {
    // Stand within the real interaction radius and hold the normal input until activation.
    const distance = station.radius + .65;
    const approach = [[0,1],[0,-1],[1,0],[-1,0]].find(([x,z]) => {
      const px=station.anchor.x+x*distance,pz=station.anchor.z+z*distance;
      return g.collision.isFree(px,pz,.36) && g.collision.hasLineOfSight(px,pz,station.anchor.x,station.anchor.z,false,station.blockerId);
    });assert(approach, 'station has a usable approach');
    g.player.position.set(station.anchor.x+approach[0]*distance,0,station.anchor.z+approach[1]*distance);
    g.player.prevPosition.copy(g.player.position);g.player.yaw=Math.atan2(approach[0],approach[1]);g.player.pitch=Math.atan2(station.height*.5-g.player.eyeHeight,station.radius+.65);g.weapons.viewmodel.recoil.reset();
    for(let i=0;i<Math.ceil(OBJECTIVE.activationTime/FIXED_STEP)+5;i++)g.step({interact:true});
    assert(station.complete,`activate ${theme} station ${station.id}`);
  }
  for(let i=0;i<Math.ceil(OBJECTIVE.extractionDelay/FIXED_STEP)+2;i++)g.step();
  g.player.reset(level.spawn);g.step();assert.equal(g.state.current,'VICTORY');
  g.restart();assert.equal(g.objectives.hudState.completed,0);assert.equal(g.player.health,100);g.dispose();
  for(const c of Object.values(pack.characters)) {
    const m=measured[c.model];assert(c.animation==='rigid'?m.skins===0:m.skins===1&&m.joints>=15&&m.clips>=5,'character matches its animation pipeline');
  }
}
console.log('Arcade: deterministic compilation, navigable objectives, real firing/reload, activation, extraction and restart passed');
