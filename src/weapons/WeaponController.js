/**
 * The weapon controller: ammo, fire cadence, the explicit state machine, reload timeline,
 * aim-down-sights gating, recoil impulses, and the requests it makes of the animator,
 * the effects and the audio. It does not own player collision, world rendering, the HUD
 * DOM or enemy AI; those talk to it through the small surface at the bottom.
 *
 * ================================ STATE MACHINE ================================
 *
 *   HOLSTERED   -> EQUIPPING
 *   EQUIPPING   -> IDLE | UNEQUIPPING
 *   IDLE        -> FIRING | ADS | RELOADING | SPRINTING | INTERACTING | INSPECTING | UNEQUIPPING
 *   ADS         -> FIRING | IDLE | RELOADING | INTERACTING | UNEQUIPPING
 *   FIRING      -> IDLE | ADS | RELOADING | UNEQUIPPING           (after the cadence gate)
 *   RELOADING   -> IDLE | ADS | INTERACTING | SPRINTING | UNEQUIPPING (only on completion,
 *                  except UNEQUIPPING which cancels it)
 *   SPRINTING   -> IDLE | ADS | RELOADING | INTERACTING | UNEQUIPPING
 *   INTERACTING -> IDLE | UNEQUIPPING
 *   INSPECTING  -> IDLE | FIRING | ADS | RELOADING | SPRINTING | INTERACTING | UNEQUIPPING
 *   UNEQUIPPING -> HOLSTERED
 *
 * Anything not in that table is refused (and logged in development). An activity that ends
 * into a rest state its own row does not list (an equip finishing under a held aim or sprint,
 * a shot settling into a sprint) settles to IDLE, and the aim, sprint and interaction rules
 * move it on from there in the same step. `EMPTY` is not a state: an empty magazine is
 * IDLE/ADS with mag == 0, and pulling the trigger then dry fires and starts a reload.
 *
 * INTERRUPTION RULES (the answers the brief asks for):
 *   - Firing interrupts ADS?      No. A shot fired while aiming returns to ADS while the
 *                                 aim button is held (FIRING keeps the ADS blend up).
 *   - ADS interrupts reload?      No. The reload finishes; aiming resumes after it.
 *   - Sprint cancels reload?      No. The reload keeps its hands while the player runs, the
 *                                 weapon state stays RELOADING until the timeline ends, and
 *                                 the sprint pose takes over from there.
 *   - Interaction cancels ADS?    Yes, immediately. Interaction cancels reload? No; the
 *                                 reach waits for the reload to end. Firing is impossible
 *                                 in either case.
 *   - Reload with a full mag?     Refused. Reload with no reserve? Refused.
 *   - Fire while equipping?       Refused; also while unequipping, reloading, interacting.
 *   - Fire while sprinting?       The trigger drops the sprint pose; the first shot lands
 *                                 after `sprintOutTime`. The sprint pose cannot return for
 *                                 `sprintHoldOff` after a shot, and never while ADS.
 *   - Switching weapon            cancels a reload (ammo is kept if `commitAmmo` had
 *                                 passed), an inspection, an interaction pose and ADS.
 *
 * CADENCE. interval = 60 / rpm. A next-shot clock accumulates (`nextShotAt += interval`,
 * never `= now + interval`), so the average rate is exact whatever the step size: 600 RPM
 * is exactly 6 fixed steps. Automatic fire can never depend on the render rate because
 * this only runs on the fixed step. A raised weapon has no shot scheduled, so its first
 * shot starts the clock and the second waits a full interval after it.
 *
 * RELOAD. A timeline, not a duration: magOut -> magIn -> commitAmmo -> (bolt) -> complete.
 * Ammunition moves from reserve to magazine at `commitAmmo`, the same number the animator
 * uses to seat the magazine, so the counter and the hands agree. An interruption before
 * commit loses nothing; after commit the ammo stays.
 */

import { Vector3, MathUtils } from 'three/webgpu';
import { WEAPONS, FIXED_STEP } from '../config/gameplay.js';
import { effectiveWeaponStats } from '../core/Economy.js';
import {
  traceShot, pelletDirection, spreadDegrees, makeHit, HIT_KIND, SURFACE,
} from './WeaponRaycaster.js';

export const WeaponState = {
  HOLSTERED: 'HOLSTERED',
  EQUIPPING: 'EQUIPPING',
  IDLE: 'IDLE',
  FIRING: 'FIRING',
  ADS: 'ADS',
  RELOADING: 'RELOADING',
  SPRINTING: 'SPRINTING',
  INTERACTING: 'INTERACTING',
  INSPECTING: 'INSPECTING',
  UNEQUIPPING: 'UNEQUIPPING',
};
const S = WeaponState;

