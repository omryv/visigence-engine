// A hand-built level played (game/LevelScript.js): keys and the doors they open, levers and trigger zones firing their
// wires, sleeping critters waking, honey drops, checkpoints and lives, restart, and the playtest trace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { quickMission } from '../../src/world/missionCard.js';
import { normalizeEdits } from '../../src/world/level/edits.js';
import { Game } from '../../src/game/Game.js';
import { State } from '../../src/sim/GameState.js';
import { FIXED_STEP } from '../../src/config/gameplay.js';

const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), CATALOG.arcade.measurements);
const base = resolveProject(quickMission('arcade'));
const events = [];
const play = (edits, patch = {}) => {
  const level = compileShooterProject({ ...base, ...patch, edits: normalizeEdits(edits) }, pack);
  const g = new Game({ level, onLevelEvent: (name, data) => events.push([name, data]) });
  g.start(); return g;
};
// Somewhere open to stand: the start's own pad, moved a little, is always clear ground.
const S = { x: 0, z: 28 };
const stand = (g, x, z, look = null) => {
  g.player.reset({ position: { x, z }, yaw: look ? Math.atan2(-(look.x - x), -(look.z - z)) : 0, pitch: 0 });
};
/** Hold interact toward a target until done or out of time; tries a few pitches so the ray meets the use column. */
const hold = (g, seconds = 3) => {
  for (const pitch of [0, -0.25, -0.45, 0.2]) {
    g.player.pitch = pitch; g.step({ interact: true });
    if (g.interactions.target) break;
  }
  for (let i = 0; i < seconds / FIXED_STEP; i++) g.step({ interact: true });
};

// ---------------------------------------------------------------- a key opens its colour's door
{
  const door = { id: 'd1', type: 'door', x: S.x + 6, z: S.z - 6, yaw: 0, props: { lock: 'amber' } };
  const g = play({ entities: [door, { id: 'k1', type: 'key', x: S.x - 3, z: S.z - 2, props: { color: 'amber' } }] });
  const d = g.script.doors[0];
  assert.equal(g.collision.boxBlockers.find(b => b.id === d.blockerId).active, true, 'a locked door starts shut');
  stand(g, door.x, door.z + 2.4, door);
  g.step({ interact: true });
  assert.match(g.interactions.prompt?.label ?? '', /Locked · find the amber key/, 'without the key the door says what it needs');
  hold(g, 1.5); assert.equal(d.opened, false, 'and holding does nothing');
  stand(g, S.x - 3, S.z - 2); g.step();
  assert.deepEqual(g.hudState.level.keys, ['amber'], 'walking over the key takes it');
  assert.equal(g.script.keys[0].taken, true);
  stand(g, door.x, door.z + 2.4, door); hold(g, 1.5);
  assert.equal(d.opened, true, 'with the key, a hold opens it');
  assert.equal(g.collision.boxBlockers.find(b => b.id === d.blockerId).active, false, 'an open door stops blocking');
  assert.deepEqual(g.hudState.level.keys, [], 'the key is used up');
  for (let i = 0; i < 120; i++) g.step();
  assert.equal(d.open, 1, 'the door swings fully open over a second');
  g.restart();
  assert.equal(d.opened, false); assert.equal(g.script.keys[0].taken, false); assert.equal(g.collision.boxBlockers.find(b => b.id === d.blockerId).active, true, 'restart shuts it again');
  g.dispose();
}

// ---------------------------------------------------------------- a lever opens its door and wakes its critters
{
  events.length = 0;
  const lever = { id: 'l1', type: 'lever', x: S.x + 4, z: S.z - 3 };
  const door = { id: 'd1', type: 'door', x: S.x - 8, z: S.z - 10, props: { lock: 'wired' } };
  const sleepers = { id: 's1', type: 'enemy', x: S.x - 8, z: S.z - 22, props: { kind: 'slime', count: 3 } };
  const awake = { id: 'a1', type: 'enemy', x: S.x + 10, z: S.z - 24, props: { kind: 'bee', count: 1, behavior: 'hunt' } };
  const g = play({ entities: [lever, door, sleepers, awake], wires: [{ from: 'l1', to: 'd1' }, { from: 'l1', to: 's1' }] }, { enemyCount: 1 });
  const placed = () => g.enemies.enemies.filter(e => e.alive && ['slime', 'bee'].includes(e.type.id)).length;
  assert.equal(g.script.groups.find(x => x.entity.id === 'a1').spawned.length, 1, 'an unwired critter is out from the start');
  assert.equal(g.script.groups.find(x => x.entity.id === 's1').spawned.length, 0, 'a wired one sleeps');
  stand(g, lever.x, lever.z + 2, lever); hold(g, 1.2);
  assert.equal(g.script.levers[0].pulled, true, 'a hold pulls the lever');
  assert.equal(g.script.doors[0].opened, true, 'its wired door opens');
  assert.equal(g.script.groups.find(x => x.entity.id === 's1').spawned.length, 3, 'its wired critters wake, all three');
  assert.ok(events.some(([n]) => n === 'lever') && events.some(([n]) => n === 'wave') && events.some(([n, d]) => n === 'door' && d.by === 'wire'));
  assert.ok(placed() >= 4);
  g.dispose();
}

