import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, InstancedBufferGeometry,
  InstancedBufferAttribute, DynamicDrawUsage } from 'three/webgpu';
import { attribute, positionGeometry, modelViewMatrix, cameraProjectionMatrix,
  vec3, vec4, texture, uv, materialColor, materialOpacity } from 'three/tsl';
import { markUnlit } from './Environment.js';

/** Camera-facing quads with fixed buffers. Size is the full diameter in world metres. */
export function particleSprites({ positions, sizes, colors, map, worldPass = true, ...options }) {
  const plane = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.attributes.position = plane.attributes.position;
  geometry.attributes.uv = plane.attributes.uv;
  geometry.instanceCount = sizes.length;
  for (const [name, data, width] of [
    ['particlePosition', positions, 3], ['particleSize', sizes, 1], ['particleColor', colors, 3],
  ]) geometry.setAttribute(name, new InstancedBufferAttribute(data, width).setUsage(DynamicDrawUsage));
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, ...options });
  // Viewmodel and preview passes have only a colour attachment. World-only MRT outputs
  // there generate an empty WGSL output struct on WebGPU (and invisible particles).
  if (worldPass) markUnlit(material);
  const center = attribute('particlePosition', 'vec3');
  const viewCenter = modelViewMatrix.mul(vec4(center, 1)).xyz;
  const offset = vec3(positionGeometry.xy.mul(attribute('particleSize', 'float')), 0);
  material.positionNode = center;
  material.vertexNode = cameraProjectionMatrix.mul(vec4(viewCenter.add(offset), 1));
  const dot = texture(map, uv());
  material.colorNode = dot.rgb.mul(attribute('particleColor', 'vec3')).mul(materialColor);
  material.opacityNode = dot.a.mul(materialOpacity);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
