/**
 * The level builder's live checks: reachability for side-on and top-down levels, keys and
 * gates, budgets, and the block-puzzle solver (solvable, unsolvable, par, dead corners).
 *   node tools/test/test-builder-analyze.mjs
 */
import assert from 'node:assert/strict';
import { createProject, createLevel } from '../../../src/play2d/core/format.js';
import { analyzeLevel, solvePuzzle } from '../../../src/play2d/core/analyze.js';
import { LIMITS } from '../../../src/play2d/core/catalog.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

/**
 * Build a one-level project from rows of characters.
 *   side:  '#' ground   '=' plank ledge
 *   top:   '#' wall  '.' floor  '_' crate pad  'O' pit  'i' ice
 *   parts: P player  G goal  k key  D gate  C crate  t plate  c honey drop  S slime
 */
const SIDE = { '#': 1, '=': 3 };
const TOP = { '#': 20, '.': 0, '_': 27, 'O': 26, 'i': 25 };
const PARTS = { P: 'player', G: 'goal', k: 'key', D: 'door', C: 'crate', t: 'plate', c: 'coin', S: 'slime' };
function build(genre, rows, { props = {}, links = [], rules = {} } = {}) {
  const side = genre === 'platformer';
  const l = createLevel(genre, { width: rows[0].length, height: rows.length, empty: true });
  const ids = {};
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    const i = y * l.width + x;
    l.terrain[i] = (side ? SIDE : TOP)[ch] ?? 0;
    if (PARTS[ch]) {
      const id = `${ch}${x}_${y}`;
      ids[ch] = ids[ch] || [];
      ids[ch].push(id);
      l.entities.push({ id, type: PARTS[ch], x, y, props: { ...(props[ch] || {}) } });
    }
  }));
  l.links = links.map(([a, b]) => ({ from: ids[a][0], to: ids[b][0] }));
  Object.assign(l.rules, rules);
  const p = createProject(genre);
  p.levels = [l];
  return p;
}
const ids = r => r.issues.map(x => x.id);
const errors = r => r.issues.filter(x => x.severity === 'error').map(x => x.id);

// ------------------------------------------------------------------ side-on reachability
test('a shrine across a short gap is reachable', () => {
  const r = analyzeLevel(build('platformer', [
    '                    ',
    '                    ',
    '                    ',
    ' P             G    ',
    '#########  #########',
    '#########  #########',
  ]), 0);
  assert.ok(!ids(r).includes('goal-unreachable'), JSON.stringify(r.issues));
  assert.deepEqual(errors(r), []);
});

test('a shrine behind a wall taller than any jump is flagged', () => {
  const r = analyzeLevel(build('platformer', [
    '          #         ',
    '          #         ',
    '          #         ',
    '          #         ',
    '          #         ',
    '          #         ',
    '          #         ',
    ' P        #    G    ',
    '####################',
  ]), 0);
  assert.ok(ids(r).includes('goal-unreachable'));
  const issue = r.issues.find(x => x.id === 'goal-unreachable');
  assert.deepEqual(issue.at, { x: 15, y: 7 }, 'the issue points at the shrine');
});

test('a ledge one high jump up is reachable; honey above a gap counts too', () => {
  const r = analyzeLevel(build('platformer', [
    '                    ',
    '            c       ',
    '         ====== G   ',
    '                    ',
    ' P                  ',
    '#######    #########',
  ]), 0);
  assert.ok(!ids(r).includes('goal-unreachable'), JSON.stringify(r.issues));
  assert.ok(!ids(r).includes('coins-unreachable'));
});

test('no player start is an error, and a buried one too', () => {
  assert.ok(errors(analyzeLevel(build('platformer', ['      G ', '########']), 0)).includes('no-player'));
  const p = build('platformer', ['   P  G ', '########']);
  p.levels[0].entities.find(e => e.type === 'player').y = 1;
  assert.ok(errors(analyzeLevel(p, 0)).includes('player-buried'));
});

// ------------------------------------------------------------------ top-down: keys and gates
test('a gate with a key on this side opens the way', () => {
  const rows = [
    '##########',
    '#P.k.#..G#',
    '#....D...#',
    '#....#...#',
    '##########',
  ];
  const locked = analyzeLevel(build('adventure', rows, { props: { D: { lock: 'amber' }, k: { color: 'amber' } } }), 0);
  assert.ok(!ids(locked).includes('goal-unreachable'), JSON.stringify(locked.issues));
  const noKey = analyzeLevel(build('adventure', rows.map(r => r.replace('k', '.')), { props: { D: { lock: 'amber' } } }), 0);
  assert.ok(ids(noKey).includes('goal-unreachable'));
  assert.ok(ids(noKey).some(id => id.startsWith('keys-short')));
});

test('a gate with no lock and no wire never opens', () => {
  const r = analyzeLevel(build('adventure', ['#######', '#P.D.G#', '#######'], { props: { D: { lock: 'none' } } }), 0);
  assert.ok(ids(r).some(id => id.startsWith('door-never')));
});

test('parts over the budget are errors', () => {
  const p = build('adventure', ['#####', '#P.G#', '#####']);
  const l = p.levels[0];
  for (let n = 0; n <= LIMITS.enemies; n++) l.entities.push({ id: 's' + n, type: 'slime', x: 2, y: 1, props: {} });
  assert.ok(errors(analyzeLevel(p, 0)).includes('budget-enemies'));
});

