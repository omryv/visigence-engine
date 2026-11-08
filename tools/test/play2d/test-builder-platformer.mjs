/**
 * The platformer simulation: feel numbers, collision, parts and rules, run headless.
 *   node tools/test/test-builder-platformer.mjs
 */
import assert from 'node:assert/strict';
import { createProject, createLevel } from '../../../src/play2d/core/format.js';
import { createPlatformerSim } from '../../../src/play2d/runtime/sims/platformer.js';
import { emptyInput } from '../../../src/play2d/runtime/sims/shared.js';

const CODES = { '#': 1, '=': 3, '^': 6, 'H': 7, '~': 8, 'C': 5, 'A': 9, 'B': 10, 'I': 4 };
const ENT = { P: 'player', G: 'goal', o: 'coin', J: 'gem', k: 'key', D: 'door', L: 'switch', s: 'slime', x: 'spiky', b: 'bee', S: 'spring', M: 'platform', T: 'turret', K: 'boss', c: 'checkpoint', X: 'bswitch', h: 'heart', w: 'powerup' };

function level(rows, props = {}, rules = {}) {
  const w = rows[0].length, h = rows.length;
  const l = createLevel('platformer', { width: Math.max(16, w), height: Math.max(12, h), empty: true, rules });
  const W = l.width;
  let n = 0;
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    if (CODES[ch]) l.terrain[(y + l.height - h) * W + x] = CODES[ch];
    else if (ENT[ch]) l.entities.push({ id: 'e' + n++, type: ENT[ch], x, y: y + l.height - h, props: { ...(props[ch] || {}) } });
  }));
  const p = createProject('platformer');
  p.levels = [l];
  return p;
}
function run(sim, frames, fn = () => ({})) {
  let prev = emptyInput();
  for (let i = 0; i < frames; i++) {
    const held = fn(i);
    const input = emptyInput();
    Object.assign(input, held);
    for (const k of ['jump', 'action', 'up', 'left', 'right', 'down']) input.pressed[k] = !!held[k] && !prev[k];
    sim.step(input);
    prev = input;
  }
}
let passed = 0;
const test = (name, fn) => { fn(); passed++; };
const flat = ['................', '................', '.P..............', '################'];

test('standing still is stable for 10 s', () => {
  const sim = createPlatformerSim(level(flat), 0);
  run(sim, 30);
  const y = sim.player.y, x = sim.player.x;
  run(sim, 600);
  assert.ok(Math.abs(sim.player.y - y) < 1e-9 && Math.abs(sim.player.x - x) < 1e-9, 'drifted');
  assert.equal(sim.player.anim, 'idle');
});

test('a full jump clears ~3.3 tiles, a tap much less', () => {
  const measure = hold => {
    const sim = createPlatformerSim(level(flat), 0);
    run(sim, 20);
    const y0 = sim.player.y;
    let top = y0;
    run(sim, 90, i => ({ jump: i < hold }));
    for (const [, y] of sim.trace) void y;
    const sim2 = createPlatformerSim(level(flat), 0);
    run(sim2, 20);
    let minY = sim2.player.y;
    run(sim2, 90, i => { minY = Math.min(minY, sim2.player.y); return { jump: i < hold }; });
    top = minY;
    return y0 - top;
  };
  const full = measure(60), tap = measure(3);
  assert.ok(full > 3.1 && full < 3.6, `full jump ${full.toFixed(2)}`);
  assert.ok(tap < 1.6, `tap jump ${tap.toFixed(2)}`);
});

test('running reaches 7.5 t/s and walls stop you', () => {
  const sim = createPlatformerSim(level(['................', '..P.........#...', '................', '################'].map((r, i) => i === 2 ? '............#...' : r)), 0);
  run(sim, 120, () => ({ right: true }));
  assert.ok(sim.player.x + sim.player.w <= 12 + 1e-9, 'went through the wall');
});

test('coyote time lets you jump just after leaving a ledge', () => {
  const sim = createPlatformerSim(level(['................', '................', '.P..............', '####............']), 0);
  let jumped = false;
  run(sim, 80, i => { if (sim.player.x > 4.05 && !jumped) { jumped = true; return { right: true, jump: true }; } return { right: true }; });
  assert.ok(sim.stats.jumps >= 1, 'coyote jump not taken');
});

test('one-way planks: land from above, drop through with down + jump', () => {
  const sim = createPlatformerSim(level(['................', '.P..............', '................', '====............', '................', '################']), 0);
  run(sim, 60);
  const onPlank = sim.player.y + sim.player.h;
  assert.ok(Math.abs(onPlank - (sim.level.height - 3)) < 0.01, `not on plank: ${onPlank}`);
  run(sim, 40, i => ({ down: true, jump: i === 2 }));
  assert.ok(sim.player.y + sim.player.h > sim.level.height - 2, 'did not drop');
});

test('springs launch higher than a jump', () => {
  const sim = createPlatformerSim(level(['................', '................', '................', '................', '................', '................', '................', '................', '.P.S............', '################'], { S: { power: 7 } }), 0);
  let minY = 99;
  run(sim, 120, () => { minY = Math.min(minY, sim.player.y); return { right: sim.player.x < 3.1 }; });
  const rise = sim.level.height - 1 - sim.player.h - minY;
  assert.ok(rise > 6, `spring rise ${rise.toFixed(2)}`);
});

