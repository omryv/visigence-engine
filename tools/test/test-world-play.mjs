// PLAY ON THE WORLD (src/world/worldPlay.js): the editor's mission brought onto the world it was set up on, at the
// world's own scale. A world of this test's own (a hill, a sea on one side, a dry hollow below the waterline the sea
// cannot reach, and a building of the world engine's own collision boxes), the mission compiled as the runtime
// compiles it, then put there and played with the real Game: the ground under the body is the world's, the sea and
// the walls are not walkable, the hollow is, the mission's things stand on reachable ground, the village's scenery
// stays behind, and the same world makes the same area to the bit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { quickMission } from '../../src/world/missionCard.js';
import { Game } from '../../src/game/Game.js';
import { Blockers } from '../../src/genesis/player/collide.js';
import { worldLevel, playArea, engineWorld, PLAY_SIZE } from '../../src/world/worldPlay.js';
import { wetAt } from '../../src/kernel/water/flood.js';

const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), CATALOG.arcade.measurements);
const V = pack.world.terrain.traversal;
const traversal = { maxSlope: V.maxSlope, stepUp: V.stepUp, wadeDepth: V.wade, slopeEps: V.slopeEps };
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`ok   ${name}`); };

// ---------------------------------------------------------------- the world
// Ground rises gently to the west and falls into the sea past x = 255 (world metres); a bowl at (170, -175) dips a metre
// below the waterline, and the sea cannot reach it.
const START = { x: 200, z: -150 };
const ground = (x, z) => {
  const sea = x > 255 ? -(x - 255) * 0.4 : 0;
  const bowl = Math.max(0, 1 - Math.hypot(x - 170, z + 175) / 20) * 6.5;
  return 6 + 0.02 * (300 - x) + 0.6 * Math.sin(z * 0.05) + sea - bowl;
};
const wet = (x, z) => x > 255;   // the sea-connected mask: only the coast
// A building: four walls of 0.3 m round an 8 m by 8 m room, its floor slab at the ground, standing at (215, -190).
const blockers = new Blockers();
const B = { x: 215, z: -190 }, gy = ground(B.x, B.z);
blockers.set('house', [
  { minX: -4, maxX: 4, minZ: -4, maxZ: -3.7, minY: gy, maxY: gy + 3 },
  { minX: -4, maxX: 4, minZ: 3.7, maxZ: 4, minY: gy, maxY: gy + 3 },
  { minX: -4, maxX: -3.7, minZ: -4, maxZ: 4, minY: gy, maxY: gy + 3 },
  { minX: 3.7, maxX: 4, minZ: -4, maxZ: 4, minY: gy, maxY: gy + 3 },
], { x: B.x, z: B.z, rot: 0 });
const engine = {
  sampleHeight: ground, blockers, water: { flood: null }, params: { water: { enabled: true, level: 4.5 } },
};
// engineWorld reads the flood mask through wetAt; this world's own mask is the coast.
const world = { ...engineWorld(engine, wetAt), wet };

const project = resolveProject({ ...quickMission('arcade'), enemyCount: 6 });
const compiled = compileShooterProject(project, pack);
const level = worldLevel(compiled, world, START, traversal);
const O = level.playArea.origin, toLocal = (x, z) => ({ x: x - O.x, z: z - O.z });

ok('the level starts where the editor said, on the world', () => {
  const s = level.spawn.position;
  assert.ok(Math.hypot(s.x + O.x - START.x, s.z + O.z - START.z) < 1, `the start is at (${s.x + O.x}, ${s.z + O.z})`);
  assert.equal(level.playArea.size, PLAY_SIZE);
  assert.equal(level.world, null, 'no village layout on the world');
  assert.deepEqual(level.buildings, []);
});

ok("the ground under the level is the world's own ground", () => {
  for (const [x, z] of [[200, -150], [180, -120], [250, -200], [140, -100]]) {
    const l = toLocal(x, z);
    assert.ok(Math.abs(level.terrain.heightAt(l.x, l.z) - ground(x, z)) < 0.02, `at (${x}, ${z}): ${level.terrain.heightAt(l.x, l.z)} against ${ground(x, z)}`);
  }
});

const g = new Game({ level });
const C = g.collision;
const cellAt = (x, z) => {
  const l = toLocal(x, z), i = Math.floor((l.x - C.originX) / C.cell), j = Math.floor((l.z - C.originZ) / C.cell);
  return C.walkable[j * C.n + i];
};

ok('the sea is not walkable, and the hollow the sea cannot reach is dry ground', () => {
  const coast = toLocal(250, -150), sea = toLocal(272, -150);
  assert.equal(level.terrain.depthAt(coast.x, coast.z), 0, 'dry before the coast');
  // Past x = 255 the ground falls below the waterline and the sea reaches it: deep water, not walkable.
  assert.ok(level.terrain.depthAt(sea.x, sea.z) > traversal.wadeDepth, 'deep water off the coast');
  assert.equal(cellAt(272, -150), 0, 'the sea is not walkable');
  assert.equal(cellAt(200, -150), 1, 'the start is walkable');
  const hollow = toLocal(170, -175);
  assert.ok(level.terrain.heightAt(hollow.x, hollow.z) < 4.5, 'the hollow is below the waterline');
  assert.equal(level.terrain.depthAt(hollow.x, hollow.z), 0, 'and dry');
  assert.equal(cellAt(170, -172), 1, 'and walkable');
});

