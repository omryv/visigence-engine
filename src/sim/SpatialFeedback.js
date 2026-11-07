/**
 * Camera-relative bearings shared by damage feedback and route guidance.
 * Zero points up the HUD; positive angles turn clockwise toward the player's right.
 */
export function relativeBearing(dx, dz, yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz);
}

export const DAMAGE_CUE_SECONDS = 1.6;

/** Four bounded hit sectors. Captured bearings expire; they never track a living enemy. */
export class DamageIndicators {
  constructor() {
    this.hits = Array.from({ length: 4 }, () => ({ x: 0, z: 0, age: DAMAGE_CUE_SECONDS, strength: 0 }));
    this.readout = this.hits.map(() => ({ angle: 0, opacity: 0 }));
  }

  reset() {
    for (const hit of this.hits) hit.age = DAMAGE_CUE_SECONDS;
    for (const cue of this.readout) cue.opacity = 0;
  }

  update(dt) {
    for (const hit of this.hits) hit.age = Math.min(DAMAGE_CUE_SECONDS, hit.age + dt);
  }

  record(amount, dx, dz) {
    const length = Math.hypot(dx, dz);
    if (!(amount > 0) || !Number.isFinite(length) || length < 0.001) return;
    const x = dx / length, z = dz / length;
    // Repeated hits from one direction refresh one cue; flanking hits retain theirs.
    let slot = this.hits.find(h => h.age < DAMAGE_CUE_SECONDS && h.x * x + h.z * z > 0.9);
    if (!slot) slot = this.hits.reduce((oldest, h) => h.age > oldest.age ? h : oldest);
    slot.x = x; slot.z = z; slot.age = 0;
    slot.strength = 0.65 + Math.min(0.35, amount / 60);
  }

  sample(yaw) {
    for (let i = 0; i < this.hits.length; i++) {
      const h = this.hits[i], cue = this.readout[i];
      cue.angle = relativeBearing(h.x, h.z, yaw);
      cue.opacity = h.strength * Math.max(0, 1 - Math.max(0, h.age - 0.15) / (DAMAGE_CUE_SECONDS - 0.15));
    }
    return this.readout;
  }
}
