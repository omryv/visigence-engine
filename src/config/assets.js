/**
 * Corrective transforms and rig data for the first-person weapons, the grenade and the enemies.
 *
 * Weapon transforms were measured off the source GLBs (PCA over each mesh's vertices for its
 * long axis and its own "up", then grip and muzzle landmarks in that corrected space); the
 * authored assemblies (WEAPON_RIGS[*].authored) are Blender exports already in rig space,
 * built from these same numbers. Do not hand-edit the measured constants.
 */

// ---------------------------------------------------------------------------
// Corrective transforms
// ---------------------------------------------------------------------------

/**
 * Weapon rigs. All GLBs are Tripo exports normalised into a unit cube with an arbitrary
 * yaw/pitch, so each needs a corrective quaternion before it can be hung off the camera.
 *
 * After `correctiveQuat` the model is in "weapon space": -Z is down the barrel, +Y is the
 * weapon's up, +X is its right. `gripPoint` and `muzzlePoint` are landmarks in that same
 * space, so the runtime builds each rig as:
 *
 *     rig(position = viewOffset)
 *       └ pivot(position = -gripPoint * scale)      <- puts the grip at the rig origin
 *           └ model(quaternion = correctiveQuat, scale = scale)
 *
 * and the muzzle sits at `(muzzlePoint - gripPoint) * scale` in rig space.
 */
/**
 * ONE KNOB FOR THE WHOLE FIRST-PERSON VIEW MODEL.
 *
 * Every length below - both weapons and both hands - is a life-size measurement multiplied
 * by this. Keeping it as one factor is what guarantees the hand-to-weapon proportion
 * survives a reframing: shrink only the guns and you get life-size hands wrapped around
 * toys.
 *
 It is now 1.0 - LIFE SIZE. The previous 0.826 was standing in for a view-model field of
 * view: a weapon drawn smaller through the world camera reads the same as a life-size one
 * drawn through a wider camera. The view model now has its own camera (CAMERA.viewmodelFov
 * in config/viewmodel.js), which is the honest way to set a first-person weapon's
 * proportions, so the scale goes back to what the models measure and the framing is
 * solved by tools/measure/sweep-viewmodel.mjs against that camera instead.
 */
export const VIEWMODEL_SCALE = 1.0;

