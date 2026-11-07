/**
 * Gameplay tuning. Every value here was picked against the MEASURED level scale
 * (59 x 60 m maze, 5.08 m walls, 3.1 m median corridor, 812 m2 walkable) rather than
 * copied from the brief's suggested ranges verbatim.
 *
 * This is the ONE place gameplay numbers live. Rendering code never carries a gameplay
 * value, and no subsystem keeps a private copy of anything defined here.
 */

import { CAMERA } from './viewmodel.js';

/** Fixed simulation step. Gameplay integrates at exactly this rate regardless of FPS. */
export const FIXED_STEP = 1 / 60;

/** Hard cap on catch-up steps so a long stall can never spiral. */
export const MAX_SUBSTEPS = 5;

export const PLAYER = {
  eyeHeight: 1.72,
  crouchEyeHeight: 1.05,
  /** Eye height chases its target at this exponential rate (1/s). */
  crouchRate: 9,
  crouchSpeedScale: 0.55,
  radius: 0.36,
  walkSpeed: 4.2,
  sprintSpeed: 6.4,
  accel: 24,
  decel: 28,
  airAccel: 4,
  gravity: -22,
  jumpSpeed: 5.6,
  maxHealth: 100,
  /** Seconds of no damage before health regeneration starts. */
  regenDelay: 7.0,
  regenRate: 6.0,
  /** Health can only regenerate back up to this fraction of max. */
  regenCeiling: 0.6,
  /** Look sensitivity, radians per pixel of pointer movement. Never multiplied by dt. */
  lookSensitivity: 0.0022,
  touchLookSensitivity: 0.0042,
  maxPitch: Math.PI / 2 - 0.02,
  /**
   * Camera bob. RESTRAINED on purpose: this is a camera that has to be aimed, and every
   * millimetre of head travel is millimetres the crosshair is not where the player put it.
   * The weapon's own bob and the idle breathe carry the sense of a body moving, and they
   * do it in front of the camera where it costs no accuracy.
   */
  bobFrequency: 8.6,
  bobAmplitude: 0.029,
  bobSprintScale: 1.45,
  bobRollAmplitude: 0.0092,
  /** Landing dip. Same reasoning: a dip you feel, not one that throws the shot. */
  landDipPerSpeed: 0.012,
  landDipMax: 0.11,
  /** Footsteps: one per half bob cycle, scaled by speed. */
  footstepMinSpeed: 0.9,
  /** Field of view, degrees. The view model has its own camera - see config/viewmodel.js. */
  fovDesktop: CAMERA.worldFovDesktop,
  fovMobile: CAMERA.worldFovMobile,
  fovSprintBonus: 5,
  near: CAMERA.worldNear,
  far: CAMERA.worldFar,
};

/**
 * Weapon definitions.
 *
 * Every weapon is described the same way so a third one is a config block and a GLB:
 *   fire        `rpm` (the interval is 60/rpm and is honoured EXACTLY on the fixed step by
 *               an accumulating next-shot clock, see WeaponController), `kind`, ammo.
 *   spread      degrees, by state: base hip/ADS, added while moving/airborne, removed while
 *               crouched, and a bounded sustained-fire bloom. Deterministic patterns only.
 *   recoil      `camera` is the GAMEPLAY kick (it moves the aim), `viewmodel` the visual one.
 *   reload      a timeline. Ammo is committed at `commitAmmo`, not at the start or end.
 *   ads         an ABSOLUTE view-model pose with the sights on the camera axis, and what
 *               aiming does to FOV, sensitivity and sway.
 *   viewOffset  the hip pose (camera space, metres / radians), and hands (rig space).
 */
