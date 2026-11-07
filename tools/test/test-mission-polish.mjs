import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Group,PerspectiveCamera} from 'three/webgpu';
import {quickMission,missionKey} from '../../src/world/missionCard.js';
import {compileShooterProject,enemyTypesForProject} from '../../src/world/shooterProject.js';
import {resolvePack} from '../../src/world/pack.js';
import {CATALOG} from '../../src/world/catalog.js';
import {Game} from '../../src/game/Game.js';
import {WeaponController} from '../../src/weapons/WeaponController.js';
import {PackViewmodel} from '../../src/viewmodel/PackViewmodel.js';
import {normalizeImportedProps} from '../../src/world/importedProps.js';
import {normalizePresentation} from '../../src/world/presentation.js';
import {inspectArtwork} from '../../editor/creatorTools.js';
const pack=resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json')),CATALOG.arcade.measurements);
const effects=Object.fromEntries(['muzzleFlash','pulseLight','enemyHit','barricadeHit','impact','ricochet'].map(k=>[k,()=>{}]));
function build(project){const level=compileShooterProject(project,pack),camera=new PerspectiveCamera();return new Game({level,camera,enemyTypes:enemyTypesForProject(project),createSystems:g=>{
 const weapons=new WeaponController({player:g.player,collision:g.collision,viewmodel:new PackViewmodel(camera),effects:{vfx:effects}}),mount=new Group(),muzzle=new Group();mount.add(muzzle);weapons.addWeapon('assault',{mount,muzzle},{},pack.weapons.assault.archetype);weapons.equip('assault',true);return {weapons};
}});}
const project=quickMission('arcade');
// Look scaling happens once in the canonical simulation, independent of render cadence.
const aimGame=build(project);aimGame.start();Object.defineProperty(aimGame.weapons,'sensitivityScale',{value:.5});aimGame.step({look:{x:.1,y:0}});assert(Math.abs(aimGame.player.yaw+.05)<1e-8);aimGame.dispose();
const prop={id:'b'.repeat(64),size:[1.3,.95,.9],scale:1,collision:'box',rightsConfirmed:true,creator:'Test',license:'Original',triangles:20,bytes:100,name:'Test prop'};
const auto=compileShooterProject({...project,importedProps:[prop]},pack).placements.find(p=>p.id==='import-0');
const edited={...prop,transform:{x:auto.x,z:auto.z,yaw:Math.PI/2},scale:.8};const level=compileShooterProject({...project,importedProps:[edited]},pack),placed=level.placements.find(p=>p.id==='import-0'),solid=new Game({level});assert.equal(placed.yaw,Math.PI/2);assert.equal(placed.scale,.8);assert(!solid.collision.isFree(placed.x,placed.z,.3));solid.dispose();
assert.throws(()=>compileShooterProject({...project,importedProps:[{...prop,transform:{x:0,z:28,yaw:0}}]},pack),/reserved/);
assert.throws(()=>normalizeImportedProps([{...prop,transform:{x:NaN,z:0,yaw:0}}]));
const png=fs.readFileSync('assets/v2/arcade/arcade-lookdev-review.png'),art=inspectArtwork(png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength));assert(art.width>0&&art.height>0);
const image={...art,id:'a'.repeat(64),creator:'Test',license:'Original',rightsConfirmed:true};const identity=normalizePresentation({studioName:'Example Studio',artwork:image,accent:'#8844cc'});assert.match(identity.artwork.model,/\.png$/);assert.throws(()=>normalizePresentation({artwork:{...image,rightsConfirmed:false}}));assert.throws(()=>normalizePresentation({accent:'url(evil)'}));assert.throws(()=>inspectArtwork(new ArrayBuffer(24)));
assert.equal(missionKey(project),missionKey({...project,presentation:identity}),'branding never resets gameplay records');
console.log('ADS scaling, transformed collision, route protection and identity validation passed');
