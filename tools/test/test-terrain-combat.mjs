import assert from 'node:assert/strict';
import { Group, Scene, Vector3 } from 'three/webgpu';
import { Terrain } from '../../src/sim/Terrain.js';
import { terrainRay } from '../../src/sim/terrainRay.js';
import { GrenadeSystem } from '../../src/sim/GrenadeSystem.js';
import { RocketSystem } from '../../src/weapons/RocketSystem.js';
import { makeHit, traceShot, HIT_KIND } from '../../src/weapons/WeaponRaycaster.js';
import { GRENADE, FIXED_STEP } from '../../src/config/gameplay.js';
import { makeGame, flatLevel } from './runtime-fixture.mjs';

// A bilinear saddle can intersect twice inside one cell despite both endpoints being
// above ground. The nearest quadratic root must win, including reversed ray direction.
{
  const terrain = new Terrain({ size: 10, res: 2, min: 0, max: 10,
    data: new Float32Array([0, 10, 10, 0]) });
  const dir = new Vector3(1, 0, 1).normalize();
  const hit = terrainRay(terrain, new Vector3(-5, 4, -5), dir, 14);
  const u = (1 - Math.sqrt(0.2)) / 2;
  assert(Math.abs(hit - u * 10 * Math.SQRT2) < 0.02);
  assert.equal(terrainRay(terrain, new Vector3(-5, 6, -5), dir, 14), null);
  assert.equal(terrainRay(terrain, new Vector3(-5, 4, -5), dir, 1), null);
  const reverse = terrainRay(terrain, new Vector3(4, 4, 4), dir.clone().negate(), 14);
  assert(reverse > 0 && reverse < 4);
}

for (const height of [12, -12, 0]) {
  const g = makeGame({ level: flatLevel(height) });
  const origin = new Vector3(0, height + 2, 0), down = new Vector3(0, -1, 0);
  const hit = traceShot(g.collision, [], origin, down, 10, makeHit());
  assert.equal(hit.kind, HIT_KIND.FLOOR);
  assert(Math.abs(hit.y - height) < 1e-6);
  assert(Math.abs(hit.dist - 2) < 1e-6);
  assert.equal(traceShot(g.collision, [], origin, down, 1, makeHit()).kind, HIT_KIND.NONE);
  assert.equal(traceShot(g.collision, [], origin, new Vector3(0, 1, 0), 10, makeHit()).kind, HIT_KIND.NONE);
  g.dispose();
}

// Cover uses finite projectile geometry, and opening it updates both collision uses.
{
  const level = flatLevel(6);
  level.placements = [{ id: 'crate', x: 0, y: 6, z: -4, height: 1, collision: 'box', halfX: 1, halfZ: 1 }];
  const g = makeGame({ level });
  const dir = new Vector3(0, 0, -1);
  const low = () => traceShot(g.collision, [], new Vector3(0, 6.5, 0), dir, 10, makeHit());
  assert.equal(low().kind, HIT_KIND.WORLD);
  assert.equal(traceShot(g.collision, [], new Vector3(0, 8, 0), dir, 10, makeHit()).kind, HIT_KIND.NONE);
  g.collision.setBlockerActive('prop:0:crate', false);
  assert.equal(low().kind, HIT_KIND.NONE);
  g.dispose();
}

// Real pooled projectiles are updated by Game and share the enemy damage callback.
for (const height of [12, -12]) {
  const scene = new Scene(), blasts = [];
  const vfx = { explosion: (...args) => blasts.push(args), pulseLight() {}, smoke: { spawn() {} } };
  const g = makeGame({ level: flatLevel(height), createSystems: game => {
    const dependencies = { scene, camera: game.camera, collision: game.collision, player: game.player, vfx };
    const grenades = new GrenadeSystem(dependencies);
    grenades.build({ get: () => ({ gltf: { scene: new Group() } }) }, scene);
    return { grenades, rockets: new RocketSystem(dependencies) };
  } });
  const enemy = g.enemies.spawn('shambler', { position: { x: 0, z: -4 }, authored: true });
  // A short fuse on a real pool slot isolates ground contact/explosion from throw pose.
  const slot = g.grenades.pool[0];
  slot.live = true; slot.fuse = 0.15; slot.pos.set(0, height + 0.1, -4);
  slot.vel.set(0, -1, 0);
  for (let i = 0; i < 12; i++) g.step();
  assert.equal(slot.live, false);
  assert(blasts.length > 0);
  assert(blasts[0][1] >= height + GRENADE.radius - 1e-6);
  assert(enemy.health < enemy.type.health);
  // An impact rocket must hit elevated/below-sea-level ground within its swept step.
  assert(g.rockets.launch(new Vector3(5, height + 1, 5), new Vector3(0, -1, 0)));
  for (let i = 0; i < 60 && g.rockets.pool.some(p => p.live); i++) g.step();
  assert(g.rockets.pool.every(p => !p.live));
  assert(g.rockets.hit.kind === HIT_KIND.FLOOR);
  g.restart();
  assert.equal(g.grenades.liveCount, 0);
  assert.equal(g.rockets.pool.some(p => p.live), false);
  g.dispose();
  assert.equal(scene.children.length, 0, 'owned projectile roots are detached');
}

// The public blast helper rejects dynamic cover and invalid radius without NaNs.
{
  const g = makeGame();
  const enemy = g.enemies.spawn('shambler', { position: { x: 0, z: -4 }, authored: true });
  g.collision.addBoxBlocker('cover', 0, -2, 2, 0.25);
  const damages = [];
  GrenadeSystem.radialDamage(new Vector3(0, 1, 0), 10, 100, g.collision, [enemy], (_, d) => damages.push(d));
  assert.equal(damages.length, 0);
  g.collision.setBlockerActive('cover', false);
  GrenadeSystem.radialDamage(new Vector3(0, 1, 0), 10, 100, g.collision, [enemy], (_, d) => damages.push(d));
  assert(damages[0] > 0 && damages[0] < 100);
  GrenadeSystem.radialDamage(enemy.position, 0, 100, g.collision, [enemy], () => assert.fail('zero-radius blast'));
  g.dispose();
}
console.log('Terrain rays, elevated/below-sea-level projectiles, blast cover and pool lifecycle passed');