export const WEAPONS = {
  smgGun: {
    id: 'smgGun',
    displayName: 'VPR-38',
    /**
     * FULLY AUTOMATIC. This is the SMG-shaped hero weapon. 600 RPM is exact rather than
     * nominal: 60/600 = 0.1 s = 6 fixed steps, and the next-shot clock accumulates so any
     * rate stays exact on average even when it is not a whole number of steps.
     */
    kind: 'auto',
    rpm: 600,
    magazine: 30,
    reserve: 150,
    reserveMax: 240,
    damage: 20,
    headshotMultiplier: 2.4,
    range: 55,
    pellets: 1,
    /**
     * Raise and lower. The authored clips (SMG_Equip 1.17 s, SMG_Holster 0.97 s) are fitted
     * to these by AuthoredAnimator, so the numbers stay gameplay's; they were widened from
     * 0.42 / 0.24 to keep the fit under 2x, at which the raise still reads as the authored
     * motion rather than a flick. The shotgun's clips were authored to its times exactly.
     */
    equipTime: 0.65,
    unequipTime: 0.40,
    /** Coming out of a sprint the weapon has to come up first: no shot before this. */
    sprintOutTime: 0.14,
    /** After a shot the player cannot re-enter the sprint pose for this long. */
    sprintHoldOff: 0.45,
    /** SMG_Inspect is 3.30 s; the state runs the clip at its authored speed. */
    inspectTime: 3.3,
    /** Every Nth round draws a tracer. */
    tracerEvery: 3,
    /**
     * The reload timeline, in seconds. The procedural reload motion and the ammo commit
     * read the SAME numbers, so the magazine fills exactly when the support hand seats it.
     * An empty magazine adds a charging-handle rack after the seat.
     */
    reload: {
      time: 1.6,
      emptyTime: 1.95,
      timeline: { magOut: 0.38, magIn: 1.02, commitAmmo: 1.16, complete: 1.6 },
      emptyTimeline: { magOut: 0.38, magIn: 1.02, commitAmmo: 1.16, bolt: 1.52, complete: 1.95 },
    },
    /** Degrees of half-angle. */
    spread: {
      hip: 1.5,
      ads: 0.55,
      moving: 1.1,
      airborne: 2.4,
      crouch: -0.35,
      sustained: { perShot: 0.14, max: 1.6, recovery: 5.5 },
    },
    recoil: {
      /** Gameplay: radians of aim kick per shot, recovered by a damped spring. */
      camera: { pitch: 0.0085, yaw: 0.0032, adsScale: 0.6, recover: { stiffness: 120, damping: 17 } },
      /** Visual: spring impulses [pitch, yaw, kickback, roll] on the RecoilRoot. */
      viewmodel: { pitch: 0.020, yaw: 0.007, back: 0.030, roll: 0.009, spring: { stiffness: 190, damping: 17 }, adsScale: 0.58 },
    },
    /**
     * AIM DOWN SIGHTS: an absolute camera-space pose that puts the VPR-38's own illuminated
     * sight window on the optical centre, so the thing the player looks through is the thing
     * the bullet goes through. SOLVED by tools/measure/solve-ads.mjs, which finds the lit window in a
     * real frame (it is painted into the baked texture, not modelled, so there is no node to
     * align) and moves the pose until its centroid is on the axis: measured at 0.4 px right
     * and 1.1 px above centre at 1280x720. Do not hand-edit; re-run the solver with --write.
     *
     * The rotation is identity by construction rather than by fit. At blend 1 the composed
     * camera-space transform of the weapon IS this rotation, so identity means the weapon's
     * corrected frame - -Z down the bore, +Y up - is the camera's frame exactly: the bore is
     * parallel to the view axis and there is no cant or roll to read through.
     */
    ads: {
      position: [-0.00812, -0.21665, -0.2455],
      rotation: [0, 0, 0],
      transition: 0.16,
      sensitivity: 0.72,
      worldFovScale: 0.80,
      viewmodelFovScale: 0.92,
      /**
       * THE SCOPED SIGHT PICTURE, weapon 1 only.
       *
       * At full aim the VPR-38 stops being a weapon in front of a camera and becomes a sight
       * the player is looking THROUGH: the receiver, the housing and both hands leave the
       * frame, everything outside the optic's own opening goes black, and the live scene
       * shows through the opening. The shape is the weapon's own - the rounded trapezoid of
       * its lit window - so the scoped view is that sight enlarged onto the screen rather
       * than a new piece of furniture.
       *
       * The geometry is normalised to the OPENING's height, measured off the reference
       * frame: a bottom edge 1.525x the height, a top edge 0.603 of the bottom, and corners
       * rounded at 0.078 of the height. `height` is a fraction of the viewport height with a
       * width ceiling, so the opening keeps its proportions and stays centred from a desktop
       * ultrawide to a landscape phone rather than being sized for one screen.
       *
       * The two ranges are ordered, and that order is the whole trick: the weapon has
       * finished leaving (0.86) before the mask has finished arriving (0.92), so there is no
       * blend at which the player can see the model's interior through a hole that is still
       * opening. Neither range starts before 0.55, so the first half of the raise is the
       * ordinary weapon animation and the scope is something the eye arrives at.
       */
      scope: {
        topWidth: 0.603,
        aspect: 1.525,
        radius: 0.078,
        height: 0.403,
        maxWidth: 0.62,
        colour: '#6FF2E2',
        /** Aim blend over which the black mask and the outline fade in. */
        maskIn: [0.55, 0.92],
        /** ...and over which the weapon leaves. Finishes first, deliberately. */
        weaponOut: [0.62, 0.86],
      },
    },
    /**
     * HIP POSE, camera space. MEASURED rather than judged: tools/measure/sweep-viewmodel.mjs
     * rasterises the life-size rig through the view-model camera at this offset and
     * reports what it covers; `--check` asserts the shipped numbers against the budget
     * (25-38% of the lower-right quadrant, gameplay cone clear).
     */
    viewOffset: [0.30, -0.29, -0.50],
    /**
     * Base view-model rotation [pitch, yaw, roll] in radians, before any animation.
     *
     * Reframed to 0.20 yaw rather than the 0.33 it shipped with: at 19 degrees the support
     * forearm swung across the bottom of the frame and its cuff was cut off by the screen
     * edge as a dark open oval. At 0.20 the forearm leaves through the bottom edge and the
     * cuff is out of frame. The offset is the
     * highest that keeps the cuff out while leaving the firing hand ON the pistol grip in
     * view - a centimetre lower and the grip, trigger finger and all, is under the frame
     * edge. 40% of the lower-right quadrant (`npm run check:viewmodel`), down from 57%.
     */
    viewRotation: [0.02, 0.20, 0.035],
    /**
     * WHERE THE HANDS GO. Both poses are in HANDS-ROOT SPACE - origin at the gun's
     * measured grip point, -Z down the barrel, +Y the gun's up - so they ride the weapon
     * through recoil, sway, bob and reload without any of it being applied twice.
     *
     * The support hand retains the column-solved placement from tools/measure/solve-hands.mjs.
     * The firing hand is calibrated against the visible trigger guard, using triggerRig
     * in assets.js and the runtime grip solve. Run tools/measure/trigger-report.mjs after changing
     * or regenerating its placement: a grip fit alone does not verify trigger reach.
     */
    hands: {
      // Seat the firing hand far enough forward for the index to enter the trigger guard.
      right: { pos: [0.035, 0.076, 0.100], rot: [0.1112, -0.350, -1.552] },
      left: { pos: [-0.0136, 0.0944, -0.1418], rot: [0.145, -0.7476, 2.7372] },
    },
    /**
     * IDLE. What the weapon does when the player is standing still, and it is the only
     * thing separating the two weapons at rest, so they are deliberately different.
     * The VPR-38 is a light SMG held high and close: a quick, shallow breathe with a
     * tight roll. `drift` runs at a second, slower rate than `freq` so the two never
     * resynchronise into a loop the eye can lock onto. Amplitudes in metres / radians.
     */
    idle: { amp: [0.0042, 0.0052, 0.0022], rot: [0.011, 0.013, 0.017], freq: 1.28, drift: 0.41 },
    /** Shell casings: rig-space ejection direction, m/s, and spin. */
    shell: { direction: [1.0, 0.55, 0.25], speed: 2.6, spin: 26 },
    impactImpulse: 2.2,
    staggerChance: 0.25,
    muzzleFlashScale: 0.16,
    muzzleFlashColor: 0x8CFFE2,
    lightIntensity: 5.5,
    audio: 'shotSmg',
    /**
     * THE SHIPPED FIRING AND RELOAD SOUNDS, by their id in config/audio.js.
     *
     * `continuousFire` is the important one: this weapon is automatic, so its firing sound
     * is ONE looping voice held for as long as the trigger is valid, not one MP3 per
     * bullet. Ballistics and audio are decoupled - a three second hold at 600 RPM is thirty
     * bullets and still exactly one audio voice.
     *
     * `reloadCommit` is only a FALLBACK. Ammunition is transferred by the reload timeline's
     * own `commitAmmo` marker above; this is what the audio was cut for, and is here so the
     * two can be compared rather than drift silently.
     */
    sound: { fire: 'weapon1Fire', continuousFire: true, reload: 'weapon1Reload', reloadCommit: 0.88 },
  },
};

