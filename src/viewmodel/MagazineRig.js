/**
 * Gives a weapon a MAGAZINE it can lose.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * A reload that visibly removes and replaces ammunition needs a magazine object to move.
 * The SMG GLB has no separate mesh node:
 *
 *     2 nodes, 1 mesh, 1 primitive, 1 material, 0 skins, 0 animations
 *
 * Its single primitive DOES contain disconnected geometry: a complete magazine shell
 * and two inset detail components. UV/normal seams duplicate vertices, so identifying
 * those components requires a position-welded topology analysis, not raw-index adjacency.
 *
 * tools/build/measure-magazine.mjs labels those WHOLE components. The former centroid-box
 * selection left 81 magazine-shell faces attached to the receiver, producing jagged
 * complementary shards when the magazine moved. No geometric cut is needed.
 *
 * The result is a real magazine mesh: the weapon's own triangles, not a stand-in box, with
 * its own transform. Original vertices, UVs, normals and material remain unchanged.
 * Additional faces finish the original insertion-end opening and small shell/detail
 * openings; their separate normals never smooth away the authored bevels.
 *
 * ---------------------------------------------------------------------------
 * TWO MAGAZINES, ALTERNATING
 * ---------------------------------------------------------------------------
 * A reload takes one magazine OUT and puts a DIFFERENT one in, and both have to be on
 * screen at once for that to read - the old one falling away while the new one comes up.
 * So the split geometry is instanced twice, as carriers `a` and `b`. One is seated and
 * visible; the other is hidden. A reload extracts the seated one, discards it, brings the
 * other in, and swaps the roles, so the next reload extracts the magazine this one
 * installed.
 *
 * There is never more than one magazine in the magwell, and the one in the player's hand is
 * never the one in the weapon.
 *
 *     mount
 *       ├── pivot ── model            the weapon, BODY triangles only
 *       ├── magCarrier:a              identity == seated; this is what the reload moves
 *       │     └── frame ── mesh       reproduces pivot*model exactly, so identity is home
 *       ├── magCarrier:b
 *       ├── magGrab / magSurface / magwellSeat / magwellEntry / magClear   anchors
 *       └── muzzle / ejection / sight / trigger / fore / handGrip
 */

import {
  BufferGeometry, BufferAttribute, Group, Mesh, Object3D, Matrix4, Vector3, Quaternion,
} from 'three/webgpu';
import { WEAPON_MAGAZINES } from '../config/weaponMag.generated.js';

const _m = new Matrix4();
const _v = new Vector3();

/**
 * Expands the generated run-length label into two index buffers.
 *
 * @param {import('three').BufferGeometry} geo  the loaded weapon geometry
 * @param {number[]} runs   alternating body/magazine triangle-run lengths, body first
 * @returns {{body: Uint32Array, mag: Uint32Array}}
 */
function splitIndex(geo, runs) {
  const src = geo.userData.__sourceIndex || geo.index;
  if (!src) throw new Error('MagazineRig: the weapon geometry is not indexed');
  geo.userData.__sourceIndex = src;
  const nTris = src.count / 3;
  if (!Number.isInteger(nTris) || runs.some(n => !Number.isInteger(n) || n < 0)
    || runs.reduce((a, b) => a + b, 0) !== nTris) {
    throw new Error('MagazineRig: invalid triangle partition');
  }
  const body = [];
  const mag = [];
  let t = 0, isMag = 0;
  for (const run of runs) {
    const into = isMag ? mag : body;
    for (let k = 0; k < run; k++, t++) {
      into.push(src.getX(t * 3), src.getX(t * 3 + 1), src.getX(t * 3 + 2));
    }
    isMag ^= 1;
  }
  return { body: new Uint32Array(body), mag: new Uint32Array(mag) };
}