// ---------------------------------------------------------------- a trigger zone fires once, when walked into
{
  const zone = { id: 't1', type: 'trigger', x: S.x, z: S.z - 8, yaw: 0.4, props: { w: 4, d: 2 } };
  const g = play({ entities: [zone, { id: 's1', type: 'enemy', x: S.x + 6, z: S.z - 20, props: { kind: 'sprout', count: 2 } }], wires: [{ from: 't1', to: 's1' }] });
  stand(g, S.x + 3, S.z - 8); g.step();
  assert.equal(g.script.zones[0].fired, false, 'outside the turned rectangle nothing happens');
  stand(g, S.x, S.z - 8); g.step();
  assert.equal(g.script.zones[0].fired, true);
  assert.equal(g.script.groups[0].spawned.length, 2);
  const spawned = g.enemies.aliveCount; g.step(); g.step();
  assert.equal(g.enemies.aliveCount, spawned, 'and only once');
  g.dispose();
}

// ---------------------------------------------------------------- honey drops, checkpoints, lives and the trace
{
  const drops = [0, 1, 2].map(i => ({ id: `c${i}`, type: 'collectible', x: S.x - 4 + i * 4, z: S.z - 5 }));
  const cp = { id: 'p1', type: 'checkpoint', x: S.x + 4, z: S.z - 10, yaw: 1 };
  const g = play({ entities: [...drops, cp] }, { settings: { lives: 3 } });
  assert.equal(g.script.total, 3); assert.equal(g.hudState.level.lives, 3);
  for (const d of drops.slice(0, 2)) { stand(g, d.x, d.z); g.step(); }
  assert.equal(g.hudState.level.collected, 2);
  stand(g, cp.x, cp.z); g.step();
  assert.equal(g.hudState.level.checkpoint, 'p1');
  stand(g, S.x, S.z); for (let i = 0; i < 40; i++) g.step();
  g.player.damage(10000); g.step();
  assert.equal(g.state.current, State.PLAYING, 'a fall with lives to spare carries on');
  assert.equal(g.hudState.level.lives, 2);
  assert.ok(Math.hypot(g.player.position.x - cp.x, g.player.position.z - cp.z) < 0.01, 'back at the last checkpoint');
  assert.equal(g.player.yaw, 1, 'facing the way the checkpoint faces');
  assert.equal(g.trace.deaths.length, 1); assert.ok(g.trace.points.length >= 2, 'the route is traced');
  g.player.damage(10000); g.step(); g.player.damage(10000); g.step();
  assert.equal(g.state.current, State.PLAYER_DEAD, 'the last life ends the run');
  assert.equal(g.trace.deaths.length, 3);
  const taken = g.script.collected;
  assert.equal(g.continueRun(), true, 'a rewarded continue carries the run on');
  assert.equal(g.state.current, State.PLAYING); assert.equal(g.player.alive, true); assert.equal(g.player.health, 100);
  assert.equal(g.hudState.level.lives, 3, 'with its lives back');
  assert.ok(Math.hypot(g.player.position.x - cp.x, g.player.position.z - cp.z) < 0.01, 'from the last checkpoint');
  assert.equal(g.script.collected, taken, 'and everything else as it was');
  assert.equal(g.continueRun(), false, 'only a lost run can be continued');
  g.restart();
  assert.equal(g.hudState.level.collected, 0); assert.equal(g.hudState.level.lives, 3); assert.deepEqual(g.trace, { points: [], deaths: [] });
  g.restart({ spawn: { position: { x: S.x + 2, z: S.z - 3 }, yaw: 0.5, pitch: 0 } });
  assert.ok(Math.hypot(g.player.position.x - (S.x + 2), g.player.position.z - (S.z - 3)) < 1e-6, 'a playtest can start from a chosen spot');
  g.dispose();
}

// ---------------------------------------------------------------- a generated mission plays as it always did
{
  const g = play({});
  assert.equal(g.script.maxLives, 1); assert.equal(g.script.doors.length + g.script.levers.length + g.script.zones.length, 0);
  g.player.damage(10000); g.step();
  assert.equal(g.state.current, State.PLAYER_DEAD, 'one life: a fall ends the run, as before');
  g.dispose();
}
console.log('Level script: key doors, levers and zones firing their wires, sleeping critters, honey drops, checkpoints, lives, continue, restart and the trace');