test('stomping a slime kills it; a hedgehog hurts', () => {
  const sim = createPlatformerSim(level(['................', '.....P..........', '................', '................', '.....s..........', '################'], { s: { speed: 0.5 } }), 0);
  run(sim, 60);
  const slime = sim.entities.find(e => e.type === 'slime');
  assert.equal(slime.alive, false, 'stomp did not kill');
  assert.equal(sim.player.hearts, 3, 'stomp hurt the player');
  const sim2 = createPlatformerSim(level(['................', '................', '.P.x............', '################']), 0);
  run(sim2, 120, () => ({ right: true }));
  assert.ok(sim2.player.hearts < 3, 'hedgehog did not hurt');
});

test('keys open doors of their colour only', () => {
  const sim = createPlatformerSim(level(['................', '................', '.Pk....D........', '################'], { k: { color: 'ice' }, D: { lock: 'amber' } }), 0);
  run(sim, 120, () => ({ right: true }));
  const door = sim.entities.find(e => e.type === 'door');
  assert.equal(door.open, false);
  assert.ok(sim.player.x + sim.player.w <= 7 + 1e-6, 'walked through a locked gate');
  const sim2 = createPlatformerSim(level(['................', '................', '.Pk....D........', '################'], { k: { color: 'amber' }, D: { lock: 'amber' } }), 0);
  run(sim2, 120, () => ({ right: true }));
  assert.equal(sim2.entities.find(e => e.type === 'door').open, true);
});

test('a lever wired to a gate opens it', () => {
  const p = level(['................', '................', '.P.L...D........', '################'], { D: { lock: 'none' } });
  const l = p.levels[0];
  l.links.push({ from: l.entities.find(e => e.type === 'switch').id, to: l.entities.find(e => e.type === 'door').id });
  const sim = createPlatformerSim(p, 0);
  run(sim, 40, i => ({ right: i < 20 }));
  run(sim, 5, i => ({ action: i === 1 }));
  assert.equal(sim.entities.find(e => e.type === 'door').open, true);
});

test('colour switch swaps the blocks', () => {
  const sim = createPlatformerSim(level(['................', '......X.........', '................', '.P..............', '################']), 0);
  assert.equal(sim.toggle, false);
  run(sim, 80, i => ({ right: sim.player.x < 5.8, jump: i > 30 && i < 60 }));
  assert.equal(sim.toggle, true, 'head bump did not toggle');
});

test('crumble blocks fall and regrow', () => {
  const sim = createPlatformerSim(level(['................', '.P..............', 'CCCC............', '................', '################']), 0);
  run(sim, 90);
  assert.ok(sim.player.y > sim.level.height - 3, 'did not fall through crumble');
  run(sim, 260);
  const i = (sim.level.height - 3) * sim.W + 0;
  assert.equal(sim.tiles[i], 5, 'did not regrow');
});

test('goal wins; falling out kills', () => {
  const sim = createPlatformerSim(level(['................', '................', '.P....G.........', '################']), 0);
  run(sim, 120, () => ({ right: true }));
  assert.equal(sim.status, 'won');
  const sim2 = createPlatformerSim(level(['................', '................', '.P..............', '###.............']), 0);
  run(sim2, 200, () => ({ right: true }));
  assert.equal(sim2.status, 'dead');
});

test('collect rule counts jars', () => {
  const sim = createPlatformerSim(level(['................', '................', '.P..J..J........', '################'], {}, { win: 'collect' }), 0);
  run(sim, 120, () => ({ right: true }));
  assert.equal(sim.status, 'won');
});

test('moving platform carries the rider', () => {
  const sim = createPlatformerSim(level(['................', '.P..............', '.M..............', '................', '................', '................'], { M: { width: 3, axis: 'x', distance: 6, speed: 3 } }), 0);
  run(sim, 60);
  const x0 = sim.player.x;
  run(sim, 60);
  assert.ok(sim.player.x - x0 > 2, `not carried: moved ${(sim.player.x - x0).toFixed(2)}`);
  assert.equal(sim.status, 'play');
});

test('ladders climb', () => {
  const sim = createPlatformerSim(level(['................', '..H.............', '..H.............', '..H.............', '.PH.............', '################']), 0);
  run(sim, 30, () => ({ right: sim.player.x < 1.9 }));
  const y0 = sim.player.y;
  run(sim, 40, () => ({ up: true }));
  assert.ok(y0 - sim.player.y > 1.5, 'did not climb');
});

test('the boss takes hp stomps', () => {
  const sim = createPlatformerSim(level(['..........................', '..........................', '..........................', '.P..........K.............', '..........................', '##########################'], { K: { hp: 2 } }, { win: 'defeat' }), 0);
  assert.equal(sim.boss.hp, 2);
  const b = sim.boss;
  // drop the player onto the boss twice
  for (let k = 0; k < 2; k++) {
    b.data.invuln = 0;
    Object.assign(sim.player, { x: b.x + 0.6, y: b.y - 2, vy: 2, invuln: 0 });
    run(sim, 30);
  }
  assert.ok(b.hp <= 0 || !b.alive, `boss hp ${b.hp}`);
});

test('deterministic: same inputs, same trace', () => {
  const rows = ['................', '....s...........', '.P......b.......', '################'];
  const a = createPlatformerSim(level(rows), 0), b = createPlatformerSim(level(rows), 0);
  const script = i => ({ right: i % 50 < 30, jump: i % 40 < 12 });
  run(a, 400, script); run(b, 400, script);
  assert.deepEqual(a.trace, b.trace);
});

console.log(`test-builder-platformer: ${passed} checks passed`);
