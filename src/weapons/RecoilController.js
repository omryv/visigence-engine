/**
 * Recoil, in three parts that never share a transform:
 *
 *   R = R_camera + R_viewmodel + R_animation
 *
 *   R_camera      GAMEPLAY. A per-shot kick added to the player's aim (pitch and yaw
 *                 offsets that the PlayerController folds into both the camera and the
 *                 shot direction). It accumulates under automatic fire and recovers when
 *                 firing stops - not while the trigger is held, and never on top of the
 *                 player's own correction: mouse input that opposes the offset is consumed
 *                 by the offset first (`consumeLook`), so pulling down against a burst
 *                 cancels the climb instead of being doubled by a spring that also pulls
 *                 down. Recovery itself is critically damped (no overshoot below the
 *                 original aim). Integrated on the FIXED step.
 *   R_viewmodel   VISUAL. Four springs (kickback, pitch, yaw, roll) on the RecoilRoot,
 *                 integrated on the render frame with the stable sub-stepped Spring.
 *   R_animation   the authored fire clip's own mechanical snap.
 *
 * The pattern is deterministic: yaw alternates on the shot counter and the pitch kick
 * follows a five-shot cycle, so the recoil is something the player can learn. No RNG.
 *
 * This is the ONLY writer of the RecoilRoot transform.
 */

import { Euler } from 'three/webgpu';
import { Spring } from '../utils/math.js';

/** Config impulses are small "feel" numbers; the springs want velocities. */
const VIEWMODEL_KICK_GAIN = 42;
/** Seconds after the last shot before the camera offset starts recovering. */
const RECOVER_DELAY = 0.09;
const _e = new Euler(0, 0, 0, 'XYZ');

export class RecoilController {
  constructor(node) {
    this.node = node;
    this.def = null;

    // --- view-model springs ---
    this.back = new Spring(190, 17);
    this.pitch = new Spring(220, 19);
    this.yaw = new Spring(170, 17);
    this.roll = new Spring(150, 15);

    // --- gameplay camera recoil (radians), recovered toward zero when firing stops ---
    this.aimPitchSpring = new Spring(120, 22);
    this.aimYawSpring = new Spring(120, 22);
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.timeSinceShot = 99;
    this.holding = false;
  }

  setWeapon(def) {
    this.def = def;
    const v = def.recoil.viewmodel;
    this.back.stiffness = v.spring.stiffness; this.back.damping = v.spring.damping;
    this.pitch.stiffness = v.spring.stiffness * 1.15; this.pitch.damping = v.spring.damping * 1.1;
    this.yaw.stiffness = v.spring.stiffness * 0.9; this.yaw.damping = v.spring.damping;
    this.roll.stiffness = v.spring.stiffness * 0.8; this.roll.damping = v.spring.damping * 0.9;
    const k = def.recoil.camera.recover.stiffness;
    // Critically damped whatever the config says about damping: recovery must not overshoot.
    const d = Math.max(def.recoil.camera.recover.damping, 2 * Math.sqrt(k));
    this.aimPitchSpring.stiffness = k; this.aimPitchSpring.damping = d;
    this.aimYawSpring.stiffness = k; this.aimYawSpring.damping = d;
      this.reset();
  }

  reset() {
    this.back.reset(); this.pitch.reset(); this.yaw.reset(); this.roll.reset();
    this.aimPitchSpring.reset(); this.aimYawSpring.reset();
    this.aimPitch = 0; this.aimYaw = 0;
    this.timeSinceShot = 99;
    this._write();
  }

