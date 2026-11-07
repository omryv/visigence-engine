import { relativeBearing } from './SpatialFeedback.js';

/**
 * A next-turn cue from the existing collision pathfinder. Never points through a wall.
 * Owns its cached path: enemy pathfinding may reuse CollisionSystem's scratch storage.
 */
export class ExtractionGuidance {
  constructor(collision, radius) {
    this.collision = collision;
    this.radius = radius;
    this.reset();
  }

  reset() {
    this.path = null;
    this.key = '';
    this.version = -1;
    this.cooldown = 0;
    this.lastX = Infinity;
    this.lastZ = Infinity;
    this.readout = { angle: 0, distance: 0, remaining: 0, label: '', available: false };
  }

  update(dt, player, target) {
    if (!target || !player.alive) {
      if (this.key) this.reset();
      return null;
    }
    const c = this.collision, p = player.position;
    const key = target.x + ':' + target.z;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const changed = key !== this.key || c.navigationVersion !== this.version;
    const moved = Math.hypot(p.x - this.lastX, p.z - this.lastZ) > 0.4;
    if (changed || (this.cooldown === 0 && moved)) {
      this.key = key;
      this.version = c.navigationVersion;
      this.lastX = p.x; this.lastZ = p.z;
      this.cooldown = 0.25;
      const route = c.findPath(p.x, p.z, target.x, target.z, Math.max(1, Math.ceil(this.radius / c.cell) + 1));
      // A body can stand between navigation-cell centres. Keep a still-valid route
      // when only the start cell loses clearance; blocker changes always discard it.
      this.path = route ? route.map(point => ({ x: point.x, z: point.z })) : changed ? null : this.path;
    }

    const out = this.readout;
    out.available = false;
    out.label = 'MOVE INTO THE CORRIDOR TO FIND THE EXIT ROUTE';
    if (!this.path?.length) return out;

    // The final point may have been snapped by the pathfinder. Only advertise a segment
    // after testing it against the actual player radius, including newly closed blockers.
    let next = -1;
    for (let i = 0; i < this.path.length; i++) {
      const point = this.path[i];
      const distance = Math.hypot(point.x - p.x, point.z - p.z);
      if (!c.canTravel(p.x, p.z, point.x, point.z, this.radius)) continue;
      next = i;
      if (distance >= 3) break;
    }
    if (next < 0) return out;
    const point = this.path[next];
    out.distance = Math.hypot(point.x - p.x, point.z - p.z);
    out.remaining = out.distance;
    for (let i = next + 1; i < this.path.length; i++) {
      out.remaining += Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].z - this.path[i - 1].z);
    }
    out.available = out.distance > 0.01;
    out.angle = relativeBearing(point.x - p.x, point.z - p.z, player.yaw + (player.aimRecoilYaw || 0));
    out.label = next === this.path.length - 1 ? 'EXTRACTION' : 'NEXT TURN';
    if (!out.available) out.label = 'FOLLOW THE OPEN CORRIDOR';
    return out;
  }
}
