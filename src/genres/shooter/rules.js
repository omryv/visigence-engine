/**
 * The shooter's runtime rules: the weapon stack, built once the pack's models are loaded.
 *
 * This is the code that used to sit inline in ShooterSession.build's createSystems. It
 * owns the view model, the weapon rigs, the rocket and grenade systems, and hands the
 * session the fields the rest of the frame reads (`viewmodel`, `weaponRigs`, `weaponRig`).
 */
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { WeaponController } from '../../weapons/WeaponController.js';
import { RocketSystem } from '../../weapons/RocketSystem.js';
import { GrenadeSystem } from '../../sim/GrenadeSystem.js';
import { PackViewmodel, makePackWeapon } from '../../viewmodel/PackViewmodel.js';
import { buildV2Rig, isV2Rig } from '../../viewmodel/V2Rig.js';
import { buildWeaponRig } from '../../viewmodel/ViewmodelLoader.js';
import { grenadeModel } from '../../world/pack.js';
import { WEAPON_RIGS } from '../../config/assets.js';
import { WEAPONS } from '../../config/gameplay.js';
import { CATALOG } from '../../world/catalog.js';

/** Build the weapon controller, rigs, rockets and grenades on a session for a game (the arena shares it). */
export function createWeaponSystems(session, game, { pools, project }) {
  session.viewmodel = new PackViewmodel(session.vmCamera, session.camera);
  const weapons = new WeaponController({ player: game.player, collision: game.collision,
    viewmodel: session.viewmodel, audio: session.audio, effects: { vfx: session.vfx, tracers: session.tracers } });
  session.weaponRigs = new Map();
  for (const id of pools.weapons) {
    // `viewmodel` (optional) is the first-person file: arms + weapon + clips. `model` stays the world/enemy weapon.
    const entry = session.pack.weapons[id], vm = entry.viewmodel ?? entry.model, source = session.assets.get(vm).gltf;
    const sourceMaterials = new Set(); source.scene.traverse(o => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) sourceMaterials.add(m); });
    const rig = isV2Rig(vm, source) ? buildV2Rig(source)
      : source.animations.length && (vm.startsWith('assets/source/weapons/') || vm.startsWith('assets/variants/'))
      ? buildWeaponRig(entry.archetype, WEAPON_RIGS[entry.archetype], { ...source, scene: cloneSkeleton(source.scene) }, WEAPONS[entry.archetype]) : makePackWeapon(source.scene, entry.metres);
    // Arcade's weapons are toon-shaded like its world; half an arm's length from the eye they want finer lines.
    session.toon?.apply(rig.mount, { outline: .4, world: false });
    rig.mount.traverse(o => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && !sourceMaterials.has(m)) session.owned.add(m); });
    session.weaponRigs.set(id, rig);
    // A pack may tune each weapon (stats, sound ids) on top of its archetype.
    weapons.addWeapon(id, rig, { displayName: CATALOG[project.theme].weapons.find(w => w.id === id).label.toUpperCase(), tracerEvery: 1, muzzleFlashColor: session.accent, ...(entry.overrides ?? {}) }, entry.archetype);
  }
  session.weaponRig = session.weaponRigs.get(project.weapon); weapons.equip(project.weapon, true);
  const rockets = new RocketSystem({ scene: session.scene, collision: game.collision, vfx: session.vfx, audio: session.audio });
  const grenades = new GrenadeSystem({ camera: session.camera, collision: game.collision, vfx: session.vfx, player: game.player, audio: session.audio });
  // The pack's grenade (Arcade's fizz-bomb) is measured from its file.
  const grenade = grenadeModel(session.pack);
  grenades.build({ get: () => session.assets.get(grenade) }, session.scene, session.vmCamera);
  if (session.toon) { session.toon.apply(grenades.held, { outline: .4, world: false }); for (const g of grenades.pool) session.toon.apply(g.obj); }
  return { weapons, rockets, grenades };
}

export const shooterRules = {
  id: 'shooter',
  pointerLock: true,
  view: () => 'first',
  createSystems: createWeaponSystems,
  /** The raw session input is the shooter's input. */
  input: (session, input) => input,
};