/** Weapon slots, in the order the number keys select them. */
// The launcher uses the same action/recoil/animation contract as the SMG. Its blue pipes
// recharge on the reload timeline below, which the authored clips were cut to
// (art-source/rpg/: Fire 1.50 s = 40 rpm, Equip 0.55, Holster 0.30, Reload 2.20
// with the rocket seated at 1.70 s, the `commitAmmo` marker). The rocket the clips move is
// the seated round; the fired one is RocketSystem's. See WEAPON_RIGS.rpg.authored.
WEAPONS.rpg = {
  ...WEAPONS.smgGun,
  id: 'rpg', displayName: 'RPG', kind: 'semi',
  energyReload: true, muzzleFlashColor: 0x55bfff, muzzleFlashScale: 0.32,
  rpm: 40, magazine: 1, reserve: 5, reserveMax: 5,
  damage: 140, headshotMultiplier: 1, range: 55,
  projectile: { speed: 24, radius: 4.2, poolSize: 4 },
  equipTime: 0.55, unequipTime: 0.30, tracerEvery: 0, shell: null,
  reload: {
    time: 2.2, emptyTime: 2.2,
    timeline: { magOut: 0.45, magIn: 1.45, commitAmmo: 1.70, complete: 2.2 },
    emptyTimeline: { magOut: 0.45, magIn: 1.45, commitAmmo: 1.70, complete: 2.2 },
  },
  spread: { hip: 0.7, ads: 0.1, moving: 0.6, airborne: 1.0, crouch: -0.1,
    sustained: { perShot: 0, max: 0, recovery: 1 } },
  viewOffset: [0.28, -0.23, -0.62], viewRotation: [0.02, 0.12, 0.02],
  // Shoulder aim: the static scope has an opaque lens, so retain the aiming reticle.
  ads: { position: [0.16, -0.23, -0.62], rotation: [0, 0, 0], transition: 0.22, keepReticle: true,
    sensitivity: 0.72, worldFovScale: 0.85, viewmodelFovScale: 1 },
  hands: {
    right: { pos: [0.027, 0.01, 0.014], rot: [0.11, -0.13, -1.552] },
    left: { pos: [-0.027, -0.015, -0.224], rot: [0.11, 0.13, 1.552] },
  },
  sound: { fire: 'rpgFire', reload: 'rpgReload' },
};

// Shared action contract, distinct cadence, ballistics, recoil and hand service motions.
//
// THE TIMINGS BELOW ARE WHAT THE BLENDER CLIPS WERE AUTHORED TO, so every state-bound clip
// runs at 1x and each ammo marker lands on the frame the clip seats the magazine or charges
// the core: pistol Reload(_Empty) 1.75 s with the magazine seated at 1.35 s, Fire 0.20 s at
// 300 rpm; sniper Reload(_Empty) 2.70 s with the core charged at 2.10 s, Fire 1.20 s at
// 50 rpm carrying the bolt cycle; shotgun Reload_Cell 3.20 s, Fire 0.80 s at 75 rpm. The
// `handling` gestures are the PROCEDURAL fallback for the static source meshes (the offline
// harness, a file without clips) and are not sampled while an authored assembly is up.
const reloadTimeline = (out, into, commit, complete) => ({ time: complete, emptyTime: complete,
  timeline: { magOut: out, magIn: into, commitAmmo: commit, complete },
  emptyTimeline: { magOut: out, magIn: into, commitAmmo: commit, complete } });
const weaponRecoil = (pitch, back) => ({
  camera: { pitch, yaw: pitch * .22, adsScale: .55, recover: { stiffness: 120, damping: 17 } },
  viewmodel: { pitch: pitch * 2.8, yaw: .006, back, roll: .012, spring: { stiffness: 190, damping: 17 }, adsScale: .58 },
});
const rifleHands = fore => ({ right: { pos: [.025, -.02, -.003], rot: [.11, -.13, -1.552] },
  left: { pos: [fore[0] - .027, fore[1] - .02, fore[2]], rot: [.11, .13, 1.552] } });
