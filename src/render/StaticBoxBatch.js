import { BoxGeometry, InstancedMesh, Matrix4 } from 'three/webgpu';

/** Static, render-only boxes. Moving/interactable objects retain their own meshes. */
export class StaticBoxBatch {
  constructor(scene, owned, {cellSize=24, castShadow=true}={}) { this.cellSize=cellSize;this.castShadow=castShadow;this.scene=scene;this.owned=owned;this.groups=new Map(); }
  add(w,h,d,x,y,z,material) {
    // Spatial buckets retain useful culling rather than making the entire city one bound.
    const key=`${material.uuid}:${Math.floor(x/this.cellSize)}:${Math.floor(z/this.cellSize)}`;
    let group=this.groups.get(key);
    if(!group){group={material,matrices:[]};this.groups.set(key,group);}
    const matrix=new Matrix4().makeScale(w,h,d);matrix.setPosition(x,y,z);group.matrices.push(matrix);
  }
  finish() {
    const geometry=new BoxGeometry(1,1,1);this.owned.add(geometry);
    const meshes=[];
    for(const {material,matrices} of this.groups.values()) {
      const mesh=new InstancedMesh(geometry,material,matrices.length);
      mesh.name='Static architectural details';mesh.castShadow=this.castShadow;mesh.receiveShadow=true;
      matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;
      mesh.computeBoundingBox();mesh.computeBoundingSphere();this.scene.add(mesh);
      this.owned.add(mesh);meshes.push(mesh);
    }
    this.groups.clear();return meshes;
  }
}
