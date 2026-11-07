/**
 * The centre-screen interaction ray.
 *
 *     R_i = Raycast(C_world, d_forward)
 *
 * Every fixed step, the ray from the player's eye along the aim is tested against every
 * registered Interactable that can currently be used:
 *   1. range       the anchor is within `maxDistance` of the eye;
 *   2. visibility  the collision grid has a clear line from the eye to the anchor, with
 *                  the target's own collider exempt;
 *   3. aim         the ray passes within the target's `radius` of its anchor column, OR,
 *                  as a narrow fallback for a small anchor the crosshair just misses, the
 *                  anchor lies inside a 14 degree cone around the aim.
 * A ray hit beats a cone hit; nearest wins among equals. So a door across the corridor
 * prompts when it is looked at, not when it is walked past.
 *
 * While INTERACT is held with a target, `target.interact(dt)` runs until it reports done;
 * releasing, or losing the target, cancels. The weapon controller mirrors `holding` into
 * its INTERACTING state, so the hands reach and the gun cannot fire during a use.
 */

import { INTERACTION } from '../config/gameplay.js';

export class InteractionSystem {
  /**
   * @param {import('../sim/CollisionSystem.js').CollisionSystem} collision
   */
  constructor(collision) {
    this.collision = collision;
    /** @type {Map<string, import('./Interactable.js').Interactable>} */
    this.items = new Map();
    this.target = null;
    this.targetByRay = false;
    this.holding = false;
    this.completed = null;
    this._cosCone = Math.cos(INTERACTION.focusHalfAngleDeg * Math.PI / 180);
  }

  register(item) { this.items.set(item.id, item); return item; }
  unregister(id) { this.items.delete(id); if (this.target?.id === id) this.target = null; }

  reset() { this.target = null; this.holding = false; this.completed = null; }

  /** What the HUD shows: the target's prompt, or null. */
  get prompt() { return this.target ? this.target.getPrompt() : null; }

  /**
   * @param {number} dt
   * @param {object} s  { eyeX, eyeY, eyeZ, dirX, dirY, dirZ, held, player }
   */
  fixedUpdate(dt, s) {
    const prev = this.target;
    const next = this._pick(s);
    if (prev && prev !== next && this.holding) prev.cancel(s.player);
    this.target = next;
    this.completed = null;

    for (const item of this.items.values()) {
      if (item !== next) item.idle(dt);
    }

    if (next && s.held) {
      this.holding = true;
      if (next.interact(s.player, dt)) {
        this.completed = next.id;
        this.holding = false;
      }
    } else {
      if (this.holding && prev) prev.cancel(s.player);
      this.holding = false;
      next?.idle(dt);
    }
  }

  _pick(s) {
    let best = null, bestScore = Infinity, bestRay = false;
    const c = this.collision;
    for (const item of this.items.values()) {
      if (!item.canInteract(s.player)) continue;
      const ax = item.anchor.x, az = item.anchor.z;
      const dx = ax - s.eyeX, dz = az - s.eyeZ;
      const maxD = item.maxDistance ?? INTERACTION.maxDistance;
      const horiz = Math.hypot(dx, dz);
      if (horiz > maxD) continue;
      if (!c.hasLineOfSight(s.eyeX, s.eyeZ, ax, az, false, item.blockerId)) continue;

      // Closest approach of the aim ray to the anchor column (a vertical segment
      // from the floor to `height`).
      const baseY = item.anchor.y ?? 0;
      const ay = Math.min(Math.max(s.eyeY + (s.dirY * horiz) / Math.max(1e-4, Math.hypot(s.dirX, s.dirZ)), baseY), baseY + item.height);
      const vx = dx, vy = ay - s.eyeY, vz = dz;
      const t = vx * s.dirX + vy * s.dirY + vz * s.dirZ;
      let rayHit = false, coneHit = false;
      if (t > 0) {
        const px = s.eyeX + s.dirX * t, py = s.eyeY + s.dirY * t, pz = s.eyeZ + s.dirZ * t;
        const missXZ = Math.hypot(px - ax, pz - az);
        const inColumn = py >= baseY - 0.2 && py <= baseY + item.height + 0.4;
        rayHit = missXZ <= item.radius && inColumn;
        if (!rayHit) {
          const len = Math.hypot(vx, vy, vz) || 1;
          coneHit = (t / len) >= this._cosCone;
        }
      }
      if (!rayHit && !coneHit) continue;
      // Ray hits beat cone hits; a small opt-in priority lets tabletop props beat their furniture.
      const score = (rayHit ? -(item.focusPriority??0) : 1000) + horiz;
      if (score < bestScore) { bestScore = score; best = item; bestRay = rayHit; }
    }
    this.targetByRay = bestRay;
    return best;
  }
}
