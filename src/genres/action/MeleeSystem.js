/**
 * Strikes instead of hitscan: the action genre's trail staff (revived from the retired adventure genre, 2026-09-23).
 *
 * A strike is a short state machine on the fixed step: a windup, then ONE damage test
 * against every living enemy inside the reach and the cone in front of the player with a
 * clear line, then recovery. Nothing here is a ray per frame or a trigger held down: one
 * press, one swing, one test, which is what makes a replay of it deterministic and what
 * makes a dodge or a wall defeat it. World hits (a barricade, a crate) go through the
 * same callback the weapon controller uses, so an objective that can be forced open with
 * bullets can be forced open with hands.
 */
import { Vector3 } from 'three/webgpu';

const _dir = new Vector3(), _hit = {};

/** The staff swing's timing matches the hero's Hero_Attack clip: the blow lands on its fifth frame (0.14 s). */
export const MELEE = {
  reach: 2.4, damage: 40, halfAngleDeg: 70,
  windup: 0.14, duration: 0.42, cooldown: 0.5,
};

export class MeleeSystem {
  /**
   * @param {object} o
   * @param {import('../../sim/PlayerController.js').PlayerController} o.player
   * @param {import('../../sim/CollisionSystem.js').CollisionSystem} o.collision
   * @param {import('../../game/EnemySystem.js').EnemySystem} o.enemies
   * @param {(x:number,y:number,z:number,surface:string,id:string,damage:number)=>void} [o.onWorldImpact]
   * @param {() => void} [o.onSwing]  presentation hook (a whoosh, a hand animation)
   */
  constructor({ player, collision, enemies, onWorldImpact = null, onSwing = null, tuning = MELEE }) {
    Object.assign(this, { player, collision, enemies, onWorldImpact, onSwing, tuning });
    this._cosHalf = Math.cos(tuning.halfAngleDeg * Math.PI / 180);
    this.reset();
  }

  reset() { this.cooldownLeft = 0; this.swing = null; this.strikes = 0; this.hits = 0; }

  /** Mid-swing, for the player's animator. */
  get attacking() { return this.swing !== null; }

  get hudState() { return { name: 'STRIKE', ready: this.cooldownLeft <= 0 && !this.swing, strikes: this.strikes, hits: this.hits }; }

  fixedUpdate(dt, input = {}) {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    const t = this.tuning;
    if (this.swing) {
      this.swing.t += dt;
      if (!this.swing.landed && this.swing.t >= t.windup) this._land();
      if (this.swing.t >= t.duration) this.swing = null;
      return;
    }
    if (input.attack && this.cooldownLeft <= 0 && this.player.alive) {
      this.swing = { t: 0, landed: false };
      this.cooldownLeft = t.cooldown;
      this.strikes++;
      this.onSwing?.();
    }
  }

  _land() {
    this.swing.landed = true;
    const p = this.player, t = this.tuning, c = this.collision;
    const dir = p.aimDirection(_dir);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - p.position.x, dz = e.position.z - p.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > t.reach + e.type.radius) continue;
      if (dist > 1e-6 && (fx * dx + fz * dz) / dist < this._cosHalf) continue;
      if (!c.hasLineOfSight(p.position.x, p.position.z, e.position.x, e.position.z)) continue;
      this.enemies.damage(e, t.damage, { direction: dir.clone(), stagger: true });
      this.hits++;
    }
    if (this.onWorldImpact) {
      const eye = p.eyePosition;
      c.raycastProjectile(eye, dir, t.reach, _hit);
      if (_hit.hit && _hit.blocker?.id) this.onWorldImpact(_hit.x, eye.y, _hit.z, _hit.blocker.surface ?? 'metal', _hit.blocker.id, t.damage);
    }
  }

  dispose() { this.swing = null; }
}
