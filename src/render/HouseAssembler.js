import { Group, Mesh, Matrix4, BufferGeometry, BufferAttribute } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { houseSlotColor } from '../world/houseGrammar.js';

/**
 * HOUSE ASSEMBLER: turns a house plan and its expansion (world/houseGrammar.js generateHouse + buildHouse) into
 * geometry. It is the engine twin of the Blender preview (tools/blender/v2/arcade/house_preview.py) and meshes
 * the same way:
 *
 *   - a prism is a convex polygon in its frame's (u, v) plane extruded along w, with a chamfer of `b` on every
 *     edge (the corners cut, the caps inset), so silhouettes catch the rim light like the kit's chunky bevel.
 *     Thin pieces (tiles, beams, struts: under THIN deep) keep the chamfer round their face only. Faces are
 *     flat, except the sides of a `round` prism, which are smooth;
 *   - a lathe revolves a closed (r, z) profile, smooth around the axis and flat along the profile;
 *   - every piece carries the kit's baked gradient (vertex colour), darkening toward the bottom of its `g`
 *     range, roofs a touch warmer;
 *   - parts come from the house parts library (arcade-house-parts.glb): placed ones at their frame, hung ones
 *     on their host's socket, a paired socket also mirrored across the host's X as a re-wound copy, so every
 *     transform stays positive.
 *
 * The plan is in Blender axes (Z up, the lot's front toward -Y); the result is in glTF axes (Y up, front +Z),
 * one mesh per material and outline width. `lite` (phones and the performance tier) drops shutters, flower
 * boxes, signs and yard props and the chamfers of thin pieces: about half the triangles, the same silhouette.
 */

export const THIN = 0.35;
const LITE_SKIP = /^(shutter\.|flowerbox$|sign$|yard\.)/;
const COOL = [0.78, 0.76, 0.86], WARM = [0.8, 0.76, 0.86];
const MIRROR = new Matrix4().makeScale(-1, 1, 1);
/** Blender (x, y, z) -> glTF (x, z, -y), and back. */
const TO_GL = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const FROM_GL = TO_GL.clone().invert();

const area2 = P => { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const unit2 = (x, y) => { const l = Math.hypot(x, y); return l > 1e-12 ? [x / l, y / l] : [0, 0]; };

/** Cut every corner of a convex polygon by c along both edges; an acute corner (under 75 degrees) stays sharp. */
function chamfer2(P, c) {
  const out = [], n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[(i + n - 1) % n], b = P[i], d = P[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]), ld = Math.hypot(d[0] - b[0], d[1] - b[1]);
    if (((a[0] - b[0]) * (d[0] - b[0]) + (a[1] - b[1]) * (d[1] - b[1])) / (la * ld) > 0.2588) { out.push(b); continue; }
    out.push([b[0] + (a[0] - b[0]) / la * c, b[1] + (a[1] - b[1]) / la * c], [b[0] + (d[0] - b[0]) / ld * c, b[1] + (d[1] - b[1]) / ld * c]);
  }
  return out;
}

/** Offset a CCW polygon inward by c (mitred corners). */
function inset2(Q, c) {
  const out = [], n = Q.length;
  for (let j = 0; j < n; j++) {
    const p = Q[(j + n - 1) % n], q = Q[j], r = Q[(j + 1) % n];
    const n1 = unit2(p[1] - q[1], q[0] - p[0]), n2 = unit2(q[1] - r[1], r[0] - q[0]);
    const k = c / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    out.push([q[0] + (n1[0] + n2[0]) * k, q[1] + (n1[1] + n2[1]) * k]);
  }
  return out;
}

/** Growing vertex/index arrays for one merged mesh, in glTF axes. */
class Sink {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(p, n, c) {
    this.pos.push(p[0], p[2], -p[1]); this.nrm.push(n[0], n[2], -n[1]); this.col.push(c[0], c[1], c[2]);
    return this.count - 1;
  }
  /** A convex face, counter-clockwise from outside: one flat normal, or one normal per vertex. */
  face(pts, cols, normals = null) {
    let nx = 0, ny = 0, nz = 0;
    if (!normals) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-12)) return;
      nx /= l; ny /= l; nz /= l;
    }
    const ids = pts.map((p, i) => this.vert(p, normals ? normals[i] : [nx, ny, nz], cols[i]));
    for (let i = 1; i < ids.length - 1; i++) this.idx.push(ids[0], ids[i], ids[i + 1]);
  }
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

function gradient(z, g, slot) {
  const lo = slot === 'Roof' ? WARM : COOL, t = Math.min(1, Math.max(0, (z - g[0]) / Math.max(g[1] - g[0], 1e-6))) ** 0.8;
  return [lo[0] + (1 - lo[0]) * t, lo[1] + (1 - lo[1]) * t, lo[2] + (1 - lo[2]) * t];
}