WEAPONS.pistol = {
  ...WEAPONS.smgGun, id: 'pistol', displayName: 'PISTOL', kind: 'semi', rpm: 300,
  magazine: 12, reserve: 60, reserveMax: 120, damage: 32, range: 45, pellets: 1,
  reload: reloadTimeline(.30, 1.05, 1.35, 1.75), handling: { reload: 'pistol', cycle: .17, kick: .025 },
  recoil: weaponRecoil(.014, .040), equipTime: .30, unequipTime: .20,
  spread: { hip: 1.3, ads: .22, moving: .8, airborne: 2, crouch: -.15, sustained: { perShot: .10, max: .9, recovery: 5 } },
  viewOffset: [.21, -.23, -.43], viewRotation: [0, .10, 0], hands: rifleHands([-.018, -.015, -.006]),
  ads: { position: [0, -.135, -.35], rotation: [0, 0, 0], transition: .15, sensitivity: .8, worldFovScale: .88, viewmodelFovScale: 1, keepReticle: true },
  muzzleFlashColor: 0xffd99b, muzzleFlashScale: .13, tracerEvery: 1,
  sound: { fire: 'pistolFire', reload: 'pistolReload' },
};
WEAPONS.shotgun = {
  ...WEAPONS.smgGun, id: 'shotgun', displayName: 'SHOTGUN', kind: 'semi', rpm: 75,
  magazine: 6, reserve: 30, reserveMax: 60, damage: 16, range: 32, pellets: 8, falloffStart: 9, falloffMin: .25,
  reload: reloadTimeline(.45, 2.30, 2.65, 3.2), handling: { reload: 'shotgun', cycle: .65, kick: .070 },
  recoil: weaponRecoil(.034, .075), equipTime: .55, unequipTime: .30,
  spread: { hip: 5.4, ads: 3.2, moving: 1, airborne: 2.4, crouch: -.4, sustained: { perShot: 0, max: 0, recovery: 1 } },
  /**
   * Hip placement, lowered 5 cm and brought 5 cm closer than the [.27, -.27, -.50] it was
   * calibrated at: the support glove's forearm is cut 38 cm behind the palm, and at the old
   * placement that cut end sat on the bottom edge of the frame (its top 3% of the half-height
   * inside it, measured through the view-model camera). Here it is 20% below the edge, which
   * covers the bob, the sway and the idle. Nothing about the clips or the hands changed.
   */
  viewOffset: [.27, -.36, -.49], viewRotation: [0, .12, 0], hands: rifleHands([0, .043, -.367]),
  ads: { position: [.10, -.23, -.48], rotation: [0, 0, 0], transition: .23, sensitivity: .75, worldFovScale: .83, viewmodelFovScale: 1, keepReticle: true },
  muzzleFlashColor: 0xffb658, muzzleFlashScale: .28, tracerEvery: 1, staggerChance: .7,
  sound: { fire: 'shotgunFire', reload: 'shotgunReload' },
};
WEAPONS.sniper = {
  ...WEAPONS.smgGun, id: 'sniper', displayName: 'SNIPER', kind: 'semi', rpm: 50,
  magazine: 5, reserve: 20, reserveMax: 40, damage: 110, headshotMultiplier: 2.5, range: 120, pellets: 1,
  reload: reloadTimeline(.45, 1.65, 2.1, 2.7), handling: { reload: 'sniper', cycle: .90, kick: .052 },
  recoil: weaponRecoil(.028, .060), equipTime: .65, unequipTime: .35,
  spread: { hip: 3.5, ads: .035, moving: 1.6, airborne: 3, crouch: 0, sustained: { perShot: 0, max: 0, recovery: 1 } },
  viewOffset: [.27, -.25, -.53], viewRotation: [0, .10, 0], hands: rifleHands([0, .068, -.349]),
  ads: { position: [0, -.265, -.44], rotation: [0, 0, 0], transition: .28, sensitivity: .30, worldFovScale: .38, viewmodelFovScale: 1,
    scope: { ...WEAPONS.smgGun.ads.scope, topWidth: 1, aspect: 1, radius: .5, height: .72, maxWidth: .72 } },
  // An energy rifle since the Blender recharge: the flash is cyan, not the powder-warm one
  // the static model had.
  muzzleFlashColor: 0x9fe6ff, muzzleFlashScale: .22, tracerEvery: 1,
  sound: { fire: 'sniperFire', reload: 'sniperReload' },
};

export const GRENADE = {
  initialCount: 3,
  maxCount: 5,
  fuse: 2.9,
  throwSpeed: 14.5,
  /** Upward component added to the aim direction, so a level throw still arcs. */
  throwLift: 0.28,
  gravity: -20,
  restitution: 0.32,
  friction: 0.72,
  radius: 0.055,
  damageRadius: 5.2,
  maxDamage: 130,
  /** Damage is maxDamage * (1 - d/R)^falloffPower. */
  falloffPower: 1.6,
  impulse: 9.0,
  throwWindup: 0.28,
  throwRecovery: 0.42,
  cookable: false,
  /** Grenades are pooled; this is the pool size (also the live cap). */
  poolSize: 10,
};