/** from -> the states it may legally enter. Exported so the play-test can assert it. */
export const LEGAL_TRANSITIONS = {
  [S.HOLSTERED]: new Set([S.EQUIPPING]),
  [S.EQUIPPING]: new Set([S.IDLE, S.UNEQUIPPING]),
  [S.IDLE]: new Set([S.FIRING, S.ADS, S.RELOADING, S.SPRINTING, S.INTERACTING, S.INSPECTING, S.UNEQUIPPING]),
  [S.ADS]: new Set([S.FIRING, S.IDLE, S.RELOADING, S.INTERACTING, S.UNEQUIPPING]),
  [S.FIRING]: new Set([S.IDLE, S.ADS, S.RELOADING, S.UNEQUIPPING]),
  [S.RELOADING]: new Set([S.IDLE, S.ADS, S.INTERACTING, S.SPRINTING, S.UNEQUIPPING]),
  [S.SPRINTING]: new Set([S.IDLE, S.ADS, S.RELOADING, S.INTERACTING, S.UNEQUIPPING]),
  [S.INTERACTING]: new Set([S.IDLE, S.UNEQUIPPING]),
  [S.INSPECTING]: new Set([S.IDLE, S.FIRING, S.ADS, S.RELOADING, S.SPRINTING, S.INTERACTING, S.UNEQUIPPING]),
  [S.UNEQUIPPING]: new Set([S.HOLSTERED]),
};

/** States in which a trigger pull can produce a shot (subject to the cadence clock). */
const CAN_FIRE_FROM = new Set([S.IDLE, S.ADS, S.FIRING, S.INSPECTING]);
/** States in which aiming is honoured. */
const CAN_ADS_FROM = new Set([S.IDLE, S.ADS, S.FIRING, S.SPRINTING, S.INSPECTING]);

import { ACTION, FADE } from '../config/audio.js';
import { DEV } from '../utils/dev.js';
import { gameEvent } from '../core/Haptics.js';

const _v = new Vector3();
const _v2 = new Vector3();
const _origin = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _muzzle = new Vector3();
const _eject = new Vector3();
const _hit = makeHit();

class Weapon {
  constructor(id, def, rig) {
    this.id = id;
    this.def = def;
    this.rig = rig.mount;        // the WeaponMount (kept as `rig` for the tools/tests)
    this.build = rig;            // the full built rig (sockets, mixer, clips)
    this.muzzle = rig.muzzle;
    this.state = S.HOLSTERED;
    this.stateTime = 0;
    this.mag = def.magazine;
    this.reserve = def.reserve;
    this.shotCounter = 0;
    this.timeSinceShot = 99;
    this.interval = 60 / def.rpm;
    this.fireClock = 0;
    this.nextShotAt = 0;
    /** Sustained-fire bloom, degrees. */
    this.sustained = 0;
    /** Reload bookkeeping. */
    this.reloadEmpty = false;
    this.reloadEvents = 0;
    /** The generation of the reload currently running; 0 when none is. */
    this.reloadToken = 0;
    /** Sprint-out gate: no shot until this reaches zero after leaving the sprint pose. */
    this.sprintOutLeft = 0;
    /** Returns the state to leave FIRING to. */
    this.returnTo = S.IDLE;
  }

  get isEmpty() { return this.mag <= 0; }
  get canReload() { return this.reserve > 0 && this.mag < this.def.magazine; }
  get activeReload() { return this.reloadEmpty ? this.def.reload.emptyTimeline : this.def.reload.timeline; }
  get activeReloadTime() { return this.activeReload.complete; }

  resetAmmo() {
    this.mag = this.def.magazine;
    this.reserve = this.def.reserve;
  }
}

export class WeaponController {
  /**
   * @param {object} deps
   * @param {import('../viewmodel/PackViewmodel.js').PackViewmodel} deps.viewmodel
   * @param {import('../sim/CollisionSystem.js').CollisionSystem} deps.collision
   * @param {import('../sim/PlayerController.js').PlayerController} deps.player
   * @param {object} deps.effects   { vfx, tracers, shells, vmScene }
   * @param {import('../audio/CombatAudio.js').CombatAudio} deps.audio
   * @param {Function} deps.onEnemyHit, deps.onWorldImpact, deps.onBarricadeHit, deps.onCrateHit
   */
  constructor({ viewmodel, collision, player, effects, audio, onEnemyHit, onWorldImpact, onBarricadeHit, onCrateHit }) {
    this.viewmodel = viewmodel;
    this.collision = collision;
    this.player = player;
    this.effects = effects;
    this.audio = audio;
    this.onEnemyHit = onEnemyHit;
    this.onWorldImpact = onWorldImpact;
    this.onBarricadeHit = onBarricadeHit;
    this.onCrateHit = onCrateHit;

    /** @type {Map<string, Weapon>} */
    this.weapons = new Map();
    this.order = [];
    this.current = null;
    this.pendingSwitch = null;
    this.ads = false;
    this.triggerHeld = false;
    this.triggerLatch = false;
    this.interacting = false;

    /** Context mirrored from the game each fixed step. */
    this.ctx = { sprinting: false, grounded: true, speedFraction: 0, crouchBlend: 0 };

    this.shotsFired = 0;
    this.shotsHit = 0;

    this.hands = null;
    this._enemies = null;
    this._transitionLog = [];

    /**
     * ACTION TOKEN. Bumped by every transition out of a cancellable action, so a delayed
     * callback taken during a reload can ask whether the reload it belongs to is still the
     * current one. A cancelled reload must not grant ammunition later.
     */
    this.actionToken = 0;
  }

