/**
 * The level builder's editing model: every edit is one undo step (a whole brush stroke, a
 * paste, a level reorder), undo and redo restore the exact document, one-per-level parts move
 * rather than multiply, wires follow what they join, and the game autosaves to this browser.
 *   node tools/test/test-builder-store.mjs
 */
import assert from 'node:assert/strict';

// the store saves to localStorage; a Map stands in for it here
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };

const { createStore, readRecent, loadSaved, forgetSaved } = await import('../../../src/play2d/editor/store.js');
const { createProject, serializeProject } = await import('../../../src/play2d/core/format.js');
const { templateById } = await import('../../../src/play2d/templates/index.js');

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };
const doc = s => serializeProject(s.project);

await test('a brush stroke is one undo step, and undo restores the exact document', () => {
  const s = createStore(createProject('platformer'));
  const before = doc(s);
  s.begin('Paint');
  for (let x = 2; x < 9; x++) s.setCell('terrain', x, 3, 1);
  s.end();
  assert.equal(s.undoLabel(), 'Paint');
  assert.notEqual(doc(s), before);
  s.undo();
  assert.equal(doc(s), before);
  assert.equal(s.canUndo(), false);
  s.redo();
  for (let x = 2; x < 9; x++) assert.equal(s.cellAt('terrain', x, 3), 1);
});

await test('painting the same code twice records nothing', () => {
  const s = createStore(createProject('adventure'));
  s.setCell('terrain', 3, 3, 20);
  s.setCell('terrain', 3, 3, 20);
  s.undo();
  assert.equal(s.canUndo(), false);
});

await test('adding, duplicating and reordering levels undo in one step each', () => {
  const s = createStore(createProject('maze'));
  const before = doc(s);
  s.addLevel(); s.duplicateLevel(0); s.moveLevel(2, 0);
  assert.equal(s.project.levels.length, 3);
  s.undo(); s.undo(); s.undo();
  assert.equal(doc(s), before);
  s.redo(); s.redo(); s.redo();
  assert.equal(s.project.levels.length, 3);
});

await test('the player start moves instead of multiplying; capped parts are refused', () => {
  const s = createStore(createProject('platformer'));
  const p0 = s.level.entities.filter(e => e.type === 'player');
  const e = s.placeEntity('player', 5, 2);
  assert.equal(s.level.entities.filter(x => x.type === 'player').length, Math.max(1, p0.length));
  assert.deepEqual([e.x, e.y], [5, 2]);
  const notes = [];
  s.on('notice', n => notes.push(n.text));
  const l = s.level;
  let placed = 0;
  for (let i = 0; i < 40; i++) if (s.placeEntity('goal', 10 + (i % 20), 1 + Math.floor(i / 20))) placed++;
  assert.ok(placed < 40, 'the goal type has a cap');
  assert.ok(notes.some(t => /at most/.test(t)));
  assert.ok(l.entities.length <= 600);
});

await test('wires connect only what can drive what, and vanish with a deleted part', () => {
  const s = createStore(createProject('adventure'));
  const lever = s.placeEntity('switch', 3, 3);
  const gate = s.placeEntity('door', 6, 3);
  const coin = s.placeEntity('coin', 8, 3);
  assert.equal(s.addLink(lever.id, gate.id), true);
  assert.equal(s.addLink(lever.id, gate.id), false, 'no duplicate wire');
  assert.equal(s.addLink(coin.id, gate.id), false, 'a honey drop drives nothing');
  s.removeEntities([gate.id]);
  assert.equal(s.level.links.length, 0);
  s.undo();
  assert.equal(s.level.links.length, 1);
});

await test('copy and paste carries tiles, parts and the wires between them', () => {
  const s = createStore(createProject('adventure'));
  s.setCell('terrain', 2, 2, 20);
  const lever = s.placeEntity('switch', 3, 2);
  const gate = s.placeEntity('door', 4, 2);
  s.addLink(lever.id, gate.id);
  s.setRegion({ x: 2, y: 2, w: 3, h: 1 });
  assert.equal(s.copy(), true);
  s.paste(2, 6);
  assert.equal(s.cellAt('terrain', 2, 6), 20);
  const copies = s.level.entities.filter(e => e.y === 6);
  assert.equal(copies.length, 2);
  assert.equal(s.level.links.length, 2);
  const [a, b] = [copies.find(e => e.type === 'switch'), copies.find(e => e.type === 'door')];
  assert.ok(s.level.links.some(k => k.from === a.id && k.to === b.id));
  s.undo();
  assert.equal(s.level.entities.filter(e => e.y === 6).length, 0);
});