/**
 * THE COMPLETE ENEMY ROSTER. `asset` is the key in ASSETS, and `EnemySystem.build` refuses a
 * type whose asset is missing rather than substituting anything, so nothing outside this
 * table can ever be spawned.
 *
 * SEVERAL TYPES MAY SHARE ONE MODEL. That is what `scale` and the per-type style block in
 * config/enemyAnim.js are for: the rig is rebuilt once per ASSET (EnemySystem.build keys
 * `targetHeight` on `def.asset`), so two types on the same model share a rebuilt skeleton and
 * differ in size, motion, perception and timing instead. An archetype is a set of numbers
 * here plus a set of numbers there, not a new file.
 *
 * `radius` is the collision disc, and it is a LEVEL number rather than a model one - it decides
 * where a body can path, so it is bounded by the maze and not by the mesh. It is checked
 * against the models rather than derived from them: the load report measures each one's trunk
 * half-width (0.19-0.21 m), which every disc here comfortably contains, so a body is never
 * wider than its collider.
 *
 *   THE ACTUAL BOUND, MEASURED. This block used to state 0.42 m, on the grounds that "the
 *   maze's tightest authored gap seals against 0.42 m". That number is about what the level
 *   SEALS OUT, and it was being read as a limit on what the level can ADMIT, which is a
 *   different question with a different answer. Sweeping `CollisionSystem.findPath` over all
 *   42 authored spawn points and every landmark, at the same per-type radius the runtime
 *   repath uses (EnemySystem: `ceil(t.radius / cell)`), the level routes a body of up to
 *   0.92 m radius everywhere it needs to go; the first failures appear at 1.10 m, where 13 of
 *   the 42 spawns lose their path. So 0.42 m was a conservative budget, not a topological
 *   limit, and a wider body is safe as long as it stays well inside 0.92 m.
 *   A wider disc also cannot defeat a seal - it is strictly more restricted than a narrow
 *   one - so the gates in levelAuthored.js keep gating whatever is added here.
 *   Re-run that sweep if the maze ever changes.
 *
 * `height` must equal the body's rebuilt height * (scale ?? 1) - the height the body actually
 * ends up at. It is what the hit VFX and the corpse sink are placed against, so a scaled type
 * that leaves this at the unscaled figure will spray blood through its own chest.
 */
