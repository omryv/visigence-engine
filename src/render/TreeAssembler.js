import { Group, Mesh, Matrix4, BufferGeometry, BufferAttribute, Vector3 } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { treeSlotColor } from '../world/treeGrammar.js';

/**
 * TREE ASSEMBLER: turns the tree plans of a level (world/treeGrammar.js generateTree, one per scatter point)
 * into geometry. It is the engine twin of the Blender preview (tools/blender/v2/arcade/tree_preview.py) and
 * meshes a plan the same way:
 *
 *   - every skeleton segment is a tapered tube (8 sides, 6 in lite) between its two rings, closed with a fan
 *     where nothing grows on; the first trunk segment starts a little under the ground and flares into
 *     lobed roots at its foot (full build only), so it sits on any lawn;
 *   - the bark's tone ramp is baked as vertex colour: dark at the foot, lighter up the trunk, faint streaks
 *     round the girth, darkening again toward the twigs;
 *   - canopy parts come from the tree parts library (arcade-tree-parts.glb), each at its socket, spun by the
 *     plan's k/64 turn and scaled; lite takes the `.lite` twin of every part.
 *
 * The whole level's trees merge into ONE mesh per (colour slot, colour, outline width): a village of seventy
 * trees is under a dozen draw calls whatever the tier, and the mobile batch takes the result as it is. The plan
 * is in Blender axes (Z up); the result is in glTF axes (Y up).
 */

const SIDES = 8, SIDES_LITE = 6;

