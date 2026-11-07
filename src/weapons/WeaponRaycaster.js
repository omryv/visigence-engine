/**
 * Hitscan: the AIM ray, spread, and what it hits.
 *
 * Two rays, two jobs. The AIM ray starts at the player's simulated eye and runs along the
 * aim direction (look + gameplay recoil); it decides what is hit. The MUZZLE ray is purely
 * visual - tracers start at the muzzle socket and run to the point the aim ray hit - so
 * a shot never appears to miss the crosshair at close range.
 *
 * COLLISION LAYERS. The shot is never a scene-graph raycast: it tests the level's grid
 * (WORLD), the live enemy capsules (ENEMY) and the floor plane, in that order of distance.
 * The first-person hands and weapon live in a separate scene that this code never sees,
 * so they cannot be shot by construction; helpers, HUD and particles are not in any of
 * the three sets.
 *
 * SPREAD is a function of state - hip/ADS base, movement, airborne, crouch, sustained fire -
 * and the pellet pattern inside the cone is a fixed sunflower rotated by the shot counter:
 * bounded, reproducible, still visibly different from shot to shot.
 */

import { Vector3, MathUtils } from 'three/webgpu';
import { clamp } from '../utils/math.js';
import { terrainRay } from '../sim/terrainRay.js';

export const HIT_KIND = { NONE: 'none', WORLD: 'world', FLOOR: 'floor', ENEMY: 'enemy' };

/** Surface classes, for impact effects and audio. */
export const SURFACE = {
  CONCRETE: 'concrete', FLOOR: 'floor', WOOD: 'wood', METAL: 'metal', GLASS: 'glass', ENEMY: 'enemy', NONE: 'none',
};

const _up = new Vector3();
const _right = new Vector3();
const _trueUp = new Vector3();
const _ray = { hit: false, x: 0, z: 0, dist: 0, normalX: 0, normalZ: 0, blocker: null };

/**
 * Spread half-angle in degrees for the current state.
 * @param {object} spread   WEAPONS[*].spread
 * @param {{adsBlend:number, speedFraction:number, grounded:boolean, crouchBlend:number}} ctx
 * @param {number} sustained  current sustained-fire bloom, degrees
 */
export function spreadDegrees(spread, ctx, sustained) {
  const base = MathUtils.lerp(spread.hip, spread.ads, ctx.adsBlend);
  const move = spread.moving * clamp(ctx.speedFraction / 0.66, 0, 1) * (1 - ctx.adsBlend * 0.5);
  const air = ctx.grounded ? 0 : spread.airborne;
  const crouch = spread.crouch * ctx.crouchBlend;
  return Math.max(0.05, base + move + air + crouch + sustained);
}

/**
 * DETERMINISTIC spread. Pellets sit on a fixed sunflower pattern inside the spread cone;
 * the whole pattern is rotated by an angle derived from the shot counter. Same shot number
 * always produces the same pattern, so tests are stable, but consecutive shots still differ.
 */
export function pelletDirection(out, aim, spreadDeg, index, pellets, shotCounter) {
  out.copy(aim);
  if (pellets === 1 && spreadDeg <= 0.001) return out;
  const spread = MathUtils.degToRad(spreadDeg);
  let r, theta;
  if (pellets === 1) {
    // Single-projectile weapons: a deterministic, area-uniform low-discrepancy sequence
    // over the cone (radius sqrt(frac(n*phi)), golden-angle rotation), so consecutive
    // rounds land near the centre as often as near the edge and never repeat visibly.
    const u = (shotCounter * 0.6180339887) % 1;
    r = spread * Math.sqrt(u);
    theta = shotCounter * 2.39996;
  } else {
    r = spread * Math.sqrt((index + 0.5) / pellets);
    theta = index * 2.39996 + shotCounter * 0.7;
  }
  const up = Math.abs(aim.y) > 0.95 ? _up.set(1, 0, 0) : _up.set(0, 1, 0);
  _right.crossVectors(aim, up).normalize();
  _trueUp.crossVectors(_right, aim).normalize();
  out.addScaledVector(_right, Math.cos(theta) * Math.tan(r));
  out.addScaledVector(_trueUp, Math.sin(theta) * Math.tan(r));
  return out.normalize();
}

/**
 * Hit result, reused by the caller. `surface` is classified here so effects and audio
 * never need to know what a blocker id means.
 */
export function makeHit() {
  return {
    kind: HIT_KIND.NONE, dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
    blocker: null, enemy: null, head: false, surface: SURFACE.NONE,
  };
}

export function classifySurface(hit) {
  if (hit.kind === HIT_KIND.ENEMY) return SURFACE.ENEMY;
  if (hit.kind === HIT_KIND.FLOOR) return SURFACE.FLOOR;
  if (hit.kind !== HIT_KIND.WORLD) return SURFACE.NONE;
  if (hit.blocker?.surface) return hit.blocker.surface;
  const id = hit.blocker?.id || '';
  if (id.startsWith('crate:')) return SURFACE.WOOD;
  if (id === 'controlStation') return SURFACE.METAL;
  return SURFACE.CONCRETE;
}