/** Mesh one prism piece into `sink` (Blender axes in, glTF out). */
export function meshPrism(pc, sink, lite = false) {
  const f = pc.f, o = f.slice(0, 3), u = f.slice(3, 6), v = f.slice(6, 9), w = f.slice(9, 12);
  let P = pc.p.map(q => [q[0], q[1]]);
  if (area2(P) < 0) P.reverse();
  P = P.filter((p, i) => { const q = P[(i + P.length - 1) % P.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });
  if (P.length < 3) return;
  const [w0, w1] = pc.w, thin = w1 - w0 < THIN;
  let edge = Infinity;
  for (let i = 0; i < P.length; i++) { const q = P[(i + P.length - 1) % P.length]; edge = Math.min(edge, Math.hypot(P[i][0] - q[0], P[i][1] - q[1])); }
  let c = Math.min(pc.b, (w1 - w0) * 0.4, edge * 0.3);
  if (lite && thin) c = 0;
  let rings;
  if (c > 1e-4) { const Q = pc.r || thin ? P : chamfer2(P, c), I = inset2(Q, c); rings = [[I, w0], [Q, w0 + c], [Q, w1 - c], [I, w1]]; }
  else rings = [[P, w0], [P, w1]];
  const at = (a, b, ww) => [o[0] + u[0] * a + v[0] * b + w[0] * ww, o[1] + u[1] * a + v[1] * b + w[1] * ww, o[2] + u[2] * a + v[2] * b + w[2] * ww];
  const pts = rings.map(([poly, ww]) => poly.map(([a, b]) => at(a, b, ww)));
  const flip = (u[1] * v[2] - u[2] * v[1]) * w[0] + (u[2] * v[0] - u[0] * v[2]) * w[1] + (u[0] * v[1] - u[1] * v[0]) * w[2] < 0;
  const n = pts[0].length, col = p => gradient(p[2], pc.g, pc.s);
  const emit = (list, normals = null) => {
    const l = flip ? [...list].reverse() : list, nl = normals && flip ? [...normals].reverse() : normals;
    sink.face(l, l.map(col), nl);
  };
  emit([...pts[0]].reverse());
  // round prisms: smooth sides, the normal pointing out from the polygon's centre
  const smoothSide = pc.r ? (rings.length === 4 ? 1 : 0) : -1;
  let cx = 0, cy = 0;
  for (const [a, b] of P) { cx += a / P.length; cy += b / P.length; }
  const radial = ([a, b]) => { const [x, y] = unit2(a - cx, b - cy); return [u[0] * x + v[0] * y, u[1] * x + v[1] * y, u[2] * x + v[2] * y]; };
  for (let r = 0; r < rings.length - 1; r++) for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n, quad = [pts[r][k], pts[r][k1], pts[r + 1][k1], pts[r + 1][k]];
    if (r === smoothSide) { const poly = rings[r][0]; emit(quad, [radial(poly[k]), radial(poly[k1]), radial(poly[k1]), radial(poly[k])]); }
    else emit(quad);
  }
  emit(pts[rings.length - 1]);
}

/** Mesh one lathe piece into `sink`. */
export function meshLathe(pc, sink) {
  const c = pc.c, prof = pc.p, n = pc.n, m = prof.length;
  let area = 0;
  for (let i = 0; i < m; i++) area += prof[i][0] * prof[(i + 1) % m][1] - prof[(i + 1) % m][0] * prof[i][1];
  for (let i = 0; i < m; i++) {
    const [r0, z0] = prof[i], [r1, z1] = prof[(i + 1) % m];
    if (r0 < 1e-6 && r1 < 1e-6) continue;
    let [nr, nz] = area > 0 ? [z1 - z0, -(r1 - r0)] : [-(z1 - z0), r1 - r0];
    const l = Math.hypot(nr, nz) || 1; nr /= l; nz /= l;
    for (let k = 0; k < n; k++) {
      const a0 = 2 * Math.PI * k / n, a1 = 2 * Math.PI * (k + 1) / n, am = (a0 + a1) / 2;
      const P = (r, z, a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z];
      const N = a => [nr * Math.cos(a), nr * Math.sin(a), nz];
      let quad = [P(r0, z0, a0), P(r1, z1, a0), P(r1, z1, a1), P(r0, z0, a1)], normals = [N(a0), N(a0), N(a1), N(a1)];
      // wind it so its geometric normal agrees with the profile's outward normal
      const A = quad[0], B = quad[1], C = quad[2], D = quad[3];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [(C[0] - A[0]) + (D[0] - A[0]), (C[1] - A[1]) + (D[1] - A[1]), (C[2] - A[2]) + (D[2] - A[2])];
      const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], want = N(am);
      if (g[0] * want[0] + g[1] * want[1] + g[2] * want[2] < 0) { quad = quad.reverse(); normals = normals.reverse(); }
      sink.face(quad, quad.map(p => gradient(p[2], pc.g, pc.s)), normals);
    }
  }
}

