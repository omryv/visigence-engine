import { Group, Mesh, Matrix4, Vector3, SphereGeometry, TubeGeometry, CatmullRomCurve3, BufferAttribute } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../utils/math.js';

/**
 * CREATURE ASSEMBLER: turns a creature blueprint (world/creatureGrammar.js) into geometry, from the parts
 * library GLB (tools/blender/v2/arcade/creature_parts.py). It is the engine twin of the Blender preview
 * (creature_preview.py) and follows the same rules:
 *
 *   - the body sits at the creature origin; every other part goes on its parent's socket (a child node
 *     named '<part>:<socket>' with extras.socket), right side first, then mirrored across X for pairs -
 *     as a mirrored COPY of the geometry with its winding flipped, so every transform stays positive and
 *     the rigid-body bake (anim/RigidBody.js) keeps the faces the right way out;
 *   - the library's CRT_<Slot> materials are colour slots, filled from the blueprint's palette;
 *   - the face is projected onto the body: rays from the body's `face.c` at an azimuth and elevation hit
 *     the surface, and flattened eyes, pupils, catchlights, brows, mouth and blush are laid on it;
 *   - surface patterns are scattered over the target part's zone by Poisson-disc sampling on the sphere
 *     of directions (seeded), then projected the same way.
 *
 * Units are the library's: a body stands about 1 tall. The session scales the result to the catalog
 * height through prepareRigidBody, and outline widths (userData.arc_outline) scale with it.
 */

const PALETTE_SLOTS = { Body: 'body', Accent: 'accent', Trim: 'trim', Leaf: 'leaf' };
const SHARED_SLOTS = { Wood: 'wood', Gold: 'gold', Stone: 'stone', Wing: 'wing', Ink: 'ink', White: 'white', Shine: 'shine' };
const DEG = Math.PI / 180;
const MIRROR = new Matrix4().makeScale(-1, 1, 1);

/** Direction from a face centre: azimuth degrees from the front (+Z) toward +X, elevation degrees up. glTF axes. */
export function fdir(az, el) {
  const a = az * DEG, e = el * DEG;
  return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/** The colour a slot takes in this blueprint. */
export function slotColor(bp, slot) {
  const pal = bp.palette, col = bp.colors;
  if (slot in PALETTE_SLOTS) {
    const key = PALETTE_SLOTS[slot];
    return pal[key] ?? { accent: pal.body, trim: col.white, leaf: col.leaf }[key] ?? pal.body;
  }
  return col[SHARED_SLOTS[slot] ?? 'white'];
}

/** Rays against a part's triangles (every primitive), from inside, both faces counted: where a feature sits. */
export class Skin {
  constructor(geometries, centre) {
    this.g = (Array.isArray(geometries) ? geometries : [geometries]).map(g => ({ p: g.attributes.position, i: g.index, n: g.index ? g.index.count : g.attributes.position.count }));
    this.c = centre.clone();
  }
  hit(dir) {
    let best = null;
    for (const g of this.g) { const h = this._hit(dir, g); if (h && (!best || h.dist < best.dist)) best = h; }
    return best;
  }
  _hit(dir, { p, i: index, n }) {
    const d = dir.clone().normalize(), o = this.c;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), h = new Vector3(), s = new Vector3(), q = new Vector3();
    let best = Infinity, normal = null;
    for (let t = 0; t < n; t += 3) {
      const i0 = index ? index.getX(t) : t, i1 = index ? index.getX(t + 1) : t + 1, i2 = index ? index.getX(t + 2) : t + 2;
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
      e1.subVectors(b, a); e2.subVectors(c, a); h.crossVectors(d, e2);
      const det = e1.dot(h);
      if (Math.abs(det) < 1e-12) continue;
      const f = 1 / det; s.subVectors(o, a);
      const u = f * s.dot(h); if (u < 0 || u > 1) continue;
      q.crossVectors(s, e1);
      const v = f * d.dot(q); if (v < 0 || u + v > 1) continue;
      const dist = f * e2.dot(q);
      if (dist > 1e-6 && dist < best) { best = dist; normal = new Vector3().crossVectors(e1, e2).normalize(); }
    }
    if (!normal) return null;
    const point = o.clone().addScaledVector(d, best);
    if (normal.dot(d) < 0) normal.negate();     // outward: away from the centre the ray left
    return { point, normal, dist: best };
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
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  } else {
    for (const attr of Object.values(g.attributes)) {
      const n = attr.itemSize, arr = attr.array;
      for (let i = 0; i < attr.count; i += 3) for (let k = 0; k < n; k++) { const t = arr[(i + 1) * n + k]; arr[(i + 1) * n + k] = arr[(i + 2) * n + k]; arr[(i + 2) * n + k] = t; }
    }
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  cache.set(geometry, g);
  return g;
}

/** A local frame whose Z is the surface normal and whose Y leans toward world up (as Blender's track-to). */
function surfaceMatrix(point, normal, spin, scale) {
  const z = normal.clone().normalize();
  let x = new Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-8) x = new Vector3(1, 0, 0).cross(z);
  x.normalize();
  const y = new Vector3().crossVectors(z, x);
  const m = new Matrix4().makeBasis(x, y, z).multiply(new Matrix4().makeRotationZ(spin));
  m.scale(scale); m.setPosition(point);
  return m;
}

