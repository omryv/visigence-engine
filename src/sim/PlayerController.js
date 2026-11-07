/**
 * First-person player: movement, look, collision sliding, crouch, damage, death.
 *
 * Movement integrates on the fixed step; the camera is composed by PlayerCamera on the
 * render frame from the simulated state, so the two never fight over the transform.
 *
 * AIM = LOOK + RECOIL. The gameplay recoil offsets live in the weapon's RecoilController;
 * the player reads them for both the camera and `aimDirection()`, so what kicks on screen
 * is what the bullet does. Look input that opposes a standing offset is consumed by the
 * offset first (pulling down against a burst cancels the climb) before it moves the true
 * aim. Mouse deltas are never multiplied by dt: they are already displacements.
 *
 * GROUND comes from `sim/Terrain.js`, not from a raycast. The height field is baked, so
 * the ground under any (x, z) is four array reads and three lerps — cheaper and more
 * exact than a ray, and guaranteed to agree with the walkable mask the baker produced
 * from the same field. `grounded`, `groundNormal` and `groundDistance` are all resolved
 * from it. The default terrain is the flat plane at y = 0 this controller assumed
 * before terrain existed, so a game that supplies none behaves exactly as it did.
 */

import { Vector3, MathUtils } from 'three/webgpu';
import { PLAYER } from '../config/gameplay.js';
import { playerMaxHealth } from '../core/Economy.js';
import { PlayerCamera } from '../player/PlayerCamera.js';
import { damp } from '../utils/math.js';
import { DamageIndicators } from './SpatialFeedback.js';
import { FLAT_GROUND } from './Terrain.js';

const _out = { x: 0, z: 0, hitX: false, hitZ: false };
const _look = { dPitch: 0, dYaw: 0 };

export class PlayerController {
  /**
   * @param {import('three').Camera} camera
   * @param {import('./CollisionSystem.js').CollisionSystem} collision
   * @param {import('./Terrain.js').Terrain} [terrain]  the ground. Omitted means the
   *   flat plane at y = 0 this controller assumed before terrain existed.
   */
  constructor(camera, collision, terrain = FLAT_GROUND) {
    this.camera = camera;
    this.collision = collision;
    this.terrain = terrain;
    this.cameraRig = new PlayerCamera(camera, this);

    this.position = new Vector3();     // feet position
    /** Feet position at the START of the last fixed step, for render interpolation. */
    this.prevPosition = new Vector3();
    this.velocity = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.groundNormal = new Vector3(0, 1, 0);
    this.groundDistance = 0;
    this.eyeHeight = PLAYER.eyeHeight;

    this.health = playerMaxHealth();
    this.alive = true;
    this.timeSinceDamage = 999;
    this.damageTaken = 0;

    // --- camera motion state (composed by PlayerCamera) ---
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.shake = 0;
    this.shakeSeed = 0;
    /** Direction the last hit came from, for the HUD indicator. */
    this._damageIndicators = new DamageIndicators();
    this.lastHitDir = new Vector3();
    this.lastHitAge = 999;

    /** Gameplay recoil, read from the weapon's RecoilController when one is attached. */
    this.recoil = null;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRoll = 0;

    this.sprinting = false;
    this.wantSprint = false;
    /** Set by the weapon: aiming, firing and interacting forbid the sprint. */
    this.sprintBlocked = false;
    this.speedFraction = 0;

    this.wantCrouch = false;
    this.crouched = false;
    this.crouchBlend = 0;

    /** Event hooks (footsteps, jump, landing) for audio. */
    this.onStep = null;
    this.onJump = null;
    this.onLand = null;
    this._stepHalf = 0;

    this._fwd = new Vector3();
    this._right = new Vector3();
    this._tmp = new Vector3();
  }

  /** The weapon's recoil controller: the source of the aim offsets. */
  setRecoilSource(recoil) { this.recoil = recoil; }

  get aimRecoilPitch() { return this.recoil ? this.recoil.aimPitch : 0; }
  get aimRecoilYaw() { return this.recoil ? this.recoil.aimYaw : 0; }

