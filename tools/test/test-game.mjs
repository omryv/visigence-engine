import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Game } from '../../src/game/Game.js';
import { State } from '../../src/sim/GameState.js';
import { FIXED_STEP, MAX_SUBSTEPS } from '../../src/config/gameplay.js';
import { Interactable } from '../../src/interaction/Interactable.js';
import { resolvePack } from '../../src/world/pack.js';
import { flatLevel, makeGame } from './runtime-fixture.mjs';

// Exact per-tick replay is invariant under different render frame grouping.
const input = tick => ({ move: { x: tick < 60 ? 1 : -1, y: 0.2 }, look: { x: 0.001, y: 0 } });
const a = makeGame(), b = makeGame();
for (let i = 0; i < 120; i++) a.advance(FIXED_STEP, input);
for (let i = 0; i < 240; i++) b.advance(FIXED_STEP / 2, input);
assert.equal(a.tick, 120); assert.equal(b.tick, 120);
assert.deepEqual(a.player.position, b.player.position);
assert.deepEqual(a.hudState, b.hudState);
a.pause();
const paused = a.player.position.clone();
assert.equal(a.advance(10, input), 0);
assert.deepEqual(a.player.position, paused);
a.resume();
assert.equal(a.advance(10, input), MAX_SUBSTEPS);
assert.throws(() => a.advance(NaN), /Invalid frame/);
a.player.damage(100000);
a.step();
assert.equal(a.state.current, State.PLAYER_DEAD);
assert.equal(a.step(), false);
a.restart();
assert.equal(a.tick, 0); assert.equal(a.state.current, State.PLAYING);
assert.equal(a.player.alive, true);
a.dispose(); a.dispose(); b.dispose();
assert.equal(a.step(), false);

// Existing offline output is accepted directly, including elevated ground and props.
{
  const level = flatLevel(9);
  const baked = { ...level.grid, SPEC: level.spec, SPAWN: level.spawn,
    HEIGHT_RES: 2, HEIGHT_PACKED: Buffer.from(level.terrain.field.data.buffer).toString('base64'),
    PLACEMENTS: [{ id: 'crate', x: 5, y: 9, z: 5, collision: 'box', halfX: 2, halfZ: 0.5,
      yaw: Math.PI / 2, height: 1 }] };
  const g = Game.fromBaked(baked);
  assert.equal(g.state.current, State.TITLE);
  assert.equal(g.player.position.y, 9);
  assert.equal(g.collision.isFree(5, 6.5, 0.1), false);
  assert.equal(g.collision.isFree(6.5, 5, 0.1), true);
  g.dispose();
}

// Runtime creates a real generated Arcade world, using the existing pack resolver.
{
  const manifest = JSON.parse(fs.readFileSync('packs/arcade/pack.json', 'utf8'));
  const spec = { ...JSON.parse(fs.readFileSync('specs/default.build.json', 'utf8')), pack: 'arcade' };
  const g = Game.fromSpec(spec, { pack: resolvePack(manifest) });
  assert.equal(g.level.spec.pack, 'arcade');
  assert.equal(g.level.placements.filter(p => p.objectiveIndex !== undefined).length, 3);
  assert(g.collision.isFree(g.player.position.x, g.player.position.z, 0.36));
  assert(g.enemies.spawn('shambler'));
  g.start(); g.step(); g.dispose();
  assert.throws(() => Game.fromSpec(spec), /Load and resolve pack/);
}

// Factories share runtime dependencies; simulation order, damage wiring and lifecycle.
{
  const calls = [];
  let weapon, grenade, rocket;
  const g = makeGame({ createSystems: game => ({
    weapons: weapon = { shotsFired: 0, setEnemyProvider(fn) { this.provider = fn; },
      fixedUpdate() { calls.push('weapons'); }, cancelPending() { calls.push('cancel'); },
      dispose() { calls.push('dispose-weapon'); } },
    grenades: grenade = { fixedUpdate() { calls.push('grenades'); } },
    rockets: rocket = { fixedUpdate(dt, enemies) { assert.equal(enemies, game.enemies.enemies); calls.push('rockets'); } },
    objectives: { complete: false, fixedUpdate() { calls.push('objectives'); } },
  }) });
  calls.length = 0;
  g.step();
  assert.deepEqual(calls, ['weapons', 'grenades', 'rockets', 'objectives']);
  const e = g.enemies.spawn('shambler', { position: { x: 0, z: -4 }, authored: true });
  assert.equal(weapon.provider()[0], e);
  weapon.onEnemyHit(e, 10, true, 1, null, false);
  assert.equal(e.health, 90, 'weapon damage is already headshot-adjusted');
  const center = e.position.clone(); center.y += e.type.height * 0.5;
  grenade.onExplode(center, 4, 10);
  rocket.onExplode(center, 4, 10);
  assert.equal(e.health, 70);
  g.pause(); assert(calls.includes('cancel'));
  g.resume(); g.objectives.complete = true; g.step();
  assert.equal(g.state.current, State.VICTORY);
  g.dispose(); assert(calls.includes('dispose-weapon'));
}

// Interaction columns follow terrain elevation, while legacy flat anchors still work.
for (const height of [0, 15, -8]) {
  const g = makeGame({ level: flatLevel(height) });
  const target = new Interactable({ id: 'terminal', anchor: { x: 0, y: height, z: -2 }, height: 2 });
  g.interactions.register(target);
  g.step();
  assert.equal(g.interactions.target, target);
  assert.equal(g.interactions.targetByRay, true);
  g.dispose();
}
console.log('Game lifecycle, render-independent replay, baked/spec loading, integration and elevated interactions passed');
