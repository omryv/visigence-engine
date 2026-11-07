import { Group, Mesh, Matrix4, Vector3, Quaternion, BufferAttribute } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * PARTS BATCH: many placements of the parts in one parts library drawn as a handful of merged meshes, one per
 * material (and outline width), instead of one object per placement. Arcade's village flora
 * (arcade-nature-parts.glb: bushes, flowers, tufts, stepping stones, signposts) goes through it, so a
 * level of 300 placements is a few draw calls whatever the tier, and the mobile batch takes the result as it is.
 *
 * Parts are top-level nodes of the library named by their id (`bush.round`; GLTFLoader strips the '.', so the
 * id survives as userData.name) at game scale, standing on their origin. `extras.arc_outline` (Arcade's toon
 * outline width) is kept on the merged mesh so the toon pass hulls it; a library without it batches the same way.
 */
const UP = new Vector3(0, 1, 0);

export function createPartsBatch(library, { name = 'PartsBatch', prefix = 'part' } = {}) {
  library.updateMatrixWorld(true);
  const parts = new Map();
  for (const node of library.children) {
    const meshes = [];
    node.traverse(o => { if (o.isMesh) meshes.push({ geometry: o.geometry, material: o.material, local: new Matrix4().copy(node.matrixWorld).invert().multiply(o.matrixWorld) }); });
    if (meshes.length) parts.set(node.userData.name ?? node.name, { meshes, outline: node.userData.arc_outline ?? meshes[0].material?.userData?.arc_outline });
  }
  // A swaying part's weight runs from its foot (0) to its top (1): tufts and reeds bend, their roots stay put.
  const tops = new Map();
  for (const [id, part] of parts) {
    let top = 0;
    for (const mesh of part.meshes) { const p = mesh.geometry.attributes.position, v = new Vector3(); for (let i = 0; i < p.count; i++) top = Math.max(top, v.fromBufferAttribute(p, i).applyMatrix4(mesh.local).y); }
    tops.set(id, top || 1);
  }
  return {
    parts,
    /**
     * @param {{part: string, x: number, y?: number, z: number, yaw?: number, scale?: number, sx?: number}[]} items
     *   `sx` stretches a part along its own x (a fence panel fitted to its run)
     * @param {{sway?: Iterable<string>}} [options]  part ids that sway in the toon wind (render/ArcadeToon.js):
     *   their meshes carry a `sway` attribute and batch apart from the still ones
     */
    build(items, { sway = [] } = {}) {
      const groups = new Map(), t = new Matrix4(), m = new Matrix4(), q = new Quaternion(), p = new Vector3(), s = new Vector3(), v = new Vector3();
      const swaying = new Set(sway);
      let missing = 0;
      for (const it of items) {
        const part = parts.get(it.part);
        if (!part) { missing++; continue; }
        const k = it.scale ?? 1, moves = swaying.has(it.part), phase = (it.x * 0.53 + it.z * 0.29) % 6.2832, top = tops.get(it.part);
        t.compose(p.set(it.x, it.y ?? 0, it.z), q.setFromAxisAngle(UP, it.yaw ?? 0), s.set(k * (it.sx ?? 1), k, k));
        for (const mesh of part.meshes) {
          const key = `${mesh.material?.uuid}|${Object.keys(mesh.geometry.attributes).sort().join(',')}|${part.outline ?? ''}|${moves}`;
          let g = groups.get(key);
          if (!g) { g = { material: mesh.material, outline: part.outline, list: [] }; groups.set(key, g); }
          const geo = mesh.geometry.clone();
          if (moves) {
            const pos = geo.attributes.position, sw = new Float32Array(pos.count * 2);
            for (let i = 0; i < pos.count; i++) { const y = v.fromBufferAttribute(pos, i).applyMatrix4(mesh.local).y; sw[i * 2] = Math.min(1, Math.max(0, y / top)) ** 1.5; sw[i * 2 + 1] = phase; }
            geo.setAttribute('sway', new BufferAttribute(sw, 2));
          }
          g.list.push(geo.applyMatrix4(m.multiplyMatrices(t, mesh.local)));
        }
      }
      const root = new Group();
      root.name = name;
      for (const g of groups.values()) {
        const merged = mergeGeometries(g.list, false);
        for (const src of g.list) src.dispose();
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new Mesh(merged, g.material);
        mesh.name = `${prefix}_${g.material?.name ?? 'part'}`;
        if (typeof g.outline === 'number') mesh.userData.arc_outline = g.outline;
        root.add(mesh);
      }
      root.userData.missingParts = missing;
      return root;
    },
  };
}

/** Arcade's village flora: the parts batch under its old name, its meshes named `nature_<material>`. */
export const createNatureBatch = library => createPartsBatch(library, { name: 'NatureBatch', prefix: 'nature' });
