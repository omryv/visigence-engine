import assert from 'node:assert/strict';
import { AnimationMixer, Vector3, Box3 } from 'three/webgpu';
import { CATALOG } from '../../src/world/catalog.js';
import { readGLB, loadGeometry } from '../lib/hand-asset.mjs';
const models=[...new Set(Object.values(CATALOG).flatMap(c=>Object.keys(c.measurements)))],report=[];
for(const file of models){
 const gltf=await loadGeometry(readGLB(file)),scene=gltf.scene,clips=gltf.animations;
 let verts=0,skinned=0;scene.updateMatrixWorld(true);
 scene.traverse(o=>{if(!o.isMesh)return;verts+=o.geometry.attributes.position.count;if(o.isSkinnedMesh){skinned++;const w=o.geometry.attributes.skinWeight;for(let i=0;i<w.count;i++){let sum=0;for(let k=0;k<4;k++)sum+=w.getComponent(i,k);assert(Math.abs(sum-1)<.025,`${file}: invalid skin sum ${sum}`);}}});
 assert(verts>0,file);const base=new Box3().setFromObject(scene),height=base.max.y-base.min.y;
 const mixer=new AnimationMixer(scene),entries=[];
 for(const clip of clips){
  assert(clip.duration>0 && Number.isFinite(clip.duration),file);assert(clip.tracks.length>0,file);
  for(const track of clip.tracks)assert([...track.values].every(Number.isFinite),`${file}: nonfinite track`);
  mixer.stopAllAction();const action=mixer.clipAction(clip).play();let maxExtent=0,minY=Infinity,moved=0,first=[];
  for(let frame=0;frame<=8;frame++){
   action.time=clip.duration*frame/8;mixer.update(0);scene.updateMatrixWorld(true);const bounds=new Box3();let current=[];
   scene.traverse(o=>{if(!o.isMesh)return;o.skeleton?.update();const n=o.geometry.attributes.position.count;for(let i=0;i<n;i+=Math.max(1,Math.floor(n/350))){const v=o.getVertexPosition(i,new Vector3()).applyMatrix4(o.matrixWorld);assert(v.toArray().every(Number.isFinite),`${file}: broken skin`);bounds.expandByPoint(v);current.push(v);}});
   if(!frame)first=current;else for(let i=0;i<current.length;i++)moved=Math.max(moved,current[i].distanceTo(first[i]));
   maxExtent=Math.max(maxExtent,bounds.getSize(new Vector3()).length());minY=Math.min(minY,bounds.min.y);
  }
  assert(maxExtent<Math.max(1,base.getSize(new Vector3()).length())*3,`${file}: exploding animation ${clip.name}`);
  entries.push({name:clip.name,duration:clip.duration,tracks:clip.tracks.length,maxSampledDisplacement:moved,minY,maxExtent});
 }
 mixer.stopAllAction();mixer.uncacheRoot(scene);scene.traverse(o=>o.geometry?.dispose());
 report.push({model:file,vertices:verts,skinnedMeshes:skinned,height,clips:entries});
}
// Skeletal enemies carry their clip set; rigid ones (Arcade's critters) are one unskinned body the engine animates.
for(const [theme,c] of Object.entries(CATALOG))for(const e of c.enemies){const r=report.find(r=>r.model===e.model);if(e.animation==='rigid'){assert(r.skinnedMeshes===0&&!r.clips.length,`${theme}/${e.id} is not rigid`);continue;}for(const name of ['Idle','Walk','Run','Death'])assert(r.clips.some(a=>a.name.split('_').at(-1).split('.')[0]===name),`${theme}/${e.id} missing ${name}`);assert(e.animation==='clips');}
console.log(`${models.length} catalog models: decoded geometry/skins and ${report.reduce((n,r)=>n+r.clips.length,0)} clips sampled. ${Object.values(CATALOG).flatMap(c=>c.enemies).length} enemy entries match their clip or rigid contract.`);
