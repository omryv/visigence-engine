import { Vector3 } from 'three/webgpu';
import { ENEMY_TYPES, ENEMY_LIMITS, PLAYER } from '../config/gameplay.js';
import { EnemyState as S } from '../sim/EnemyState.js';
import { mulberry32 } from '../utils/math.js';
import { GrenadeSystem } from '../sim/GrenadeSystem.js';

/** Fixed-step behavior. Models/animators are optional observers, never AI inputs. */
export class EnemySystem {
  constructor({ collision, terrain, player, seed = 1, tier = 'balanced',
    createVisual = null, onDeath = null, types = ENEMY_TYPES }) {
    this.types = types;
    Object.assign(this, { collision, terrain, player, createVisual, onDeath });
    this.maxAlive = ENEMY_LIMITS.maxAliveByTier[tier] ?? ENEMY_LIMITS.maxAliveByTier.mobile;
    this.enemies = [];
    this.seed = seed;
    this.reset();
  }

  get aliveCount() { return this.enemies.reduce((n, e) => n + Number(e.alive), 0); }

  reset() {
    for (const e of this.enemies) e.visual?.dispose?.();
    this.enemies.length = 0;
    this.rng = mulberry32(this.seed);
    this.nextId = 1;
  }

  /** Explicit points are validated, never silently moved. Returns null if unavailable. */
  spawn(typeId, { position = null, authored = false, alerted = false, yaw = 0 } = {}) {
    const type = this.types[typeId];
    if (!type) throw new Error(`Unknown enemy type: ${typeId}`);
    if (this.aliveCount >= this.maxAlive) return null;
    const c = this.collision, player = this.player.position;
    let pathQueries = 0;
    const minDistance = authored ? ENEMY_LIMITS.authoredSpawnDistance : ENEMY_LIMITS.minSpawnDistance;
    const valid = (p) => Number.isFinite(p.x) && Number.isFinite(p.z)
      && Math.hypot(p.x - player.x, p.z - player.z) >= minDistance
      && c.isFree(p.x, p.z, type.radius)
      && !this.enemies.some(e => e.alive
        && Math.hypot(e.position.x - p.x, e.position.z - p.z) < e.type.radius + type.radius)
      && ++pathQueries <= ENEMY_LIMITS.spawnPathBudget
      && c.isReachable(p.x, p.z, player.x, player.z, type.radius / c.cell);
    if (position) {
      if (!valid(position)) return null;
    } else {
      // A seeded cyclic scan visits each nav cell at most once. No rejection loop.
      const start = Math.floor(this.rng() * c.walkable.length);
      for (let k = 0; k < c.walkable.length && pathQueries < ENEMY_LIMITS.spawnPathBudget; k++) {
        const idx = (start + k) % c.walkable.length;
        if (!c.walkable[idx]) continue;
        const p = { x: c.worldX(idx % c.n), z: c.worldZ(Math.floor(idx / c.n)) };
        if (valid(p)) { position = p; break; }
      }
      if (!position) return null;
    }
    const p = new Vector3(position.x, this.terrain.heightAt(position.x, position.z), position.z);
    const e = { id: this.nextId++, type, health: type.health, position: p,
      prevPosition: p.clone(), velocity: new Vector3(), yaw,
      state: S.IDLE, stateTime: 0, alive: true,
      aware: alerted ? ENEMY_LIMITS.alertedAwareSeconds : 0,
      deathTime: 0, dissolve: false, distToPlayer: p.distanceTo(player),
      target: player.clone(), cooldown: 0, repath: 0, path: [], pathIndex: 0,
      navVersion: -1, seed: Math.floor(this.rng() * 0x100000000), visual: null };
    e.visual = this.createVisual?.(e) ?? null;
    e.visual?.animator?.reset(e.seed);
    this.enemies.push(e);
    return e;
  }

  _state(e, state) { e.state = state; e.stateTime = 0; }

  /** Called by a gameplay noise source; stationary players are not automatically heard. */
  hear(position, radius = Infinity) {
    for (const e of this.enemies) {
      if (!e.alive || e.position.distanceTo(position) > Math.min(radius, e.type.hearingRange)) continue;
      e.aware = ENEMY_LIMITS.alertedAwareSeconds;
      e.target.copy(position);
      e.repath = 0;
    }
  }