/** sRGB hex -> linear RGB. */
function lin(hex) {
  const n = parseInt(hex.slice(1), 16), f = c => { const u = c / 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
/** The kit's bark ramp (tools/blender/v2/arcade/nature.py BARK) as a multiplier of its sunlit stop. */
const BARK = ['#5e3521', '#8a532f', '#b0733f'].map(lin), BARK_TOP = BARK[BARK.length - 1];
function barkMult(t) {
  const u = Math.min(1, Math.max(0, t)) * (BARK.length - 1), i = Math.min(Math.floor(u), BARK.length - 2), f = u - i, a = BARK[i], b = BARK[i + 1];
  return [Math.min(1, (a[0] + (b[0] - a[0]) * f) / BARK_TOP[0]), Math.min(1, (a[1] + (b[1] - a[1]) * f) / BARK_TOP[1]), Math.min(1, (a[2] + (b[2] - a[2]) * f) / BARK_TOP[2])];
}

/** Growing vertex/index arrays for one merged mesh, in glTF axes. */
class Sink {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(p, n, c) { this.pos.push(p[0], p[2], -p[1]); this.nrm.push(n[0], n[2], -n[1]); this.col.push(c[0], c[1], c[2]); return this.count - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.count > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Mesh a plan's skeleton into `sink` (Blender axes in, glTF out). `top` is the plan's top for the bark ramp.
 * @returns {number} triangles added
 */
export function meshSkeleton(plan, sink, lite = false) {
  const n = lite ? SIDES_LITE : SIDES, hasChild = new Set(plan.segments.map(g => g.i)), before = sink.idx.length;
  const seed = plan.segments.length * 7 + plan.sockets.length;
  for (const [si, g] of plan.segments.entries()) {
    const dir = unit(sub(g.b, g.a));
    const u = Math.abs(dir[2]) < 0.99 ? unit(cross(dir, [0, 0, 1])) : [1, 0, 0], v = cross(dir, u);
    // rings: [centre, radius, flareLobes]; the trunk foot starts under the lawn and flares into roots. A palm
    // ('rings') gets a proud lip at every trunk joint, its frond scar; a cactus ('ribs') no root flare at all.
    const style = plan.bark, root = g.i < 0 && !lite && style !== 'ribs', lobes = style ? 0.25 : 0.5;
    const at = t => [g.a[0] + dir[0] * t, g.a[1] + dir[1] * t, g.a[2] + dir[2] * t];
    const rings = root
      ? [[[g.a[0], g.a[1], g.a[2] - 0.06], g.r0 * (style ? 1.3 : 1.5), lobes], [at(0.14), g.r0 * 1.14, lobes * 0.44], [at(0.36), g.r0 * 1.02, 0.04], [g.b, g.r1, 0]]
      : style === 'rings' && g.d === 0 ? [[g.a, g.r0 * 1.12, 0], [at(0.1), g.r0 * 0.97, 0], [g.b, g.r1, 0]]
        : [[g.i < 0 ? [g.a[0], g.a[1], g.a[2] - 0.06] : g.a, g.r0, 0], [g.b, g.r1, 0]];
    const ids = rings.map(([c, r, lobe], ri) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const a = 2 * Math.PI * k / n, ca = Math.cos(a), sa = Math.sin(a);
        const flare = 1 + lobe * Math.max(0, Math.cos(5 * a + seed)) ** 2;
        const rad = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
        const p = [c[0] + rad[0] * r * flare, c[1] + rad[1] * r * flare, c[2] + rad[2] * r * flare];
        let col;
        if (style === 'ribs') { const m = 0.78 + 0.22 * (0.5 + 0.5 * Math.cos(Math.PI * k)); col = [m, m, m]; }
        else if (style === 'rings') { const m = ri === 0 && rings.length === 3 ? 0.62 : 0.84 + 0.16 * (0.5 + 0.5 * Math.cos(4 * a + si * 1.7)); col = [m, m * 0.97, m * 0.94]; }
        else {
          // bark tone: up the trunk, a streak round the girth, darker toward the twigs
          const h = Math.min(1, p[2] / Math.max(0.35 * plan.top, 1e-3)), streak = 0.5 + 0.5 * Math.cos(4 * a + si * 1.7);
          col = barkMult(0.35 + 0.45 * h + 0.25 * streak - 0.3 * Math.max(0, (p[2] - 0.75 * plan.top) / (0.25 * plan.top)) - 0.08 * g.d);
        }
        out.push(sink.vert(p, rad, col));
      }
      return out;
    });
    for (let r = 0; r < ids.length - 1; r++) for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n, a = ids[r][k], b = ids[r][k1], c = ids[r + 1][k1], d = ids[r + 1][k];
      sink.tri(a, b, c); sink.tri(a, c, d);
    }
    // a tip: close it with a fan
    if (!hasChild.has(si)) {
      const c = sink.vert(g.b, dir, barkMult(0.25)), last = ids[ids.length - 1];
      for (let k = 0; k < n; k++) sink.tri(last[k], last[(k + 1) % n], c);
    }
  }
  return (sink.idx.length - before) / 3;
}

/** A library geometry reduced to position, normal and an RGB colour, so every piece merges with every other. */
function uniform(geometry) {
  const g = geometry.clone();
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
  const c = g.attributes.color;
  if (!c) g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  else if (c.itemSize === 4 || c.normalized || !(c.array instanceof Float32Array)) {
    const c3 = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) { c3[i * 3] = c.getX(i); c3[i * 3 + 1] = c.getY(i); c3[i * 3 + 2] = c.getZ(i); }
    g.setAttribute('color', new BufferAttribute(c3, 3));
  }
  if (!g.index) { const idx = new Uint32Array(g.attributes.position.count); for (let i = 0; i < idx.length; i++) idx[i] = i; g.setIndex(new BufferAttribute(idx, 1)); }
  return g;
}

/**
 * @param {object} opts
 * @param {import('three').Object3D} opts.library  the tree parts GLB's scene
 * @param {(slot: string, hex: string) => import('three').Material} opts.material  a material per colour slot and colour
 */
