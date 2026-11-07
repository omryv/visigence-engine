/**
 * Friendly wildlife (src/game/Wildlife.js): seeded, spread out, clear of the mission's places, never inside
 * cover, inside its bounds, and shy - it leaves when the player walks up.
 */
import assert from 'node:assert/strict';
import { Wildlife } from '../../src/game/Wildlife.js';

// A walled yard: a 60 m square with a 6 m block in the middle.
const collision = { isFree: (x, z, r) => Math.abs(x) + r < 30 && Math.abs(z) + r < 30 && !(Math.abs(x) < 3 + r && Math.abs(z) < 3 + r) };
const families = ['slime', 'shroom', 'bee'];
const avoid = [{ x: 0, z: 20 }, { x: 10, z: -10 }];
const make = seed => new Wildlife({ count: 8, seed, families, collision, avoid });

const w = make('K7QN-3F2A-9XBD');
assert.equal(w.agents.length, 8);
assert.deepEqual(w.agents.map(a => a.family), [0, 1, 2, 3, 4, 5, 6, 7].map(i => families[i % 3]), 'families rotate');
for (const a of w.agents) {
  assert(collision.isFree(a.position.x, a.position.z, 0.8), 'spawned on free ground');
  for (const p of avoid) assert(Math.hypot(a.position.x - p.x, a.position.z - p.z) >= 6, 'clear of the mission');
  for (const b of w.agents) if (a !== b) assert(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) >= 5, 'blue-noise spacing');
}
assert.deepEqual(make('K7QN-3F2A-9XBD').agents.map(a => [a.position.x, a.position.z]), w.agents.map(a => [a.position.x, a.position.z]), 'the seed decides');
assert.notDeepEqual(make('OTHER-SEED').agents.map(a => a.position.x), w.agents.map(a => a.position.x));

// Ten simulated minutes: they wander, never enter the block or leave the yard, and they rest now and then.
const far = { x: 500, z: 500 };
let moved = 0, rested = 0;
for (let t = 0; t < 36000; t++) {
  w.update(1 / 60, far);
  for (const a of w.agents) {
    assert(collision.isFree(a.position.x, a.position.z, a.radius - 1e-6), 'never inside cover');
    if (a.mode === 'rest') rested++; else moved++;
  }
}
assert(moved > 0 && rested > 0, 'both wander and rest');
const travelled = w.agents.map(a => Math.hypot(a.position.x - a.home.x, a.position.z - a.home.z));
assert(travelled.some(d => d > 0.5), 'they go places');

// Shy: walk up to one and it moves away.
const a = w.agents[0], player = { x: a.position.x + 1.5, z: a.position.z };
const before = Math.hypot(a.position.x - player.x, a.position.z - player.z);
for (let t = 0; t < 60; t++) w.update(1 / 60, player);
assert.equal(a.mode, 'flee');
assert(Math.hypot(a.position.x - player.x, a.position.z - player.z) > before + 0.8, 'it scurries off');
// A paused game freezes them.
const frozen = w.agents.map(b => [b.position.x, b.position.z]);
w.update(0, player);
assert.deepEqual(w.agents.map(b => [b.position.x, b.position.z]), frozen);
// Village life: a route node's home draws its families first; keepers stand their ground and never flee.
{
  const homes = [{ x: 20, z: -20, r: 3.5, families: ['bee'] }, { x: -20, z: 20, r: 3.5, families: ['slime', 'shroom'] }];
  const keepers = [{ x: 12, z: 12, yaw: 0.7, family: 'acorn' }, { x: -12, z: -12, yaw: -1.1, family: 'pebble' }, { x: 0, z: 20.5, yaw: 0, family: 'sprout' }];
  const v = new Wildlife({ count: 6, seed: 'LIFE', families, collision, avoid, homes, keepers });
  const wanderers = v.agents.filter(a => !a.keeper);
  assert.equal(wanderers.length, 6);
  for (const a of wanderers) {
    const home = homes.find(h => h.families.includes(a.family));
    assert(home && a.homed && Math.hypot(a.home.x - home.x, a.home.z - home.z) <= home.r * 0.8 * Math.SQRT2 + 1e-9, `${a.family} settles at its home`);
  }
  assert.equal(v.keepers.length, 2, 'the keeper whose post is near the mission is skipped');
  assert.deepEqual(v.keepers.map(k => [k.family, k.position.x, k.position.z, k.yaw]), [['acorn', 12, 12, 0.7], ['pebble', -12, -12, -1.1]]);
  const k = v.keepers[0], near = { x: k.position.x + 1, z: k.position.z };
  for (let t = 0; t < 600; t++) v.update(1 / 60, near);
  assert(k.mode === 'keep' && k.position.x === 12 && k.position.z === 12 && k.yaw === 0.7, 'a keeper stands its ground');
  assert(wanderers.some(a => a.mode !== 'keep'), 'the others still wander');
}
console.log(`Wildlife: 8 seeded friends, blue-noise spawn, 10 simulated minutes inside the yard, shy of the player; homes and keepers.`);