/** A geometry over `attrs`, sharing them, with `index` as its own element buffer. */
function shareGeometry(geo, index) {
  const out = new BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  out.setIndex(new BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/** Close component boundaries with separate face normals and the original material. */
function finishGeometry(source, cfg, magazineIndex) {
  const ids = cfg.finishTriangles;
  if (!ids?.length) return null;
  const selected = new Set(magazineIndex);
  if (ids.length % 3 || ids.some(i => !Number.isInteger(i) || !selected.has(i))) {
    throw new Error('MagazineRig: finishing face references a vertex outside the magazine');
  }
  const geo = new BufferGeometry(), getters = ['getX', 'getY', 'getZ', 'getW'];
  for (const [name, attr] of Object.entries(source.attributes)) {
    const values = new Float32Array(ids.length * attr.itemSize);
    for (let i = 0; i < ids.length; i++) for (let k = 0; k < attr.itemSize; k++) {
      values[i * attr.itemSize + k] = name === 'uv' ? cfg.finishUv[k] : attr[getters[k]](ids[i]);
    }
    geo.setAttribute(name, new BufferAttribute(values, attr.itemSize));
  }
  const pos = geo.attributes.position, normals = new Float32Array(ids.length * 3);
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < ids.length; i += 3) {
    a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).sub(a);
    c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)).sub(a);
    b.cross(c).normalize();
    for (let k = 0; k < 3; k++) normals.set([b.x, b.y, b.z], (i + k) * 3);
  }
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * An orthonormal frame from the magazine's own measured directions.
 *
 * +Y is the INSERT axis - up the magazine, into the weapon - so "move the magazine along
 * its insertion axis" is `translateY`, and a debug arrow drawn down local -Y is the
 * extraction direction. +X is the grab normal: out of the wide face the palm lies on.
 */
function magazineQuaternion(insertAxis, grabNormal) {
  const y = insertAxis.clone().normalize();
  const x = grabNormal.clone().projectOnPlane(y).normalize();
  const z = new Vector3().crossVectors(x, y);
  _m.makeBasis(x, y, z);
  return new Quaternion().setFromRotationMatrix(_m);
}

/**
 * @typedef {object} MagazineAnchors
 * @property {Object3D} grab        palm target on the magazine body, +Y along the insert axis
 * @property {Object3D} surface     the same, pushed out to the face the palm actually meets
 * @property {Object3D} seat        the grab point with the magazine home
 * @property {Object3D} entry       the magwell's mouth
 * @property {Object3D} clear       the grab point once the magazine is out of the well
 * @property {Vector3}  insertAxis  unit, rig space, pointing INTO the weapon
 */

/**
 * Build the magazine rig for one weapon, or return null when the weapon has no measured
 * magazine (a weapon added without re-running the tool still loads and still fires; it
 * simply reloads without a magazine to move).
 *
 * @param {string} id
 * @param {import('three').Object3D} mount   WeaponMount
 * @param {import('three').Object3D} model   the weapon model, already corrected and scaled
 * @param {number} scale
 */