export const WEAPON_RIGS = {
  // Inspected static source meshes, identity node transforms, long axis X, up +Y.
  // Side-view landmarks in source units mapped into -Z forward; no geometric cuts.
  pistol: {
    correctiveQuat: [0, -0.7071067811865476, 0, 0.7071067811865476], correctedLength: .99951171875, targetLength: .27,
    gripPoint: [0, .19, .34], muzzlePoint: [0, .55, -.49], sightPoint: [0, .67, .30], ejectionPoint: [.075, .54, .12],
    handGripRig: [0, 0, 0], triggerRig: [.012, .040, -.035], foreRig: [-.018, -.015, -.006],
    /**
     * THE AUTHORED ASSEMBLY (assets/pistol-animated.glb, from art-source/pistol/).
     * Same contract as smgGun.authored below. The parts are the pistol's: frame, slide,
     * trigger, the seated magazine and the fresh one (parked offscreen at rest and swapped
     * in by the reload clips, so it is NOT hidden). Both hand armatures carry their rest
     * placement in the file, and it is the same placement as WEAPONS.pistol.hands.
     */
    authored: {
      root: 'PistolRoot',
      hands: { right: 'rightHand_Rig', left: 'leftHand_Rig' },
      handMeshes: ['rightHand_Mesh', 'leftHand_Mesh'],
      reloadResetNodes: ['Pistol_Magazine', 'Pistol_Magazine_Fresh'],
      hidden: [],
    },
  },
  shotgun: {
    correctiveQuat: [0, .7071067811865476, 0, .7071067811865476], correctedLength: .99951171875, targetLength: .72,
    gripPoint: [0, .09, .21], muzzlePoint: [0, .25, -.49], sightPoint: [0, .39, .15], ejectionPoint: [.07, .25, .01],
    handGripRig: [0, 0, 0], triggerRig: [.012, .045, -.025], foreRig: [0, .043, -.367],
    /**
     * THE AUTHORED ASSEMBLY (assets/shotgun-animated.glb). Same contract as smgGun.authored
     * below; the part list is the shotgun's: a hinged chamber cover, the power cell the reload
     * exchanges, the pumped fore-end and the trigger.
     */
    authored: {
      root: 'ShotgunRoot',
      hands: { right: 'Shotgun_rightHand_Rig', left: 'Shotgun_leftHand_Rig' },
      handMeshes: ['Shotgun_rightHand_Mesh', 'Shotgun_leftHand_Mesh'],
      reloadResetNodes: ['Shotgun_PowerCell'],
      hidden: [],
    },
  },
  sniper: {
    correctiveQuat: [0, -.7071067811865476, 0, .7071067811865476], correctedLength: .99951171875, targetLength: .85,
    gripPoint: [0, .06, .31], muzzlePoint: [0, .19, -.49], sightPoint: [0, .37, .13], ejectionPoint: [.055, .18, .07],
    handGripRig: [0, 0, 0], triggerRig: [.012, .037, -.030], foreRig: [0, .068, -.349],
    /**
     * THE AUTHORED ASSEMBLY (assets/sniper-animated.glb, from art-source/sniper/).
     * Same contract as smgGun.authored below; the parts are body, bolt, trigger and the two
     * magazines. The reload is an ENERGY RECHARGE rather than a magazine exchange: the
     * support hand works the lower valve while twenty pipe-flow spheres and two core
     * overlays, all zero-scale at rest, are driven by node transforms inside the reload
     * clips.
     *
     * The two authored core overlays - a flat textured disc and a dark one - are `hidden`,
     * the one departure from the package's "do not hide" note. The pipe-flow spheres stay:
     * `effects` keeps the derived weapon material off them.
     *
     * Sniper_Fire carries the bolt cycle itself (0.25-1.05 s).
     */
    authored: {
      root: 'SniperRoot',
      hands: { right: 'rightHand_Rig', left: 'leftHand_Rig' },
      handMeshes: ['rightHand_Mesh', 'leftHand_Mesh'],
      hidden: ['Sniper_CoreCharge', 'Sniper_CoreDepleted'],
      effects: [/^Sniper_EnergyFlow_/],
    },
  },
  rpg: {
    // Inspected the raw art-source/weapons-raw/rpg.glb: one static mesh, 13,521 vertices, no clips or sockets.
    // Source bounds: X +/-0.095459, Y 0..0.501465, Z +/-0.499756.
    // The open muzzle is +Z; rotate it to the game's -Z weapon frame.
    correctiveQuat: [0, 1, 0, 0],
    correctedLength: 0.99951172,
    targetLength: 0.70 * VIEWMODEL_SCALE,
    gripPoint: [0, 0.08, 0],
    muzzlePoint: [0, 0.245, -0.499],
    sightPoint: [0, 0.46, 0.12],
    triggerRig: [0, 0.066, -0.015],
    handGripRig: [0, 0.028, 0.007],
    foreRig: [0, -0.007, -0.224],
    /**
     * THE AUTHORED ASSEMBLY (assets/rpg-animated.glb, from art-source/rpg/). Same
     * contract as smgGun.authored below; the parts are body, trigger and the rocket.
     *
     * `round` is the LOADED ROUND: RPG_Rocket is the launcher's nose cap, separated so the
     * fire clip can send it down the tube and the reload clip can bring the next one in
     * through the muzzle. The game owns the real projectile (RocketSystem), so the animator
     * shows this mesh only while a round is actually chambered or a reload is running, and
     * hides it while the tube is empty - otherwise the idle would show a rocket seated in a
     * launcher the HUD says is empty.
     */
    authored: {
      root: 'RPGRoot',
      hands: { right: 'rightHand_Rig', left: 'leftHand_Rig' },
      handMeshes: ['rightHand_Mesh', 'leftHand_Mesh'],
      hidden: [],
      round: 'RPG_Rocket',
    },
  },
  smgGun: {
    // measured: principal axis [0.7453,0.2457,0.6198], object-up [-0.2272,0.9676,-0.1103]
    correctiveQuat: [-0.079723, 0.896419, -0.099267, 0.424526],
    // corrected-space AABB: min [-0.0982,-0.0169,-0.7578] max [0.0624,0.6833,0.5568]
    correctedLength: 1.3146,
    gripPoint: [-0.0138, 0.0262, -0.1364],
    muzzlePoint: [-0.0217, 0.4037, -0.7365],
   /**
     * Ejection port and sight line, in the same corrected space. Measured by
     * tools/measure/solve-ads.mjs: the port is on the receiver's right flank just above the grip
     * station; `sightPoint` is the top of the rail at the rear of the receiver, and
     * `sightForward` the rail's own direction (parallel to the bore).
     */
    ejectionPoint: [0.0624, 0.2400, -0.1000],
    sightPoint: [-0.0178, 0.6832, -0.2504],
    /**
     * Resting index-pad target at the visible trigger-guard opening, in rig-space metres.
     * Calibrated against smg-gun.glb with the firing-hand placement in gameplay.js.
     * The pad approaches from the right; its fingertip enters the guard as it curls.
     * Recheck this target against the mesh if the model or its scale changes.
     */
    triggerRig: [0.016, 0.117, 0.042],
    /**
     * The PISTOL GRIP's palm point and the FORE-END's, both rig space. Note that neither is
     * the rig origin: the origin is `gripPoint` above, the bottom-slab centroid that
     * the measurement uses to scale and hang the weapon, and on this SMG that sits under the
     * magazine well, 40 mm below where a palm actually closes. These two were read off the
     * mesh's real anatomy.
     */
    handGripRig: [-0.0006, 0.0957, 0.1251],
    foreRig: [-0.0013, 0.1078, -0.1044],
    /** Life-size 0.46 m SMG. */
    targetLength: 0.46 * VIEWMODEL_SCALE,
    /**
     * THE AUTHORED ASSEMBLY (assets/smg-gun-animated.glb, from art-source/smg/).
     *
     * The Blender scene was built out of this file's own numbers - the corrective quaternion,
     * the 0.46 m scale, the 0.104 m hand width, the measured finger joints - so the exported
     * assembly is ALREADY IN RIG SPACE: origin at `gripPoint`, -Z down the bore, weapon at its
     * final scale. So
     * src/viewmodel/AuthoredRig.js hangs `root` under the WeaponMount at IDENTITY - no
     * correction, no scale - and none of the geometry-cutting or hand-rigging code runs.
     *
     * `hands` names the two armature nodes. Blender exported every node it never keyed at
     * identity - the right-hand armature, the seated magazine, the charging handle - so the
     * loader restores a rest placement for each of them: the first keyframe of the first clip
     * that moves the node, or for the right hand (never keyed) WEAPONS[id].hands.right.
     *
     * `hidden` are helper nodes with nothing to draw. `handMeshes` are given the glove
     * material fix rather than the weapon's derived material.
     */
    authored: {
      root: 'WeaponRoot',
      // The reload export keys trigger rotation but drops its unkeyed translation.
      // Verified in art-source/smg/maze-smg-reloads.blend (Blender Z-up).
      restPositions: { Trigger: [0, .1255, .042] },
      hands: { right: 'rightHand_Rig', left: 'leftHand_Rig' },
      handMeshes: ['rightHand_Mesh', 'leftHand_Mesh'],
      reloadResetNodes: ['Magazine_Old', 'Magazine_Fresh'],
      hidden: ['BoltCarrier_Internal'],
    },
  },
};

