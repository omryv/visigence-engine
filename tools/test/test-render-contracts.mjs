/** Semantic rendering contracts exercised against the actual vendored three.js. */
import assert from 'node:assert/strict';
import { Color,DirectionalLight,Vector3,HemisphereLight,PerspectiveCamera } from 'three/webgpu';
import { createSkyUniforms } from '../../src/render/Sky.js';
import { LOOKS } from '../../src/config/looks.js';
import { fitSunShadow } from '../../src/render/SunShadow.js';
import { ShooterSession } from '../../src/game/ShooterSession.js';
import {applyEnemyReadability} from '../../src/render/EnemyReadability.js';
import {Group,Mesh,BoxGeometry,MeshPhysicalMaterial,Texture} from 'three/webgpu';
// Compatibility path must keep the original material family and shared texture
// identity, without altering source assets or introducing custom node shaders.
for(const theme of ['arcade']){
 const source=new MeshPhysicalMaterial({color:0x445566,clearcoat:.4,transparent:true,opacity:.8,map:new Texture()});
 const root=new Group(),geometry=new BoxGeometry(),a=new Mesh(geometry,source),b=new Mesh(geometry,source);root.add(a,b);
 const original=source.emissive.clone(),release=applyEnemyReadability(root,{theme,lighting:'night'},{classic:true});
 assert.equal(a.material.isNodeMaterial,undefined);assert(a.material.isMeshPhysicalMaterial);
 assert.notEqual(a.material,source);assert.equal(a.material,b.material);assert.equal(a.material.map,source.map);
 assert.equal(a.material.clearcoat,.4);assert.equal(a.material.opacity,.8);
 assert(a.material.emissive.r+a.material.emissive.g+a.material.emissive.b>0);assert(source.emissive.equals(original));
 let disposed=0;a.material.addEventListener('dispose',()=>disposed++);release();assert.equal(disposed,1);
 source.map.dispose();source.dispose();geometry.dispose();
}
// Arcade toon: ARC_ materials become toon twins on the clone only, glows keep theirs, and every node with an
// authored outline width gets a closed back-face shell scaled by that width.
{
 const {createArcadeToon}=await import('../../src/render/ArcadeToon.js');
 const {MeshStandardMaterial}=await import('three/webgpu');
 const wood=new MeshStandardMaterial({name:'ARC_Wood',color:0xc47d4a,vertexColors:true}),roof=new MeshStandardMaterial({name:'ARC_Roof'});
 const glowMat=new MeshStandardMaterial({name:'ARC_Glow',emissive:0xffd873}),plain=new MeshStandardMaterial({name:'Pickup'});
 const geometry=new BoxGeometry(),owned=new Set(),toon=createArcadeToon(owned,LOOKS.arcade.dawn.toon);
 const node=new Group();node.userData.arc_outline=.04;node.add(new Mesh(geometry,wood),new Mesh(geometry,roof),new Mesh(geometry,glowMat));
 const bare=new Mesh(geometry,plain),root=new Group();root.add(node,bare);
 toon.apply(root);
 const [w,r,g]=node.children;
 assert(w.material.isArcadeToon&&w.material.name==='ARC_Wood'&&w.material.vertexColors&&w.material.color.equals(wood.color),'palette and gradient survive the swap');
 assert(!wood.isArcadeToon&&wood.name==='ARC_Wood','the loader material is untouched');
 assert(r.material.toonShade.equals(new Color('#bd9ec6')),'per-material shade tint');assert.equal(g.material,glowMat,'glows stay emissive');
 assert.equal(bare.material,plain,'non-kit materials are left alone');assert.equal(bare.children.length,0,'no outline without an authored width');
 const hull=w.children[0];assert(hull.userData.arcOutlineHull&&hull.material.isArcadeOutline&&hull.material.outlineWidth===.04);
 assert(hull.geometry.attributes.outlineNormal,'smoothed shell normals');assert.equal(hull.castShadow,false);
 const n=hull.geometry.attributes.outlineNormal;assert(Math.abs(Math.hypot(n.getX(0),n.getY(0),n.getZ(0))-1)<1e-6);
 // A box corner's three split normals average to one diagonal, so the shell cannot crack along the edges.
 assert(Math.abs(Math.abs(n.getX(0))-Math.abs(n.getY(0)))<1e-6&&Math.abs(Math.abs(n.getY(0))-Math.abs(n.getZ(0)))<1e-6);
 toon.apply(root);assert.equal(w.children.length,1,'applying twice adds no second shell');
 const vm=new Group();vm.userData.arc_outline=.006;vm.add(new Mesh(geometry,wood));toon.apply(vm,{outline:.4,world:false});
 assert(Math.abs(vm.children[0].children[0].material.outlineWidth-.0024)<1e-9);assert.equal(vm.children[0].children[0].material.mrtNode,null,'view-model shells declare no world MRT');
 assert(owned.has(w.material)&&owned.has(hull.material),'the session owns what the kit creates');
 // Readability keeps a critter toon-shaded under its rim.
 const critter=new Group();critter.add(new Mesh(geometry,w.material));const release=applyEnemyReadability(critter,{theme:'arcade',lighting:'dawn'},{classic:false});
 assert(critter.children[0].material.isArcadeToon&&critter.children[0].material!==w.material&&critter.children[0].material.toonShade.equals(w.material.toonShade));
 release();for(const m of owned)m.dispose();geometry.dispose();
}
// Arcade wind: a mesh whose geometry carries `sway` gets a swaying twin of its toon material and a swaying hull
// (the ink line moves with the leaf); still meshes keep the shared material; `wind: false` builds no sway at all.
// The water is a toon surface too, coloured from its mesh's `shore` attribute.
{
 const {createArcadeToon,TOON}=await import('../../src/render/ArcadeToon.js');
 const {MeshStandardMaterial,BufferAttribute}=await import('three/webgpu');
 const leaf=new MeshStandardMaterial({name:'ARC_Leaf',vertexColors:true}),still=new BoxGeometry(),moving=new BoxGeometry();
 moving.setAttribute('sway',new BufferAttribute(new Float32Array(moving.attributes.position.count*2).fill(.5),2));
 const make=look=>{const owned=new Set(),toon=createArcadeToon(owned,look),g=new Group();g.userData.arc_outline=.02;g.add(new Mesh(still,leaf),new Mesh(moving,leaf));toon.apply(g);return {toon,g,owned};};
 const on=make(LOOKS.arcade.dawn.toon),[a,b]=on.g.children;
 assert(on.toon.windOn&&a.material.isArcadeToon&&b.material.isArcadeToon&&a.material!==b.material,'a swaying mesh gets its own twin');
 assert(!a.material.positionNode&&b.material.positionNode,'only the twin moves');
 assert(a.children[0].material!==b.children[0].material,'and its outline hull moves with it');
 assert(Math.abs(TOON.windStrength.value-LOOKS.arcade.dawn.toon.wind.strength)<1e-9&&Math.abs(Math.hypot(TOON.windDir.value.x,TOON.windDir.value.y)-1)<1e-9,'the look sets the one wind');
 const off=make({...LOOKS.arcade.dawn.toon,wind:false}),[c,d]=off.g.children;
 assert(!off.toon.windOn&&c.material===d.material&&!d.material.positionNode,'wind off: nothing sways');
 const water=on.toon.water({deep:'#4aa6c8',shallow:'#86d3dc'});
 assert(water.isArcadeToon&&water.colorNode&&water.name==='ARC_Water'&&water.toonRim<=.3,'toon water: flat colour from the shore, a soft rim');
 for(const m of [...on.owned,...off.owned])m.dispose();still.dispose();moving.dispose();
 // The flora batch bakes the sway only into the parts the rules name, its weight rising from the root to the tip.
 const {createNatureBatch}=await import('../../src/render/PartsBatch.js');
 const lib=new Group();for(const id of ['tuft.a','stone.step']){const n=new Group();n.userData.name=id;const box=new BoxGeometry(.2,.4,.2);box.translate(0,.2,0);n.add(new Mesh(box,leaf));lib.add(n);}
 const flora=createNatureBatch(lib).build([{part:'tuft.a',x:1,z:2},{part:'stone.step',x:3,z:0},{part:'tuft.a',x:-2,z:5}],{sway:['tuft.a']});
 const sw=flora.children.filter(m=>m.geometry.attributes.sway);
 assert.equal(sw.length,1,'the tufts batch apart from the still stone');
 const s=sw[0].geometry.attributes.sway,p=sw[0].geometry.attributes.position;
 for(let i=0;i<s.count;i++)assert(p.getY(i)<.01?s.getX(i)<.01:s.getX(i)>.99,'rooted at the ground, free at the tip');
}
const sky=createSkyUniforms({...LOOKS.arcade.dawn.sky,horizon:0x808080});
assert(Math.abs(sky.horizon.value.r-new Color(0x808080).r)<1e-12,'hex colours must be linearized once');
assert(sky.discInnerCos.value>sky.discCos.value&&sky.discInnerCos.value<=1,'sun disc reaches its radiance at its centre');
const light=new DirectionalLight();light.userData.sunDir=new Vector3(.3,.8,.5).normalize();light.shadow.mapSize.set(2048,2048);
const projected=[];for(const x of [0,.001,.002,.01,.5]){fitSunShadow(light,new Vector3(x,0,28));projected.push(new Vector3().applyMatrix4(light.shadow.matrix));}
assert(projected[0].distanceTo(projected[1])<1e-4,'small movement must preserve shadow texel phase');
for(const p of projected)for(const c of [p.x,p.y])assert(Math.abs(c*2048-Math.round(c*2048))<1e-8,'world origin remains aligned to texel grid');
assert(projected[0].distanceTo(projected.at(-1))>.001,'shadow frustum still follows movement');
const previousProjection=light.shadow.camera.projectionMatrix.clone();
fitSunShadow(light,new Vector3(0,0,28),{near:2});
assert.equal(light.shadow.camera.near,2);
assert(!light.shadow.camera.projectionMatrix.equals(previousProjection),'near-plane changes refresh the projection');
const host={renderLook:LOOKS.arcade.night,look:{x:0,y:0},keys:new Set(),actions:{},touchMove:{x:0,y:0},vmHemi:new HemisphereLight(),hemi:new HemisphereLight(0xffffff,0xffffff,0.9),vmKey:new DirectionalLight(),sunLight:new DirectionalLight(0xffcf9e,2.4),sky:{sunDir:new Vector3(0,1,0)},vmLocal:[],camera:new PerspectiveCamera()};
ShooterSession.prototype._clearInput.call(host);ShooterSession.prototype._mirrorViewLights.call(host);
assert.equal(host.vmHemi.intensity,0.9*1.6,'input resets must not replace authored lighting');
assert.equal(host.vmKey.intensity,2.4*0.85);
console.log('Colour, sun disc, world-anchored shadow snapping and lighting/input ownership passed');
const {StaticBoxBatch}=await import('../../src/render/StaticBoxBatch.js');
const {Scene,MeshStandardMaterial,Matrix4}=await import('three/webgpu');
const owned=new Set(),scene=new Scene(),material=new MeshStandardMaterial(),batch=new StaticBoxBatch(scene,owned);
batch.add(2,3,4,1,2,3,material);batch.add(1,1,1,2,2,3,material);batch.add(1,1,1,60,0,0,material);
const meshes=batch.finish();assert.equal(meshes.length,2,'nearby same-material boxes batch; remote boxes retain separate culling');
const transform=new Matrix4();meshes[0].getMatrixAt(0,transform);
assert.deepEqual(new Vector3(1,1,1).applyMatrix4(transform).toArray(),[3,5,7],'instance transforms preserve dimensions and placement');
for(const o of owned)o.dispose();material.dispose();

