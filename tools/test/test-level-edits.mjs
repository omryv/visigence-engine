// A level's hand edits (world/level/): the edit document's rules, and that the compiler applies them so they
// survive saving, reloading and regenerating the parts of the level they do not name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { quickMission } from '../../src/world/missionCard.js';
import { createEdits, normalizeEdits, nextEntityId, isEmptyEdits } from '../../src/world/level/edits.js';
import { encodeRegions, decodeRegions, emptyRegions, brushCells, REGION_CODES, regionIndex, regionAt, REGION_N } from '../../src/world/level/regions.js';
import { CollisionSystem } from '../../src/sim/CollisionSystem.js';
import { liftToGame, levelProject, patchGame, addLevel, removeLevel, moveLevel, duplicateLevel } from '../../src/world/level/game.js';

const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), CATALOG.arcade.measurements);
const base = resolveProject(quickMission('arcade'));
const compile = edits => compileShooterProject({ ...base, edits }, pack);
const near = (p, x, z, d = 0.01) => Math.hypot(p.x - x, p.z - z) < d;

// ---------------------------------------------------------------- the edit document
{
  assert.deepEqual(normalizeEdits(undefined), createEdits());
  assert.ok(isEmptyEdits(normalizeEdits(null)));
  const e = normalizeEdits({ start: { x: 99, z: -3.14159, yaw: 7 }, entities: [
    { id: 'e1', type: 'enemy', x: 5, z: 5, props: { kind: 'bee', count: 40, behavior: 'dance', extra: 1 } },
    { id: 'e2', type: 'prop', x: 1, z: 1, scale: 9, props: { prop: 'barrel' } },
    { id: 'e3', type: 'lever', x: 0, z: 0 }, { id: 'e4', type: 'door', x: 3, z: 0, props: { lock: 'ice' } },
  ], wires: [{ from: 'e3', to: 'e4' }, { from: 'e3', to: 'e4' }, { from: 'e4', to: 'e3' }, { from: 'e3', to: 'gone' }, { from: 'e3', to: 'e1' }] });
  assert.deepEqual(e.start, { x: 38, z: -3.14, yaw: 0.7168 }, 'the start is clamped to the meadow and its yaw folded');
  assert.deepEqual(e.entities[0].props, { kind: 'bee', count: 6, behavior: 'guard' }, 'props clamp, unknown values fall back, unknown keys go');
  assert.equal(e.entities[1].scale, 2, 'scale is clamped to its range');
  assert.equal(e.entities[3].props.lock, 'ice');
  assert.deepEqual(e.wires, [{ from: 'e3', to: 'e4' }, { from: 'e3', to: 'e1' }], 'duplicate, reversed and dangling wires are dropped');
  assert.equal(nextEntityId(e), 'e5');
  assert.throws(() => normalizeEdits({ entities: [{ id: 'e1', type: 'dragon', x: 0, z: 0 }] }), /edits\.entities\[0\]: Unknown entity type/);
  assert.throws(() => normalizeEdits({ entities: [{ id: 'e1', type: 'enemy', x: 0, z: 0 }, { id: 'e1', type: 'enemy', x: 1, z: 1 }] }), /duplicate "e1"/);
  assert.throws(() => normalizeEdits({ entities: [{ id: 'Bad Id', type: 'enemy', x: 0, z: 0 }] }), /lowercase/);
  assert.throws(() => normalizeEdits({ entities: Array.from({ length: 13 }, (_, i) => ({ id: `e${i}`, type: 'door', x: i, z: 0 })) }), /at most 12 door/);
  assert.throws(() => normalizeEdits({ overrides: { 'house@1.0,2.0': { x: 3, z: 4 } } }), /can be removed, not moved/);
  assert.throws(() => normalizeEdits({ overrides: { 'step:activate:0': { removed: true } } }), /mission graph/);
  assert.throws(() => normalizeEdits({ overrides: { '../etc': { removed: true } } }), /unknown key/);
  assert.deepEqual(normalizeEdits({ overrides: { 'tree@1.0,-2.5': { x: 1.234, z: 2, yaw: 4 } } }).overrides, { 'tree@1.0,-2.5': { x: 1.23, z: 2, yaw: -2.2832 } });
}

// ---------------------------------------------------------------- painted regions
{
  const cells = emptyRegions();
  assert.equal(encodeRegions(cells), '', 'an unpainted level stores nothing');
  for (const k of brushCells(0, 0, 2.2)) cells[k] = REGION_CODES.path;
  for (const k of brushCells(-30, 30, 1)) cells[k] = REGION_CODES.nogo;
  const text = encodeRegions(cells);
  assert.deepEqual(decodeRegions(text), cells, 'the run-length string round-trips');
  assert.ok(text.length < 200, `a few strokes stay small (${text.length} chars)`);
  assert.equal(regionAt(cells, 0.2, -0.3), REGION_CODES.path);
  assert.equal(regionIndex(-40, -40), 0); assert.equal(regionIndex(39.99, 39.99), REGION_N * REGION_N - 1); assert.equal(regionIndex(40, 0), -1);
  assert.throws(() => decodeRegions('5.'), /5 of 6400 cells/);
  assert.throws(() => decodeRegions('6400q'), /malformed/);
  assert.throws(() => decodeRegions('abc'), /unexpected/);
}

