/**
 * V2 first-person rigs: one Blender-authored GLB holding the arms, the weapon and every clip.
 *
 * The file is authored in CAMERA SPACE (tools/blender/v2/fp.py): its origin is the eye,
 * glTF -Z is the view direction, and the rest pose is the hip pose, so the rig hangs from
 * the view model at identity. Named nodes it may carry:
 *   Muzzle   bore exit, child of the animated weapon bone (flash and tracers follow recoil)
 *   Sight    sight line point; `extras.eye` is the eye relief used for the ADS pose. It is
 *            measured where aiming holds it: on the AimIn's last frame, or at rest (the hip pose)
 *   Round    loaded projectile shown only while chambered (launchers)
 * Clips follow CLIP_PATTERNS (`<Prefix>_Idle`, `_Walk`, `_Run`/`_Sprint`, `_Shoot`/`_Fire`, `_Reload`,
 * `_ReloadEmpty`, `_Equip`, `_Unequip`/`_Holster`, `_Inspect`, `_AimIn`) and are played by
 * AuthoredAnimator, which fits each state-bound clip to the weapon controller's durations. Extra
 * shot clips (`_Shoot_B`, `_Shoot_C`, ...) become `fireVariants`, picked per shot so a burst never
 * repeats. An aimed shot (`_AimShoot`, `_AimShoot_B`, ...) partners the hip shot with the same
 * suffix in `aimFire`, and the animator splits a shot's weight between the two by the ADS blend.
 */
const FIRE_VARIANT = /(^|_)(shoot|fire)(_[a-z0-9]+)?$/i;
const AIM_FIRE_VARIANT = /(^|_)aim(shoot|fire)(_[a-z0-9]+)?$/i;
import { AnimationMixer, Group, LoopOnce, LoopRepeat, Vector3 } from 'three/webgpu';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { resolveClips } from '../core/AssetInspector.js';
import { CLIP_PATTERNS } from '../config/viewmodel.js';
import { LOOPING_CLIPS } from './AuthoredRig.js';

export const isV2Rig = (model, gltf) => model.startsWith('assets/v2/') && (gltf.animations?.length ?? 0) > 0;

export function buildV2Rig(gltf) {
  const mount = new Group();
  const root = cloneSkeleton(gltf.scene);
  mount.add(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    // Skinned bounds are measured in the bind pose; a view model must never be culled by them.
    o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true;
  });

  const mixer = new AnimationMixer(root);
  const clips = resolveClips(gltf.animations, CLIP_PATTERNS);
  const actions = {}, clipDurations = {};
  for (const [semantic, clip] of Object.entries(clips)) {
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    const looping = LOOPING_CLIPS.has(semantic);
    action.setLoop(looping ? LoopRepeat : LoopOnce, looping ? Infinity : 1);
    action.clampWhenFinished = !looping;
    actions[semantic] = action;
    clipDurations[semantic] = clip.duration;
  }
  // A launcher is always empty when it reloads: without a dedicated clip the plain reload plays.
  if (!actions.reloadEmpty && actions.reload) { actions.reloadEmpty = actions.reload; clipDurations.reloadEmpty = clipDurations.reload; }
  const once = (c) => { const a = mixer.clipAction(c); a.setLoop(LoopOnce, 1); a.clampWhenFinished = true; return a; };
  const fireVariants = (gltf.animations ?? []).filter(c => FIRE_VARIANT.test(c.name)).map(once);
  const suffix = (name, re) => (name.match(re)?.[3] ?? '').toLowerCase();
  const aimFire = new Map();
  for (const c of gltf.animations ?? []) {
    if (!AIM_FIRE_VARIANT.test(c.name)) continue;
    const hip = fireVariants.find(a => suffix(a.getClip().name, FIRE_VARIANT) === suffix(c.name, AIM_FIRE_VARIANT));
    if (hip) aimFire.set(hip, once(c));
  }

  const muzzle = root.getObjectByName('Muzzle') ?? mount;
  const sightNode = root.getObjectByName('Sight');
  let sight = null;
  if (sightNode) {
    // Stopping the aim hands every node back its rest transform (three's mixer restores what
    // no running action binds any more), so the rig leaves here in the pose it came in.
    const aim = actions.ads;
    if (aim) { aim.play(); aim.time = Math.max(0, clipDurations.ads - 1e-4); mixer.update(0); }
    mount.updateMatrixWorld(true);
    sight = sightNode.getWorldPosition(new Vector3());
    if (aim) aim.stop();
  }
  mount.updateMatrixWorld(true);

  return {
    mount, root, model: root, visual: root, muzzle, sight,
    sightEye: sightNode?.userData?.eye,
    roundNode: root.getObjectByName('Round') ?? null,
    mixer, clips, actions, clipDurations, fireVariants, aimFire,
    authored: { reloadResetNodes: [] },
    v2: true,
  };
}