ok("the building's walls are not walkable, and the closed room inside is out of reach", () => {
  assert.equal(cellAt(B.x - 3.85, B.z), 0, 'the west wall');
  assert.equal(cellAt(B.x + 3.85, B.z + 1), 0, 'the east wall');
  assert.equal(cellAt(B.x, B.z), 0, 'the middle of the sealed room cannot be reached');
  assert.equal(cellAt(B.x - 6, B.z), 1, 'outside the wall is open ground');
});

ok("the mission's things are on reachable ground, the village's scenery is not brought", () => {
  assert.ok(level.placements.length > 0);
  assert.ok(!level.placements.some((p) => p.village), 'no village placement');
  for (const p of level.placements) {
    if (p.collisionOnly) continue;
    const i = Math.floor((p.x - C.originX) / C.cell), j = Math.floor((p.z - C.originZ) / C.cell);
    assert.equal(C.walkable[j * C.n + i], 1, `${p.key ?? p.id} stands on reachable ground`);
    assert.ok(Math.abs(p.y - level.terrain.heightAt(p.x, p.z)) < 0.6, `${p.key ?? p.id} stands on the ground`);
  }
  const steps = compiled.placements.filter((p) => p.stepId && !p.village).length;
  assert.equal(level.placements.filter((p) => p.stepId).length, steps, 'every mission pad came');
});

ok('the same world makes the same area, to the bit', () => {
  const again = worldLevel(compiled, world, START, traversal);
  assert.equal(again.grid.WALKABLE_PACKED, level.grid.WALKABLE_PACKED);
  assert.deepEqual(Array.from(again.terrain.field.data.slice(0, 2000)), Array.from(level.terrain.field.data.slice(0, 2000)));
  assert.deepEqual(again.placements.map((p) => [p.x, p.z, p.y]), level.placements.map((p) => [p.x, p.z, p.y]));
});

ok('played: the body stands on the world, walks on it and stops at the wall', () => {
  g.start();
  const p = g.player;
  for (let i = 0; i < 30; i++) g.step({});
  const at = p.position;
  assert.ok(Math.abs(at.y - level.terrain.heightAt(at.x, at.z)) < 0.05, `feet at ${at.y}, ground at ${level.terrain.heightAt(at.x, at.z)}`);
  // Walk at the building's west wall from outside it: the body stops short of it.
  const w = toLocal(B.x - 10, B.z);
  p.reset({ position: { x: w.x, z: w.z }, yaw: -Math.PI / 2, pitch: 0 });
  for (let i = 0; i < 240; i++) g.step({ move: { x: 0, y: 1 } });
  assert.ok(p.position.x + O.x < B.x - 3.7, `the body is at x = ${p.position.x + O.x}, the wall at ${B.x - 4}`);
  assert.ok(p.position.x + O.x > B.x - 9, 'and it did walk toward it');
});

ok("the mission's critters come out on the world's dry, reachable ground", () => {
  const out = g.script.spawnGenerated(project).filter(Boolean);
  assert.equal(out.length, project.enemyCount);
  for (const e of out) {
    assert.equal(level.terrain.depthAt(e.position.x, e.position.z), 0, 'not in water');
    assert.ok(Math.abs(e.position.y - level.terrain.heightAt(e.position.x, e.position.z)) < 0.05, 'on the ground');
  }
});

ok('a start in the sea moves onto the nearest standing room; with none in reach it says so', () => {
  const wetStart = worldLevel(compiled, world, { x: 330, z: -150 }, traversal);
  const s = wetStart.spawn.position, o = wetStart.playArea.origin;
  assert.ok(s.x + o.x < 268, `moved toward the shore, to x = ${s.x + o.x}`);
  assert.ok(wetStart.terrain.depthAt(s.x, s.z) <= traversal.wadeDepth, 'into water no deeper than a body wades');
  assert.throws(() => worldLevel(compiled, { ...world, ground: () => -50, wet: () => true }, START, traversal), /no ground to stand on/);
});

ok('playArea reads the world through the functions it is handed, and nothing else', () => {
  let calls = 0;
  const a = playArea({ ground: () => { calls++; return 1; }, waterLevel: -Infinity }, { x: 0, z: 0 }, traversal, { size: 20, cell: 1 });
  assert.equal(calls, 21 * 21);
  assert.equal(a.local.reduce((n, v) => n + v, 0), (20 - 6) * (20 - 6), 'flat dry ground: everything inside the rim');
});

console.log(`world play: ${passed} checks passed`);