export const ENEMY_TYPES = {
  shambler: {
    id: 'shambler',
    health: 100,
    speed: 1.55,
    chaseSpeed: 2.05,
    radius: 0.42,
    height: 1.72,
    /** Distance at which the attack wind-up starts. */
    attackRange: 1.75,
    /** The damage window only opens after this much wind-up. */
    attackWindup: 0.45,
    attackActive: 0.16,
    attackRecovery: 0.70,
    /** Full attack cycle cannot repeat faster than this. */
    attackCooldown: 1.35,
    damage: 12,
    /** Player must be within this to be hit when the window opens. */
    attackReach: 2.05,
    sightRange: 22,
    sightHalfAngleDeg: 78,
    hearingRange: 17,
    staggerTime: 0.42,
    turnRate: 3.4,
    corpseLinger: 3.2,
    scoreValue: 100,
  },
  runner: {
    id: 'runner',
    health: 70,
    speed: 2.4,
    chaseSpeed: 4.15,
    radius: 0.40,
    height: 1.80,
    attackRange: 1.65,
    attackWindup: 0.32,
    attackActive: 0.14,
    attackRecovery: 0.52,
    attackCooldown: 1.0,
    damage: 9,
    attackReach: 1.95,
    sightRange: 26,
    sightHalfAngleDeg: 88,
    hearingRange: 21,
    staggerTime: 0.30,
    turnRate: 5.2,
    corpseLinger: 2.6,
    scoreValue: 150,
  },
  /**
   * The third body. It is the small, quick, fragile one: it dies to a single burst but it
   * closes faster than a shambler and swings on a shorter fuse, so a pack of them is a
   * different problem from a pack of either of the others rather than a reskin of one.
   */
  husk: {
    id: 'husk',
    health: 55,
    speed: 2.05,
    chaseSpeed: 3.30,
    radius: 0.38,
    height: 1.66,
    attackRange: 1.55,
    attackWindup: 0.26,
    attackActive: 0.12,
    attackRecovery: 0.44,
    attackCooldown: 0.85,
    damage: 7,
    attackReach: 1.80,
    sightRange: 24,
    sightHalfAngleDeg: 84,
    hearingRange: 19,
    staggerTime: 0.24,
    turnRate: 6.0,
    corpseLinger: 2.4,
    scoreValue: 125,
  },

  /**
   * THE BRUTE: the body that takes the corridor away from you.
   *
   * The three above are all things you can walk backwards from - the whole approach is
   * built on retreating while firing, and in a 3-4.5 m corridor that always works. This one
   * makes it not work, and it does so with geometry rather than with numbers: at a 0.62 m
   * radius it is wider than the crowd separation will let anything slip past in a corridor,
   * so a brute standing between the player and the way out is a wall that is walking at
   * them. That is a different question from "how much damage does it do" and it is the
   * reason this type exists.
   *
   * Every other number is chosen so the answer to that question is skill, not damage:
   *
   *   turnRate 1.9   the slowest in the roster by a factor of two. Circling it works, and
   *                  in a room it is barely a threat at all. It is only a problem where
   *                  there is no room to circle - which is exactly where the level puts it.
   *   windup 0.78    the longest telegraph in the game, nearly double a shambler's. The
   *                  swing is always dodgeable if you are watching it; it is lethal only
   *                  when you have already let yourself be cornered.
   *   damage 26      being cornered has to actually cost something, or the geometry is a
   *                  nuisance rather than a threat. Two connected swings is most of a
   *                  full-health player.
   *   staggerTime .16 shortest in the roster: it barely flinches, so chip damage does not
   *                  buy the retreat that it buys against a husk. You have to commit or
   *                  you have to move.
   *
   * It is the shambler's body at `scale` 1.19, which lands it at 2.05 m - a head over a shambler,
   * read instantly at distance without a new model.
   */
  brute: {
    id: 'brute',
    /**
     * Per-instance model scale; the rig itself is rebuilt per ASSET, so size lives here.
     * Written as the quotient rather than as a rounded factor so `height` below and this
     * are exactly consistent by construction: the base body is rebuilt to 1.72 m,
     * and 2.05 / 1.72 is what puts this body at 2.05 m.
     * tools/test/validate-anim.mjs asserts the product, so if that rebuilt height ever moves,
     * this fails loudly instead of drifting.
     */
    scale: 2.05 / 1.72,
    health: 320,
    speed: 1.05,
    chaseSpeed: 1.45,
    /** The whole point. Wide enough that a corridor with one in it has no gap left. */
    radius: 0.62,
    height: 2.05,
    attackRange: 2.10,
    attackWindup: 0.78,
    attackActive: 0.20,
    attackRecovery: 1.05,
    attackCooldown: 2.00,
    damage: 26,
    attackReach: 2.50,
    sightRange: 20,
    sightHalfAngleDeg: 74,
    hearingRange: 15,
    staggerTime: 0.16,
    turnRate: 1.9,
    corpseLinger: 4.2,
    scoreValue: 400,
  },

  /**
   * THE LURKER: the body that is already in the room.
   *
   * WHAT MAKES IT AN AMBUSH IS ITS PERCEPTION, NOT A NEW BEHAVIOUR. EnemySystem._perception
   * gates everything - hearing included - behind `distToPlayer > sightRange`, and an enemy
   * that is not aware stays in IDLE, which has no movement in it at all. So a short
   * `sightRange` IS the ambush: this one stands exactly where it was placed, does not call,
   * does not path, and does not know the player exists until they are inside 9 m. No new
   * state, no new code, no new asset - the mechanic falls out of three numbers.
   *
   *   sightRange 9        it notices late. This is the ambush.
   *   sightHalfAngleDeg 132  but it is WATCHING - once you are inside 9 m, facing barely
   *                       helps you. You do not get to walk past it, only to stay outside it.
   *   chaseSpeed 4.55     the fastest thing in the game once it goes. The reveal has to be
   *                       violent or a short sight range is just a weaker enemy.
   *
   * `awareTimer` is 6 s and awareness drops past sightRange * 1.2, so breaking off and
   * backing out past ~11 m genuinely works and it returns to lurking. That is deliberate:
   * an ambusher you can never disengage from is a chase, not an ambush.
   *
   * Health is low. It is a scare and a burst of pressure, not a damage sponge - and it is
   * always fought at close range, where it is easy to hit and hard to react to.
   */
  lurker: {
    id: 'lurker',
    health: 85,
    speed: 1.20,
    chaseSpeed: 4.55,
    radius: 0.38,
    /** Unscaled, so this is the body's rebuilt height exactly. */
    height: 1.66,
    attackRange: 1.60,
    attackWindup: 0.24,
    attackActive: 0.13,
    attackRecovery: 0.55,
    attackCooldown: 1.05,
    damage: 14,
    attackReach: 2.00,
    /** Short on purpose - see above. This single number is the archetype. */
    sightRange: 9,
    sightHalfAngleDeg: 132,
    hearingRange: 8,
    staggerTime: 0.40,
    turnRate: 6.4,
    corpseLinger: 2.4,
    scoreValue: 220,
  },

  /**
   * THE PROWLER: the body that finds you first.
   *
   * Its archetype is PERCEPTION in the opposite direction from the
   * lurker's. Every other type is gated by `sightRange`, and the level is built around the
   * player choosing when to be seen - breaking line of sight behind a crate, backing out of
   * a hall. This one has the longest sight and the longest hearing in the roster, so it is
   * the enemy that is already coming when the others are still standing in the dark, and a
   * fight with a prowler in it starts before the player wanted it to.
   *
   *   sightRange 30 / hearingRange 26   it notices from further than anything else. The ambush
   *                                     is on the player's side this time: sprinting past a
   *                                     doorway is heard from the far end of the corridor.
   *   chaseSpeed 2.8                    quick, but under the husk and the runner: it is the
   *                                     enemy that STARTS coming first, not the one that
   *                                     arrives fastest, and that is the archetype.
   *   health 75 / damage 9              fragile and light-hitting. It is pressure, not a wall.
   *
   * THE BODY is a RIGID export with no skeleton and no clips, carried by src/anim/RigidBody.js like
   * the heavies: a rigid body's stride is derived from its height (ANIM.rigid), and the walk-to-run
   * band in config/enemyAnim.js does not apply to it.
   */
  prowler: {
    id: 'prowler',
    health: 75,
    speed: 2.00,
    chaseSpeed: 2.80,
    radius: 0.40,
    height: 1.70,
    attackRange: 1.60,
    attackWindup: 0.28,
    attackActive: 0.13,
    attackRecovery: 0.48,
    attackCooldown: 0.95,
    damage: 9,
    attackReach: 1.90,
    sightRange: 30,
    sightHalfAngleDeg: 92,
    hearingRange: 26,
    staggerTime: 0.28,
    turnRate: 6.2,
    corpseLinger: 2.6,
    scoreValue: 160,
  },

  /**
   * THE HEAVIES. Bodies that ship UNRIGGED - one solid mesh with no skeleton and no clips - so
   * they take the rigid-body path in src/anim/RigidBody.js, and `height` here is the height that
   * path scales the mesh to (unscaled). What they share as a
   * class: the brute's lesson taken further. Each is wide enough that the crowd separation
   * lets nothing past it in a corridor, each has the health to make "just shoot it" a
   * decision rather than a reflex, and each telegraphs for the best part of a second before
   * it swings. They differ in the one thing each is FOR.
   *
   * RADIUS. The level routes a body of up to 0.92 m radius everywhere it needs to go and
   * first fails at 1.10 m (see the block above ENEMY_TYPES), so every disc here stays under
   * 0.92 with a margin. tools/test/validate-anim.mjs checks each one against the trunk CORE
   * RigidBody measures off the mesh (the median half-width of the trunk band: 0.78 m hippo,
   * 0.47 m giraffe, 0.74 m tortoise), the same way it checks the rigs. What the disc does
   * NOT contain, by measurement, is the hippo's arms (to 1.15 m) and the tortoise's shell
   * (to 1.38 m): in the tightest 3 m corridors a limb or a shell edge can pass into a wall.
   * That is accepted rather than fixed, because the only fix is a disc the level cannot
   * route, and the disc is what decides where a body can go.
   */

  /**
   * THE BEHEMOTH: the hippo. The wall that walks. Widest disc in the game, most health
   * after the titan, the hardest single hit. It is the brute's geometry problem with the
   * numbers turned up: slowest turn rate in the roster, longest windup, and it barely
   * staggers - 0.10 s, so chip damage buys nothing. You go around it or you commit.
   */
  behemoth: {
    id: 'behemoth',
    health: 650,
    speed: 0.95,
    chaseSpeed: 1.30,
    radius: 0.80,
    height: 2.30,
    attackRange: 2.40,
    attackWindup: 0.95,
    attackActive: 0.22,
    attackRecovery: 1.20,
    attackCooldown: 2.40,
    damage: 34,
    attackReach: 2.90,
    sightRange: 20,
    sightHalfAngleDeg: 70,
    hearingRange: 14,
    staggerTime: 0.10,
    turnRate: 1.5,
    corpseLinger: 5.0,
    scoreValue: 700,
  },

  /**
   * THE STALKER: the giraffe. The tallest thing in the game, and its archetype is REACH.
   * The neck puts its head 3.2 m up and well forward of its feet, so `attackRange` and
   * `attackReach` are the longest in the roster - it swings at you from further than any
   * other body can - and `sightRange` is the longest too: it sees over crates and over
   * crowds. Thinner than the other heavies (0.55 m), so it does not seal a lane; it
   * threads through the pack and reaches over it, and the answer to it is distance, not
   * cover.
   */
  stalker: {
    id: 'stalker',
    health: 260,
    speed: 1.35,
    chaseSpeed: 2.30,
    radius: 0.55,
    height: 3.20,
    attackRange: 2.90,
    attackWindup: 0.70,
    attackActive: 0.18,
    attackRecovery: 0.90,
    attackCooldown: 1.80,
    damage: 22,
    attackReach: 3.40,
    sightRange: 34,
    sightHalfAngleDeg: 96,
    hearingRange: 18,
    staggerTime: 0.22,
    turnRate: 2.6,
    corpseLinger: 4.0,
    scoreValue: 450,
  },

  /**
   * THE TITAN: the tortoise. The archetype is ARMOUR: the most health in the game and the
   * shortest stagger, and it is the slowest body in the roster by a margin. It is never a
   * chase - at 1.10 m/s anything can walk away from it - it is a timer. It arrives last, it
   * does not leave, and the longer a fight goes on the more of the room it has taken. The
   * shell means the mesh runs deep behind the trunk, which is why RigidBody recentres on
   * the trunk band and not on the bounding box: the disc sits under the body, not the shell.
   */
  titan: {
    id: 'titan',
    health: 900,
    speed: 0.80,
    chaseSpeed: 1.10,
    radius: 0.76,
    height: 2.40,
    attackRange: 2.20,
    attackWindup: 1.05,
    attackActive: 0.22,
    attackRecovery: 1.30,
    attackCooldown: 2.60,
    damage: 30,
    attackReach: 2.70,
    sightRange: 18,
    sightHalfAngleDeg: 64,
    hearingRange: 12,
    staggerTime: 0.08,
    turnRate: 1.3,
    corpseLinger: 5.5,
    scoreValue: 800,
  },
};