const renderHost={last:100,animate:()=>{},renderer:{setAnimationLoop(value){this.loop=value;}}};
ShooterSession.prototype.setRendering.call(renderHost,false);assert.equal(renderHost.renderer.loop,null);
ShooterSession.prototype.setRendering.call(renderHost,true);assert.equal(renderHost.renderer.loop,renderHost.animate);assert.equal(renderHost.last,0);

// The mount is not the rig descriptor: losing that distinction draws duplicate body arms.
const authored={mount:new Group(),authored:{hands:{}},model:new Mesh(new BoxGeometry(.1,.1,.5),new MeshStandardMaterial())};
const fallback={mount:new Group()};
const presentation={weaponRig:authored,game:{weapons:{current:{id:'assault',rig:authored.mount,build:authored}}},firstPersonArms:{visible:true}};
ShooterSession.prototype._syncWeaponVisual.call(presentation);
assert.equal(presentation.weaponRig,authored);assert.equal(presentation.firstPersonArms.visible,false,'authored hands exclude fallback body arms');
presentation.game.weapons.current={id:'static',rig:fallback.mount,build:fallback};
ShooterSession.prototype._syncWeaponVisual.call(presentation);assert.equal(presentation.firstPersonArms.visible,true);
presentation.game.weapons.current={id:'assault',rig:authored.mount,build:authored};
ShooterSession.prototype._syncWeaponVisual.call(presentation);assert.equal(presentation.firstPersonArms.visible,false,'switching back must remove the fallback arms');
// The rule is the same in every theme: Arcade's viewmodels carry the hero's arms, and a static weapon gets the fallback arms.
presentation.project={theme:'arcade'};presentation.game.weapons.current={id:'sidearm',rig:authored.mount,build:authored};
ShooterSession.prototype._syncWeaponVisual.call(presentation);assert.equal(presentation.firstPersonArms.visible,false,'an Arcade viewmodel brings its own arms');
presentation.game.weapons.current={id:'static',rig:fallback.mount,build:fallback};
ShooterSession.prototype._syncWeaponVisual.call(presentation);assert.equal(presentation.firstPersonArms.visible,true,'Arcade no longer hides the arms of a static weapon');
authored.model.geometry.dispose();authored.model.material.dispose();