// ---------------------------------------------------------------- no edits compiles what it always has
const plain = compile(undefined);
{
  const empty = compile(createEdits());
  assert.deepEqual(empty.placements, plain.placements, 'empty edits change nothing');
  assert.deepEqual(plain.spawn.position, { x: 0, y: plain.spawn.position.y, z: 28 });
  assert.deepEqual(plain.orphans, []);
  const keys = plain.placements.filter(p => !p.parent && !p.collisionOnly).map(p => p.key);
  assert.ok(keys.every(Boolean), 'every generated thing has a key');
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  assert.ok(plain.placements.filter(p => p.id === 'tree-trunk').every(t => plain.placements.some(p => p.key === t.parent)), 'every trunk names its tree');
  assert.ok(plain.placements.filter(p => p.id === 'house-block').every(b => plain.placements.some(p => p.key === b.parent && p.house)), 'every house block names its house');
  assert.deepEqual(compile(undefined).placements.map(p => p.key), plain.placements.map(p => p.key), 'keys are deterministic');
}

// ---------------------------------------------------------------- placed things, and the village making room for them
const tree = plain.placements.find(p => p.tree && !p.landmarkOf && Math.abs(p.x) < 30 && Math.abs(p.z) < 30);
{
  const edits = normalizeEdits({ entities: [
    { id: 'e1', type: 'prop', x: tree.x, z: tree.z, props: { prop: 'barrel' } },
    { id: 'e2', type: 'pickup', x: 6, z: 20, props: { kind: 'ammo' } },
    { id: 'e3', type: 'door', x: -6, z: 12, yaw: Math.PI / 2, props: { lock: 'hold' } },
    { id: 'e4', type: 'checkpoint', x: 0, z: 0 },
    { id: 'e5', type: 'prop', x: 20, z: -20, props: { prop: 'house', variant: 'farmhouse' } },
    { id: 'e6', type: 'prop', x: -20, z: -20, scale: 1.5, props: { prop: 'tree', variant: 'conifer' } },
    { id: 'e7', type: 'enemy', x: 10, z: -10, props: { kind: 'slime' } },
  ] });
  const level = compile(edits);
  const of = id => level.placements.find(p => p.entity === id);
  assert.equal(of('e1').id, 'barrel'); assert.equal(of('e1').key, 'entity:e1');
  assert.ok(!level.placements.some(p => p.tree && near(p, tree.x, tree.z)), 'the village gives a placed barrel its spot');
  assert.equal(of('e2').pickup, 'ammo', 'a placed supply is a supply');
  assert.equal(of('e3').interaction, 'override', 'a hold door opens like a gate'); assert.equal(of('e3').yaw, 1.5708);
  assert.equal(of('e4').role, 'respawn');
  assert.ok(of('e5').house, 'a placed house is grown from its plan');
  assert.ok(level.placements.some(p => p.id === 'house-block' && p.parent === 'entity:e5'), 'with its blocks');
  assert.ok(of('e6').tree && level.placements.some(p => p.id === 'tree-trunk' && p.parent === 'entity:e6'), 'a placed tree has its trunk');
  assert.ok(!level.placements.some(p => p.entity === 'e7'), 'an enemy is not a placement: the level script spawns it');
  assert.equal(level.entities.length, 7);
  // Hand edits never re-plan the village: every generated thing they do not touch stays exactly where it was.
  const villageOf = l => new Map(l.placements.filter(p => p.village && !p.parent).map(p => [p.key, p]));
  const before = villageOf(plain), after = villageOf(level);
  for (const [key, p] of after) assert.ok(before.has(key) && near(before.get(key), p.x, p.z, 1e-9), `${key} did not move`);
  const cleared = [...before.keys()].filter(k => !after.has(k));
  assert.ok(cleared.length > 0 && cleared.every(k => !/^(house|landmark|bridge|basin)@/.test(k)), 'only clutter round the placed things is cleared');
  // The same edits compile the same level: a reload changes nothing.
  assert.deepEqual(compile(normalizeEdits(JSON.parse(JSON.stringify(edits)))).placements, level.placements);
}

