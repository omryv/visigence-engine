import { Group, Vector3, Box3 } from 'three/webgpu';
import { RecoilController } from '../weapons/RecoilController.js';
import { AuthoredAnimator } from './AuthoredAnimator.js';
import { ADSController } from './ADSController.js';

/** Presentation adapter for static pack weapons; WeaponController owns all firing/reload rules. */
export class PackViewmodel {
  constructor(camera, worldCamera = camera) {
    this.worldCamera = worldCamera; this.separateCamera = camera !== worldCamera;
    this.root = new Group(); this.adsRoot = new Group(); this.recoilRoot = new Group();
    this.root.add(this.adsRoot); this.adsRoot.add(this.recoilRoot); camera.add(this.root);
    this.ads = new ADSController(this.adsRoot);
    this.recoil = new RecoilController(this.recoilRoot);
    this.throwBlend = 0;
    this.time = 0;
  }
  attachWeapon(rig, def) {
    this.recoilRoot.clear(); this.recoilRoot.add(rig.mount);
    this.rig = rig;
    // Static weapons with an authored 'Sight' node aim down that sight line; others use a generic pose.
    const s = rig.sight, eye = rig.sightEye ?? 0.12;
    const ads = s ? { ...def.ads, position: [-s.x, -s.y, -eye - s.z], rotation: [0, 0, 0] }
      : { ...def.ads, position: [0, -0.15, -0.42], rotation: [0, 0, 0] };
    // v2 rigs are authored in camera space (hip pose at identity); legacy statics hang at a fixed offset.
    this.def = rig.authored && !rig.v2 ? def : { ...def, viewOffset: rig.v2 ? [0, 0, 0] : [0.26, -0.27, -0.48], viewRotation: [0, 0, 0], ads };
    // An authored shot clip already kicks the arms and weapon: keep only a third of the procedural spring on top.
    if (rig.v2 && rig.actions?.fire) {
      const v = def.recoil.viewmodel;
      this.def = { ...this.def, recoil: { ...def.recoil, viewmodel: { ...v, pitch: v.pitch * 0.35, yaw: v.yaw * 0.35, back: v.back * 0.3, roll: v.roll * 0.35 } } };
    }
    this.ads.setWeapon(this.def); this.recoil.setWeapon(this.def);
    this.authored = rig.authored ? new AuthoredAnimator() : null;
    if (this.authored) this.authored.setRig(rig, def);
    this.animator = { play: name => this.authored?.play(name), stop: name => this.authored?.stop(name), onShot: () => this.authored?.play('fire') };
  }
  update(dt, state, intent = {}) {
    this.time += dt;
    this.ads.update(dt, state.wantAds); this.recoil.update(dt);
    const reloadDip = this.authored ? 0 : Math.sin(state.reloadProgress * Math.PI) * 0.25;
    // Rigs with an authored walk loop carry their own bob; a second procedural one would double it.
    const bob = this.authored?.hasClip('walk') ? 0 : Math.sin(this.time * 9) * Math.min(1, intent.speed ?? 0) * 0.014;
    const [x,y,z] = this.def.viewOffset; this.root.position.set(x,y-reloadDip+bob,z);
    this.root.rotation.set(...(this.def.viewRotation ?? [0,0,0]));
    this.authored?.update(dt, { ...state, adsBlend: this.ads.blend, speed: intent.speed ?? 0 });
    this.root.rotation.z -= reloadDip;
  }
  getMuzzleWorld(out) { return (this.externalMuzzle ?? this.rig.muzzle).getWorldPosition(out); }
  toWorldProjected(point, out) { out.copy(point); if (this.separateCamera && !this.externalMuzzle) this.worldCamera.localToWorld(out); return out; }
  setThrowPose() {}
  reset() { this.ads.reset(); this.recoil.reset(); if(this.authored) this.authored.setRig(this.rig, this.def); }
  dispose() { this.root.removeFromParent(); }
}

export function makePackWeapon(model, length) {
  const mount = new Group(), muzzle = new Group();
  const visual = model.clone(true);
  let box = new Box3().setFromObject(visual), size = box.getSize(new Vector3());
  // Pack weapons are unrigged, normalized assets. Orient their longest axis down -Z.
  if (size.x > size.z) visual.rotation.y = Math.PI / 2;
  visual.updateMatrixWorld(true);
  box = new Box3().setFromObject(visual); size = box.getSize(new Vector3());
  const scale = length / Math.max(size.x, size.y, size.z);
  const center = box.getCenter(new Vector3());
  visual.scale.multiplyScalar(scale);
  visual.position.addScaledVector(center, -scale);
  visual.traverse(o => { if(o.isSkinnedMesh) o.visible = false; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  mount.add(visual, muzzle); muzzle.position.set(0, 0.035, -length * 0.5);
  // v2 weapons carry an authored 'Muzzle' node at the bore exit; prefer it over the bounding-box estimate.
  const tip = visual.getObjectByName('Muzzle');
  if (tip) { mount.updateMatrixWorld(true); tip.getWorldPosition(muzzle.position); }
  const eyeNode = visual.getObjectByName('Sight');
  let sight = null;
  if (eyeNode) { mount.updateMatrixWorld(true); sight = eyeNode.getWorldPosition(new Vector3()); }
  return { mount, muzzle, visual, sight, sightEye: eyeNode?.userData?.eye };
}
