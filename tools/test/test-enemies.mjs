import assert from 'node:assert/strict';
import { Group, Vector3 } from 'three/webgpu';
import { RigidAnimator } from '../../src/anim/RigidBody.js';
import { makeGame, flatLevel } from './runtime-fixture.mjs';
import { EnemyState as S } from '../../src/sim/EnemyState.js';
import { ENEMY_TYPES, FIXED_STEP } from '../../src/config/gameplay.js';
import { makeHit, traceShot, HIT_KIND } from '../../src/weapons/WeaponRaycaster.js';

const spawn = (g, z = -5, extra = {}) => g.enemies.spawn('shambler', {
  position: { x: 0, z }, authored: true, ...extra });

// Valid nav, body radius, player distance, cap and deterministic spawn sequence.
{
  const a = makeGame(), b = makeGame();
  assert.equal(spawn(a, -1), null);
  assert.equal(spawn(a, -32), null);
  a.collision.addBoxBlocker('cover', 0, -5, 1, 1);
  assert.equal(spawn(a), null);
  a.collision.setBlockerActive('cover', false);
  const positions = g => Array.from({ length: g.enemies.maxAlive }, () => {
    const e = g.enemies.spawn('shambler');
    assert(e);
    assert(g.collision.isFree(e.position.x, e.position.z, e.type.radius));
    assert(e.position.distanceTo(g.player.position) >= 11);
    return e.position.toArray();
  });
  assert.deepEqual(positions(a), positions(b));
  assert.equal(a.enemies.spawn('shambler'), null);
  assert.throws(() => a.enemies.spawn('missing'), /Unknown enemy/);
  a.dispose(); b.dispose();
}

// Perception honors facing and walls, then pursues the last known position.
{
  const g = makeGame();
  const e = spawn(g, -8, { yaw: Math.PI });
  g.step();
  assert.equal(e.state, S.IDLE);
  e.yaw = 0;
  g.collision.addBoxBlocker('screen', 0, -4, 2, 0.5);
  g.step();
  assert.equal(e.state, S.IDLE);
  g.enemies.hear(g.player.position);
  const initial = e.position.clone();
  for (let i = 0; i < 180; i++) {
    g.step();
    assert(g.collision.isFree(e.position.x, e.position.z, e.type.radius));
  }
  assert(e.position.distanceTo(initial) > 2, 'routes around cover');
  assert(e.position.distanceTo(g.player.position) < initial.distanceTo(g.player.position));
  g.dispose();
}

// Windup must complete, damage happens once, a wall/dodge defeats the active window.
{
  const g = makeGame();
  const e = spawn(g, -3, { alerted: true });
  for (let i = 0; i < 180 && e.state !== S.ATTACK_WINDUP; i++) g.step();
  assert.equal(e.state, S.ATTACK_WINDUP);
  const hp = g.player.health;
  while (e.state === S.ATTACK_WINDUP) {
    assert.equal(g.player.health, hp);
    g.step();
  }
  assert.equal(g.player.health, hp - e.type.damage);
  while (e.state === S.ATTACK_ACTIVE) g.step();
  assert.equal(g.player.health, hp - e.type.damage);
  while (e.state !== S.ATTACK_WINDUP) g.step();
  g.player.position.x += 6;
  while (e.state === S.ATTACK_WINDUP) g.step();
  assert.equal(g.player.health, hp - e.type.damage, 'dodge cancels damage');
  g.dispose();
}

// Hitscan contract, head flag, no double headshot multiplier, collapse and cleanup.
{
  const events = [];
  const g = makeGame({ level: flatLevel(12), createEnemyVisual: () => ({ animator: {
    reset: () => {}, setDeathDirection: angle => events.push(['death', angle]),
    kickStagger: () => events.push(['stagger']), update: () => {} },
    dispose: () => events.push(['dispose']) }) });
  const e = spawn(g);
  const hit = traceShot(g.collision, g.enemies.enemies,
    new Vector3(0, 12 + e.type.height * 0.9, 0), new Vector3(0, 0, -1), 20, makeHit());
  assert.equal(hit.kind, HIT_KIND.ENEMY);
  assert.equal(hit.enemy, e);
  assert.equal(hit.head, true);
  g.enemies.damage(e, 30);
  assert.equal(e.health, ENEMY_TYPES.shambler.health - 30);
  assert.equal(e.state, S.STAGGER);
  g.enemies.damage(e, 100, { direction: new Vector3(0, 0, -1) });
  assert.equal(e.state, S.DEAD);
  assert.equal(g.hudState.kills, 1);
  assert.equal(g.enemies.damage(e, 100), false);
  assert.equal(g.hudState.kills, 1);
  assert.equal(events.filter(x => x[0] === 'death').length, 1);
  const hp = g.player.health;
  for (let i = 0; i < Math.ceil(e.type.corpseLinger / FIXED_STEP) + 1; i++) g.step();
  assert.equal(g.enemies.enemies.length, 0);
  assert.equal(g.player.health, hp);
  assert.equal(events.filter(x => x[0] === 'dispose').length, 1);
  g.dispose();
}

// Blast falloff, occlusion and no damage beyond the radius.
{
  const g = makeGame();
  const near = spawn(g, -5), far = spawn(g, -12);
  g.enemies.explode(new Vector3(0, 1, -4), 4, 30);
  assert(near.health < near.type.health);
  assert.equal(far.health, far.type.health);
  g.collision.addBoxBlocker('blast-cover', 0, -3, 2, 0.3);
  const hp = near.health;
  g.enemies.explode(new Vector3(0, 1, -1), 10, 1000);
  assert.equal(near.health, hp);
  g.dispose();
}

// Two enemies retain their own routes, and seeded replays remain byte-identical.
function replay() {
  const g = makeGame();
  const a = spawn(g, -10, { alerted: true });
  const b = g.enemies.spawn('runner', { position: { x: 8, z: -10 }, authored: true, alerted: true });
  g.step();
  assert.notEqual(a.path, b.path);
  const history = [];
  for (let i = 0; i < 300; i++) {
    g.step({ move: { x: i % 120 < 60 ? 1 : -1, y: 0 } });
    history.push(g.enemies.enemies.map(e => [e.id, e.position.toArray(), e.state, e.health]));
  }
  const result = JSON.stringify({ history, hud: g.hudState });
  g.dispose();
  return result;
}
assert.equal(replay(), replay());

// Exercise the real existing animation interface, including procedural death.
{
  const g = makeGame({ createEnemyVisual: e => {
    const root = new Group(), model = new Group(); root.add(model);
    return { root, animator: new RigidAnimator({ height: e.type.height, halfDepth: e.type.radius },
      model, e.type, e.seed), dispose: () => root.removeFromParent() };
  } });
  const e = spawn(g, -6, { alerted: true });
  for (let i = 0; i < 30; i++) { g.advance(FIXED_STEP); g.updateVisuals(FIXED_STEP); }
  g.enemies.damage(e, 10000);
  for (let i = 0; i < 30; i++) { g.advance(FIXED_STEP); g.updateVisuals(FIXED_STEP); }
  assert(Number.isFinite(e.visual.animator.model.position.y));
  assert(e.visual.animator.model.position.y < 0, 'existing death collapse moves the body');
  assert.equal(e.state, S.DEAD);
  g.dispose();
}
console.log('Enemy lifecycle, nav, perception, melee, hitscan, blast and replay passed');
