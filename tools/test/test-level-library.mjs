// The games saved in this browser (editor/build/library.js): add, list newest first, touch on save, remove, the
// single game kept before the library migrating in as its first entry, and storage that refuses.
import assert from 'node:assert/strict';
import { createLibrary, LIBRARY_KEY, LEGACY_KEY } from '../../editor/build/library.js';

const memory = (seed = {}, { full = false } = {}) => {
  const m = new Map(Object.entries(seed));
  return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => { if (full) throw Error('QuotaExceededError'); m.set(k, String(v)); }, removeItem: k => m.delete(k) };
};
let t = 1000;
const clock = { now: () => t };

{
  const store = memory(), lib = createLibrary(store, clock);
  assert.deepEqual(lib.list(), []);
  assert.equal(lib.migrate(), null, 'nothing to migrate');
  const a = lib.add({ name: 'Hive Patrol', genre: 'shooter', levels: [{}, {}, {}] });
  t = 2000;
  const b = lib.add({ name: 'Honey Harvest', genre: 'collect', levels: [{}] });
  assert.match(a, /^g[a-z0-9]{10}$/); assert.notEqual(a, b);
  assert.deepEqual([a, b], ['g0000000001', 'g0000000002'], 'ids are counted, not drawn');
  assert.deepEqual(lib.list().map(e => [e.name, e.genre, e.levels]), [['Honey Harvest', 'collect', 1], ['Hive Patrol', 'shooter', 3]], 'newest first');
  assert.equal(JSON.parse(lib.text(a)).name, 'Hive Patrol', 'the document is kept under its own key');
  assert.ok(store.m.has(LIBRARY_KEY) && store.m.has(lib.key(a)));
  t = 3000; lib.touch(a, { name: 'Hive Patrol II', genre: 'shooter', levels: [{}, {}] });
  assert.deepEqual(lib.list().map(e => e.name), ['Hive Patrol II', 'Honey Harvest'], 'a save moves a game to the top and renames it');
  assert.equal(lib.list().length, 2, 'touch never duplicates');
  lib.remove(b);
  assert.deepEqual(lib.list().map(e => e.id), [a]); assert.equal(lib.text(b), null); assert.equal(lib.has(b), false);
}
{
  // The one game saved before the library becomes its first entry, and the old key goes.
  const legacy = JSON.stringify({ kind: 'visigames.project', version: 4, name: 'Arcade', genre: 'shooter', levels: [{ id: 'l1' }, { id: 'l2' }] });
  const store = memory({ [LEGACY_KEY]: legacy }), lib = createLibrary(store, clock);
  const id = lib.migrate();
  assert.ok(id); assert.equal(store.m.has(LEGACY_KEY), false);
  assert.equal(lib.text(id), legacy); assert.deepEqual(lib.list().map(e => [e.name, e.levels]), [['Arcade', 2]]);
  assert.equal(lib.migrate(), null, 'migrates once');
  const broken = memory({ [LEGACY_KEY]: '{nope' });
  assert.equal(createLibrary(broken, clock).migrate(), null); assert.ok(broken.m.has(LEGACY_KEY), 'an unreadable old game is left where it is');
}
{
  // A full storage refuses the add; nothing half-written stays behind. A corrupt index reads as empty.
  const lib = createLibrary(memory({}, { full: true }), clock);
  assert.equal(lib.add({ name: 'Too much', levels: [] }), null); assert.deepEqual(lib.list(), []);
  assert.deepEqual(createLibrary(memory({ [LIBRARY_KEY]: '{"not":"a list"}' }), clock).list(), []);
  assert.deepEqual(createLibrary(memory({ [LIBRARY_KEY]: JSON.stringify([{ id: '../x', name: 'bad' }, { id: 'gabcdefghij', name: 'ok', updated: 1 }]) }), clock).list().map(e => e.name), ['ok'], 'entries with bad ids are dropped');
}
console.log('Game library: add, newest first, touch, remove, the old single save migrated once, full and corrupt storage');