  // ------------------------------------------------------------------
  // Build
  // ------------------------------------------------------------------

  setEnemyProvider(fn) { this._enemies = fn; }
  /** Register a pack-supplied visual rig while retaining the existing weapon simulation. */
  addWeapon(id, rig, overrides = {}, archetype = id) {
    if (!WEAPONS[archetype] || !rig?.mount || !rig?.muzzle) throw new Error('Invalid pack weapon rig');
    if (this.weapons.has(id)) throw new Error(`Weapon already registered: ${id}`);
    const weapon = new Weapon(id, { ...WEAPONS[archetype], ...effectiveWeaponStats(archetype), ...overrides }, rig);
    weapon.archetype=archetype;this.weapons.set(id,weapon);
    this.order.push(id);
  }
  setThrowPose(pose) { this.viewmodel.setThrowPose(pose); }
  get throwBlend() { return this.viewmodel.throwBlend; }

  // ------------------------------------------------------------------
  // Input intents
  // ------------------------------------------------------------------

  /** The latch is a PENDING SHOT (see pressTrigger in the old system): fast clicks fire once. */
  pressTrigger() { this.triggerHeld = true; this.triggerLatch = true; }
  releaseTrigger() { this.triggerHeld = false; }
  cancelTrigger() { this.triggerHeld = false; this.triggerLatch = false; }
  setAds(on) { this.ads = on; }
  /** Held by the interaction system while a valid target is being used. */
  setInteracting(on) { this.interacting = on; }
  /** Per-step context from the game: what the player's body is doing. */
  setContext(ctx) { Object.assign(this.ctx, ctx); }

  equip(id, instant = false) {
    if (!this.weapons.has(id)) return false;
    if (!this.order.includes(id)) return false;
    const cur = this.current;
    if (cur?.id === id && cur.state !== S.HOLSTERED && cur.state !== S.UNEQUIPPING) return false;
    if (instant || !cur) {
      if (cur) this._holster(cur);
      this._raise(this.weapons.get(id), instant);
      return true;
    }
    // Switching cancels a reload (ammo kept only past commit), inspection, interaction
    // and ADS: the weapon comes down first, then the other comes up.
    this.pendingSwitch = id;
    if (cur.state !== S.UNEQUIPPING && this._transition(cur, S.UNEQUIPPING, 'switch')) {
      this.viewmodel.animator?.play('holster');
    }
    return true;
  }

  reload() {
    const w = this.current;
    if (!w) return false;
    if (!w.canReload) return false;
    if (!LEGAL_TRANSITIONS[w.state].has(S.RELOADING)) return false;
    w.reloadEmpty = w.isEmpty;
    w.reloadEvents = 0;
    this._transition(w, S.RELOADING, 'reload');
    this.viewmodel.animator?.play(w.reloadEmpty ? 'reloadEmpty' : 'reload');
    // The reload owns a token for its whole run. `_transition` bumps it on the way out, so
    // anything that was scheduled by THIS reload can tell that it is no longer the one.
    w.reloadToken = ++this.actionToken;
    if (w.def.sound?.reload) this.audio?.startActionVoice(this._reloadAction(w), w.def.sound.reload);
    return true;
  }

  inspect() {
    const w = this.current;
    if (!w || w.state !== S.IDLE) return false;
    this._transition(w, S.INSPECTING, 'inspect');
    this.viewmodel.animator?.play('inspect');
    this.audio?.play('inspect', null, 0.35);
    return true;
  }

  addAmmo(id, amount) {
    const w = this.weapons.get(id);
    if (!w) return 0;
    const room = w.def.reserveMax - w.reserve;
    const given = Math.min(room, amount);
    w.reserve += given;
    // Picking up ammo while dry should get you shooting again without a manual reload.
    if (given > 0 && w === this.current && w.isEmpty && (w.state === S.IDLE || w.state === S.ADS)) this.reload();
    return given;
  }
  get ammoPickupTarget() {
    const carried = [this.current, ...this.order.map(id => this.weapons.get(id))];
    return carried.find(w => w && this.order.includes(w.id) && w.reserve < w.def.reserveMax);
  }
  addLoadoutAmmo(amount) {
    const w = this.ammoPickupTarget;
    return w ? this.addAmmo(w.id, Math.max(1, Math.round(amount / 30 * w.def.magazine))) : 0;
  }

