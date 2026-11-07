/**
 * THE HERO, SEEN FROM OUTSIDE: the pack's player character in the world for the genres that show them (third person,
 * top-down). The same model the first-person arms are cut from, toon-shaded and outlined like everything around it,
 * standing where the simulation puts the player, turned to their yaw, and animated from what they do
 * (anim/HeroAnimator.js). It can hold the trail staff in its right hand's Grip_R socket (the third person's strike) or
 * carry the pack's weapon at the chest (the arena's), whose muzzle then becomes where the shots leave from.
 *
 * Presentation only. Geometry and materials are cloned from the loaded assets and released with the session.
 */
import { Group, Vector3 } from 'three/webgpu';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { HeroAnimator } from '../../anim/HeroAnimator.js';
import { makePackWeapon } from '../../viewmodel/PackViewmodel.js';

/** Where the arena's weapon sits on the hero (model space, the hero facing +Z): the grip AimIdle's right hand holds. */
const WEAPON_MOUNT = [-0.1, 1.1, 0.34];
const _pos = new Vector3();

/**
 * @param {object} session  the ShooterSession: its pack, assets, scene and toon kit
 * @param {{held?: 'staff'|'weapon'|null, weaponId?: string}} [o]
 */
export function createHeroPresentation(session, { held = null, weaponId = null } = {}) {
  const entry = session.pack.characters.player, gltf = session.assets.get(entry.model).gltf;
  const root = new Group(), model = cloneSkeleton(gltf.scene);
  root.name = 'Hero';
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  session.toon?.apply(model, { outline: 1 });
  root.add(model); session.scene.add(root);
  const animator = new HeroAnimator(model, gltf.animations);
  let prop = null, weapon = null;
  if (held === 'staff') {
    const staff = session.pack.props.find(p => p.id === 'staff');
    const node = staff && session.assets.has(staff.model) ? session.assets.get(staff.model).gltf.scene.getObjectByName('Staff') : null;
    const grip = model.getObjectByName('Grip_R');
    if (node && grip) {
      prop = node.clone(true); prop.position.set(0, 0, 0); prop.quaternion.identity();
      prop.traverse(o => { if (o.isMesh) o.castShadow = true; });
      session.toon?.apply(prop); grip.add(prop);
    }
  }
  if (held === 'weapon' && weaponId) {
    const w = session.pack.weapons[weaponId], source = session.assets.get(w.model).gltf.scene;
    weapon = makePackWeapon(source.clone(true), w.metres);
    weapon.mount.position.set(...WEAPON_MOUNT);
    weapon.mount.rotation.y = Math.PI;
    session.toon?.apply(weapon.mount, { outline: 0.6 });
    model.add(weapon.mount);
  }
  return {
    root, animator, weapon, prop,
    /** The world point shots leave from when the hero carries a weapon. */
    get muzzle() { return weapon?.muzzle ?? null; },
    /**
     * @param {number} dt
     * @param {{player: object, alpha?: number, attacking?: boolean, won?: boolean, interacting?: boolean, aim?: boolean}} s
     */
    update(dt, { player, alpha = 1, attacking = false, won = false, interacting = false, aim = false }) {
      _pos.copy(player.prevPosition).lerp(player.position, Math.max(0, Math.min(1, alpha)));
      if (player.prevPosition.distanceToSquared(player.position) > 0.25) _pos.copy(player.position);
      root.position.copy(_pos);
      root.rotation.y = player.yaw + Math.PI;
      animator.update(dt, { speed: Math.hypot(player.velocity.x, player.velocity.z), grounded: player.grounded, attacking, hitAge: player.lastHitAge, dead: !player.alive, won, interacting, aim });
    },
    setVisible(on) { root.visible = on; },
    reset() { animator.reset(); },
    dispose() { animator.dispose(); root.removeFromParent(); },
  };
}
