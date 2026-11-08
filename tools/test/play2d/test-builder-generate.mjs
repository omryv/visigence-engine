/**
 * The level generator (builder/core/generate.js): for every genre and several seeds, every level
 * it returns passes the editor's own checks with no error or warning, puzzles are proven solvable
 * with their par set to the shortest solution, the difficulty climbs in order across the range
 * asked for, the same seed gives the same levels byte for byte, and every level plays in its
 * genre's simulation without throwing.
 *   node tools/test/test-builder-generate.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateLevels, difficultyLabel, GENERATE_MAX, GENERATOR_VERSION, generatorStamp, parseGenerateLink } from '../../../src/play2d/core/generate.js';
import { analyzeLevel, solvePuzzle } from '../../../src/play2d/core/analyze.js';
import { createProject, serializeProject, parseProject } from '../../../src/play2d/core/format.js';
import { GENRE_IDS, genreById, BIOME_IDS } from '../../../src/play2d/core/catalog.js';
import { createSim, emptyInput, STEP } from '../../../src/play2d/runtime/sims/index.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };
const projectOf = (genre, levels) => { const p = createProject(genre, { id: 'fixed' }); p.levels = levels; return p; };

function drive(sim, seconds) {
  let prev = emptyInput();
  for (let i = 0; i < Math.round(seconds / STEP) && sim.status === 'play'; i++) {
    const input = emptyInput();
    const phase = Math.floor(i / 45) % 6;
    input.right = phase < 3; input.left = phase === 4; input.up = phase === 2 || phase === 5; input.down = phase === 3;
    input.jump = i % 40 < 10; input.fire = i % 20 < 4; input.action = i % 90 === 0;
    input.aim = { x: Math.cos(i / 30), y: Math.sin(i / 30) };
    for (const k of ['up', 'down', 'left', 'right', 'jump', 'fire', 'action']) input.pressed[k] = !!input[k] && !prev[k];
    sim.step(input);
    prev = input;
  }
}

const SEEDS = ['alpha', 'bramble-7', 'frost-42'];
const runs = new Map();
for (const genre of GENRE_IDS) for (const seed of SEEDS) {
  const count = genre === 'puzzle' ? 4 : 5;
  runs.set(`${genre}|${seed}`, { genre, seed, count, result: generateLevels(genre, { count, seed, biome: 'mixed', from: 0.1, to: 0.9 }) });
}

for (const { genre, seed, count, result } of runs.values()) {
  const tag = `${genre} ${seed}`;
  test(`${tag}: the count asked for, in order of difficulty`, () => {
    assert.equal(result.levels.length, count, `${result.rejected} rejected: ${JSON.stringify(result.reasons)}`);
    for (let i = 1; i < result.levels.length; i++) assert.ok(result.levels[i].score >= result.levels[i - 1].score, 'scores climb');
    for (const r of result.levels) assert.equal(r.label, difficultyLabel(r.score));
    const spread = result.levels.at(-1).score - result.levels[0].score;
    assert.ok(spread >= 0.3, `the climb spans the range (spread ${spread.toFixed(2)})`);
  });

  test(`${tag}: every level passes the editor's checks`, () => {
    const project = projectOf(genre, result.levels.map(r => r.level));
    project.levels.forEach((level, i) => {
      const a = analyzeLevel(project, i, { maxNodes: 400000 });
      const bad = a.issues.filter(x => x.severity !== 'tip');
      assert.deepEqual(bad.map(x => `${x.id}: ${x.message}`), [], `${level.name}`);
      const g = genreById(genre);
      assert.ok(level.width >= g.minSize.width && level.width <= g.maxSize.width && level.height >= g.minSize.height && level.height <= g.maxSize.height, 'inside the genre\'s size limits');
      assert.ok(level.entities.filter(e => e.type === 'player').length === 1, 'one player start');
      if (genre === 'puzzle') {
        const s = solvePuzzle(level, { maxNodes: 400000 });
        assert.equal(s.solvable, true, `${level.name} is solvable`);
        assert.equal(level.rules.par, s.moves, 'par is the shortest solution');
      }
    });
  });

  test(`${tag}: names, ids and biomes are set and distinct`, () => {
    const levels = result.levels.map(r => r.level);
    assert.equal(new Set(levels.map(l => l.id)).size, levels.length);
    assert.equal(new Set(levels.map(l => l.name)).size, levels.length);
    for (const l of levels) {
      assert.ok(l.name.length > 3 && l.name.length <= 40);
      assert.ok(BIOME_IDS.includes(l.biome));
      assert.equal(new Set(l.entities.map(e => e.id)).size, l.entities.length, 'entity ids are unique');
      for (const k of l.links) assert.ok(l.entities.some(e => e.id === k.from) && l.entities.some(e => e.id === k.to), 'wires join real parts');
    }
    assert.deepEqual([...new Set(levels.map(l => l.biome))].sort(), [...BIOME_IDS].sort(), 'mixed runs through all three biomes');
  });

  test(`${tag}: survives a save and reload`, () => {
    const p = projectOf(genre, result.levels.map(r => r.level));
    const text = serializeProject(p);
    assert.equal(serializeProject(parseProject(text)), text);
  });

  test(`${tag}: every level records the generator version, and keeps it through a save and reload`, () => {
    const p = parseProject(serializeProject(projectOf(genre, result.levels.map(r => r.level))));
    for (const l of p.levels) assert.deepEqual(generatorStamp(l.notes), { genre, seed, version: GENERATOR_VERSION }, l.notes);
  });

  test(`${tag}: every level plays without throwing`, () => {
    const p = projectOf(genre, result.levels.map(r => r.level));
    for (let i = 0; i < p.levels.length; i++) drive(createSim(p, i, { seed: 3 }), 12);
  });
}

test('the same seed makes the same levels; another seed makes others', () => {
  for (const genre of GENRE_IDS) {
    const a = serializeProject(projectOf(genre, generateLevels(genre, { count: 3, seed: 'same' }).levels.map(r => r.level)));
    const b = serializeProject(projectOf(genre, generateLevels(genre, { count: 3, seed: 'same' }).levels.map(r => r.level)));
    const c = serializeProject(projectOf(genre, generateLevels(genre, { count: 3, seed: 'other' }).levels.map(r => r.level)));
    assert.equal(a, b, `${genre} is deterministic`);
    assert.notEqual(a, c, `${genre} varies with the seed`);
  }
});

// What the generator makes for seed "pin" in every genre, by GENERATOR_VERSION. When this fails,
// the output for a seed changed: bump GENERATOR_VERSION in builder/core/generate.js and add the
// new version's fingerprint here (keep the old ones). Never edit an existing entry to match. The
// version number in the notes' stamp is left out of the hash, so bumping it alone does not change
// the fingerprint and the value printed below is the right one to pin for the next version.
const FINGERPRINTS = {
  1: 'c94ddb2603a5649c',
};
test('the output for a fixed seed matches the fingerprint pinned to GENERATOR_VERSION', () => {
  const levels = GENRE_IDS.map(genre => generateLevels(genre, { count: 2, seed: 'pin', biome: 'mixed' }).levels.map(r => r.level));
  const got = createHash('sha256').update(JSON.stringify(levels).replace(/generator v\d+/g, 'generator v#')).digest('hex').slice(0, 16);
  assert.ok(FINGERPRINTS[GENERATOR_VERSION], `no fingerprint for generator v${GENERATOR_VERSION}: add ${GENERATOR_VERSION}: '${got}'`);
  assert.equal(got, FINGERPRINTS[GENERATOR_VERSION], `generated levels changed but GENERATOR_VERSION is still ${GENERATOR_VERSION}: bump it and pin ${GENERATOR_VERSION + 1}: '${got}'`);
});

test('generatorStamp reads only a real stamp', () => {
  assert.deepEqual(generatorStamp('Generated (maze, seed a, b: c, generator v3): hard.'), { genre: 'maze', seed: 'a, b: c', version: 3 });
  assert.equal(generatorStamp('Generated (maze, seed a): an old level, before the version was recorded.'), null);
  assert.equal(generatorStamp('My own notes. Generated (maze, seed a, generator v1): copied'), null);
  assert.equal(generatorStamp(''), null);
  assert.equal(generatorStamp(undefined), null);
});

test('#generate= links: a genre alone, or a genre and a seed', () => {
  const read = h => parseGenerateLink(new URLSearchParams(h.slice(1)).get('generate'));
  // old links keep working: the genre alone, a random seed
  for (const genre of GENRE_IDS) assert.deepEqual(read(`#generate=${genre}`), { genre, seed: null });
  assert.deepEqual(read('#generate=puzzle:frost-7'), { genre: 'puzzle', seed: 'frost-7' });
  assert.deepEqual(read('#generate=maze:a:b'), { genre: 'maze', seed: 'a:b' }, 'the seed is everything after the first colon');
  assert.deepEqual(read('#generate=arena:' + encodeURIComponent('two words & more')), { genre: 'arena', seed: 'two words & more' });
  assert.deepEqual(read('#generate=puzzle:'), { genre: 'puzzle', seed: null }, 'an empty seed is a random one');
  assert.deepEqual(read('#generate=puzzle:%20%20'), { genre: 'puzzle', seed: null });
  assert.equal(read('#generate=puzzle:' + 'x'.repeat(60)).seed.length, 40, 'cut to the dialog\'s 40 characters');
  assert.equal(read('#generate=racing'), null);
  assert.equal(read('#generate=racing:seed'), null);
  assert.equal(read('#generate='), null);
  assert.equal(parseGenerateLink(null), null);
  // the seed from a link is the seed the levels are made with
  const { genre, seed } = read('#generate=puzzle:frost-7');
  assert.equal(generatorStamp(generateLevels(genre, { count: 1, seed }).levels[0].level.notes).seed, 'frost-7');
});

test('a gentle range stays easier than a tough one', () => {
  for (const genre of ['platformer', 'adventure', 'maze']) {
    const gentle = generateLevels(genre, { count: 4, seed: 'curve', from: 0.05, to: 0.4 }).levels;
    const tough = generateLevels(genre, { count: 4, seed: 'curve', from: 0.6, to: 0.95 }).levels;
    const mean = list => list.reduce((n, r) => n + r.score, 0) / list.length;
    assert.ok(mean(gentle) + 0.2 < mean(tough), `${genre}: gentle ${mean(gentle).toFixed(2)} vs tough ${mean(tough).toFixed(2)}`);
  }
});

test('options are clamped and a single biome is honoured', () => {
  const r = generateLevels('maze', { count: 99, seed: 'clamp', biome: 'snow' });
  assert.equal(r.levels.length, GENERATE_MAX);
  assert.ok(r.levels.every(x => x.level.biome === 'snow'));
  assert.equal(generateLevels('arena', { count: 0, seed: 'one' }).levels.length, 1);
  const sized = generateLevels('platformer', { count: 2, seed: 'wide', width: 150 }).levels;
  assert.ok(sized.every(x => x.level.width === 150));
  assert.throws(() => generateLevels('racing', {}), /No generator/);
});

test('progress is reported as candidates are checked', () => {
  const seen = [];
  generateLevels('arena', { count: 2, seed: 'progress', onProgress: p => seen.push(p) });
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(p => p.done <= p.total && p.kept + p.rejected === p.attempts));
});

console.log(`ok ${passed} builder generator tests`);