// ------------------------------------------------------------------ block puzzles
test('the solver finds the shortest push sequence and suggests it as par', () => {
  const p = build('puzzle', [
    '#######',
    '#P.C._#',
    '#######',
  ]);
  const s = solvePuzzle(p.levels[0]);
  assert.equal(s.solvable, true);
  assert.equal(s.moves, 3);
  assert.equal(s.path, 'RRR');
  const r = analyzeLevel(p, 0);
  assert.ok(ids(r).includes('solved'));
  assert.equal(r.stats.par, 3);
});

test('par below the best solution warns; a set par silences the suggestion', () => {
  const rows = ['#######', '#P.C._#', '#######'];
  assert.ok(ids(analyzeLevel(build('puzzle', rows, { rules: { par: 2 } }), 0)).includes('par-impossible'));
  const ok = ids(analyzeLevel(build('puzzle', rows, { rules: { par: 3 } }), 0));
  assert.ok(!ok.includes('solved') && !ok.includes('par-impossible'));
});

test('a crate that can only reach a corner is unsolvable', () => {
  const r = analyzeLevel(build('puzzle', [
    '######',
    '#C..P#',
    '#....#',
    '#...._',
    '######',
  ].map(x => x.replace(/_$/, '#')).map((x, i) => (i === 3 ? '#..._#' : x))), 0);
  // the crate starts against the top wall in the left corner column: it can only slide along
  // the wall into the corner, never down to the pad
  assert.ok(errors(r).includes('unsolvable'), JSON.stringify(r.issues));
});

test('a pit in a corner is not a dead end: a crate fills it and the way opens', () => {
  const p = build('puzzle', [
    '#########',
    '#P.C.O###',
    '####.####',
    '####.####',
    '####C####',
    '####_####',
    '#########',
  ]);
  // the first crate blocks the way down until it is pushed on into the pit in the corner
  const s = solvePuzzle(p.levels[0]);
  assert.equal(s.solvable, true);
  assert.equal(s.path, 'RRRDDD');
});

test('a plate in a corner holds a crate that opens a gate', () => {
  const p = build('puzzle', [
    '#########',
    '#t.C..P.#',
    '#######D#',
    '#######C#',
    '#######_#',
    '#########',
  ], { props: { D: { lock: 'none' } }, links: [['t', 'D']] });
  // push the first crate into the corner onto the plate; the gate opens; push the second onto the pad
  const s = solvePuzzle(p.levels[0]);
  assert.equal(s.solvable, true, 'the plate in the corner must not count as a dead cell');
  assert.equal(s.path, 'LLLLRRRRRDD');
});

// The solver used to track filled pits, unlocked gates and taken keys as bits of a 32-bit integer,
// and a JavaScript shift count is taken mod 32: pit 32 shared pit 0's bit, gate 32 shared gate 0's.
// Each level below needs pit or gate 32 crossed and gives no way to do it; with the aliasing,
// filling pit 0 (or unlocking gate 0) made pit or gate 32 look done too, and the solver called the
// level solvable. Each has a twin with one more crate or key that really is solvable.
const PITS33 = [
  '####################',
  '#.PCO###############', // pit 0: this crate can only go into it
  '#.##################',
  '#.#OOOOOOOOOOOOOOOO#', // pits 1 to 16, walled off
  '#.##################',
  '#.#OOOOOOOOOOOOOOO##', // pits 17 to 31, walled off
  '#.##################',
  '#O.C_###############', // pit 32 cuts the corridor off from the last crate and its pad
  '####################',
];
test('pit 32 is its own pit: filling pit 0 does not fill it', () => {
  const l = build('puzzle', PITS33).levels[0];
  assert.equal(l.terrain.filter(c => c === 26).length, 33);
  const s = solvePuzzle(l);
  assert.equal(s.solvable, false, `no crate can reach pit 32 (solver found ${s.path})`);
  // a crate in the corridor can fill pit 32, and then it is solvable
  const twin = build('puzzle', PITS33.map((r, y) => (y === 5 ? '#C' + r.slice(2) : r))).levels[0];
  const s2 = solvePuzzle(twin);
  assert.equal(s2.solvable, true);
  assert.equal(s2.path, 'LDDDDDDRR');
});

const GATES33 = [
  '########################',
  '#PkD.###################', // the only key opens gate 0, the only way on
  '####.###################',
  '####.#DDDDDDDDDDDDDDDD##', // gates 1 to 16, walled off
  '####.###################',
  '####.#DDDDDDDDDDDDDDD###', // gates 17 to 31, walled off
  '####.###################',
  '####.DC_################', // gate 32, locked, before the crate and its pad
  '########################',
];
const AMBER = { props: { D: { lock: 'amber' }, k: { color: 'amber' } } };
test('gate 32 is its own gate: unlocking gate 0 does not unlock it', () => {
  const l = build('puzzle', GATES33, AMBER).levels[0];
  assert.equal(l.entities.filter(e => e.type === 'door').length, 33);
  const s = solvePuzzle(l);
  assert.equal(s.solvable, false, `the one key is spent on gate 0 (solver found ${s.path})`);
  // a second key on the way down opens gate 32 too
  const twin = build('puzzle', GATES33.map((r, y) => (y === 2 ? '####k' + r.slice(5) : r)), AMBER).levels[0];
  const s2 = solvePuzzle(twin);
  assert.equal(s2.solvable, true);
  assert.equal(s2.path, 'RRRDDDDDDRR');
});

console.log(`ok ${passed} builder analysis tests`);