ENEMY_TYPES.crocodile = { ...ENEMY_TYPES.behemoth, id: 'crocodile', height: 2.30 };
/**
 * THE BEAR, the fifth heavy. Between the behemoth and the stalker in pace, and the hardest
 * single hit in the roster.
 */
ENEMY_TYPES.bear = {
  ...ENEMY_TYPES.behemoth, id: 'bear', height: 2.40, radius: 0.72,
  health: 720, speed: 1.05, chaseSpeed: 1.60, damage: 36, attackRange: 2.30, attackReach: 2.80,
  attackWindup: 0.85, attackRecovery: 1.10, attackCooldown: 2.20, turnRate: 1.9, sightRange: 22,
  hearingRange: 16, scoreValue: 750,
};

export const ENEMY_LIMITS = {
  /** Bound expensive reachability queries for a procedural spawn in a blocked world. */
  spawnPathBudget: 64,
  /** Hard cap on simultaneously live enemies, per quality tier. */
  maxAliveByTier: { ultra: 26, high: 22, balanced: 18, performance: 14, mobile: 11 },
  /** Beyond this distance an enemy's animation mixer updates at a reduced rate. */
  animLodDistance: 16,
  animLodInterval: 1 / 15,
  /** Beyond this an enemy skips pathfinding most ticks. */
  pathLodDistance: 26,
  /** Repath interval when actively chasing. */
  repathInterval: 0.45,
  repathIntervalFar: 1.3,
  /** Enemies never spawn closer than this to the player. */
  minSpawnDistance: 11.0,
  /**
   * The floor for an AUTHORED encounter spawn (a breach wave, an approach encounter, the
   * escape): only far enough that nothing appears inside the player's reach. The authored
   * points are the design - the first wave-1 shambler is 4 m from the station on purpose -
   * so they are not subject to the generic 11 m push. See EnemySystem.spawn.
   */
  authoredSpawnDistance: 2.5,
  /** How long a wave enemy stays on the hunt before its own perception has to keep it there. */
  alertedAwareSeconds: 8,
  /** Separation force so a crowd cannot stack into one point. */
  separationStrength: 5.2,
};