  reset(spawn) {
    /**
     * A spawn point names WHERE, not how high: a level's spawns are authored on the
     * ground plan, and on terrain the ground is wherever the height field puts it. A
     * spawn that carries its own `y` is honoured (a catwalk, a drop-in), otherwise the
     * player is stood on the ground under the point. Under FLAT_GROUND this is 0, which
     * is what it always was.
     */
    const groundY = this.terrain.heightAt(spawn.position.x, spawn.position.z);
    this.position.set(spawn.position.x, spawn.position.y ?? groundY, spawn.position.z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = spawn.yaw;
    this.pitch = spawn.pitch;
    this.health = playerMaxHealth();
    this.alive = true;
    this.timeSinceDamage = 999;
    this.damageTaken = 0;
    this.grounded = true;
    this.groundDistance = 0;
    this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
    this.bobPhase = 0; this.bobAmount = 0;
    this.landDip = 0; this.landDipVel = 0;
    this.shake = 0;
    this._damageIndicators.reset();
    this.lastHitAge = 999;
    this.recoilPitch = this.recoilYaw = this.recoilRoll = 0;
    this.recoil?.reset();
    this.eyeHeight = PLAYER.eyeHeight;
    this.wantCrouch = false; this.crouched = false; this.crouchBlend = 0;
    this.sprintBlocked = false;
    this._stepHalf = 0;
  }

  /**
   * Look input, in radians. Applied immediately so mouse feel is not step-quantised.
   * A standing recoil offset absorbs opposing input first.
   */
  addLook(dYaw, dPitch) {
    if (!this.alive) return;
    let y = dYaw, p = dPitch;
    if (this.recoil) {
      this.recoil.consumeLook(dPitch, dYaw, _look);
      y = _look.dYaw; p = _look.dPitch;
    }
    this.yaw -= y;
    this.pitch -= p;
    this.pitch = MathUtils.clamp(this.pitch, -PLAYER.maxPitch, PLAYER.maxPitch);
    // Keep yaw bounded so long sessions cannot drift into float imprecision.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Unit forward on the XZ plane, from yaw alone. */
  forward(out = this._fwd) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Full 3D aim direction: look plus the gameplay recoil offsets. */
  aimDirection(out = new Vector3()) {
    const pitch = MathUtils.clamp(this.pitch + this.aimRecoilPitch, -PLAYER.maxPitch, PLAYER.maxPitch);
    const yaw = this.yaw + this.aimRecoilYaw;
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  get eyePosition() {
    return this._tmp.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /**
   * Fixed-step simulation.
   * @param {number} dt          exactly FIXED_STEP
   * @param {{x:number,y:number}} move  normalised input, +y forward, +x right
   * @param {boolean} jump
   */
  fixedUpdate(dt, move, jump) {
    this.prevPosition.copy(this.position);
    if (!this.alive) {
      this.velocity.set(0, 0, 0);
      return;
    }
    this.timeSinceDamage += dt;
    this.lastHitAge += dt;
    this._damageIndicators.update(dt);

    // --- desired horizontal velocity ---
    this.forward(this._fwd);
    this._right.set(-this._fwd.z, 0, this._fwd.x);   // right = forward rotated -90deg

    const inputLen = Math.hypot(move.x, move.y);
    // Sprint only counts when actually pushing forward; strafe-sprinting reads wrong.
    // The weapon can forbid it (aiming, firing, interacting), and sprinting stands up.
    this.sprinting = this.wantSprint && !this.sprintBlocked && inputLen > 0.35 && move.y > 0.4;
    this.crouched = this.wantCrouch && !this.sprinting && this.grounded;
    this.crouchBlend = damp(this.crouchBlend, this.crouched ? 1 : 0, PLAYER.crouchRate, dt);
    if (this.crouchBlend < 0.001) this.crouchBlend = 0;
    if (this.crouchBlend > 0.999) this.crouchBlend = 1;
    this.eyeHeight = MathUtils.lerp(PLAYER.eyeHeight, PLAYER.crouchEyeHeight, this.crouchBlend);

    const maxSpeed = (this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed)
      * MathUtils.lerp(1, PLAYER.crouchSpeedScale, this.crouchBlend);

    let wishX = this._fwd.x * move.y + this._right.x * move.x;
    let wishZ = this._fwd.z * move.y + this._right.z * move.x;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-5) { wishX /= wishLen; wishZ /= wishLen; }

    const targetX = wishX * maxSpeed * Math.min(1, inputLen);
    const targetZ = wishZ * maxSpeed * Math.min(1, inputLen);

    const rate = (wishLen > 1e-5 ? PLAYER.accel : PLAYER.decel) * (this.grounded ? 1 : PLAYER.airAccel / PLAYER.accel);
    this.velocity.x = approach(this.velocity.x, targetX, rate * dt);
    this.velocity.z = approach(this.velocity.z, targetZ, rate * dt);

    // --- vertical ---
    if (jump && this.grounded) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.grounded = false;
      this.onJump?.();
    }
    if (!this.grounded) this.velocity.y += PLAYER.gravity * dt;

    // --- horizontal move with sliding ---
    this.collision.bodyQuery={y:this.position.y,height:this.eyeHeight+.15};
    this.collision.moveDisc(
      this.position.x, this.position.z,
      this.velocity.x * dt, this.velocity.z * dt,
      PLAYER.radius, _out
    );
    this.collision.bodyQuery=null;
    // Kill the velocity component into a wall so we do not keep accelerating into it.
    if (_out.hitX) this.velocity.x = 0;
    if (_out.hitZ) this.velocity.z = 0;
    this.position.x = _out.x;
    this.position.z = _out.z;

    /**
     * --- vertical resolve, against the TERRAIN.
     *
     * This used to test `position.y <= 0` because the level was one floor plane. The
     * ground is now whatever `sim/Terrain.js` says it is at this (x, z), and the
     * default terrain says 0 everywhere — so a game that supplies no terrain resolves
     * against exactly the plane it always did, to the float.
     *
     * The ground is sampled AFTER the horizontal move, not before: the player has
     * already slid along whatever wall they hit, so this is the height under where they
     * actually ended up. Sampling first would resolve them onto the ground under a
     * position they never occupied, which on a slope is a visible pop.
     */
    const groundY = this.terrain.heightAt(this.position.x, this.position.z);
    this.position.y += this.velocity.y * dt;
    if (this.position.y <= groundY) {
      if (!this.grounded) {
        const impact = Math.abs(this.velocity.y);
        this.landDipVel -= Math.min(PLAYER.landDipMax, impact * PLAYER.landDipPerSpeed) * 26;
        this.onLand?.(impact);
      }
      this.position.y = groundY;
      this.velocity.y = 0;
      this.grounded = true;
    } else if (this.grounded) {
      /**
       * THE GROUND FELL AWAY. On a flat floor this case does not exist, which is why it
       * was missing: `y <= groundY` can only fire while the ground is rising to meet
       * you. Walking DOWNHILL the ground drops below the body, the test stays false, and
       * — because gravity is gated on `!grounded` — nothing pulls the player down
       * either. Measured before this branch existed: the body floated off every descent
       * still reporting `grounded`, 48% of all ticks, with a worst per-tick descent of
       * exactly 0.0 mm. It never came down at all.
       *
       * Two outcomes, and the threshold between them is the SAME NUMBER the baker used
       * to decide the mask. A rise you could have stepped up is a drop you can step
       * down without leaving the ground; anything deeper is an edge you walked off.
       * Sharing `stepUp` is what keeps the body's idea of continuous ground and the
       * flood fill's idea of a reachable neighbour from drifting apart.
       */
      const drop = this.position.y - groundY;
      if (drop <= this.terrain.stepDown) {
        this.position.y = groundY;          // follow the slope down
      } else {
        this.grounded = false;              // walked off an edge; gravity takes it
      }
    }
    this.groundDistance = this.position.y - groundY;
    /**
     * The normal is read only while grounded. In the air the last ground normal is
     * meaningless and `groundDistance` is what callers should be asking about; keeping
     * the stale normal costs nothing and avoids a per-frame sample nobody reads.
     */
    if (this.grounded) this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

    // --- bob drive + footsteps ---
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speedFraction = speed / PLAYER.sprintSpeed;
    const bobTarget = this.grounded ? Math.min(1, speed / PLAYER.walkSpeed) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 9);
    const freq = PLAYER.bobFrequency * (this.sprinting ? PLAYER.bobSprintScale : 1);
    this.bobPhase += freq * dt * Math.max(0.2, this.bobAmount);
    // One footstep per half bob cycle while actually moving on the ground.
    const half = Math.floor(this.bobPhase / Math.PI);
    if (half !== this._stepHalf) {
      this._stepHalf = half;
      if (this.grounded && speed > PLAYER.footstepMinSpeed) this.onStep?.(speed, this.sprinting, this.crouched);
    }

    // --- health regeneration, capped below full so damage still matters ---
    if (this.timeSinceDamage > PLAYER.regenDelay) {
      const ceiling = playerMaxHealth() * PLAYER.regenCeiling;
      if (this.health < ceiling) this.health = Math.min(ceiling, this.health + PLAYER.regenRate * dt);
    }
  }

  /** Per-render-frame camera composition. See PlayerCamera. */
  updateCamera(dt, alpha = 1) { this.cameraRig.update(dt, alpha); }

  /**
   * @param {number} amount
   * @param {Vector3|null} fromPosition  used for the directional damage indicator
   */
  damage(amount, fromPosition) {
    if (!this.alive || amount <= 0) return false;
    this.health -= amount;
    this.damageTaken += amount;
    this.timeSinceDamage = 0;
    this.shake = Math.min(1.4, this.shake + Math.min(0.9, amount / 26));
    this.landDipVel -= Math.min(2.4, amount * 0.05);
    if (fromPosition) {
      this._damageIndicators.record(amount, fromPosition.x - this.position.x, fromPosition.z - this.position.z);
      this.lastHitDir.copy(fromPosition).sub(this.position).setY(0).normalize();
      this.lastHitAge = 0;
    }
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      return true;    // died
    }
    return false;
  }

  heal(amount) {
    this.health = Math.min(playerMaxHealth(), this.health + amount);
  }

  damageIndicators() { return this._damageIndicators.sample(this.yaw + this.aimRecoilYaw); }

}

function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