/**
 * Directions over a pattern zone: evenly spaced on a ring, or Poisson-disc (dart throwing with a minimum
 * angular distance sized to the count) on the sphere of directions. Mirrors creature_preview.scatter_dirs.
 */
export function scatterDirs(meta, count, seed, kind) {
  const rng = mulberry32(seed), lo = meta.el[0] * DEG, hi = meta.el[1] * DEG;
  if (kind === 'ring') {
    const el = (lo + (hi - lo) * 0.18) / DEG, off = rng() * 360;
    return Array.from({ length: count }, (_, k) => fdir(off + (360 * k) / count, el));
  }
  const z0 = Math.sin(lo), z1 = Math.sin(hi), dmin = Math.sqrt((2 * Math.PI * (z1 - z0)) / count) * 0.72, dirs = [];
  for (let i = 0; i < count * 30 && dirs.length < count; i++) {
    const z = z0 + rng() * (z1 - z0), a = rng() * 2 * Math.PI, rxy = Math.sqrt(Math.max(0, 1 - z * z));
    const d = new Vector3(rxy * Math.cos(a), z, -rxy * Math.sin(a));   // Blender (x, y, z) -> glTF (x, z, -y)
    if (dirs.every(p => d.angleTo(p) >= dmin)) dirs.push(d);
  }
  return dirs;
}

/**
 * @param {object} opts
 * @param {import('three').Object3D} opts.library  the parts GLB's scene
 * @param {(slot: string, hex: string) => import('three').Material} opts.material  a material per colour slot
 */