await test('flipping a region mirrors tiles and parts and turns facing parts around', () => {
  const s = createStore(createProject('platformer'));
  s.setCell('terrain', 1, 1, 3);
  const slime = s.placeEntity('slime', 2, 1);
  s.flipRegion({ x: 0, y: 0, w: 6, h: 3 });
  assert.equal(s.cellAt('terrain', 4, 1), 3);
  assert.equal(s.cellAt('terrain', 1, 1), 0);
  assert.equal(s.entity(slime.id).x, 3);
});

await test('moving a selection past the edge is refused', () => {
  const s = createStore(createProject('adventure'));
  const c = s.placeEntity('coin', 1, 1);
  assert.equal(s.moveEntities([c.id], -5, 0), false);
  assert.equal(s.moveEntities([c.id], 2, 1), true);
  assert.deepEqual([s.entity(c.id).x, s.entity(c.id).y], [3, 2]);
});

await test('resizing keeps the anchored corner and undoes', () => {
  const s = createStore(createProject('platformer'));
  const before = doc(s);
  const { width, height } = s.level;
  s.resizeLevel(width + 10, height + 2, 0, 1);
  assert.equal(s.level.width, width + 10);
  assert.equal(s.level.height, height + 2);
  s.undo();
  assert.equal(doc(s), before);
});

await test('generated levels go in as one undo step, with fresh ids, after the current level or in place of all', async () => {
  const { generateLevels } = await import('../../../src/play2d/core/generate.js');
  const made = generateLevels('maze', { count: 3, seed: 'store' }).levels.map(r => r.level);
  const s = createStore(createProject('maze'));
  const before = doc(s);
  assert.equal(s.insertLevels(made), 3);
  assert.equal(s.project.levels.length, 4);
  assert.equal(s.state.levelIndex, 1, 'the first new level is selected');
  assert.ok(s.project.levels.slice(1).every(l => !made.some(m => m.id === l.id)), 'fresh level ids');
  assert.equal(s.undoLabel(), 'Add generated levels');
  s.undo();
  assert.equal(doc(s), before);
  s.redo();
  assert.equal(s.project.levels.length, 4);
  // twice over: nothing collides
  s.insertLevels(made);
  assert.equal(new Set(s.project.levels.map(l => l.id)).size, 7);
  // replace: every level goes, one step brings them all back
  const full = doc(s);
  assert.equal(s.insertLevels(made.slice(0, 2), { replace: true, label: 'Use generated levels' }), 2);
  assert.equal(s.project.levels.length, 2);
  assert.equal(s.state.levelIndex, 0);
  s.undo();
  assert.equal(doc(s), full);
  // the 24-level cap
  const many = Array.from({ length: 30 }, () => made[0]);
  assert.equal(s.insertLevels(many), 24 - 7);
  assert.equal(s.project.levels.length, 24);
});

await test('the game autosaves, lists itself as recent, and loads back', () => {
  mem.clear();
  const p = templateById('crate-garden').build({ id: 'save-test' });
  const s = createStore(p);
  s.setProject({ title: 'Saved garden' });
  s.save(true);
  const recent = readRecent();
  assert.equal(recent[0].id, 'save-test');
  assert.equal(recent[0].title, 'Saved garden');
  assert.equal(recent[0].levels, 3);
  const back = loadSaved('save-test');
  assert.equal(serializeProject(back), doc(s));
  forgetSaved('save-test');
  assert.equal(loadSaved('save-test'), null);
  assert.equal(readRecent().length, 0);
});

await test('a full browser storage is reported, not thrown', () => {
  const s = createStore(createProject('maze'));
  const events = [];
  s.on('saved', e => events.push(e));
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try { s.save(true); } finally { globalThis.localStorage.setItem = real; }
  assert.equal(events.at(-1).ok, false);
});

console.log(`ok ${passed} builder store tests`);
