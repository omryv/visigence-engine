import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialKey } from './materialKey.js';
import { Mesh, InstancedMesh, Matrix4 } from 'three/webgpu';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
/** World guns share geometry/instances. First-person rigs retain their authored geometry. */
export class WorldModelBatch {
 constructor(scene,owned){this.scene=scene;this.owned=owned;this.entries=[];this.meshes=[];this.geometryCache=new Map();this.rigidCache=new Map();this.dirty=false;this.zero=new Matrix4().makeScale(0,0,0);}
 static async ready(){await MeshoptSimplifier.ready;}
 simplify(geometry){
  if(this.geometryCache.has(geometry))return this.geometryCache.get(geometry);
  if(!geometry.index||geometry.groups.length>1)return geometry;
  const p=geometry.attributes.position,positions=new Float32Array(p.count*3);
  for(let i=0;i<p.count;i++)positions.set([p.getX(i),p.getY(i),p.getZ(i)],i*3);
  const indices=new Uint32Array(geometry.index.array);
  const [reduced]=MeshoptSimplifier.simplify(indices,positions,3,Math.max(12,Math.floor(indices.length*.25/3)*3),.02,['Permissive']);
  const result=geometry.clone();result.setIndex(Array.from(reduced));result.clearGroups();result.computeBoundingSphere();
  this.owned.add(result);this.geometryCache.set(geometry,result);return result;
 }
 mergeRigid(root){
  root.updateWorldMatrix(true,true);const inverse=root.matrixWorld.clone().invert(),groups=new Map(),parts=[];
  root.traverseVisible(o=>{if(!o.isMesh||o.isSkinnedMesh)return;
   if(Array.isArray(o.material))throw Error('Rigid batching expects individual material primitives');
   const transform=inverse.clone().multiply(o.matrixWorld),key=materialKey(o.material)+'|'+Object.keys(o.geometry.attributes).sort().join(',');
   let group=groups.get(key);if(!group){group={material:o.material,parts:[],key};groups.set(key,group);}group.parts.push({geometry:o.geometry,transform});parts.push(o);
  });
  for(const group of groups.values()){
   const key=group.key+'|'+group.parts.map(p=>p.geometry.uuid+':'+p.transform.elements.map(n=>n.toFixed(5)).join(',')).join('|');
   let geometry=this.rigidCache.get(key);
   if(!geometry){const sources=group.parts.map(p=>p.geometry.clone().applyMatrix4(p.transform));geometry=mergeGeometries(sources);sources.forEach(g=>g.dispose());if(!geometry)throw Error('Rigid geometry cannot be merged');this.rigidCache.set(key,geometry);this.owned.add(geometry);}
   root.add(new Mesh(geometry,group.material));
  }
  parts.forEach(o=>o.visible=false);
 }
 add(root,{simplify=true,merge=false}={}){
  if(merge)this.mergeRigid(root);
  root.traverse(o=>{if(o.name==='Magazine_Fresh')o.visible=false;});
  const parts=[];root.traverseVisible(o=>{if(o.isMesh&&!o.isSkinnedMesh)parts.push(o);});
  for(const o of parts){if(simplify)o.geometry=this.simplify(o.geometry);this.entries.push({root,part:o});o.visible=false;}this.dirty=true;
 }
 remove(root){this.entries=this.entries.filter(e=>e.root!==root);this.dirty=true;}
 update(){
  if(this.dirty){
   for(const m of this.meshes){m.removeFromParent();m.dispose();this.owned.delete(m);}this.meshes=[];
   const groups=new Map();
   for(const entry of this.entries){const o=entry.part,m=Array.isArray(o.material)?o.material:[o.material],key=[o.geometry.uuid,...m.map(x=>x.uuid)].join(':');
    let g=groups.get(key);if(!g){g={geometry:o.geometry,material:o.material,entries:[]};groups.set(key,g);}g.entries.push(entry);
   }
   for(const g of groups.values()){const mesh=new InstancedMesh(g.geometry,g.material,g.entries.length);mesh.name='Instanced world objects';mesh.receiveShadow=true;mesh.userData.entries=g.entries;this.scene.add(mesh);this.owned.add(mesh);this.meshes.push(mesh);}this.dirty=false;
  }
  for(const mesh of this.meshes){
   for(const [index,{part}]of mesh.userData.entries.entries()){
    let parent=part.parent,visible=true;
    while(parent&&parent!==this.scene){if(!parent.visible)visible=false;parent=parent.parent;}
    if(parent!==this.scene)visible=false;
    if(visible){part.updateWorldMatrix(true,false);mesh.setMatrixAt(index,part.matrixWorld);}else mesh.setMatrixAt(index,this.zero);
   }
   mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();
  }
 }
}