export function createCreatureAssembler({ library, material }) {
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
    parts.set(node.userData.name ?? node.name, { node, sockets, meshes: meshes.map(m => ({ geometry: m.geometry, material: m.material, local: new Matrix4().copy(node.matrixWorld).invert().multiply(m.matrixWorld) })) });
  }
  const sphere = new Map();
  const ball = detail => { if (!sphere.has(detail)) sphere.set(detail, new SphereGeometry(1, detail * 4, detail * 3)); return sphere.get(detail); };

  function place(group, geometry, mat, matrix, width) {
    const mesh = new Mesh(geometry, mat);
    matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.userData.arc_outline = width;
    group.add(mesh);
    return mesh;
  }

  /**
   * @param {object} bp  a blueprint from generateCreature
   * @param {{merge?: boolean}} [options]  merge (default): bake every piece into one mesh per material and
   *   outline width, so a creature costs a handful of draw calls instead of one per eye, spot and leaf.
   */
  function build(bp, { merge = true } = {}) {
    const root = assemble(bp);
    return merge ? merged(root) : root;
  }

  function assemble(bp) {
    const root = new Group(); root.name = `creature:${bp.family}:${bp.key}`; root.userData.blueprint = bp;
    const placed = new Map();
    for (const p of bp.parts) {
      const part = parts.get(p.part);
      if (!part) throw new Error(`Creature part "${p.part}" is not in the library`);
      let placements;
      if (!p.on) placements = [[new Matrix4(), false]];
      else {
        const parent = placed.get(p.on), socket = parts.get(parent.part).sockets.get(p.socket);
        if (!socket) throw new Error(`"${parent.part}" has no "${p.socket}" socket`);
        const base = parent.matrix.clone().multiply(socket);
        placements = [[base, false]];
        if (p.pair) placements.push([MIRROR.clone().multiply(base).multiply(MIRROR), true]);
      }
      placements.forEach(([matrix, mirror], i) => {
        for (const m of part.meshes) {
          const slot = (m.material?.name ?? 'CRT_Body').replace(/^CRT_/, '');
          place(root, mirror ? mirrored(m.geometry, mirrorCache) : m.geometry, material(slot, slotColor(bp, slot)),
            matrix.clone().multiply(mirror ? MIRROR.clone().multiply(m.local).multiply(MIRROR) : m.local), part.node.userData.arc_outline ?? 0.018);
        }
        if (i === 0) placed.set(p.slot, { part: p.part, matrix });
      });
      if (!p.on) face(root, bp, part);
    }
    for (const pat of bp.patterns) {
      const target = placed.get(pat.on), part = parts.get(target.part), meta = part.node.userData.pattern;
      if (!meta) continue;
      const skin = new Skin(part.meshes.map(m => m.geometry), new Vector3(...meta.c)), rng = mulberry32((pat.seed ^ 0x5bd1e995) >>> 0);
      const mat = material('Trim', bp.palette[pat.color] ?? bp.colors.white);
      for (const d of scatterDirs(meta, pat.count, pat.seed, pat.pattern)) {
        const r = pat.size * (0.8 + 0.4 * rng()), h = skin.hit(d);
        if (!h) continue;
        place(root, ball(2), mat, target.matrix.clone().multiply(surfaceMatrix(h.point.addScaledVector(h.normal, -0.02 * r), h.normal, 0, new Vector3(r, r, r * 0.22))), 0.008);
      }
    }
    return root;
  }

  /** Eyes, pupils, catchlights, brows, mouth and blush, projected onto the body (the body sits at the origin). */
  function face(root, bp, body) {
    const meta = body.node.userData.face;
    if (!meta) return;
    const skin = new Skin(body.meshes.map(m => m.geometry), new Vector3(...meta.c)), f = bp.face;
    const r = meta.r * f.eye, az = meta.az * (0.9 + 0.1 * f.eye), el = meta.el;
    const first = skin.hit(fdir(az, el));
    if (!first) return;
    const ang = (r / first.point.distanceTo(skin.c)) / DEG;
    const ink = material('Ink', bp.colors.ink), white = material('White', bp.colors.white), shine = material('Shine', bp.colors.shine), blush = material('Blush', bp.colors.blush);
    const stick = (dir, size, mat, scale, out = 0, spin = 0, detail = 3, width = 0.006) => {
      const h = skin.hit(dir);
      if (h) place(root, ball(detail), mat, surfaceMatrix(h.point.addScaledVector(h.normal, out), h.normal, spin, new Vector3(size * scale[0], size * scale[1], size * scale[2])), width);
    };
    const line = (dirs, radius, mat, out = 0) => {
      const pts = dirs.map(d => skin.hit(d)).filter(Boolean).map(h => h.point.addScaledVector(h.normal, out));
      if (pts.length >= 2) place(root, new TubeGeometry(new CatmullRomCurve3(pts), pts.length * 4, radius, 6, false), mat, new Matrix4(), 0.006);
    };
    const look = f.look ?? 0;
    for (const s of [-1, 1]) {
      const a = s * az;
      if (f.eyes === 'round') {
        stick(fdir(a, el), r, white, [0.82, 1.12, 0.42], -0.25 * r);
        stick(fdir(a, el - 0.3 * ang + look * ang * 0.4), r * 0.58, ink, [0.8, 1.0, 0.5], r * 0.1);
        stick(fdir(a - ang * 0.25, el + ang * 0.3), r * 0.2, shine, [1, 1, 0.5], r * 0.34, 0, 2, 0);
      } else if (f.eyes === 'arc') {
        line([fdir(a - ang * 0.8, el - ang * 0.25), fdir(a, el + ang * 0.45), fdir(a + ang * 0.8, el - ang * 0.25)], r * 0.2, ink, r * 0.08);
      } else {
        line([fdir(a - ang * 0.8, el), fdir(a, el - ang * 0.35), fdir(a + ang * 0.8, el)], r * 0.18, ink, r * 0.08);
      }
      if (f.brows) {
        const b = el + ang * 1.35;
        line([fdir(s * (az - ang * 0.9), b), fdir(s * (az + ang * 1.1), b + f.brows)], r * 0.2, ink, r * 0.1);
      }
      if (f.blush) stick(fdir(s * Math.min(az * 1.9, az + ang * 2.4), el - ang * 1.3), r * 0.75, blush, [1.3, 0.8, 0.22], -0.08 * r, 0, 2);
    }
    const m = el - ang * 2.1, w = az * 0.5, dep = ang * 0.55, arc = (half, fn) => [-1, -0.5, 0, 0.5, 1].map(t => fdir(half * t, fn(t)));
    switch (f.mouth) {
      case 'smile': line(arc(w, t => m - dep * (1 - t * t)), r * 0.16, ink, r * 0.06); break;
      case 'small': line(arc(w * 0.55, t => m - dep * (1 - t * t)), r * 0.16, ink, r * 0.06); break;
      case 'frown': line(arc(w * 0.7, t => m - dep + dep * (1 - t * t)), r * 0.16, ink, r * 0.06); break;
      case 'w': line([[-1, 0], [-0.5, 1], [0, 0.25], [0.5, 1], [1, 0]].map(([t, k]) => fdir(w * 0.6 * t, m - dep * k)), r * 0.14, ink, r * 0.06); break;
      case 'open': stick(fdir(0, m - dep * 0.6), r * 0.62, ink, [1.2, 0.95, 0.3], -0.1 * r); break;
      case 'fang':
        line([-1, 0, 1].map(t => fdir(w * 0.55 * t, m - dep * 0.2 * (1 - t * t))), r * 0.15, ink, r * 0.06);
        for (const s of [-1, 1]) stick(fdir(s * w * 0.3, m - dep * 0.45), r * 0.22, white, [0.7, 1.3, 0.5], 0, 0, 2);
        break;
      default:   // roar
        stick(fdir(0, m - dep * 0.6), r * 0.95, ink, [1.9, 0.8, 0.3], -0.12 * r);
        for (const s of [-1, 1]) stick(fdir(s * w * 0.35, m + dep * 0.15), r * 0.26, white, [0.9, 1.1, 0.5], 0, 0, 2);
    }
  }

  /** One mesh per (material, outline width): geometry baked in creature space, attributes made uniform. */
  function merged(root) {
    root.updateMatrixWorld(true);
    const groups = new Map();
    for (const m of root.children) {
      const key = `${m.material.uuid}|${m.userData.arc_outline}`;
      if (!groups.has(key)) groups.set(key, { material: m.material, width: m.userData.arc_outline, list: [] });
      const g = m.geometry.index ? m.geometry.clone() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
      if (!g.attributes.color) g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
      else if (g.attributes.color.itemSize === 4) {
        const c4 = g.attributes.color, c3 = new Float32Array(c4.count * 3);
        for (let i = 0; i < c4.count; i++) { c3[i * 3] = c4.getX(i); c3[i * 3 + 1] = c4.getY(i); c3[i * 3 + 2] = c4.getZ(i); }
        g.setAttribute('color', new BufferAttribute(c3, 3));
      }
      groups.get(key).list.push(g.applyMatrix4(m.matrixWorld));
    }
    const out = new Group(); out.name = root.name; out.userData.blueprint = root.userData.blueprint;
    for (const { material: mat, width, list } of groups.values()) {
      const indexed = list.every(g => g.index), geometry = mergeGeometries(indexed ? list : list.map(g => g.index ? g.toNonIndexed() : g));
      for (const g of list) g.dispose();
      const mesh = new Mesh(geometry, mat); mesh.userData.arc_outline = width; out.add(mesh);
    }
    return out;
  }

  return { build, parts, dispose() { for (const g of mirrorCache.values()) g.dispose(); for (const g of sphere.values()) g.dispose(); } };
}
