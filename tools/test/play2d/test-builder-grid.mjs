/**
 * The grid simulations (arcade maze and block puzzle), headless.
 *   node tools/test/test-builder-grid.mjs
 */
import assert from 'node:assert/strict';
import { createProject, createLevel } from '../../../src/play2d/core/format.js';
import { createMazeSim } from '../../../src/play2d/runtime/sims/maze.js';
import { createPuzzleSim } from '../../../src/play2d/runtime/sims/puzzle.js';
import { emptyInput } from '../../../src/play2d/runtime/sims/shared.js';

const CODES = { '#': 20, '-': 21, '=': 28, '_': 27, 'i': 25, 'O': 26 };
const ENT = { P: 'player', B: 'bee', J: 'power', g: 'gem', C: 'crate', k: 'key', D: 'door', t: 'plate', w: 'teleporter' };

function level(genre, rows, props = {}) {
  const l = createLevel(genre, { width: rows[0].length, height: rows.length, empty: true });
  let n = 0;
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    l.terrain[y * l.width + x] = CODES[ch] ?? 0;
    if (ch === '*') l.terrain[y * l.width + x] = 27;
    if (ENT[ch] || ch === '*') l.entities.push({ id: ch + n++, type: ch === '*' ? 'crate' : ENT[ch], x, y, props: { ...(props[ch] || {}) } });
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
    for (const k of ['up', 'left', 'right', 'down', 'undo', 'restart']) input.pressed[k] = !!held[k] && !prev[k];
    sim.step(input);
    prev = input;
  }
}
const tap = dir => i => (i === 0 ? { [dir]: true } : {});
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

// ------------------------------------------------------------------ maze
const MAZE = [
  '#########',
  '#.......#',
  '#.##.##.#',
  '.........',
  '#.##.##.#',
  '#...P...#',
  '#########',
];

test('maze: moves along corridors and stops at walls', () => {
  const sim = createMazeSim(level('maze', MAZE), 0);
  run(sim, 60, () => ({ right: true }));
  assert.ok(Math.abs(sim.player.data.cx - 7.5) < 1e-6, `stopped at ${sim.player.data.cx}`);
  assert.equal(sim.player.anim, 'idle');
});

test('maze: a buffered turn is taken at the next junction', () => {
  const sim = createMazeSim(level('maze', MAZE), 0);
  run(sim, 3, () => ({ left: true }));
  run(sim, 60, i => (i < 3 ? { up: true } : {}));
  // from x=4 heading left, the first open way up is x=1 (x=2,3 are walls above)
  assert.ok(sim.player.data.cy < 5, 'did not turn up');
  assert.ok(Math.abs(sim.player.data.cx - 1.5) < 1e-6, `turned at x=${sim.player.data.cx}`);
});

test('maze: tunnels wrap', () => {
  const sim = createMazeSim(level('maze', ['#########', '.........', '#...P...#', '#########']), 0);
  run(sim, 20, () => ({ up: true }));
  let wrapped = false, last = sim.player.data.cx;
  run(sim, 90, () => { const x = sim.player.data.cx; if (x > last + 2) wrapped = true; last = x; return { left: true }; });
  assert.ok(wrapped, 'no wrap');
});

test('maze: pollen scores and the maze is won when it is gone', () => {
  const sim = createMazeSim(level('maze', ['#######', '#P....#', '#######']), 0);
  assert.equal(sim.dotsLeft, 4);
  run(sim, 60, () => ({ right: true }));
  assert.equal(sim.dotsLeft, 0);
  assert.equal(sim.status, 'won');
  assert.equal(sim.score, 40);
});

test('maze: bees leave the hive, never pass walls, and catch you', () => {
  const rows = ['###########', '#.........#', '#.###=###.#', '#.#B...#..#', '#.#####.#.#', '#....P....#', '###########'];
  const sim = createMazeSim(level('maze', rows), 0);
  let left = false;
  run(sim, 60 * 25, () => {
    for (const b of sim.entities) if (b.type === 'bee') { const d = b.data; const t = sim.tiles[Math.floor(d.cy) * sim.W + Math.floor(d.cx)]; assert.notEqual(t, 20, 'bee inside a wall'); if (Math.floor(d.cy) <= 1) left = true; }
    return {};
  });
  assert.ok(left, 'bee never left the hive');
  assert.equal(sim.status, 'dead', 'the bee never caught a player standing still');
  sim.respawn();
  assert.equal(sim.status, 'play');
});

test('maze: the player never passes a hive gate', () => {
  const rows = ['#######', '#.....#', '###=###', '#P....#', '#######'];
  const sim = createMazeSim(level('maze', rows), 0);
  run(sim, 30, () => ({ right: true }));
  run(sim, 60, () => ({ up: true }));
  assert.equal(Math.floor(sim.player.data.cy), 3);
});

