/**
 * ADSRoot: the hip-fire <-> sight-aligned transition.
 *
 * Each weapon has two ABSOLUTE camera-space poses: `viewOffset`/`viewRotation` (hip) and
 * `ads.position`/`ads.rotation` (sights on the camera axis, solved by tools/measure/solve-ads.mjs).
 * The hip pose is carried by ViewmodelRoot, so this node carries the RELATIVE transform
 * hip^-1 * ads, blended by a smoothed 0..1 value: position by lerp, rotation by slerp.
 * At blend 1 the composed transform is exactly the solved ADS pose (the sway, bob and
 * recoil layers between are near identity while aiming, by their own ADS scales).
 *
 * The same blend drives everything else aiming changes - world FOV, view-model FOV,
 * sensitivity, sway, bob and spread - so nothing can be "aimed" by one system and not
 * another. This is the ONLY writer of the ADSRoot transform.
 */

import { Vector3, Quaternion, Euler } from 'three/webgpu';
import { damp, lerp } from '../utils/math.js';

const _e = new Euler(0, 0, 0, 'XYZ');
const _qHip = new Quaternion();
const _qAds = new Quaternion();
const _identity = new Quaternion();
const _v = new Vector3();

export class ADSController {
  constructor(node) {
    this.node = node;
    this.blend = 0;
    this.def = null;
    /** Relative ADS transform for the current weapon, in hip space. */
    this.localPos = new Vector3();
    this.localQuat = new Quaternion();
    /** Live copies so the calibration panel can edit a pose without touching config. */
    this.position = [0, 0, 0];
    this.rotation = [0, 0, 0];
  }

  setWeapon(def) {
    this.def = def;
    this.position = def.ads.position.slice();
    this.rotation = def.ads.rotation.slice();
    this._solveLocal();
  }

  /** Re-derive hip^-1 * ads. Called on weapon change and by the calibration panel. */
  _solveLocal() {
    const def = this.def;
    if (!def) return;
    const [hx, hy, hz] = def.viewOffset;
    const vr = def.viewRotation || [0, 0, 0];
    _qHip.setFromEuler(_e.set(vr[0], vr[1], vr[2], 'XYZ'));
    _qAds.setFromEuler(_e.set(this.rotation[0], this.rotation[1], this.rotation[2], 'XYZ'));
    // local = hip^-1 * ads
    const inv = _qHip.clone().invert();
    this.localQuat.copy(inv).multiply(_qAds);
    _v.set(this.position[0] - hx, this.position[1] - hy, this.position[2] - hz).applyQuaternion(inv);
    this.localPos.copy(_v);
  }

  reset() { this.blend = 0; this._write(); }

  /**
   * @param {number} dt
   * @param {boolean} want  whether the weapon state allows and the player asks for ADS
   */
  update(dt, want) {
    const t = this.def?.ads.transition ?? 0.16;
    // Rate chosen so the blend covers ~95% of the transition time.
    this.blend = damp(this.blend, want ? 1 : 0, 3 / Math.max(0.03, t), dt);
    if (this.blend < 0.0005) this.blend = 0;
    if (this.blend > 0.9995) this.blend = 1;
    this._write();
  }

  _write() {
    const k = this.blend;
    this.node.position.copy(this.localPos).multiplyScalar(k);
    this.node.quaternion.copy(_identity).slerp(this.localQuat, k);
  }

  get worldFovScale() { return lerp(1, this.def?.ads.worldFovScale ?? 0.8, this.blend); }
  get viewmodelFovScale() { return lerp(1, this.def?.ads.viewmodelFovScale ?? 0.92, this.blend); }
  get sensitivityScale() { return lerp(1, this.def?.ads.sensitivity ?? 0.72, this.blend); }
  /** True once the blend is mostly there - the HUD hides the crosshair past this. */
  get isAiming() { return this.blend > 0.5; }

}