export function createTreeAssembler({ library, material }) {
  const parts = new Map();
  library.updateMatrixWorld(true);
  for (const node of library.children) {
    const meshes = [];
    node.traverse(o => { if (o.isMesh) meshes.push({ geometry: uniform(o.geometry), slot: (o.material?.name ?? 'TRE_Leaf').replace(/^TRE_/, '').replace(/\.\d+$/, ''), local: new Matrix4().copy(node.matrixWorld).invert().multiply(o.matrixWorld) }); });
    // GLTFLoader strips '.' from node names; the part id survives as userData.name.
    if (meshes.length) parts.set(node.userData.name ?? node.name, { meshes });
  }

  /**
   * @param {{plan: object, x: number, y?: number, z: number, yaw?: number, scale?: number, lean?: number[]}[]} items  one entry per
   *   placed tree; `lean` [dx, dz, radians] tips the whole tree toward the water beside it (world/worldTerrain.js)
   * @param {{lite?: boolean}} [options]
   * @returns {Group} one mesh per (slot, colour, outline width), in world space. Canopy meshes carry a `sway`
   *   attribute (weight rising up each clump, a phase per tree) for the toon wind (render/ArcadeToon.js).
   */
  function build(items, { lite = false } = {}) {
    const groups = new Map(), world = new Matrix4(), place = new Matrix4(), socket = new Matrix4(), tilt = new Matrix4(), axis = new Vector3();
    const group = (plan, slot) => {
      const hex = treeSlotColor(plan, slot), key = `${slot}|${hex}|${plan.outline}`;
      if (!groups.has(key)) groups.set(key, { material: material(slot, hex), width: plan.outline, sink: new Sink(), list: [], slot });
      return groups.get(key);
    };
    let missing = 0, skeletonTris = 0;
    for (const it of items) {
      const plan = it.plan, k = it.scale ?? 1;
      world.makeRotationY(it.yaw ?? 0).scale({ x: k, y: k, z: k, isVector3: true });
      // A lean turns the tree about the axis square to its water direction (up x toward), pivoting at the foot.
      if (it.lean?.[2] > 0) world.premultiply(tilt.makeRotationAxis(axis.set(it.lean[1], 0, -it.lean[0]).normalize(), it.lean[2]));
      world.setPosition(it.x, it.y ?? 0, it.z);
      const phase = (it.x * 0.37 + it.z * 0.61) % 6.2832;
      // the skeleton, meshed in place: its sink is in glTF axes around the tree's origin, so it takes the world transform after
      const bark = group(plan, 'Bark'), local = new Sink();
      skeletonTris += meshSkeleton(plan, local, lite);
      bark.list.push(local.geometry().applyMatrix4(world));
      for (const q of plan.sockets) {
        const part = parts.get(lite && parts.has(`${q.part}.lite`) ? `${q.part}.lite` : q.part);
        if (!part) { missing++; continue; }
        // socket frame in Blender axes: translate, spin about Z, scale; a Blender Z turn is a glTF Y turn
        socket.makeRotationY(2 * Math.PI * q.k / 64).scale({ x: q.s, y: q.s, z: q.s, isVector3: true }).setPosition(q.p[0], q.p[2], -q.p[1]);
        place.multiplyMatrices(world, socket);
        for (const m of part.meshes) {
          // In the clump's own frame first: the sway weight rises from its base to its crown, then into the world.
          const g = m.geometry.clone().applyMatrix4(m.local), p = g.attributes.position, sw = new Float32Array(p.count * 2);
          for (let i = 0; i < p.count; i++) { const y = p.getY(i); sw[i * 2] = Math.min(1, Math.max(0, 0.4 + y / 1.4)); sw[i * 2 + 1] = phase + q.k * 0.1; }
          if (m.slot !== 'Bark') g.setAttribute('sway', new BufferAttribute(sw, 2));
          group(plan, m.slot).list.push(g.applyMatrix4(place));
        }
      }
    }
    const out = new Group(); out.name = 'TreeBatch';
    for (const { material: mat, width, list, slot } of groups.values()) {
      if (!list.length) continue;
      const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false);
      for (const g of list) if (g !== geometry) g.dispose();
      if (!geometry) continue;
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, mat); mesh.name = `trees_${slot}`; mesh.userData.arc_outline = width; out.add(mesh);
    }
    out.userData.missingParts = missing; out.userData.skeletonTris = skeletonTris; out.userData.trees = items.length;
    return out;
  }

  return { build, parts, dispose() { for (const p of parts.values()) for (const m of p.meshes) m.geometry.dispose(); } };
}
