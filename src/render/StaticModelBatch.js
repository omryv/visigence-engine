import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialKey } from './materialKey.js';
import { Mesh, InstancedMesh } from 'three/webgpu';

/** Batch repeated static asset primitives; preserve transforms, materials and local culling.
 * Interactables and skinned models never enter this batch. Source geometry stays asset-owned.
 */
export class StaticModelBatch {
  constructor(scene, owned, {merge=false,cellSize=24}={}) { this.merge=merge;this.cellSize=cellSize;this.scene=scene;this.owned=owned;this.groups=new Map(); }
  add(root,{detach=true}={}) {
    root.updateMatrixWorld(true);
    root.traverseVisible(o=>{
      if(!o.isMesh)return;
      if(o.isSkinnedMesh || o.morphTargetInfluences)throw Error('Animated meshes cannot enter a static batch');
      if(this.merge){this.addMerged(o);return;}
      const p=o.matrixWorld.elements, materials=Array.isArray(o.material)?o.material:[o.material];
      const key=[o.geometry.uuid,...materials.map(m=>m.uuid),o.castShadow,o.receiveShadow,Math.floor(p[12]/24),Math.floor(p[14]/24)].join(':');
      let group=this.groups.get(key);
      if(!group){group={geometry:o.geometry,material:o.material,castShadow:o.castShadow,receiveShadow:o.receiveShadow,matrices:[]};this.groups.set(key,group);}
      group.matrices.push(o.matrixWorld.clone());
    });
    if(detach)root.removeFromParent();
  }
  addMerged(o){
    const p=o.matrixWorld.elements,materials=Array.isArray(o.material)?o.material:[o.material];
    for(const [index,material]of materials.entries()){
      const geometry=o.geometry.clone();
      if(materials.length>1){const group=o.geometry.groups.find(g=>g.materialIndex===index);if(!group){geometry.dispose();continue;}
        if(!geometry.index)throw Error('Merged multi-material geometry must be indexed');
        geometry.setIndex(Array.from(geometry.index.array.slice(group.start,group.start+group.count)));geometry.clearGroups();
      }
      geometry.applyMatrix4(o.matrixWorld);
      const key=[materialKey(material),Object.keys(geometry.attributes).sort().join(','),!!geometry.index,Math.floor((p[12]+this.cellSize/2)/this.cellSize),Math.floor((p[14]+this.cellSize/2)/this.cellSize)].join('|');
      let group=this.groups.get(key);if(!group){group={material,geometries:[]};this.groups.set(key,group);}group.geometries.push(geometry);
    }
  }
  finish() {
    const result=[];
    for(const g of this.groups.values()){
      if(this.merge){
        const geometry=mergeGeometries(g.geometries);for(const source of g.geometries)source.dispose();
        if(!geometry)throw Error('Static geometry attributes cannot be merged');
        const mesh=new Mesh(geometry,g.material);mesh.name='Merged static architecture';mesh.receiveShadow=true;mesh.castShadow=false;
        geometry.computeBoundingSphere();this.scene.add(mesh);this.owned.add(geometry);result.push(mesh);continue;
      }
      const mesh=new InstancedMesh(g.geometry,g.material,g.matrices.length);
      mesh.name='Batched static architecture';mesh.castShadow=g.castShadow;mesh.receiveShadow=g.receiveShadow;
      g.matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;
      mesh.computeBoundingBox();mesh.computeBoundingSphere();this.scene.add(mesh);this.owned.add(mesh);result.push(mesh);
    }
    this.groups.clear();return result;
  }
}
