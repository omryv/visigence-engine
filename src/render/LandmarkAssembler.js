import { Group, Mesh, Matrix4, Vector3, Quaternion } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * LANDMARK ASSEMBLER: a village landmark (world/worldLandmarks.js) from the landmark parts library
 * (arcade-landmark-parts.glb), one Group per landmark: the still meshes merged per (material, outline width), and
 * every MOVING node (a windmill's sails, a waterwheel) as its own mesh at the node's authored transform, carrying
 * `userData.spin` {axis, rate, wind} for the session to turn each frame. One transform per moving part per frame,
 * on every tier; `lite` (phones and the performance tier) takes the `.lite` twin of the part.
 *
 * Library contract (landmark_parts.py): one top-level node per part named by its id (`stall.a`; GLTFLoader keeps
 * the id in userData.name), standing on its origin at game scale, its front toward +Z; `extras.arc_outline` is the
 * outline width; a child node with `extras.arc_spin` {axis, rate, wind?} is a moving part hinged on its own origin.
 * Materials are the kit's ARC_ ones (toon-swapped by the session) or colour SLOTS named LMK_<Slot> (white times the
 * gradient) that take the landmark's `colors[slot]` (a stall's awning) through `material(slot, hex)`.
 */
const UP = new Vector3(0, 1, 0);

export function createLandmarkAssembler({ library, material }) {
  library.updateMatrixWorld(true);
  const parts = new Map();
  for (const node of library.children) {
    const still = [], moving = [];
    const gather = (root, into) => root.traverse(o => {
      if (o.isMesh && (o === root || !o.userData?.arc_spin) && !(o !== root && ancestorSpin(o, root))) into.push({ geometry: o.geometry, material: o.material, local: new Matrix4().copy(root.matrixWorld).invert().multiply(o.matrixWorld) });
    });
    const ancestorSpin = (o, root) => { for (let p = o.parent; p && p !== root; p = p.parent) if (p.userData?.arc_spin) return true; return false; };
    gather(node, still);
    node.traverse(o => {
      if (o === node || !o.userData?.arc_spin) return;
      const meshes = [];
      o.traverse(m => { if (m.isMesh) meshes.push({ geometry: m.geometry, material: m.material, local: new Matrix4().copy(o.matrixWorld).invert().multiply(m.matrixWorld) }); });
      // Blender suffixes a twin's child ('Wheel.001'); the moving part's name is the stem.
      moving.push({ name: (o.userData.name ?? o.name).split('.')[0], spin: o.userData.arc_spin, meshes, frame: new Matrix4().copy(node.matrixWorld).invert().multiply(o.matrixWorld) });
    });
    if (still.length || moving.length) parts.set(node.userData.name ?? node.name, { node, still, moving, outline: node.userData.arc_outline ?? 0.03 });
  }
  const slotOf = m => (m?.name ?? '').startsWith('LMK_') ? m.name.replace(/^LMK_/, '').replace(/\.\d+$/, '') : null;
  const mat = (m, landmark) => { const slot = slotOf(m); return slot ? material(slot, landmark.colors?.[slot] ?? '#ffffff') : m; };

  return {
    parts,
    /**
     * @param {{kind: string, part: string, colors?: object, wheel?: {y: number}}} landmark  the placement's landmark record
     * @param {{lite?: boolean}} [options]
     * @returns {Group} in glTF axes, the landmark's origin at the group's origin; `userData.spinners` lists its moving meshes
     */
    build(landmark, { lite = false } = {}) {
      const id = lite && parts.has(`${landmark.part}.lite`) ? `${landmark.part}.lite` : landmark.part, part = parts.get(id);
      const out = new Group(); out.name = `landmark:${landmark.kind}`; out.userData.kind = landmark.kind; out.userData.spinners = [];
      if (!part) { out.userData.missing = landmark.part; return out; }
      const groups = new Map();
      for (const m of part.still) {
        const material_ = mat(m.material, landmark), key = `${material_?.uuid}|${Object.keys(m.geometry.attributes).sort().join(',')}`;
        let g = groups.get(key);
        if (!g) { g = { material: material_, list: [] }; groups.set(key, g); }
        g.list.push(m.geometry.clone().applyMatrix4(m.local));
      }
      for (const g of groups.values()) {
        const merged = g.list.length === 1 ? g.list[0] : mergeGeometries(g.list, false);
        if (merged !== g.list[0]) for (const src of g.list) src.dispose();
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new Mesh(merged, g.material); mesh.name = `${landmark.kind}_${g.material?.name ?? 'part'}`; mesh.userData.arc_outline = part.outline; out.add(mesh);
      }
      for (const mv of part.moving) {
        const list = mv.meshes.map(m => m.geometry.clone().applyMatrix4(m.local)), merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
        if (merged !== list[0]) for (const src of list) src.dispose();
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new Mesh(merged, mat(mv.meshes[0].material, landmark)); mesh.name = `${landmark.kind}_${mv.name}`; mesh.userData.arc_outline = part.outline;
        mesh.applyMatrix4(mv.frame);
        // The waterwheel's axle sits where the grammar put it on the water: the authored height is overridden.
        if (mv.name === 'Wheel' && landmark.wheel) mesh.position.y = landmark.wheel.y;
        mesh.userData.spin = { axis: mv.spin.axis ?? 'y', rate: mv.spin.rate ?? 0.5, wind: !!mv.spin.wind };
        out.add(mesh); out.userData.spinners.push(mesh);
      }
      return out;
    },
    /** A landmark placed in the world: the group at (x, y, z) turned by yaw (about +Y). */
    place(landmark, x, y, z, yaw, options) {
      const g = this.build(landmark, options), q = new Quaternion().setFromAxisAngle(UP, yaw);
      g.position.set(x, y, z); g.quaternion.copy(q);
      return g;
    },
  };
}

/** Triangles of a landmark per tier from the parts index (world/landmarkParts.js), for the budgets test. */
export function landmarkTris(index, part, lite = false) {
  const id = lite && index[`${part}.lite`] ? `${part}.lite` : part;
  return index[id]?.tris ?? 0;
}