// ---------------------------------------------------------------- gear: keys, their padlocks, levers and honey drops
{
  const level = compile(normalizeEdits({ entities: [
    { id: 'k1', type: 'key', x: 5, z: 5, props: { color: 'rose' } }, { id: 'd1', type: 'door', x: 8, z: -6, yaw: Math.PI / 2, props: { lock: 'rose' } },
    { id: 'd2', type: 'door', x: -8, z: -6, props: { lock: 'wired' } }, { id: 'l1', type: 'lever', x: -4, z: -2 }, { id: 'c1', type: 'collectible', x: 2, z: -12 },
  ], wires: [{ from: 'l1', to: 'd2' }] }));
  const of = id => level.placements.find(p => p.entity === id);
  assert.deepEqual([of('k1').id, of('k1').node, of('k1').pickup, of('k1').color], ['keyRose', 'Key_rose', 'key', 'rose'], 'a key is its colour\'s node of the keys file');
  const lock = level.placements.find(p => p.lockOf === 'd1');
  assert.ok(lock && lock.id === 'lockRose' && lock.lift > 1 && lock.collision === 'none', 'a colour-locked door wears its padlock');
  assert.ok(near(lock, 8 + 0.58, -6, 0.01), 'on the gate\'s front, turned with it');
  assert.equal(of('d1').lock, 'rose'); assert.ok(!of('d1').interaction, 'a locked door does not open with a hold');
  assert.ok(!level.placements.some(p => p.lockOf === 'd2'), 'a wired door has no padlock');
  assert.equal(of('l1').id, 'lever'); assert.ok(of('l1').lever);
  assert.deepEqual([of('c1').id, of('c1').pickup], ['honeyDrop', 'collectible']);
  assert.ok(!level.placements.some(p => p.pickup === 'key' && p.village), 'gear never enters the village: it is not a pool option');
  assert.ok(!CATALOG.arcade.props.some(p => p.role === 'gear') && CATALOG.arcade.gear.length === 9, 'the studio lists gear apart from the pools');
}

// ---------------------------------------------------------------- overrides: move, remove, and what follows
{
  const trunk = plain.placements.find(p => p.parent === tree.key && p.id === 'tree-trunk');
  const house = plain.placements.find(p => p.house && p.village);
  const pad = plain.placements.find(p => p.key?.startsWith('step:') && p.interaction === 'activate');
  const edits = normalizeEdits({ overrides: {
    [tree.key]: { x: tree.x + 2, z: tree.z - 1, yaw: 1 },
    [house.key]: { removed: true },
    [pad.key]: { x: -20, z: 5 },
    'gate:0': { removed: true },
  } });
  const level = compile(edits);
  const moved = level.placements.find(p => p.key === tree.key);
  assert.ok(near(moved, tree.x + 2, tree.z - 1) && moved.yaw === 1, 'a moved tree stands where it was put');
  assert.ok(near(level.placements.find(p => p.parent === tree.key), trunk.x + 2, trunk.z - 1), 'its trunk follows');
  assert.ok(!level.placements.some(p => p.key === house.key || p.parent === house.key), 'a removed house takes its blocks with it');
  assert.ok(near(level.placements.find(p => p.key === pad.key), -20, 5), 'a mission pad moves');
  assert.ok(!level.placements.some(p => p.key === 'gate:0'), 'a generated gate can be taken out');
  assert.deepEqual(level.orphans, []);
  // Regenerating what the edits do not name keeps them: another encounter size, another light, another mission step.
  for (const patch of [{ enemyCount: 9 }, { lighting: 'dawn' }, { behavior: 'hunt' }]) {
    const again = compileShooterProject({ ...base, ...patch, edits }, pack);
    assert.ok(near(again.placements.find(p => p.key === tree.key), tree.x + 2, tree.z - 1), `the moved tree survives ${Object.keys(patch)[0]}`);
    assert.ok(near(again.placements.find(p => p.key === pad.key), -20, 5));
    assert.deepEqual(again.orphans, []);
  }
  // A new seed grows a new village: the village edits name trees that no longer exist and are reported, not lost;
  // the mission pad's edit still applies, because the pad is still that step's.
  // Moving the start or a pad, or removing a gate, is a hand edit too: the village it was generated with stays.
  for (const more of [{ start: { x: -12, z: 20 } }, { entities: [{ id: 'e1', type: 'lever', x: 25, z: 0 }] }]) {
    const again = compile(normalizeEdits({ ...edits, ...more }));
    assert.ok(near(again.placements.find(p => p.key === tree.key), tree.x + 2, tree.z - 1)); assert.deepEqual(again.orphans, []);
  }
  const reseeded = compileShooterProject({ ...base, seed: 'ZZZZ-4444-QQQQ', edits }, pack);
  assert.ok(reseeded.orphans.includes(tree.key) && reseeded.orphans.includes(house.key), 'village edits of another seed are orphaned');
  assert.ok(near(reseeded.placements.find(p => p.key === pad.key), -20, 5), 'the pad edit survives a new seed');
}

