import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';

/**
 * WILDLIFE: friendly generated creatures that live in the world whatever the genre - the "procedural
 * friends" half of the creature grammar. Each one is a unique individual (world/creatureGrammar.js,
 * role 'friendly') placed by blue-noise dart throwing, and each runs a small seeded brain:
 *
 *   rest -> wander to a free spot near home -> rest ...   and   flee when the player comes close.
 *
 * Wildlife is presentation, not simulation: it registers no collider, deals and takes no damage and
 * never enters the fixed-step game state, so it cannot change a mission's outcome or a replay. It does
 * respect the world's collision (it walks around cover, never through it) and it drives the same
 * RigidAnimator the critter enemies use, through an agent that looks like an enemy to it.
 */

const IDLE = 'IDLE';

export class Wildlife {
  /**
   * @param {object} o
   * @param {number} o.count
   * @param {string|number} o.seed          project seed
   * @param {string[]} o.families
   * @param {{isFree(x: number, z: number, r: number): boolean}} o.collision
   * @param {{x: number, z: number}[]} [o.avoid]   spawn point, objective sites: keep clear of them
   * @param {number} [o.bounds]             half-size of the square the animals live in
   * @param {{x: number, z: number, r: number}[]} [o.zones]  clearings the world layout set aside; homes go there first
   * @param {(spec: {family: string, key: string, index: number}) => {root: import('three').Object3D, animator: object, radius: number} | null} [o.makeVisual]
   * @param {{heightAt(x: number, z: number): number}} [o.terrain]  the ground (sim/Terrain.js): the animals walk on it
   *   (the nav grid behind `collision.isFree` already keeps them out of deep water and off steep banks)
   */
  constructor({ count, seed, families, collision, avoid = [], bounds = 30, zones = [], homes = [], keepers = [], makeVisual = null, terrain = null }) {
    Object.assign(this, { collision, bounds, makeVisual, terrain });
    this.rng = mulberry32(hashSeed(`${seed}|wildlife`));
    this.agents = [];
    const spots = [];
    for (let i = 0, tries = 0; i < count && tries < count * 60; tries++) {
      const family = families[i % families.length];
      // A home a route node set aside for this family first (world/routeGraph.js `life`: bees at the orchard),
      // then a clearing (the world layout's wildlife zones, in turn), then the open meadow.
      const mine = homes.filter(h => h.families.includes(family));
      const home = mine.length && tries < count * 15 ? mine[tries % mine.length] : null;
      const zone = home ?? (zones.length && tries < count * 30 ? zones[tries % zones.length] : null);
      const x = zone ? zone.x + (this.rng() * 2 - 1) * zone.r * 0.8 : (this.rng() * 2 - 1) * bounds;
      const z = zone ? zone.z + (this.rng() * 2 - 1) * zone.r * 0.8 : (this.rng() * 2 - 1) * bounds;
      // blue noise: far from the mission's places, from each other, and on free ground
      if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < 6)) continue;
      if (spots.some(s => Math.hypot(s.x - x, s.z - z) < (zone ? 2.5 : 5))) continue;
      if (!collision.isFree(x, z, 0.8)) continue;
      spots.push({ x, z });
      const key = `${seed}|wild|${i}`;
      const visual = makeVisual?.({ family, key, index: i }) ?? null;
      const radius = visual?.radius ?? 0.45;
      this.agents.push({
        family, key, visual, radius, home: { x, z }, homed: !!home,
        position: { x, y: terrain?.heightAt(x, z) ?? 0, z }, velocity: { x: 0, y: 0, z: 0 }, yaw: this.rng() * Math.PI * 2,
        alive: true, state: IDLE, stateTime: 0, mode: 'rest', timer: 0.5 + this.rng() * 3, target: null,
        pace: 0.55 + this.rng() * 0.5, fled: 0,
      });
      i++;
    }
    // Keepers: a stallholder behind each counter and a water-carrier at the well, standing their ground (they
    // neither wander nor flee); skipped when their post is not free ground.
    for (const [i, k] of keepers.entries()) {
      if (!collision.isFree(k.x, k.z, 0.5) || avoid.some(a => Math.hypot(a.x - k.x, a.z - k.z) < 3)) continue;
      const key = `${seed}|keeper|${i}`, visual = makeVisual?.({ family: k.family, key, index: count + i }) ?? null;
      this.agents.push({
        family: k.family, key, visual, radius: visual?.radius ?? 0.45, home: { x: k.x, z: k.z }, keeper: true,
        position: { x: k.x, y: terrain?.heightAt(k.x, k.z) ?? 0, z: k.z }, velocity: { x: 0, y: 0, z: 0 }, yaw: k.yaw ?? 0,
        alive: true, state: IDLE, stateTime: 0, mode: 'keep', timer: 0, target: null, pace: 0, fled: 0,
      });
    }
    for (const a of this.agents) this._sync(a, 0, null);
  }

  /** The agents on duty at a landmark (the stallholders and the water-carrier). */
  get keepers() { return this.agents.filter(a => a.keeper); }

  /** A free spot within `radius` of `from`, or null after a few tries. */
  _pick(a, from, radius) {
    for (let k = 0; k < 8; k++) {
      const ang = this.rng() * Math.PI * 2, d = radius * (0.35 + 0.65 * this.rng());
      const x = Math.max(-this.bounds, Math.min(this.bounds, from.x + Math.cos(ang) * d));
      const z = Math.max(-this.bounds, Math.min(this.bounds, from.z + Math.sin(ang) * d));
      if (this.collision.isFree(x, z, a.radius)) return { x, z };
    }
    return null;
  }

  update(dt, player) {
    if (!(dt > 0)) { for (const a of this.agents) this._sync(a, 0, player); return; }
    for (const a of this.agents) {
      a.stateTime += dt; a.timer -= dt;
      if (a.keeper) { this._sync(a, dt, player); continue; }
      const px = player ? player.x - a.position.x : Infinity, pz = player ? player.z - a.position.z : Infinity;
      const near = Math.hypot(px, pz);
      // Shy: a friend that sees the player close up scurries away for a moment.
      if (near < 3.2 && a.mode !== 'flee') {
        const away = { x: a.position.x - px / near * 5, z: a.position.z - pz / near * 5 };
        a.mode = 'flee'; a.timer = 1.6; a.target = this.collision.isFree(away.x, away.z, a.radius) ? away : this._pick(a, a.position, 4);
      }
      if (a.mode === 'rest') {
        a.velocity.x = a.velocity.z = 0;
        if (a.timer <= 0) { a.target = this._pick(a, a.home, 6); a.mode = a.target ? 'wander' : 'rest'; a.timer = a.target ? 12 : 1; }
      } else {
        const speed = a.mode === 'flee' ? 2.2 : 0.9 * a.pace;
        const t = a.target, dx = t ? t.x - a.position.x : 0, dz = t ? t.z - a.position.z : 0, dist = Math.hypot(dx, dz);
        if (!t || dist < 0.3 || a.timer <= 0) {
          a.mode = 'rest'; a.timer = 1.2 + this.rng() * 3.5; a.velocity.x = a.velocity.z = 0;
        } else {
          const step = Math.min(dist, speed * dt), nx = a.position.x + dx / dist * step, nz = a.position.z + dz / dist * step;
          if (this.collision.isFree(nx, nz, a.radius)) {
            a.velocity.x = (nx - a.position.x) / dt; a.velocity.z = (nz - a.position.z) / dt;
            a.position.x = nx; a.position.z = nz;
            if (this.terrain) a.position.y = this.terrain.heightAt(nx, nz);
            const desired = Math.atan2(dx, dz), turn = Math.atan2(Math.sin(desired - a.yaw), Math.cos(desired - a.yaw));
            a.yaw += Math.sign(turn) * Math.min(Math.abs(turn), 5 * dt);
          } else { a.mode = 'rest'; a.timer = 0.6; a.velocity.x = a.velocity.z = 0; }
        }
      }
      this._sync(a, dt, player);
    }
  }

  _sync(a, dt, player) {
    const v = a.visual;
    if (!v) return;
    v.root.position.set(a.position.x, a.position.y, a.position.z);
    v.root.rotation.y = a.yaw;
    v.animator?.update(dt, a, player ?? a.position);
  }

  dispose() { for (const a of this.agents) a.visual?.dispose?.(); this.agents = []; }
}
