/**
 * The top-down simulations (adventure and arena), headless.
 *   node tools/test/test-builder-topdown.mjs
 */
import assert from 'node:assert/strict';
import { createProject, createLevel } from '../../../src/play2d/core/format.js';
import { createAdventureSim } from '../../../src/play2d/runtime/sims/adventure.js';
import { createArenaSim } from '../../../src/play2d/runtime/sims/arena.js';
import { emptyInput } from '../../../src/play2d/runtime/sims/shared.js';

const CODES = { '#': 20, '-': 21, '~': 22, '=': 23, 'b': 24, 'i': 25, 'O': 26, '_': 27 };
const ENT = { P: 'player', G: 'goal', o: 'coin', J: 'gem', k: 'key', D: 'door', L: 'switch', s: 'slime', x: 'spiky', B: 'bee', C: 'crate', c: 'chest', N: 'npc', T: 'turret', K: 'boss', t: 'plate', w: 'teleporter', Z: 'spawner', h: 'heart', S: 'spirit', l: 'checkpoint' };

function level(genre, rows, props = {}, rules = {}) {
  const w = rows[0].length, h = rows.length;
  const l = createLevel(genre, { width: Math.max(12, w), height: Math.max(10, h), empty: true, rules });
  for (let i = 0; i < l.terrain.length; i++) l.terrain[i] = 20;
  let n = 0;
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    l.terrain[y * l.width + x] = CODES[ch] ?? 0;
    if (ENT[ch]) l.entities.push({ id: ch + n++, type: ENT[ch], x, y, props: { ...(props[ch] || {}) } });
  }));
  const p = createProject(genre);
  p.levels = [l];
  return p;
}
function run(sim, frames, fn = () => ({})) {
  let prev = emptyInput();
  for (let i = 0; i < frames; i++) {
    const held = fn(i) || {};
    const input = emptyInput();
    Object.assign(input, held);
    for (const k of ['jump', 'action', 'fire', 'up', 'left', 'right', 'down']) input.pressed[k] = !!held[k] && !prev[k];
    sim.step(input);
    prev = input;
  }
}
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

test('moves at speed, diagonals normalised', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#P.........#', '#..........#', '#..........#', '#..........#', '############']), 0);
  const x0 = sim.player.x;
  run(sim, 30, () => ({ right: true }));
  const v = (sim.player.x - x0) / 0.5;
  assert.ok(v > 4.3 && v < 5.6, `speed ${v}`);
  const sim2 = createAdventureSim(level('adventure', ['############', '#P.........#', '#..........#', '#..........#', '#..........#', '############']), 0);
  const a = { x: sim2.player.x, y: sim2.player.y };
  run(sim2, 20, () => ({ right: true, down: true }));
  const d = Math.hypot(sim2.player.x - a.x, sim2.player.y - a.y) / (20 / 60);
  assert.ok(d < 5.6, `diagonal ${d}`);
});

test('walls stop you; corners nudge you into corridors', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#P...#.....#', '#....#.....#', '#..........#', '#....#.....#', '############']), 0);
  run(sim, 90, () => ({ right: true }));
  assert.ok(sim.player.x + sim.player.w <= 5 + 1e-6, 'went through the wall');
  // start slightly misaligned with the corridor at row 3 and walk right into it
  const sim2 = createAdventureSim(level('adventure', ['############', '#....#.....#', '#....#.....#', '#P.........#', '#....#.....#', '############']), 0);
  sim2.player.y += 0.25;
  run(sim2, 90, () => ({ right: true }));
  assert.ok(sim2.player.x > 6, `stuck at corridor mouth x=${sim2.player.x.toFixed(2)}`);
});

test('crates push one cell and fill pits', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#P.CO......#', '#..........#', '############']), 0);
  run(sim, 60, () => ({ right: true }));
  const crate = sim.entities.find(e => e.type === 'crate');
  assert.equal(crate.alive, false, 'crate did not fall into the pit');
  assert.equal(sim.tiles[1 * sim.W + 4], 0, 'pit not filled');
});

test('ice slides until blocked', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#Piiiiiii..#', '#..........#', '############']), 0);
  run(sim, 25, () => ({ right: sim.player.x < 1.6 }));
  run(sim, 80);
  assert.ok(sim.player.x > 8, `slide stopped early at ${sim.player.x.toFixed(2)}`);
});

test('pits cost a heart and return you', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#P.OOOO....#', '#..........#', '############']), 0);
  run(sim, 60, () => ({ right: true }));
  assert.ok(sim.player.hearts < 3, 'no damage');
  run(sim, 40);
  assert.ok(sim.player.x < 3.2, 'not returned to safe ground');
});

test('keys, levers and plates open gates', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#Pk..D.....#', '#..........#', '############'], { k: { color: 'rose' }, D: { lock: 'rose' } }), 0);
  run(sim, 60, () => ({ right: true }));
  assert.equal(sim.entities.find(e => e.type === 'door').open, true);
  const p = level('adventure', ['############', '#P.C.t.D...#', '#..........#', '############'], { D: { lock: 'none', stayOpen: false } });
  const l = p.levels[0];
  l.links.push({ from: l.entities.find(e => e.type === 'plate').id, to: l.entities.find(e => e.type === 'door').id });
  const sim2 = createAdventureSim(p, 0);
  run(sim2, 70, () => ({ right: sim2.entities.find(e => e.type === 'crate').cell.x < 5 }));
  assert.equal(sim2.entities.find(e => e.type === 'plate').active, true, 'crate did not hold the plate');
  assert.equal(sim2.entities.find(e => e.type === 'door').open, true, 'plate did not open the gate');
});