export const BARRICADE = {
  health: 420,
  /** Seconds of holding INTERACT to force it open when out of ammo. */
  forceOpenTime: 2.6,
  /** Grenades do this fraction of their radial damage to it. */
  explosiveMultiplier: 2.0,
};

export const DOOR = {
  /** Distance at which the door override prompt appears. */
  interactRange: 3.4,
  /** Seconds of holding INTERACT to open a gate. */
  overrideTime: 2.2,
};

export const OBJECTIVE = {
  /** Distance at which the INTERACT prompt appears. */
  interactRange: 3.1,
  /** Control-station activation sequence length. */
  activationTime: 3.4,
  /**
   * Survive this many authored waves before extraction opens; the boss arrives on the last.
   */
  wavesToSurvive: 4,
  /** Seconds between the last wave clearing and extraction unlocking. */
  extractionDelay: 1.5,
  /** Radius of the extraction trigger. */
  extractionRadius: 2.6,
};

/**
 * The centre-screen interaction ray. A target has to be within `maxDistance`, visible,
 * and either under the ray (within its own radius) or inside the focus cone.
 */
export const INTERACTION = {
  maxDistance: 4.6,
  /**
   * The centre ray is the primary test (it has to pass within the target's own radius).
   * This narrow cone is only the fallback for a small anchor the crosshair just misses.
   */
  focusHalfAngleDeg: 14,
  /** Progress bleeds away at this rate when the hold is released. */
  cancelDecay: 1.5,
};

/**
 * THE SALVAGE ECONOMY. Every enemy already carries a `scoreValue` above; salvage is that
 * value, banked between runs (core/Progress.js), spent on weapons and upgrades. The numbers
 * are paced against the authored spawn tables: a typical first clear (60-80% of the
 * bodies plus the clear bonus) affords the shotgun, the sniper lands mid-campaign, the RPG
 * late - tests/test_progression.mjs pins that cadence against the real mission data.
 */
export const ECONOMY = {
  /** What a fresh operative carries. Everything else is bought with salvage. */
  defaultOwned: ['smgGun', 'pistol'],
  weaponPrices: { shotgun: 4000, sniper: 12000, rpg: 20000 },
  /** A death banks this fraction of the run's salvage: a failed run still pays forward. */
  deathKeepFraction: 0.75,
  /**
   * The extraction bonus: base scales with how deep the campaign the sector is, then by
   * how fast and how accurately the run was flown. See core/Economy.js clearBonus().
   */
  clearBonus: { base: 350, perOrder: 250, parTime: 480, timeFloor: 0.75, timeCeiling: 1.25,
    accuracyFloor: 0.75, accuracySpan: 0.5 },
  /** Keys mirror levelAuthored.DIFFICULTY; the order is the unlock ladder. */
  difficultyOrder: ['standard', 'hardened', 'nightmare'],
  salvageMultiplier: { standard: 1, hardened: 1.5, nightmare: 2 },
  /**
   * Upgrade tracks. Weapon tracks are multipliers on the definitions above, applied per
   * weapon (core/Economy.js weaponStatOverrides); support tracks are flat additions.
   */
  upgrades: {
    weapons: {
      damage:   { label: 'DAMAGE',   perTier: 0.10, costs: [1500, 3000, 6000] },
      magazine: { label: 'MAGAZINE', perTier: 0.15, costs: [1000, 2000, 4000] },
      reserve:  { label: 'RESERVE',  perTier: 0.25, costs: [800, 1600, 3200] },
    },
    grenades: { label: 'FRAG POUCH', perTier: 1,  costs: [1200, 2500] },
    health:   { label: 'VITALS',     perTier: 15, costs: [2000, 4500] },
  },
  /**
   * Per-sector challenges, each paying once per sector, evaluated on extraction from the
   * run counters the game already keeps (kills, time, accuracy, damage taken).
   */
  challenges: [
    { id: 'lowProfile', label: 'LOW PROFILE', desc: 'Extract with 50 damage taken or less', reward: 500, maxDamage: 50 },
    { id: 'marksman', label: 'MARKSMAN', desc: 'Extract with 80% accuracy or better', reward: 500, minAccuracy: 0.8 },
    { id: 'swift', label: 'SWIFT CLEAR', desc: 'Extract in under 8 minutes', reward: 500, maxTime: 480 },
  ],
};

export const HUD_TEXT = {
  objectiveReachDoor: 'REACH THE VILLAGE GATE',
  objectiveOverride: 'OPEN THE VILLAGE GATE',
  objectiveFindStation: 'LOCATE THE SHRINE',
  objectiveActivate: 'ACTIVATE THE CONTROL STATION',
  objectiveActivating: 'ACTIVATION IN PROGRESS - HOLD POSITION',
  objectiveSurvive: 'THE SWARM IS COMING - SURVIVE',
  objectiveBarricade: 'CLEAR THE HAY BARRICADE',
  objectiveExtract: 'REACH THE EXTRACTION POINT',
  promptInteract: 'ACTIVATE',
  promptOverride: 'OVERRIDE SEAL',
  promptForce: 'FORCE OPEN',
  subDoorSealed: 'GATE SHUT',
};