/** First-person hands: the glove material the authored assemblies' hand meshes are tuned to. */
export const HAND_RIGS = {
  /** Gloves: the matte end of VIEWMODEL_MATERIAL_FIX. See that block. */
  materialFix: { roughness: 0.72, metalness: 0.05 },
};

/**
 * ONE MATERIAL RESPONSE FOR THE WHOLE VIEW MODEL.
 *
 * Both guns ship from Tripo as MeshPhysicalMaterial at metalness 0 / roughness 0.5 with
 * KHR_materials_volume declared, and nothing was correcting them: the weapons rendered as
 * uniformly semi-glossy transmissive plastic while the hands beside them had been fixed to
 * matte glove. Same lights, same place in the frame, visibly different substance - which is
 * most of what "the hands look pasted on" actually was.
 *
 * So the two are now specified together, as one surface family:
 *   - the same `envMapIntensity`, which is the term that decides how much of the room a
 *     surface reflects, and therefore whether two objects look like they are in the room;
 *   - transmission and thickness forced off on both (nothing here is glass, and
 *     transmission is an expensive extra pass);
 *   - roughness split only as far as the materials really differ - a polymer-and-steel
 *     weapon is meaningfully glossier than a fabric glove, and reading that difference is
 *     the point of having two numbers rather than one.
 *
 * The environment sits at PROP_MATERIAL_FIX (0.74 / 0.12 / 0.9), so the view model is
 * deliberately a touch sharper and a touch less reflective than the walls: near, lit
 * objects, in the same world.
 */
export const VIEWMODEL_MATERIAL_FIX = {
  weapon: { roughness: 0.54, metalness: 0.34 },
  envMapIntensity: 0.85,
};

/**
 * The thrown grenade (the pack's `grenade` model, Arcade's fizz-bomb): its principal axis is
 * +Y and it stands on y=0 centred in XZ, so it needs no corrective rotation - only a scale,
 * measured from the file's own height (sim/GrenadeSystem.js).
 */
export const GRENADE_RIG = {
  /** Target height in metres -> a 13 cm grenade. */
  targetHeight: 0.13,
  /** Physics radius, from the mean of the horizontal half-extents at target scale. */
  radius: 0.055,
};