  /**
   * One shot. `shotIndex` is the weapon's running shot counter; `adsBlend` scales the kick.
   * Called from the fixed step by the weapon controller.
   */
  kick(shotIndex, adsBlend) {
    const def = this.def;
    if (!def) return;
    const sign = (shotIndex % 2) ? 1 : -1;
    const cycle = ((shotIndex % 5) / 5) * 0.6 + 0.7;

    const v = def.recoil.viewmodel;
    const vs = 1 - adsBlend * (1 - v.adsScale);
    this.pitch.kick(v.pitch * VIEWMODEL_KICK_GAIN * vs * cycle);
    this.yaw.kick(v.yaw * VIEWMODEL_KICK_GAIN * vs * sign * cycle);
    this.back.kick(v.back * VIEWMODEL_KICK_GAIN * vs);
    this.roll.kick(v.roll * VIEWMODEL_KICK_GAIN * vs * sign);

    const c = def.recoil.camera;
    const cs = 1 - adsBlend * (1 - c.adsScale);
    // The aim offset is displaced directly (an impulse on position, not velocity) so the
    // first round is felt on the very step it fires. Velocity is zeroed so a recovery in
    // progress does not keep pulling through the new kick.
    this.aimPitchSpring.value += c.pitch * cs * cycle;
    this.aimYawSpring.value += c.yaw * cs * sign * cycle;
    this.aimPitchSpring.velocity = 0;
    this.aimYawSpring.velocity = 0;
    this.aimPitch = this.aimPitchSpring.value;
    this.aimYaw = this.aimYawSpring.value;
    this.timeSinceShot = 0;
  }

 /** Gameplay recovery, on the fixed step. `holding` = the trigger is down. */
  fixedUpdate(dt, holding) {
    this.timeSinceShot += dt;
    this.holding = holding;
      if (holding && this.timeSinceShot < RECOVER_DELAY) {
      this.aimPitch = this.aimPitchSpring.value;
      this.aimYaw = this.aimYawSpring.value;
      if (Math.abs(this.aimPitch) < 1e-5 && Math.abs(this.aimPitchSpring.velocity) < 1e-4) { this.aimPitch = 0; this.aimPitchSpring.reset(); }
      if (Math.abs(this.aimYaw) < 1e-5 && Math.abs(this.aimYawSpring.velocity) < 1e-4) { this.aimYaw = 0; this.aimYawSpring.reset(); }
      return;
    }
    if (this.timeSinceShot < RECOVER_DELAY) return;
    this.aimPitch = this.aimPitchSpring.update(dt);
    this.aimYaw = this.aimYawSpring.update(dt);
  }
/**
   * The player's own correction. Look input that opposes a standing offset cancels it
   * before it moves the true aim. `dPitch` and `dYaw` are the player's deltas in the
   * PlayerController's own sign convention (pitch -= dPitch, yaw -= dYaw), so a downward
   * mouse move (dPitch > 0) opposes a positive (upward) pitch offset.
   * @returns {{dPitch:number, dYaw:number}} what remains for the camera
   */
  consumeLook(dPitch, dYaw, out) {
    let p = dPitch, y = dYaw;
    if (this.aimPitch > 0 && p > 0) { const c = Math.min(p, this.aimPitch); this.aimPitch -= c; p -= c; }
    else if (this.aimPitch < 0 && p < 0) { const c = Math.min(-p, -this.aimPitch); this.aimPitch += c; p += c; }
    if (this.aimYaw > 0 && y > 0) { const c = Math.min(y, this.aimYaw); this.aimYaw -= c; y -= c; }
    else if (this.aimYaw < 0 && y < 0) { const c = Math.min(-y, -this.aimYaw); this.aimYaw += c; y += c; }
    this.aimPitchSpring.value = this.aimPitch;
    this.aimYawSpring.value = this.aimYaw;
    out.dPitch = p; out.dYaw = y;
    return out;
  }
  /** Visual springs, on the render frame. */
  update(dt) {
    this.back.update(dt);
    this.pitch.update(dt);
    this.yaw.update(dt);
    this.roll.update(dt);
    this._write();
  }

  _write() {
    const back = this.back.value, p = this.pitch.value, y = this.yaw.value, r = this.roll.value;
    this.node.position.set(0, p * 0.0022, back * 0.010);
    _e.set(p * 0.010, y * 0.010, r * 0.010);
    this.node.quaternion.setFromEuler(_e);
  }

  /** How far the view-model pitch spring is from rest, for the crosshair bloom. */
  get visualAmount() { return Math.abs(this.pitch.value); }
  /** Roll to lend the camera, radians - the only visual spring that touches the camera. */
  get cameraRoll() { return this.roll.value * 0.0018; }
}
