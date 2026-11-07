/**
 * The world camera, composed from the player's simulated state every render frame.
 *
 * Conceptually the hierarchy the brief describes:
 *
 *     PlayerRoot (interpolated feet position)
 *       └── YawRoot (yaw + recoil yaw)
 *             └── PitchRoot (pitch + recoil pitch)
 *                   └── CameraEffectsRoot (bob, landing dip, shake, recoil roll)
 *                         └── WorldCamera
 *
 * It is composed as ONE transform from scratch each frame rather than as nested
 * Object3Ds, for the same reason the view model recomputes every layer: nothing is ever
 * incremented into the camera, so nothing can drift, and the audio listener and the
 * enemy code that read `camera.position` keep getting a world position.
 *
 *   position = feet, interpolated between the last two fixed steps by the loop's
 *              accumulator fraction (smooth at any display rate)
 *            + eye height (crouch-blended)
 *            + bob (locomotion)      + landing dip (impact)      + damage shake (reaction)
 *   rotation = yaw + recoil yaw,  pitch + recoil pitch,  bob roll + shake roll + recoil roll
 *
 * The recoil terms are the SAME gameplay offsets the shot direction uses, so what the
 * player sees kick is exactly what the bullet does.
 */

import { Vector3, Euler } from 'three/webgpu';
import { PLAYER } from '../config/gameplay.js';

/**
 * The most one fixed step can legitimately move the player is sprint speed over 1/60 s
 * (0.107 m) plus the jump's first step (0.093 m). A larger gap between two consecutive
 * steps is a teleport - a respawn, a restart, a test hook - and the camera snaps to it
 * rather than sliding across the level.
 */
const TELEPORT_DISTANCE_SQ = 0.5 * 0.5;

export class PlayerCamera {
  constructor(camera, player) {
    this.camera = camera;
    this.player = player;
    this._renderPos = new Vector3();
    this._right = new Vector3();
    this._euler = new Euler(0, 0, 0, 'YXZ');
  }

  /**
   * @param {number} dt     render-frame delta, clamped by the loop
   * @param {number} alpha  accumulator fraction into the next fixed step, 0..1
   */
  update(dt, alpha = 1) {
    const p = this.player;
    const rp = this._renderPos;
    if (alpha >= 1 || p.prevPosition.distanceToSquared(p.position) > TELEPORT_DISTANCE_SQ) {
      rp.copy(p.position);
    } else {
      rp.copy(p.prevPosition).lerp(p.position, Math.max(0, alpha));
    }

    /**
     * Damped spring for the landing dip: x'' + 2*zeta*w*x' + w^2*x = 0, integrated in
     * sub-steps of at most 0.5/w so a 250 ms stalled frame cannot diverge it.
     */
    const w = 15.5, zeta = 0.42;
    const dipSteps = Math.max(1, Math.min(64, Math.ceil(dt * w / 0.5)));
    const dipH = dt / dipSteps;
    for (let i = 0; i < dipSteps; i++) {
      p.landDipVel += (-2 * zeta * w * p.landDipVel - w * w * p.landDip) * dipH;
      p.landDip += p.landDipVel * dipH;
    }

    if (p.shake > 0) p.shake = Math.max(0, p.shake - dt * 2.6);

    const bobY = Math.sin(p.bobPhase * 2) * PLAYER.bobAmplitude * p.bobAmount;
    const bobX = Math.cos(p.bobPhase) * PLAYER.bobAmplitude * 0.55 * p.bobAmount;
    const bobRoll = Math.cos(p.bobPhase) * PLAYER.bobRollAmplitude * p.bobAmount;

    // Deterministic shake: two incommensurate sines, no RNG, so a replay matches.
    p.shakeSeed += dt * 47;
    const sh = p.shake * p.shake;
    const shX = Math.sin(p.shakeSeed * 1.7) * sh * 0.037;
    const shY = Math.sin(p.shakeSeed * 2.31 + 1.1) * sh * 0.037;
    const shRoll = Math.sin(p.shakeSeed * 1.13 + 0.4) * sh * 0.029;

    this._right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));

    this.camera.position.set(
      rp.x + this._right.x * (bobX + shX),
      rp.y + p.eyeHeight + bobY + p.landDip + shY,
      rp.z + this._right.z * (bobX + shX)
    );

    // Gameplay recoil offsets, mirrored onto the player for anything that reads them.
    p.recoilPitch = p.aimRecoilPitch;
    p.recoilYaw = p.aimRecoilYaw;
    this._euler.set(
      p.pitch + p.recoilPitch,
      p.yaw + p.recoilYaw,
      bobRoll + shRoll + p.recoilRoll,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(this._euler);
  }
}