  fixedUpdate(dt) {
    const player = this.player, c = this.collision;
    for (const e of this.enemies) {
      e.prevPosition.copy(e.position);
      e.velocity.set(0, 0, 0);
      e.stateTime += dt;
      e.distToPlayer = e.position.distanceTo(player.position);
      if (!e.alive) { e.deathTime += dt; continue; }
      const t = e.type;
      e.cooldown = Math.max(0, e.cooldown - dt);
      e.aware = Math.max(0, e.aware - dt);
      const dx = player.position.x - e.position.x, dz = player.position.z - e.position.z;
      const horizontal = Math.hypot(dx, dz);
      const los = player.alive && c.hasLineOfSight(e.position.x, e.position.z, player.position.x, player.position.z);
      const facing = horizontal < 1e-6 || (Math.sin(e.yaw) * dx + Math.cos(e.yaw) * dz) / horizontal
        >= Math.cos(t.sightHalfAngleDeg * Math.PI / 180);
      if (los && e.distToPlayer <= t.sightRange && (e.aware > 0 || facing)) {
        e.aware = ENEMY_LIMITS.alertedAwareSeconds;
        e.target.copy(player.position);
      }
      if (!player.alive) { e.aware = 0; this._state(e, S.IDLE); continue; }
      if (e.state === S.STAGGER) {
        if (e.stateTime >= t.staggerTime) this._state(e, S.IDLE);
        continue;
      }
      if (e.state === S.ATTACK_WINDUP) {
        if (e.stateTime >= t.attackWindup) {
          this._state(e, S.ATTACK_ACTIVE);
          // Exactly one damage test per swing, after windup. A dodge or wall can defeat it.
          if (los && e.distToPlayer <= t.attackReach) player.damage(t.damage, e.position);
        }
        continue;
      }
      if (e.state === S.ATTACK_ACTIVE) {
        if (e.stateTime >= t.attackActive) this._state(e, S.ATTACK_RECOVER);
        continue;
      }
      if (e.state === S.ATTACK_RECOVER) {
        if (e.stateTime >= t.attackRecovery) this._state(e, S.IDLE);
        continue;
      }
      if (!e.aware) { if (e.state !== S.IDLE) this._state(e, S.IDLE); continue; }
      if (los && e.distToPlayer <= t.attackRange) {
        if (e.cooldown === 0) {
          this._state(e, S.ATTACK_WINDUP);
          e.cooldown = t.attackCooldown;
        }
        continue;
      }
      if (e.state !== S.CHASE) this._state(e, S.CHASE);
      e.repath -= dt;
      if (e.repath <= 0 || e.navVersion !== c.navigationVersion) {
        // CollisionSystem owns scratch storage: keep an independent path per enemy.
        e.path = (c.findPath(e.position.x, e.position.z, e.target.x, e.target.z,
          t.radius / c.cell, { bestEffort: true }) ?? []).map(p => ({ ...p }));
        e.pathIndex = 0;
        // The first node is a cell center behind the moving body after a repath.
        // Skip it only if the next segment clears the actual body's radius.
        if (e.path.length > 1 && c.canTravel(e.position.x, e.position.z,
          e.path[1].x, e.path[1].z, t.radius)) e.pathIndex = 1;
        e.navVersion = c.navigationVersion;
        e.repath = e.distToPlayer > ENEMY_LIMITS.pathLodDistance
          ? ENEMY_LIMITS.repathIntervalFar : ENEMY_LIMITS.repathInterval;
      }
      const stride = t.chaseSpeed * dt;
      let waypoint = e.path[e.pathIndex];
      while (waypoint && Math.hypot(waypoint.x - e.position.x, waypoint.z - e.position.z) <= stride) {
        waypoint = e.path[++e.pathIndex];
      }
      if (!waypoint) continue;
      const wx = waypoint.x - e.position.x, wz = waypoint.z - e.position.z;
      const length = Math.hypot(wx, wz);
      let mx = wx / length * stride, mz = wz / length * stride;
      // Resolve nearby bodies in stable spawn order; corpses never participate.
      for (const other of this.enemies) {
        if (other === e || !other.alive) continue;
        const sx = e.position.x - other.position.x, sz = e.position.z - other.position.z;
        const d = Math.hypot(sx, sz), gap = t.radius + other.type.radius;
        if (d < gap && d > 1e-6) {
          const push = Math.min(gap - d, ENEMY_LIMITS.separationStrength * dt);
          mx += sx / d * push; mz += sz / d * push;
        }
      }
      const out = {};
      c.moveDisc(e.position.x, e.position.z, mx, mz, t.radius, out);
      if (Math.hypot(out.x - player.position.x, out.z - player.position.z) >= t.radius + PLAYER.radius) {
        e.position.set(out.x, this.terrain.heightAt(out.x, out.z), out.z);
      }
      e.velocity.copy(e.position).sub(e.prevPosition).divideScalar(dt);
      const desired = Math.atan2(wx, wz);
      const turn = Math.atan2(Math.sin(desired - e.yaw), Math.cos(desired - e.yaw));
      e.yaw += Math.max(-t.turnRate * dt, Math.min(t.turnRate * dt, turn));
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive && e.deathTime >= e.type.corpseLinger) {
        e.visual?.dispose?.();
        this.enemies.splice(i, 1);
      }
    }
  }

  /** WeaponController already applies headshot/falloff. Never multiply them again. */
  damage(e, amount, { direction = null, stagger = true } = {}) {
    if (!this.enemies.includes(e) || !e.alive || !Number.isFinite(amount) || amount <= 0) return false;
    e.health = Math.max(0, e.health - amount);
    e.aware = ENEMY_LIMITS.alertedAwareSeconds;
    e.target.copy(this.player.position);
    if (e.health === 0) {
      e.alive = false;
      e.velocity.set(0, 0, 0);
      e.path = [];
      this._state(e, S.DEAD);
      e.visual?.animator?.setDeathDirection(direction ? Math.atan2(direction.x, direction.z) : e.yaw);
      this.onDeath?.(e);
    } else if (stagger) {
      this._state(e, S.STAGGER);
      e.visual?.animator?.kickStagger(1);
    }
    return true;
  }

  /** Shared grenade/rocket damage callback, with distance falloff and cover rejection. */
  explode(position, radius, damage) {
    if (!(radius > 0) || !Number.isFinite(radius)) return;
    this.hear(position);
    GrenadeSystem.radialDamage(position, radius, damage, this.collision, this.enemies,
      (e, amount) => this.damage(e, amount, { direction: e.position.clone().sub(position) }));
  }

  updateVisuals(dt, alpha = 1) {
    for (const e of this.enemies) {
      const v = e.visual;
      if (v?.root) {
        v.root.position.lerpVectors(e.prevPosition, e.position, alpha);
        v.root.rotation.y = e.yaw;
      }
      v?.animator?.update(dt, e, this.player.position);
      v?.updateReadability?.();
    }
  }

  dispose() { this.reset(); }
}