/**
 * Trace one projectile. Enemies are tested against a capsule, the world against the grid,
 * the floor against baked terrain (legacy fallback y = 0); the nearest wins, so an enemy cannot be shot through a wall.
 *
 * @param {import('../sim/CollisionSystem.js').CollisionSystem} collision
 * @param {Array} enemies   live enemy list (may be empty)
 * @param {Vector3} origin
 * @param {Vector3} dir     unit
 * @param {number} range
 * @param {object} out      from makeHit()
 * @param {number} minEnemyDistance  hitscan eye clearance; zero for swept projectiles
 */
export function traceShot(collision, enemies, origin, dir, range, out, minEnemyDistance = 0.25) {
  // 1. world distance along this ray (the XZ grid raycast measures horizontal distance)
  _ray.normalY = 0;
  if(collision.raycastProjectile)collision.raycastProjectile(origin,dir,range,_ray);
  else collision.raycastXZ(origin.x, origin.z, dir.x, dir.z, range, _ray);
  let worldDist = _ray.hit ? _ray.dist : range;
  const horiz = Math.hypot(dir.x, dir.z);
  if (!collision.raycastProjectile && horiz > 1e-4) worldDist = worldDist / horiz;
  let kind = _ray.hit ? HIT_KIND.WORLD : HIT_KIND.NONE;
  let nx = _ray.normalX, ny = _ray.normalY || 0, nz = _ray.normalZ;
  let blocker = _ray.blocker;

  // Generated worlds use their baked ground. Legacy callers retain the flat floor.
  if (collision.terrain?.field) {
    const groundDist = terrainRay(collision.terrain, origin, dir, worldDist);
    if (groundDist !== null && groundDist <= worldDist) {
      worldDist = groundDist; kind = HIT_KIND.FLOOR; blocker = null;
      collision.terrain.normalAt(origin.x + dir.x * groundDist, origin.z + dir.z * groundDist, _up);
      nx = _up.x; ny = _up.y; nz = _up.z;
    }
  } else if (dir.y < -1e-4) {
    const floorDist = origin.y / -dir.y;
    if (floorDist < worldDist) {
      worldDist = floorDist; kind = HIT_KIND.FLOOR;
      nx = 0; ny = 1; nz = 0; blocker = null;
    }
  }
  if (worldDist > range) { worldDist = range; kind = HIT_KIND.NONE; }

  // 2. nearest enemy along the ray, closer than the wall
  let best = null, bestT = worldDist;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.alive) continue;
    const t = raySphereCapsule(origin, dir, e.position, e.type.radius * 1.05, e.type.height);
    if (t !== null && t >= minEnemyDistance && t < bestT) { bestT = t; best = e; }
  }

  out.dist = bestT;
  out.x = origin.x + dir.x * bestT;
  out.y = origin.y + dir.y * bestT;
  out.z = origin.z + dir.z * bestT;
  out.enemy = best;
  out.blocker = best ? null : blocker;
  if (best) {
    out.kind = HIT_KIND.ENEMY;
    out.nx = -dir.x; out.ny = -dir.y; out.nz = -dir.z;
    // Headshot: the top ~22% of the capsule.
    out.head = out.y >= best.position.y + best.type.height * 0.78;
  } else {
    out.kind = kind;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.head = false;
    if (kind === HIT_KIND.FLOOR && !collision.terrain?.field) out.y = Math.max(0.01, out.y);
  }
  out.surface = classifySurface(out);
  return out;
}

/**
 * Ray vs a vertical capsule approximated as a vertical cylinder with flat caps.
 * Returns the near hit distance or null. Cheap enough to run against every live enemy
 * for every pellet (9 pellets x ~20 enemies = 180 tests per blast shot).
 */
export function raySphereCapsule(origin, dir, base, radius, height) {
  const ox = origin.x - base.x, oz = origin.z - base.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-8) {
    if (ox * ox + oz * oz > radius * radius) return null;
    const t = dir.y > 0 ? (base.y + height - origin.y) / dir.y : (base.y - origin.y) / dir.y;
    return t > 0 ? t : null;
  }
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0) return null;
  const y = origin.y + dir.y * t;
  if (y >= base.y && y <= base.y + height) return t;
  const capY = y < base.y ? base.y : base.y + height;
  if (Math.abs(dir.y) < 1e-6) return null;
  const tc = (capY - origin.y) / dir.y;
  if (tc < 0) return null;
  const cx = origin.x + dir.x * tc - base.x;
  const cz = origin.z + dir.z * tc - base.z;
  return (cx * cx + cz * cz <= radius * radius) ? tc : null;
}