  resetAll() {
    this.shotsFired = 0;
    this.shotsHit = 0;
    for (const w of this.weapons.values()) {
      // Upgrades bought since the last run land here, before the ammo refill reads them.
      Object.assign(w.def, effectiveWeaponStats(w.archetype??w.id));
      w.resetAmmo();
      w.state = S.HOLSTERED;
      w.stateTime = 0;
      w.sustained = 0;
      w.fireClock = 0; w.nextShotAt = 0;
      w.sprintOutLeft = 0;
      w.rig.visible = false;
    }
    this.current = null;
    this.pendingSwitch = null;
    this.ads = false;
    this.interacting = false;
    this.cancelTrigger();
    this.viewmodel.reset();
    this.equip(this.order[0], true);
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------

  canTransition(from, to) { return !!LEGAL_TRANSITIONS[from]?.has(to); }

  _transition(w, next, reason = '') {
    if (w.state === next) return true;
    if (!this.canTransition(w.state, next)) {
      if (DEV) console.warn(`[weapon] refused ${w.state} -> ${next} (${reason})`);
      return false;
    }
    const prev = w.state;
    /**
     * LEAVING A RELOAD ENDS IT, wherever that came from. This is the one place every route
     * passes through, so the reload's token is invalidated here rather than at each call
     * site, where one of them would eventually be forgotten - and its audio is settled here
     * too. A reload that COMPLETED ('reloaded', the timeline's own end) releases its sound
     * to play out: the reload files are longer than their mechanisms (the shotgun's 4.4 s
     * for a 3.2 s timeline, the sniper's 4.56 s for 2.7 s) and cutting them at the timeline
     * clipped every one of them. Anything else - firing, a weapon switch, an interaction,
     * death, a pause - is a cancel, and a cancelled reload's sound stops with it.
     */
    if (prev === S.RELOADING && next !== S.RELOADING) this._endReload(w, reason === 'reloaded');
    w.state = next;
    w.stateTime = 0;
    if (DEV) {
      this._transitionLog.push(`${prev}->${next}`);
      if (this._transitionLog.length > 16) this._transitionLog.shift();
    }
    return true;
  }

  /** This weapon's reload action id: one voice per weapon, so two cannot overlap. */
  _reloadAction(w) {
    return w.id === 'smgGun' ? ACTION.weapon1Reload : `player:${w.id}-reload`;
  }

  /**
   * End a reload: invalidate its token, and either let its sound finish (`completed`) or
   * stop it (cancelled). Safe to call when none is running.
   */
  _endReload(w, completed = false) {
    const action = this._reloadAction(w);
    if (completed) this.audio?.releaseActionVoice?.(action);
    else this.audio?.stopActionVoice(action, FADE.cancel);
    w.reloadToken = 0;
    this.actionToken++;
  }

  /**
   * THE AUTOMATIC-FIRE VOICE, validated every fixed step.
   *
   * `_fire` starts it on an accepted shot; this is what ends it. The conditions are the
   * weapon's own state, not the input's: a released trigger, an empty magazine, a reload,
   * a switch, a sprint-out, a death and a pause all leave the loop with nothing to be
   * true about, and it fades out in FADE.fire (45 ms).
   */
  _updateFireVoice(w) {
    if (!this.audio) return;
    if (!w.def.sound?.continuousFire) return;
    const firing = this._wantsShot(w)
      && CAN_FIRE_FROM.has(w.state)
      && w.mag > 0
      && w.sprintOutLeft <= 0
      && this.player.alive
      && this.current === w;
    if (!firing) this.audio.stopActionVoice(ACTION.weapon1Fire, FADE.fire);
  }

  _holster(w) {
    // An instant holster bypasses _transition, so it repeats its cancellation here.
    if (w.state === S.RELOADING) this._endReload(w);
    this.audio?.stopActionVoice(ACTION.weapon1Fire, FADE.fire);
    w.state = S.HOLSTERED;
    w.stateTime = 0;
    w.rig.visible = false;
    w.sprintOutLeft = 0;
  }

  _raise(w, instant) {
    this.current = w;
    this.pendingSwitch = null;
    this.viewmodel.attachWeapon(w.build, w.def);
    w.rig.visible = true;
    w.state = instant ? S.IDLE : S.EQUIPPING;
    w.stateTime = 0;
    w.fireClock = 0;
    w.nextShotAt = -Infinity;   // nothing scheduled: the first shot starts the cadence
    this.cancelTrigger();
    if (!instant) {
      this.viewmodel.animator?.play('equip');
      this.audio?.playOneShot('weaponSwitch');
    }
  }

  /**
   * Where a weapon goes when its current activity ends, given what is held right now. A rest
   * state the table refuses from here settles to IDLE instead, and _updateAds and
   * _updateSprint move it on legally in the same step. A held interaction is not a rest
   * state: _updateInteract takes the weapon from whatever this returns, also in the same
   * step, so every route into INTERACTING starts its clip.
   */
  _restState(w) {
    const want = this.ads ? S.ADS : this._wantsSprintPose(w) ? S.SPRINTING : S.IDLE;
    return this.canTransition(w.state, want) ? want : S.IDLE;
  }

  _wantsSprintPose(w) {
    return this.ctx.sprinting && !this.ads && !this.triggerHeld && !this.triggerLatch && !this.interacting
      && w.timeSinceShot >= w.def.sprintHoldOff;
  }

  /** Does the current weapon state forbid the player from sprinting? */
  get blocksSprint() {
    const w = this.current;
    if (!w) return false;
    return this.ads || this.triggerHeld || this.triggerLatch || w.timeSinceShot < w.def.sprintHoldOff
      || w.state === S.INTERACTING || w.state === S.ADS;   // sprinting cancels an inspect
  }

  // ------------------------------------------------------------------
  // Simulation (fixed step)
  // ------------------------------------------------------------------

  fixedUpdate(dt) {
    const w = this.current;
    if (!w) return;
    w.stateTime += dt;
    w.timeSinceShot += dt;
    w.fireClock += dt;
    if (w.sprintOutLeft > 0) w.sprintOutLeft = Math.max(0, w.sprintOutLeft - dt);
    // Sustained-fire bloom decays whether or not the trigger is held.
    w.sustained = Math.max(0, w.sustained - w.def.spread.sustained.recovery * dt);

    switch (w.state) {
      case S.EQUIPPING:
        if (w.stateTime >= w.def.equipTime) this._transition(w, this._restState(w), 'equipped');
        break;

      case S.UNEQUIPPING:
        if (w.stateTime >= w.def.unequipTime) {
          this._transition(w, S.HOLSTERED, 'holstered');
          this._holster(w);
          const next = this.weapons.get(this.pendingSwitch) || w;
          this._raise(next, false);
          return;
        }
        break;

      case S.RELOADING:
        this._updateReload(w);
        break;

      case S.INSPECTING:
        if (w.stateTime >= w.def.inspectTime) this._transition(w, this._restState(w), 'inspected');
        break;

      case S.FIRING:
        // The cadence window: once it has elapsed and nothing keeps firing, settle.
        if (w.fireClock >= w.nextShotAt && !this._wantsShot(w)) {
          this._transition(w, this._restState(w), 'settled');
        }
        break;

      default:
        break;
    }

    // --- modifiers that move the rest states around ---
    this._updateInteract(w);
    this._updateAds(w);
    this._updateSprint(w);

    // --- the trigger ---
    this._updateTrigger(w);
    this._updateFireVoice(w);

   // Camera recoil recovers once firing stops; the player reads the offsets live.
    this.viewmodel.recoil.fixedUpdate(dt, this.triggerHeld && w.mag > 0);
  }
 /**
   * Drop anything pending: used on pause, death and state changes so nothing carries a
   * shot, a sprint-out, an interaction or an inspection across a menu.
   */
  cancelPending() {
    this.cancelTrigger();
    this.interacting = false;
    // Pause, death and every menu route through here: the firing loop must not survive
    // any of them, and a reload interrupted by one of them must not pay out later.
    this.audio?.stopActionVoice(ACTION.weapon1Fire, FADE.fire);
    const w = this.current;
    if (!w) return;
    if (w.state === S.RELOADING) this._transition(w, S.IDLE, 'cancelled');
    w.sprintOutLeft = 0;
    if (w.state === S.INTERACTING || w.state === S.INSPECTING) this._transition(w, S.IDLE, 'cancelled');
  }
  _updateInteract(w) {
    if (this.interacting) {
      // Interaction takes the weapon immediately, except from a reload: the reach waits for the
      // timeline to end and starts on the step it completes.
      if (w.state !== S.INTERACTING && w.state !== S.RELOADING && LEGAL_TRANSITIONS[w.state].has(S.INTERACTING)) {
        this._transition(w, S.INTERACTING, 'interact');
        this.viewmodel.animator?.play('interact');
      }
    } else if (w.state === S.INTERACTING) {
      this._transition(w, S.IDLE, 'interact ended');
      this.viewmodel.animator?.stop('interact');
    }
  }

  _updateAds(w) {
    if (this.ads) {
      if (w.state === S.IDLE || w.state === S.SPRINTING || w.state === S.INSPECTING) {
        this._transition(w, S.ADS, 'aim');
      }
    } else if (w.state === S.ADS) {
      this._transition(w, this._wantsSprintPose(w) ? S.SPRINTING : S.IDLE, 'aim released');
    }
  }

  _updateSprint(w) {
    if (this._wantsSprintPose(w)) {
      if (w.state === S.IDLE || w.state === S.INSPECTING) {
        this._transition(w, S.SPRINTING, 'sprint');
        this.viewmodel.animator?.play('sprint');
      }
    } else if (w.state === S.SPRINTING) {
      // Leaving the sprint pose: the weapon has to come up before it can fire.
      w.sprintOutLeft = w.def.sprintOutTime;
      this._transition(w, S.IDLE, 'sprint ended');
      this.viewmodel.animator?.stop('sprint');
    }
  }

  _wantsShot(w) {
    if (!this.player.alive) return false;
    const semi = w.def.kind !== 'auto';
    // A complete click can arrive between fixed ticks. Its first shot is buffered for
    // automatic weapons too; only continued firing depends on the held state.
    return semi ? this.triggerLatch : this.triggerHeld || this.triggerLatch;
  }

  _updateTrigger(w) {
    if (!this._wantsShot(w)) return;
    if (!CAN_FIRE_FROM.has(w.state)) {
      // A shot cannot come out of a reload, an equip or an interaction; the latch is
      // dropped so a press during a reload does not fire the instant it ends.
      if (w.state !== S.SPRINTING) this.triggerLatch = false;
      return;
    }
    if (w.sprintOutLeft > 0) return;              // weapon still coming up
    if (w.fireClock < w.nextShotAt) return;       // cadence

    this.triggerLatch = false;

    if (w.mag <= 0) {
      if (w.timeSinceShot > 0.28) {
        this.audio?.play('dryFire', null, 0.4);
        w.timeSinceShot = 0;
      }
      // Auto-reload on a dry trigger pull is the forgiving, expected behaviour.
      if (w.canReload) this.reload();
      return;
    }

    // Reserve a projectile slot before spending ammo or producing any shot feedback.
    if (w.def.projectile && !this.effects.rockets?.canLaunch) return;

    // Exact cadence: the clock accumulates unless the last shot was long ago.
    w.nextShotAt = (w.fireClock - w.nextShotAt > w.interval) ? w.fireClock + w.interval : w.nextShotAt + w.interval;
    w.returnTo = this.ads ? S.ADS : S.IDLE;
    if (w.state !== S.FIRING) this._transition(w, S.FIRING, 'shot');
    else w.stateTime = 0;
    this._fire(w);
  }

  _updateReload(w) {
    const tl = w.activeReload;
    const t = w.stateTime;
    const fire = (bit, at, fn) => {
      if (!(w.reloadEvents & bit) && t >= at) { w.reloadEvents |= bit; fn(); }
    };
    fire(1, tl.magOut, () => { if (!w.def.energyReload && !w.def.handling) this.audio?.play('magOut', null, 0.55); });
    fire(2, tl.magIn, () => { if (!w.def.energyReload && !w.def.handling) this.audio?.play('magIn', null, 0.6); });
    // The ammo transfer carries the token the reload started with. It is checked inside
    // _commitAmmo, so a marker that somehow outlives its reload cannot pay out.
    fire(4, tl.commitAmmo, () => this._commitAmmo(w, w.reloadToken));
    if (tl.bolt !== undefined) fire(8, tl.bolt, () => this.audio?.play('boltRack', null, 0.6));
    if (t >= tl.complete) {
      this._transition(w, this._restState(w), 'reloaded');
    }
  }

  /**
   * Move rounds from the reserve into the magazine. Driven by the reload timeline's own
   * `commitAmmo` marker - the gameplay/animation authority - and NOT by the reload MP3,
   * whose container runs on past its last mechanical sound (1.60 s of file for 1.11 s of
   * mechanism on weapon 1). `def.sound.reloadCommit` records where the audio's own final
   * mechanism lands so the two can be compared.
   *
   * @param {number} [token]  the reload generation this commit belongs to
   */
  _commitAmmo(w, token) {
    if (token !== undefined && (token === 0 || token !== w.reloadToken)) return;
    if (w.state !== S.RELOADING) return;
    const need = w.def.magazine - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take;
    w.reserve -= take;
  }

  // ------------------------------------------------------------------
  // Firing
  // ------------------------------------------------------------------

  _fire(w) {
    const def = w.def;
    const vm = this.viewmodel;
    w.mag--;
    w.shotCounter++;
    this.shotsFired += def.pellets;
    gameEvent('fire');
    w.timeSinceShot = 0;
    w.sustained = Math.min(def.spread.sustained.max, w.sustained + def.spread.sustained.perShot);

    // --- recoil: gameplay kick on the aim, visual springs on the rig, snap in the pose ---
    const adsBlend = vm.ads.blend;
    vm.recoil.kick(w.shotCounter, adsBlend);
    vm.animator?.onShot();
    this.player.shake = Math.min(1.0, this.player.shake + (def.pellets > 1 ? 0.42 : 0.16));

   // --- the visual origin: sockets on the animated weapon. The flash sprite and the
    // view-model light stay in the view-model scene at the socket itself; anything that
    // lives in the WORLD scene is reprojected so it lands on the same pixel. ---
    const fx = this.effects;
    // The socket's own parent: on an authored assembly that is the animated root, not the mount.
    fx.vfx.muzzleFlash(w.muzzle.parent, w.muzzle.position, def.muzzleFlashScale, def.muzzleFlashColor, w.shotCounter);
    vm.getMuzzleWorld(_v2);
    fx.vmScene?.muzzleFlash(_v2.x, _v2.y, _v2.z, def.muzzleFlashColor);
    vm.toWorldProjected(_v2, _muzzle);
    fx.vfx.pulseLight(_muzzle.x, _muzzle.y, _muzzle.z, def.muzzleFlashColor, def.lightIntensity, 0.075, 9);
    /**
     * THE FIRING SOUND, on an accepted shot and never before one.
     *
     * An automatic weapon holds ONE looping voice for as long as the trigger stays valid -
     * `startActionVoice` is a no-op while that voice exists, so this line runs on every
     * bullet and still produces exactly one source. Everything else plays once per accepted
     * trigger event, which is once per shot however many pellets that shot throws.
     */
    const snd = def.sound;
    if (snd?.continuousFire) this.audio?.startActionVoice(ACTION.weapon1Fire, snd.fire);
    else if (snd?.fire) this.audio?.playOneShot(snd.fire);
    else this.audio?.play(def.audio, null, 1.0);

    if (def.shell && fx.shells?.enabled) {
      vm.getEjectionWorld(_v2);
      vm.toWorldProjected(_v2, _eject);
      const sh = def.shell;
      vm.rigDirectionToWorld(_v, sh.direction[0], sh.direction[1], sh.direction[2]).normalize().multiplyScalar(sh.speed);
      _v.x += this.player.velocity.x * 0.6; _v.z += this.player.velocity.z * 0.6;
      fx.shells.spawn(_eject.x, _eject.y, _eject.z, _v.x, _v.y, _v.z, sh.spin);
      if (w.shotCounter % 3 === 0) this.audio?.play('shellDrop', _eject, 0.18);
    }

    // Blast weapons puff smoke at the muzzle.
    if (def.pellets > 1) {
      const dir = this.player.aimDirection(_v2);
      for (let i = 0; i < 3; i++) {
        fx.vfx.smoke.spawn(_muzzle.x, _muzzle.y, _muzzle.z,
          dir.x * (1.4 + i) + (i - 1) * 0.3, dir.y * (1.4 + i) + 0.5, dir.z * (1.4 + i) + (i - 1) * 0.3,
          0.5 + i * 0.15, 0.14 + i * 0.05, 0.34, 0.30, 0.26);
      }
    }

    // --- the AIM ray: from the simulated eye, along look + recoil ---
    _origin.copy(this.player.eyePosition);
    this.player.aimDirection(_aim);
    const spreadDeg = spreadDegrees(def.spread, {
      adsBlend, speedFraction: this.ctx.speedFraction, grounded: this.ctx.grounded, crouchBlend: this.ctx.crouchBlend,
    }, w.sustained - def.spread.sustained.perShot);
    if (def.projectile) {
      pelletDirection(_dir, _aim, spreadDeg, 0, 1, w.shotCounter);
      // Start at the simulated eye, like hitscan: a muzzle beyond a nearby wall must
      // never let the projectile spawn through that wall. It then sweeps every step.
      fx.rockets.launch(_origin, _dir);
      fx.rockets.energyBlast(_muzzle, _dir, false);
      return;
    }
    const enemies = this._enemies?.() || [];
    const tracer = def.tracerEvery > 0 && (w.shotCounter % def.tracerEvery === 0);
    for (let p = 0; p < def.pellets; p++) {
      pelletDirection(_dir, _aim, spreadDeg, p, def.pellets, w.shotCounter);
      traceShot(this.collision, enemies, _origin, _dir, def.range, _hit);
      this._resolveHit(w, _hit, _dir, p);
      if (tracer && (p === 0 || def.pellets > 1)) {
        // Tracer from the MUZZLE to where the AIM ray landed.
        const endX = _hit.kind === HIT_KIND.NONE ? _origin.x + _dir.x * def.range : _hit.x;
        const endY = _hit.kind === HIT_KIND.NONE ? _origin.y + _dir.y * def.range : _hit.y;
        const endZ = _hit.kind === HIT_KIND.NONE ? _origin.z + _dir.z * def.range : _hit.z;
        fx.tracers?.spawn(_muzzle.x, _muzzle.y, _muzzle.z, endX, endY, endZ, def.muzzleFlashColor);
      }
    }
  }

  _resolveHit(w, hit, dir, pelletIndex) {
    const def = w.def;
    if (hit.kind === HIT_KIND.ENEMY) {
      let dmg = def.damage * (hit.head ? def.headshotMultiplier : 1);
      if (def.falloffStart) {
        const k = MathUtils.clamp((hit.dist - def.falloffStart) / (def.range - def.falloffStart), 0, 1);
        dmg *= MathUtils.lerp(1, def.falloffMin, k);
      }
      // Deterministic stagger: pellet 0 of a blast, or every 4th SMG shot.
      const stagger = def.staggerChance >= 0.8
        ? pelletIndex === 0
        : (w.shotCounter % 4 === 0 && pelletIndex === 0);
      this.shotsHit++;
      this.effects.vfx.enemyHit(hit.x, hit.y, hit.z, dir.x, dir.y, dir.z, def.pellets > 1);
      this.onEnemyHit?.(hit.enemy, dmg, hit.head, def.impactImpulse, dir, stagger);
      return;
    }
    if (hit.kind === HIT_KIND.NONE) return;

    const id = hit.blocker?.id || '';
    if (id.startsWith('crate:')) {
      /**
       * THE CRATE'S OWN NORMAL, exactly like every other world hit.
       *
       * This used to pass `(-dir.x, 0.25, -dir.z)` - the bullet's path turned round, with a
       * quarter of upward tilt mixed in and no normalisation. That is not a surface normal,
       * it is a direction back towards whoever fired, so the decal it oriented was frozen
       * facing the spot the player happened to be standing on. From there the mark looked
       * fine; from anywhere else it was a quad standing at up to 45 degrees out of the crate
       * face, which reads as a stretched teardrop and puts half the quad inside the crate,
       * where it clips and pops. Crates are blockers in the collision grid like anything
       * else, so `hit` already carries the real axis-aligned face normal.
       */
      this.effects.vfx.impact(SURFACE.WOOD, hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
      this.onCrateHit?.(id, def.damage);
    } else {
      this.effects.vfx.impact(hit.surface, hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
      this.onWorldImpact?.(hit.x, hit.y, hit.z, hit.surface, hit.blocker?.id, def.damage);
    }
  }

  // ------------------------------------------------------------------
  // Presentation (render frame)
  // ------------------------------------------------------------------

  /** Runs every render frame. Hands the state to the view model, which owns every layer. */
  updateVisuals(dt, intent) {
    const w = this.current;
    if (!w) return;
    const reloading = w.state === S.RELOADING;
    this.viewmodel.update(dt, {
      state: w.state,
      stateTime: w.stateTime,
      def: w.def,
      mag: w.mag,
      reloadProgress: reloading ? MathUtils.clamp(w.stateTime / w.activeReloadTime, 0, 1) : 0,
      reloadTimeline: w.activeReload,
      equipProgress: w.state === S.EQUIPPING ? MathUtils.clamp(w.stateTime / w.def.equipTime, 0, 1)
        : w.state === S.UNEQUIPPING ? MathUtils.clamp(w.stateTime / w.def.unequipTime, 0, 1) : 0,
      inspectProgress: w.state === S.INSPECTING ? MathUtils.clamp(w.stateTime / w.def.inspectTime, 0, 1) : 0,
      wantAds: this.ads && CAN_ADS_FROM.has(w.state) && w.state !== S.SPRINTING,
      /**
       * The player's finger, not the shot. The trigger-finger channel follows THIS rather
       * than the fire cadence, so a held burst is one continuous press instead of a twitch
       * per round, and a pull that fires nothing - an empty magazine, the sprint-out delay -
       * still moves the finger, because the player still pulled it.
       */
      triggerHeld: this.triggerHeld,
    }, intent);
    // The visual roll spring is the one view-model spring that leans on the camera.
    this.player.recoilRoll = this.viewmodel.recoil.cameraRoll;
  }

  // ------------------------------------------------------------------

  /** Current spread in degrees (for the crosshair), from the same function the shot uses. */
  get currentSpreadDeg() {
    const w = this.current;
    if (!w) return 0;
    return spreadDegrees(w.def.spread, {
      adsBlend: this.viewmodel.ads.blend, speedFraction: this.ctx.speedFraction,
      grounded: this.ctx.grounded, crouchBlend: this.ctx.crouchBlend,
    }, w.sustained);
  }

  get hudState() {
    const w = this.current;
    if (!w) return null;
    return {
      id: w.id,
      name: w.def.displayName,
      mag: Math.round(w.mag),
      magSize: w.def.magazine,
      reserve: Math.round(w.reserve),
      state: w.state,
      reloadProgress: w.state === S.RELOADING ? MathUtils.clamp(w.stateTime / w.activeReloadTime, 0, 1) : 0,
      ads: this.viewmodel.ads.isAiming,
      adsBlend: this.viewmodel.ads.blend,
      keepAimReticle: !!w.def.ads.keepReticle,
      /** Crosshair spread in normalised screen units, for the dynamic reticle. */
      spread: this.currentSpreadDeg / 12 + Math.min(0.5, this.viewmodel.recoil.visualAmount * 0.012),
      /**
       * Live visual recoil, 0..1, which is what gives the reticle its outward impulse on
       * every shot (brief item 19). Normalised here rather than in the HUD because the raw
       * `visualAmount` is in the view model's own units and only this file knows their
       * scale - 30 is a full burst's worth.
       */
      recoil: Math.min(1, this.viewmodel.recoil.visualAmount / 30),
      sustained: w.sustained,
    };
  }

  get fovScale() { return this.viewmodel.ads.worldFovScale; }
  get viewmodelFovScale() { return this.viewmodel.ads.viewmodelFovScale; }
  get sensitivityScale() { return this.viewmodel.ads.sensitivityScale; }
  get state() { return this.current?.state ?? S.HOLSTERED; }

  dispose() {
    this.viewmodel.dispose();
  }
}

export { FIXED_STEP };