export function buildMagazineRig(id, mount, model, scale) {
  const cfg = WEAPON_MAGAZINES[id];
  if (!cfg) return null;

  let mesh = null;
  model.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  const geo = mesh.geometry;
  const src = geo.userData.__sourceIndex || geo.index;
  if (!src || geo.attributes.position.count !== cfg.vertexCount || src.count / 3 !== cfg.triangleCount) {
    // The label describes a mesh this is not. Refusing here is the point: a silently
    // mislabelled split would carve an arbitrary 900 triangles out of the receiver.
    throw new Error(
      `MagazineRig(${id}): ${cfg.file} now has ${geo.attributes.position.count} vertices / `
      + `${(src ? src.count / 3 : 0)} triangles, but the generated label describes `
      + `${cfg.vertexCount} / ${cfg.triangleCount}. Re-run: node tools/build/measure-magazine.mjs --write`
    );
  }

  if (cfg.sourceIndexHash !== undefined) {
    let hash = 2166136261;
    for (let i = 0; i < src.count; i++) hash = Math.imul(hash ^ src.getX(i), 16777619) >>> 0;
    if (hash !== cfg.sourceIndexHash) throw new Error(`MagazineRig(${id}): source triangle order changed; regenerate the component labels`);
  }

  const { body, mag } = splitIndex(geo, cfg.runs);
  mesh.geometry = shareGeometry(geo, body);
  const magGeo = shareGeometry(geo, mag);
  const finishGeo = finishGeometry(geo, cfg, mag);

  // --- the transform that puts a magazine mesh exactly where it was in the weapon ---
  // Read off the live scene rather than reconstructed: whatever chain of nodes the GLB put
  // between the model root and the mesh, this reproduces it.
  model.updateWorldMatrix(true, true);
  mount.updateWorldMatrix(true, false);
  const homeMatrix = new Matrix4()
    .copy(mount.matrixWorld).invert()
    .multiply(mesh.matrixWorld);

  const carriers = {};
  for (const key of ['a', 'b']) {
    const carrier = new Group();
    carrier.name = `magCarrier:${id}:${key}`;
    const frame = new Object3D();
    frame.name = `magFrame:${id}:${key}`;
    frame.matrixAutoUpdate = false;
    frame.matrix.copy(homeMatrix);
    carrier.add(frame);
    const m = new Mesh(magGeo, mesh.material);
    m.name = `magazine:${id}:${key}`;
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = false;
    m.renderOrder = mesh.renderOrder;
    frame.add(m);
    if (finishGeo) {
      const finish = new Mesh(finishGeo, mesh.material);
      finish.name = `magazineFinish:${id}:${key}`;
      finish.frustumCulled = false;
      finish.renderOrder = mesh.renderOrder;
      frame.add(finish);
    }
    mount.add(carrier);
    carriers[key] = carrier;
  }

  // --- anchors, in rig space, from the measured surface ---
  const insertAxis = new Vector3().fromArray(cfg.longAxis).negate().normalize();
  const grabNormal = new Vector3().fromArray(cfg.grabNormal).normalize();
  const quat = magazineQuaternion(insertAxis, grabNormal);
  /** Half the magazine's thin cross-section: from its axis out to the face a palm meets. */
  const faceOffset = Math.min(cfg.crossSection[0], cfg.crossSection[1]) * 0.5;

  const anchor = (name, pos) => {
    const o = new Object3D();
    o.name = `${name}:${id}`;
    o.position.copy(pos);
    o.quaternion.copy(quat);
    mount.add(o);
    return o;
  };
  const grabPos = new Vector3().fromArray(cfg.grabCenter);
  const anchors = {
    grab: anchor('magGrabAnchor', grabPos),
    surface: anchor('magSurfaceAnchor', _v.copy(grabNormal).multiplyScalar(faceOffset).add(grabPos).clone()),
    seat: anchor('magwellSeatAnchor', new Vector3().fromArray(cfg.seat)),
    entry: anchor('magwellEntryAnchor', new Vector3().fromArray(cfg.mouth)),
    clear: anchor('magClearAnchor', new Vector3().fromArray(cfg.clear)),
    insertAxis,
    quat,
    length: cfg.length,
    crossSection: cfg.crossSection,
    faceOffset,
  };

  return new MagazineRig(id, mount, carriers, anchors, scale, cfg);
}

/**
 * The two magazine carriers and the anchors they move between.
 *
 * Every reparent goes through Object3D.attach(), which preserves world transform, so a
 * magazine never jumps: it is at the same place in the world on both sides of the change of
 * owner. The choreography then moves it from there.
 */
export class MagazineRig {
  constructor(id, mount, carriers, anchors, scale, cfg) {
    this.id = id;
    this.mount = mount;
    this.carriers = carriers;
    this.anchors = anchors;
    this.scale = scale;
    this.cfg = cfg;
    /** Which carrier is currently in the weapon. The other is the spare. */
    this.seatedKey = 'a';
    this.reset();
  }

  get seated() { return this.carriers[this.seatedKey]; }
  get spare() { return this.carriers[this.seatedKey === 'a' ? 'b' : 'a']; }

  /** Home: the seated magazine in the weapon at identity, the spare hidden. */
  reset() {
    for (const key of ['a', 'b']) {
      const c = this.carriers[key];
      if (c.parent !== this.mount) this.mount.add(c);
      c.position.set(0, 0, 0);
      c.quaternion.identity();
      c.visible = key === this.seatedKey;
    }
  }

  dispose() {
    const geometries = new Set();
    for (const key of ['a', 'b']) {
      const c = this.carriers[key];
      c.parent?.remove(c);
      c.traverse((o) => { if (o.isMesh) geometries.add(o.geometry); });
    }
    for (const geometry of geometries) geometry?.dispose?.();
  }
}
