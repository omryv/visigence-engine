// node --import ./tools/lib/_three-real-hook.mjs tools/test/test-rendering-cpu.mjs
import assert from 'node:assert/strict';
import { Scene, PointLight, Vector3, PerspectiveCamera, DataTexture, Group } from 'three/webgpu';
import { pointIrradiance } from '../../src/render/irradiance.js';
import { LightRig } from '../../src/render/LightRig.js';
import { particleSprites } from '../../src/render/ParticleSprites.js';
import { probePalette, setUnlitMrtEnabled, markUnlit } from '../../src/render/Environment.js';
import { readDeviceSignals } from '../../src/core/DeviceProfile.js';

assert.equal(pointIrradiance(2,0,4),200);
assert.equal(pointIrradiance(2,16,4),0);
assert.equal(pointIrradiance(2,25,4),0);
assert(Math.abs(pointIrradiance(2,4,4)-.5*(1-1/16)**2)<1e-12);
const scene=new Scene(), rig=new LightRig(scene,1), eye=new Vector3();
const a=new PointLight(0xffffff,10,10,2), b=new PointLight(0xff0000,1,10,2);
a.position.x=1;b.position.x=-1;scene.add(a,b);rig.addAll([a,b]);
for(let i=0;i<20;i++)rig.update(eye,null,0,1/60);
assert.equal(rig.slots[0].position.x,1); assert.equal(rig.slots[0].intensity,10);
b.intensity=12;for(let i=0;i<20;i++)rig.update(eye,null,0,1/60);
assert.equal(rig.slots[0].position.x,1,'20% challenger must not evict');
b.intensity=30;let minimum=Infinity,changed=false;
for(let i=0;i<30;i++){
 const oldX=rig.slots[0].position.x,oldI=rig.slots[0].intensity;
 rig.update(eye,null,0,1/60);minimum=Math.min(minimum,rig.slots[0].intensity);
 if(oldX!==rig.slots[0].position.x){changed=true;assert(oldI<2,'outgoing light fades before relocation');assert(rig.slots[0].intensity<5,'incoming light ramps from zero');}
 assert(rig.slots[0].visible);assert(!a.visible&&!b.visible);
}
assert(changed);assert.equal(rig.slots[0].position.x,-1);
rig.update(eye,b,.6,1/60);assert.equal(rig.chosen[0].intensity,30);assert.equal(rig.slots[0].intensity,12);
rig.clear();assert.equal(rig.live,0);assert.equal(rig.chosen[0].intensity,0);

const positions=new Float32Array([1,2,3]),sizes=new Float32Array([.4]),colors=new Float32Array([1,0,0]);
const sprites=particleSprites({positions,sizes,colors,map:new DataTexture()});
assert(sprites.isMesh&&!sprites.isPoints);assert(sprites.geometry.isInstancedBufferGeometry);
assert.equal(sprites.geometry.instanceCount,1);assert.equal(sprites.geometry.attributes.uv.count,4);
assert.equal(sprites.geometry.attributes.particlePosition.array,positions);assert.equal(sprites.geometry.index.count,6);
const palette=probePalette({zones:[{pos:{x:1,z:0},color:0x44ccaa,intensity:10}]});
const breached=probePalette({sky:0x5A3020,zones:[{pos:{x:1,z:0},color:0x44ccaa,intensity:10}],breached:true});
assert.notDeepEqual(palette.lobes,breached.lobes);assert.equal(palette.profile[0][1],'rgb(8,14,18)');
assert(readDeviceSignals({renderer:{backend:{device:{adapterInfo:{description:'SwiftShader'}}}}}).software);
setUnlitMrtEnabled(false,true);assert(markUnlit({}).mrtNode);
setUnlitMrtEnabled(false,false);assert.equal(markUnlit({}).mrtNode,undefined);
const { PostFX } = await import('../../src/render/PostFX.js');
const { PROFILES } = await import('../../src/config/quality.js');
for (const profile of Object.values(PROFILES)) {
  const camera = new PerspectiveCamera(75, 1.5, .05, 100);
  const p = new PostFX({ renderer: { backend: { isWebGPUBackend: false } }, worldScene: new Scene(), worldCamera: camera, viewmodelScene: new Scene(), viewmodelCamera: camera }, profile);
  if (p.aoEnabled) assert(p.worldPass.getMRT().outputNodes.aoMask);
  p.dispose();
}
console.log('PASS irradiance, light hysteresis/fades/shadow split, quad buffers, probe palette, software detection and unlit mask');

// Shared architectural maps survive unloading one of several building instances.
{
 const {AssetLoader}=await import('../../src/core/AssetLoader.js');
 const {Mesh,BoxGeometry,MeshStandardMaterial}=await import('three/webgpu');
 const loader=new AssetLoader({definitions:{}}),roots=[];
 for(let i=0;i<2;i++){
  const texture=new DataTexture(new Uint8Array([128,128,255,255]),1,1);texture.name='T_same-content';
  const root=new Group();root.add(new Mesh(new BoxGeometry(),new MeshStandardMaterial({map:texture})));
  loader._processMaterials(root,'architecture-test');roots.push(root);loader.loaded.set(String(i),{gltf:{scene:root}});
 }
 assert.equal(roots[0].children[0].material.map,roots[1].children[0].material.map);
 let disposed=0;roots[1].children[0].material.map.addEventListener('dispose',()=>disposed++);
 loader.retain(['1']);assert.equal(disposed,0,'retained building still owns shared map');
 loader.dispose();assert.equal(disposed,1);
}
console.log('PASS shared PBR texture ownership across building unloads');