test('maze: royal jelly lets you eat bees in a chain', () => {
  const rows = ['#########', '#J.....B#', '#########'];
  const sim = createMazeSim(level('maze', rows.map(r => r.replace('J', 'P')).map((r, i) => i === 1 ? '#PJ....B#' : r), { J: { seconds: 10 } }), 0);
  sim.entities.find(e => e.type === 'bee').data.release = 0;
  run(sim, 60 * 3, () => ({ right: true }));
  assert.ok(sim.kills >= 1, 'did not eat the bee');
  assert.ok(sim.score >= 200);
});

test('maze: deterministic', () => {
  const rows = ['###########', '#.........#', '#.###=###.#', '#.#B.B.#..#', '#.#####.#.#', '#....P....#', '###########'];
  const a = createMazeSim(level('maze', rows), 0), b = createMazeSim(level('maze', rows), 0);
  const script = i => ({ left: i % 120 < 60, right: i % 120 >= 60, up: i % 200 < 30 });
  run(a, 800, script); run(b, 800, script);
  assert.deepEqual(a.trace, b.trace);
});

// ------------------------------------------------------------------ puzzle
test('puzzle: push a crate; blocked pushes do nothing', () => {
  const sim = createPuzzleSim(level('puzzle', ['#######', '#P.C._#', '#######']), 0);
  run(sim, 30, tap('right'));
  assert.equal(sim.moves, 1);
  const c = sim.entities.find(e => e.type === 'crate');
  run(sim, 30, tap('right')); run(sim, 30, tap('right'));
  assert.equal(c.cell.x, 5); assert.equal(sim.status, 'won'); assert.equal(sim.pushes, 2);
  const sim2 = createPuzzleSim(level('puzzle', ['#######', '#PCC._#', '#######']), 0);
  run(sim2, 30, tap('right'));
  assert.equal(sim2.moves, 0, 'pushed two crates');
});

test('puzzle: crates fill pits; players cannot enter them', () => {
  const sim = createPuzzleSim(level('puzzle', ['########', '#PCO.._#', '########']), 0);
  run(sim, 20, tap('right'));
  assert.equal(sim.tiles[1 * sim.W + 3], 0, 'pit not filled');
  assert.equal(sim.entities.find(e => e.type === 'crate').alive, false);
  const sim2 = createPuzzleSim(level('puzzle', ['#######', '#PO.._#', '#######']), 0);
  run(sim2, 20, tap('right'));
  assert.equal(sim2.moves, 0);
});

test('puzzle: ice slides crates and players', () => {
  const sim = createPuzzleSim(level('puzzle', ['#########', '#PCiii._#', '#########']), 0);
  run(sim, 40, tap('right'));
  const c = sim.entities.find(e => e.type === 'crate');
  assert.equal(c.cell.x, 6, `crate slid to ${c.cell.x}`);
});

test('puzzle: keys open gates; plates hold gates open', () => {
  const sim = createPuzzleSim(level('puzzle', ['#######', '#PkD._#', '#######'], { k: { color: 'amber' }, D: { lock: 'amber' } }), 0);
  run(sim, 20, tap('right')); run(sim, 20, tap('right'));
  assert.equal(sim.entities.find(e => e.type === 'door').open, true);
  const p = level('puzzle', ['########', '#PCt.D.#', '########'], { D: { lock: 'none', stayOpen: false } });
  const l = p.levels[0];
  l.links.push({ from: l.entities.find(e => e.type === 'plate').id, to: l.entities.find(e => e.type === 'door').id });
  const sim2 = createPuzzleSim(p, 0);
  run(sim2, 20, tap('right'));
  assert.equal(sim2.entities.find(e => e.type === 'door').open, true);
});

test('puzzle: undo restores exactly; restart goes back to the start', () => {
  const sim = createPuzzleSim(level('puzzle', ['########', '#P.CO._#', '#......#', '########']), 0);
  const s0 = JSON.stringify([sim.player.data.cell, [...sim.tiles]]);
  run(sim, 20, tap('right')); run(sim, 20, tap('right')); run(sim, 20, tap('down'));
  assert.equal(sim.moves, 3);
  run(sim, 5, i => (i === 0 ? { undo: true } : {}));
  assert.equal(sim.moves, 2);
  run(sim, 5, i => (i === 0 ? { restart: true } : {}));
  assert.equal(JSON.stringify([sim.player.data.cell, [...sim.tiles]]), s0);
  assert.equal(sim.entities.find(e => e.type === 'crate').alive, true);
});

test('puzzle: held direction repeats', () => {
  const sim = createPuzzleSim(level('puzzle', ['##########', '#P.......#', '##########']), 0);
  run(sim, 60, () => ({ right: true }));
  assert.ok(sim.moves >= 3, `moves ${sim.moves}`);
});

test('puzzle: warp flowers carry the player', () => {
  const sim = createPuzzleSim(level('puzzle', ['#########', '#Pw...w.#', '#########']), 0);
  run(sim, 20, tap('right'));
  assert.equal(sim.player.data.cell.x, 6);
});

console.log(`test-builder-grid: ${passed} checks passed`);