/** Mirror a geometry across X with its triangles re-wound and its normals flipped in X (cached per source). */
function mirrored(geometry, cache) {
  let g = cache.get(geometry);
  if (g) return g;
  g = geometry.clone();
  const pos = g.attributes.position, nrm = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  if (nrm) for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
  const a = g.index.array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  g.computeBoundingBox(); g.computeBoundingSphere();
  cache.set(geometry, g);
  return g;
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
 * @param {import('three').Object3D} opts.library  the parts GLB's scene
 * @param {(slot: string, hex: string) => import('three').Material} opts.material  a material per colour slot
 */
export function createHouseAssembler({ library, material }) {
  const parts = new Map(), mirrorCache = new Map();
  library.updateMatrixWorld(true);
  for (const node of library.children) {
    const sockets = new Map(), meshes = [];
    node.traverse(o => {
      if (o === node) { if (o.isMesh) meshes.push(o); return; }
      if (o.userData?.socket) { o.updateMatrix(); sockets.set(o.userData.socket, o.matrix.clone()); }
      else if (o.isMesh) meshes.push(o);
    });
    // GLTFLoader strips '.' and ':' from node names; the part id survives as userData.name.
    parts.set(node.userData.name ?? node.name, { node, sockets, meshes: meshes.map(m => ({ geometry: uniform(m.geometry), slot: (m.material?.name ?? 'HSE_Wall').replace(/^HSE_/, '').replace(/\.\d+$/, ''),
      local: new Matrix4().copy(node.matrixWorld).invert().multiply(m.matrixWorld) })) });
  }

  /**
   * @param {object} plan   from generateHouse
   * @param {object} built  from buildHouse(rules, plan)
   * @param {{lite?: boolean}} [options]
   * @returns {Group} one mesh per (material, outline width), in glTF axes with the lot's centre at the origin
   */
  function build(plan, built, { lite = false } = {}) {
    const groups = new Map();
    const group = (slot, width) => {
      const hex = houseSlotColor(plan, slot), key = `${slot}|${hex}|${width}`;
      if (!groups.has(key)) groups.set(key, { material: material(slot, hex), width, sink: new Sink(), list: [] });
      return groups.get(key);
    };
    for (const pc of built.pieces) {
      const g = group(pc.s, pc.o);
      if (pc.k === 'lathe') meshLathe(pc, g.sink); else meshPrism(pc, g.sink, lite);
    }
    const placed = [];
    for (const p of built.parts) {
      let frames;
      if (p.m) {
        const m = p.m, blender = new Matrix4().set(m[3], m[6], m[9], m[0], m[4], m[7], m[10], m[1], m[5], m[8], m[11], m[2], 0, 0, 0, 1);
        frames = [[TO_GL.clone().multiply(blender).multiply(FROM_GL), false]];
      } else {
        const host = placed[p.on];
        if (!host) { placed.push(null); continue; }
        const S = parts.get(host.id)?.sockets.get(p.socket);
        if (!S) throw new Error(`House part "${host.id}" has no "${p.socket}" socket`);
        frames = [[host.matrix.clone().multiply(S), false]];
        if (p.pair) frames.push([host.matrix.clone().multiply(MIRROR).multiply(S).multiply(MIRROR), true]);
      }
      const part = parts.get(p.id);
      if (!part) throw new Error(`House part "${p.id}" is not in the library`);
      placed.push({ id: p.id, matrix: frames[0][0] });
      if (lite && LITE_SKIP.test(p.id)) continue;
      const width = part.node.userData.arc_outline ?? 0.025;
      for (const [matrix, mirror] of frames) for (const m of part.meshes) {
        const local = mirror ? MIRROR.clone().multiply(m.local).multiply(MIRROR) : m.local;
        group(m.slot, width).list.push((mirror ? mirrored(m.geometry, mirrorCache) : m.geometry).clone().applyMatrix4(matrix.clone().multiply(local)));
      }
    }
    const out = new Group(); out.name = `house:${plan.family}:${plan.key}`; out.userData.plan = plan;
    for (const { material: mat, width, sink, list } of groups.values()) {
      const all = sink.count ? [sink.geometry(), ...list] : list;
      if (!all.length) continue;
      const geometry = all.length === 1 ? all[0] : mergeGeometries(all);
      for (const g of all) if (g !== geometry) g.dispose();
      const mesh = new Mesh(geometry, mat); mesh.userData.arc_outline = width; out.add(mesh);
    }
    return out;
  }

  return { build, parts, dispose() { for (const g of mirrorCache.values()) g.dispose(); for (const p of parts.values()) for (const m of p.meshes) m.geometry.dispose(); } };
}