// ---------------------------------------------------------------- the start, the extraction and painted ground
{
  const cells = emptyRegions();
  for (const k of brushCells(tree.x, tree.z, 2.5)) cells[k] = REGION_CODES.path;
  for (const k of brushCells(-25, -25, 3)) cells[k] = REGION_CODES.nogo;
  for (const k of brushCells(15, -15, 2)) cells[k] = REGION_CODES.spawn;
  const extract = base.blueprint.nodes.find(n => n.objective === 'extract');
  const level = compile(normalizeEdits({ start: { x: -12, z: 20, yaw: 1 }, regions: encodeRegions(cells), overrides: { [`step:${extract.id}:0`]: { x: 5, z: -30 } } }));
  assert.deepEqual([level.spawn.position.x, level.spawn.position.z, level.spawn.yaw], [-12, 20, 1], 'the player starts where the editor put them');
  assert.deepEqual([level.extraction.x, level.extraction.z], [5, -30], 'the extraction moves with its marker');
  assert.ok(!level.placements.some(p => p.key === tree.key || p.parent === tree.key), 'a painted path clears the tree and its trunk');
  assert.ok(level.spawnZones.length >= 12 && level.spawnZones.every(p => Math.hypot(p.x - 15, p.z + 15) < 2.5), 'spawn zones become points');
  assert.equal(compile(normalizeEdits({ start: { x: -12, z: 20, yaw: 1 } })).extraction.x, -12, 'without a marker, extraction is the start');
  // No-go cells leave the nav grid every body walks (the packed grid CollisionSystem reads).
  const painted = new CollisionSystem(level.grid), open = new CollisionSystem(plain.grid);
  let refused = 0, kept = 0;
  for (let j = 0; j < open.n; j++) for (let i = 0; i < open.n; i++) {
    const x = open.worldX(i), z = open.worldZ(j), inside = regionAt(cells, x, z) === REGION_CODES.nogo;
    if (inside && painted.walkable[j * open.n + i]) refused = -Infinity;
    if (inside && open.walkable[j * open.n + i]) refused++;
    if (!inside && painted.walkable[j * open.n + i]) kept++;
  }
  assert.ok(refused > 20, `no-go cells are refused (${refused})`);
  assert.ok(kept > 10000, 'the rest of the meadow stays walkable');
}

// ---------------------------------------------------------------- a game of levels
{
  const game = liftToGame({ ...base, edits: normalizeEdits({ start: { x: 3, z: 25 } }) });
  assert.equal(game.levels.length, 1); assert.equal(game.levels[0].seed, base.seed); assert.ok(!('seed' in game) && !('edits' in game));
  const two = addLevel(game, 0, 'QQQQ-2222-AAAA');
  assert.equal(two.levels[1].id, 'l2'); assert.ok(isEmptyEdits(two.levels[1].edits)); assert.equal(two.levels[1].seed, 'QQQQ-2222-AAAA');
  const flat = levelProject(two, 1);
  assert.equal(flat.seed, 'QQQQ-2222-AAAA'); assert.equal(flat.genre, base.genre); assert.ok(!('levels' in flat));
  const patched = patchGame(two, 1, { lighting: 'dawn', difficulty: 'hard' });
  assert.equal(patched.levels[1].lighting, 'dawn'); assert.equal(patched.levels[0].lighting, base.lighting, 'a level field stays in its level');
  assert.equal(patched.difficulty, 'hard', 'a game field is shared'); assert.equal(two.difficulty, base.difficulty, 'patching returns a new game');
  const three = duplicateLevel(patched, 1);
  assert.deepEqual(three.levels.map(l => l.id), ['l1', 'l2', 'l3']); assert.equal(three.levels[2].name, 'Level 2 copy');
  assert.deepEqual(moveLevel(three, 2, 0).levels.map(l => l.id), ['l3', 'l1', 'l2']);
  assert.deepEqual(removeLevel(three, 0).levels.map(l => l.id), ['l2', 'l3']);
  assert.throws(() => removeLevel(game, 0), /at least one level/);
  let full = game; for (let i = 1; i < 8; i++) full = addLevel(full, i - 1, 'AAAA-BBBB-CCCC');
  assert.throws(() => addLevel(full, 0, 'AAAA-BBBB-CCCC'), /up to 8 levels/);
  // Every level compiles on its own.
  for (let i = 0; i < three.levels.length; i++) assert.ok(compileShooterProject(levelProject(three, i), pack).placements.length > 50);
}

console.log('Hand edits: normalized and clamped, regions round-trip, placed things and overrides compile and survive reloads and regeneration, orphans are reported, a game of levels flattens per level');
