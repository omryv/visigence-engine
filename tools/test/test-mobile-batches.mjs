import assert from 'node:assert/strict';
import {Scene,Group,Mesh,BoxGeometry,PlaneGeometry,MeshStandardMaterial,Vector3,Matrix4} from 'three/webgpu';
import {StaticModelBatch} from '../../src/render/StaticModelBatch.js';
import {WorldModelBatch} from '../../src/render/WorldModelBatch.js';
const scene=new Scene(),owned=new Set(),material=new MeshStandardMaterial(),sourceGeometry=new BoxGeometry();
const batch=new StaticModelBatch(scene,owned,{merge:true,cellSize:1000});
for(const x of [3,7]){const mesh=new Mesh(sourceGeometry,material.clone());mesh.position.x=x;scene.add(mesh);batch.add(mesh);}
const merged=batch.finish();assert.equal(merged.length,1,'identical materials merge despite different object UUIDs');
merged[0].geometry.computeBoundingBox();assert.equal(merged[0].geometry.boundingBox.min.x,2.5);assert.equal(merged[0].geometry.boundingBox.max.x,7.5);
assert.equal(sourceGeometry.attributes.position.getX(0),.5,'source geometry remains immutable');
await WorldModelBatch.ready();const instances=new WorldModelBatch(scene,owned),root=new Group(),part=new Mesh(sourceGeometry,material);root.add(part);scene.add(root);instances.add(root);instances.update();
assert.equal(instances.meshes.length,1);root.visible=false;instances.update();const matrix=new Matrix4();instances.meshes[0].getMatrixAt(0,matrix);assert.equal(matrix.elements[0],0,'hidden ancestors hide batched instances');
root.visible=true;root.position.x=4;instances.update();instances.meshes[0].getMatrixAt(0,matrix);assert.equal(matrix.elements[12],4,'moving interactables update their batch');
instances.remove(root);instances.update();assert.equal(instances.meshes.length,0);
for(const resource of owned)resource.dispose();sourceGeometry.dispose();material.dispose();
console.log('Static transforms, resource ownership and moving instances passed');

// The same external image may have different glTF texture names in split LOD files.
const {AssetLoader}=await import('../../src/core/AssetLoader.js');
const {DataTexture}=await import('three/webgpu');
const loader=new AssetLoader(),a=new DataTexture(new Uint8Array([255,255,255,255]),1,1),b=a.clone(),c=a.clone();a.name='first';b.name='second';c.name='third';c.channel=1;
const textures=new WeakMap([[a,'https://assets.test/shared.png'],[b,'https://assets.test/shared.png'],[c,'https://assets.test/shared.png']]);
const testRoot=new Group(),materials=[a,b,c].map(map=>new MeshStandardMaterial({map}));materials.forEach(m=>testRoot.add(new Mesh(new BoxGeometry(),m)));
loader._processMaterials(testRoot,'architecture-test',1024,textures);
assert.equal(materials[0].map,materials[1].map,'split-file aliases must share one uploaded texture');assert.notEqual(materials[0].map,materials[2].map,'different UV channels must remain distinct');loader.dispose();
