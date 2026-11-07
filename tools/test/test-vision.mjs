import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readVision, indexLexicon, visionSeed, visionName, tokenize } from '../../src/world/vision.js';
import { resolveProject } from '../../src/world/shooterProject.js';
import { compileBlueprint, OBJECTIVE_KINDS } from '../../src/world/blueprint.js';
import { CATALOG } from '../../src/world/catalog.js';
import { GENRES } from '../../src/genres/registry.js';

const lexicon = JSON.parse(fs.readFileSync('src/world/visionLexicon.json', 'utf8'));
const catalog = CATALOG.arcade;
/** A vision is only useful if the studio can open it and the compiler can build it. */
function build(text) {
  const v = readVision(text, lexicon), project = resolveProject(v.project);
  const compiled = compileBlueprint(project.blueprint, catalog, { genre: GENRES[project.genre] });
  return { v, project, compiled, steps: compiled.mission.map(s => s.objective) };
}

// The lexicon itself: no word twice, every choice names something that exists.
indexLexicon(lexicon);
const sets = { world: catalog.world.map(w => w.id), genre: Object.keys(GENRES), difficulty: ['easy', 'normal', 'hard'], lighting: ['night', 'dawn'], behavior: ['guard', 'hunt'] };
const adds = { enemies: catalog.enemies.map(e => e.id), weapons: catalog.weapons.map(w => w.id), objectives: Object.keys(OBJECTIVE_KINDS) };
for (const entry of lexicon.entries) {
  assert.ok(entry.words.en?.length && entry.words.he?.length, `${entry.id} has English and Hebrew words`);
  for (const [k, v] of Object.entries(entry.set ?? {})) if (k !== 'enemyCount') assert.ok(sets[k]?.includes(v), `${entry.id}: ${k}=${v}`);
  for (const [k, list] of Object.entries(entry.add ?? {})) for (const v of list) assert.ok(adds[k]?.includes(v), `${entry.id}: ${k} ${v}`);
}

// The example on the landing page.
{
  const { v, project, compiled, steps } = build('A snowy fort where bees guard the honey');
  assert.deepEqual(compiled.pools.world, ['snow']);
  assert.ok(compiled.pools.enemies.includes('bee'));
  assert.deepEqual(steps, ['barricade', 'waves', 'extract']);
  assert.equal(project.genre, 'shooter');
  assert.equal(project.name, 'A snowy fort where bees guard the honey');
  assert.deepEqual(v.reading.map(r => r.word), ['snowy', 'fort', 'bees', 'guard', 'honey']);
  assert.equal(v.reading.find(r => r.word === 'bees').node, 'enemies');
  assert.equal(v.reading.find(r => r.word === 'fort').node, 'barricade-1');
  assert.equal(project.seed, build('A snowy fort where bees guard the honey').project.seed, 'the same words build the same game');
  assert.notEqual(project.seed, build('A snowy fort where bees guard the gate').project.seed);
}

// The same vision in Hebrew reads the same way: prefixes (ה, ו, ב, ש), plurals and final letters.
{
  const en = build('A snowy fort where bees guard the honey'), he = build('מבצר מושלג שבו דבורים שומרות על הדבש');
  assert.deepEqual(he.compiled.pools.world, en.compiled.pools.world);
  assert.deepEqual(he.steps, en.steps);
  assert.ok(he.compiled.pools.enemies.includes('bee'));
  assert.deepEqual(build('דבורים בשלג').compiled.pools.world, ['snow']);
  assert.deepEqual(tokenize("ג׳לי").map(t => t.norm), ["ג'לי"]);
}

// Calm words make an exploration route, with only the steps a player can do by hand.
{
  const { project, steps } = build('A peaceful walk to find the secret shrine at dawn');
  assert.equal(project.genre, 'exploration');
  assert.equal(project.lighting, 'dawn');
  assert.deepEqual(steps, ['reach', 'activate', 'extract']);
  const mixed = build('a cozy village with cannons and a siege');
  assert.equal(mixed.project.genre, 'shooter', 'naming a weapon and a fight overrides a calm word');
  assert.equal(mixed.project.weapon, 'launcher');
}

// Number words and digits set a step's count; the boss brings its king.
{
  assert.equal(build('wake three shrines then escape').compiled.mission.find(s => s.objective === 'activate').count, 3);
  assert.equal(build('4 crystals in the desert').compiled.mission.find(s => s.objective === 'activate').count, 4);
  assert.equal(build('להפעיל שני מקדשים').compiled.mission.find(s => s.objective === 'activate').count, 2);
  const boss = build('defeat the giant boss');
  assert.ok(boss.steps.includes('boss'));
  assert.ok(boss.compiled.pools.enemies.includes('king'));
  assert.equal(build('a king in a desert castle').compiled.pools.enemies.includes('king'), true);
  assert.equal(build('hard night, many chased by spirits').project.difficulty, 'hard');
  assert.equal(build('hard night, many chased by spirits').project.behavior, 'hunt');
  assert.equal(build('hard night, many chased by spirits').project.enemyCount, 10);
}

// Nothing understood still makes a game: the meadow, its shrines, a way out.
{
  const { v, compiled, steps } = build('zzz qwerty');
  assert.deepEqual(compiled.pools.world, ['meadow']);
  assert.deepEqual(steps, ['activate', 'extract']);
  assert.deepEqual(v.unmatched, ['zzz', 'qwerty']);
  assert.equal(visionName(''), 'My vision');
  assert.ok(visionName('word '.repeat(40)).length <= 64);
  assert.match(visionSeed('anything at all'), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
}

// Every pair of entries builds: whatever two ideas a player combines, the studio opens a valid game.
{
  const firsts = lexicon.entries.map(e => [e.words.en[0], e.words.he[0]]);
  let built = 0;
  for (const [a, ah] of firsts) for (const [b, bh] of firsts) {
    build(`${a} ${b}`); build(`${ah} ${bh}`); built += 2;
  }
  assert.ok(built > 1000);
}
console.log('vision: lexicon, English and Hebrew readings, genres, counts and every entry pair build');