test('chests, villagers and warp flowers', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#Pc........#', '#.N.......w#', '#w.........#', '############'], { c: { contains: 'key-ice' }, N: { name: 'Mira', text: 'Hello' } }), 0);
  run(sim, 10, i => ({ action: i === 3 }));
  assert.equal(sim.entities.find(e => e.type === 'chest').open, true);
  assert.equal(sim.keys.ice, 1);
  run(sim, 30, i => ({ down: i < 8, action: i === 20 }));
  assert.equal(sim.message?.title, 'Mira');
  const sim2 = createAdventureSim(level('adventure', ['############', '#Pw.......w#', '#..........#', '############']), 0);
  run(sim2, 30, () => ({ right: sim2.player.x < 2.3 }));
  assert.ok(sim2.player.x > 8, 'warp did not carry you');
});

test('slingshot and arena shots', () => {
  const sim = createAdventureSim(level('adventure', ['############', '#P.....s...#', '#..........#', '############'], { s: { hp: 1, speed: 0.5 } }, { slingshot: true }), 0);
  sim.player.dir = 'right';
  run(sim, 40, () => ({ fire: true }));
  assert.equal(sim.entities.find(e => e.type === 'slime').alive, false, 'pebble did not hit');
  const sim2 = createArenaSim(level('arena', ['############', '#P..b.....#', '#..........#', '############'], {}, { win: 'survive', survive: 999 }), 0);
  run(sim2, 90, () => ({ fire: true, aim: { x: 1, y: 0 } }));
  assert.equal(sim2.tiles[1 * sim2.W + 4], 0, 'bush did not break after hits');
});

test('arena waves progress and fire their wires', () => {
  const p = level('arena', ['################', '#P.............#', '#..............#', '#.........Z....#', '#..............#', '#.............D#', '################'], { Z: { enemy: 'slime', waves: 2, perWave: 2, gap: 0.2, rest: 0.5, delay: 0.2 }, D: { lock: 'none' } }, { win: 'waves' });
  const l = p.levels[0];
  l.links.push({ from: l.entities.find(e => e.type === 'spawner').id, to: l.entities.find(e => e.type === 'door').id });
  const sim = createArenaSim(p, 0);
  // an invincible marksman: aim at the nearest critter every step
  let maxWave = 0;
  run(sim, 60 * 40, () => {
    sim.player.invuln = 1;
    const t = sim.entities.filter(e => e.alive && e.type === 'slime').sort((a, b) => Math.hypot(a.x - sim.player.x, a.y - sim.player.y) - Math.hypot(b.x - sim.player.x, b.y - sim.player.y))[0];
    maxWave = Math.max(maxWave, sim.waves.current);
    return t ? { fire: true, aim: { x: t.x - sim.player.x, y: t.y - sim.player.y } } : {};
  });
  assert.equal(maxWave, 2);
  assert.equal(sim.status, 'won', `status ${sim.status}, objective ${sim.objective.text}`);
  assert.equal(sim.entities.find(e => e.type === 'door').open, true, 'burrow wire did not open the gate');
});

test('survive rule', () => {
  const sim = createArenaSim(level('arena', ['############', '#P.........#', '#..........#', '############']), 0);
  sim.level.rules.win = 'survive'; sim.level.rules.survive = 5;
  run(sim, 60 * 6);
  assert.equal(sim.status, 'won');
});

test('critters hurt on contact; chasing slimes find a way round walls', () => {
  const sim = createArenaSim(level('arena', ['############', '#P...#.....#', '#....#..s..#', '#..........#', '############'], { s: { speed: 3 } }, { win: 'defeat' }), 0);
  run(sim, 60 * 6);
  assert.ok(sim.player.hearts < 3, 'slime never reached the player');
});

test('boss splits as it weakens', () => {
  const sim = createArenaSim(level('arena', ['################', '#P.............#', '#..............#', '#.........K....#', '#..............#', '#..............#', '#..............#', '################'], { K: { hp: 12 } }, { win: 'defeat' }), 0);
  run(sim, 60 * 12, () => { sim.player.invuln = 1; const b = sim.boss; return { fire: true, aim: { x: b.x + 0.9 - sim.player.x, y: b.y + 0.8 - sim.player.y } }; });
  assert.ok(!sim.boss.alive, `boss hp ${sim.boss.hp}`);
  assert.ok(sim.entities.filter(e => e.type === 'slime').length >= 6, 'no splits');
});

test('deterministic', () => {
  const rows = ['############', '#P...#.....#', '#....#..s..#', '#......B...#', '############'];
  const a = createArenaSim(level('arena', rows), 0), b = createArenaSim(level('arena', rows), 0);
  const script = i => ({ right: i % 60 < 30, down: i % 90 < 20, fire: i % 7 === 0, aim: { x: 1, y: 0.2 } });
  run(a, 500, script); run(b, 500, script);
  assert.deepEqual(a.trace, b.trace);
  assert.equal(a.score, b.score);
});

console.log(`test-builder-topdown: ${passed} checks passed`);
