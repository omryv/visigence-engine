/**
 * The collect-a-thon's only attack: land on a critter and it is bopped; the hero bounces off it.
 *
 * On the fixed step, while the hero is falling, every living critter under their feet (within its radius plus the
 * hero's, and with the feet between its middle and a little above its crown) takes a lethal blow and the hero's fall
 * turns into a bounce. Anything else a critter does (a lunge, a bite) still hurts: a walk into one is how a run ends.
 */
import { PLAYER } from '../../config/gameplay.js';

export const STOMP = { bounce: 0.82, reach: 0.35 };

export class StompSystem {
  constructor({ player, enemies, onStomp = null }) { Object.assign(this, { player, enemies, onStomp }); this.reset(); }
  reset() { this.stomps = 0; }
  get hudState() { return { stomps: this.stomps }; }
  fixedUpdate() {
    const p = this.player;
    if (!p.alive || p.grounded || p.velocity.y >= 0) return;
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const top = e.position.y + (e.type.height ?? 1.2), feet = p.position.y;
      if (feet < e.position.y + (e.type.height ?? 1.2) * 0.45 || feet > top + 0.4) continue;
      if (Math.hypot(p.position.x - e.position.x, p.position.z - e.position.z) > e.type.radius + PLAYER.radius + STOMP.reach) continue;
      this.enemies.damage(e, 1e6, { stagger: true });
      p.velocity.y = PLAYER.jumpSpeed * STOMP.bounce;
      this.stomps++; this.onStomp?.(e);
      break;
    }
  }
}
