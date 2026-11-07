// The level editor's store (editor/build/store.js): named undo steps, drags as one step, the game never mutated,
// levels, selection, wires, painting and autosave. No DOM, no three.
import assert from 'node:assert/strict';
import { createStore, label } from '../../editor/build/store.js';
import { resolveGame } from '../../src/world/shooterProject.js';
import { quickMission } from '../../src/world/missionCard.js';
import { brushCells, decodeRegions, REGION_CODES } from '../../src/world/level/regions.js';

const saves = [], timers = [];
const storage = { setItem: (k, v) => saves.push([k, v]) };
const game0 = resolveGame(quickMission('arcade'));
const s = createStore(game0, { storage, key: 'test.game', schedule: fn => { timers.push(fn); return timers.length; }, cancel: t => { timers[t - 1] = null; } });
const events = [];
s.on('*', kind => events.push(kind));
const flushTimers = () => { for (const [i, fn] of timers.entries()) if (fn) { timers[i] = null; fn(); } };

// A placed thing is one named step, and the game before it is untouched.
const barrel = s.addEntity('prop', 3, 4, { props: { prop: 'barrel' } });
assert.equal(barrel, 'e1'); assert.equal(s.undoLabel(), 'Place barrel');
assert.equal(game0.levels[0].edits.entities.length, 0, 'the old game is never mutated');
assert.ok(events.includes('game') && events.includes('history'));
// A drag is one step however many moves it took.
s.begin('Move barrel');
for (let i = 1; i <= 30; i++) s.updateEntity(barrel, { x: 3 + i * 0.1 });
s.end();
assert.equal(s.entity(barrel).x, 6); assert.equal(s.undoLabel(), 'Move barrel');
s.undo(); assert.equal(s.entity(barrel).x, 3, 'one undo takes back the whole drag');
s.redo(); assert.equal(s.entity(barrel).x, 6);
assert.equal(s.redoLabel(), ''); assert.ok(s.canUndo());
// Autosave waits for the edit to settle, then writes the whole game once.
assert.equal(saves.length, 0); flushTimers();
assert.equal(saves.length, 1); assert.equal(saves[0][0], 'test.game');
assert.equal(resolveGame(JSON.parse(saves[0][1])).levels[0].edits.entities[0].x, 6, 'what is saved reopens as it was');
assert.ok(s.state.saved);

// Generated things are moved and removed by override; houses refuse to move; pads and the start refuse to go.
assert.equal(s.setTransform('tree@1.0,2.0', { x: 5, z: 6 }, { x: 1, z: 2, yaw: 0.5 }), true);
assert.deepEqual(s.edits.overrides['tree@1.0,2.0'], { x: 5, z: 6, yaw: 0.5 });
s.translate(['tree@1.0,2.0', barrel, 'start', 'rocks@9.0,9.0'], 1, -1, 'Move', { 'rocks@9.0,9.0': { x: 9, z: 9, yaw: 0 } });
assert.deepEqual(s.edits.overrides['tree@1.0,2.0'], { x: 6, z: 5, yaw: 0.5 }); assert.deepEqual(s.edits.overrides['rocks@9.0,9.0'], { x: 10, z: 8, yaw: 0 });
assert.deepEqual(s.edits.start, { x: 1, z: 27, yaw: 0 }); assert.equal(s.entity(barrel).x, 7);
assert.equal(s.undoLabel(), 'Move'); s.undo(); assert.equal(s.edits.start, null, 'a multi-move is one step');
let notices = []; s.on('notice', n => notices.push(n.text));
assert.equal(s.setTransform('house@3.0,4.0', { x: 0, z: 0 }), false); assert.match(notices.at(-1), /removed, not moved/);
s.remove(['house@3.0,4.0', 'step:activate:0', 'start']);
assert.deepEqual(s.edits.overrides['house@3.0,4.0'], { removed: true }); assert.ok(!('step:activate:0' in s.edits.overrides));
assert.match(notices.at(-1), /moved, not deleted|mission graph/);
s.restore('house@3.0,4.0'); assert.ok(!('house@3.0,4.0' in s.edits.overrides), 'restore brings a generated thing back');

// Wires only between things that can be wired; deleting either end cuts them.
const lever = s.addEntity('lever', 0, 0), door = s.addEntity('door', 4, 0, { props: { lock: 'wired' } }), zone = s.addEntity('trigger', 8, 8);
assert.equal(s.wire(door, lever), false); assert.match(notices.at(-1), /Wires run from/);
assert.ok(s.wire(lever, door) && s.wire(zone, door)); assert.equal(s.wire(lever, door), false, 'no duplicate wire');
assert.equal(s.undoLabel(), 'Wire trigger zone to door');
s.remove([lever]); assert.deepEqual(s.edits.wires, [{ from: zone, to: door }], 'a deleted end takes its wires');
s.undo(); assert.equal(s.edits.wires.length, 2);
// Duplicating copies the wires that run between copied things.
s.select([lever, door]);
const copies = s.duplicate([lever, door], 2, 0);
assert.equal(copies.length, 2); assert.deepEqual(s.state.selection, copies);
assert.ok(s.edits.wires.some(w => w.from === copies[0] && w.to === copies[1]), 'the copy is wired like the original');
assert.equal(s.entity(copies[0]).x, 2);

// Painting a stroke is one step; the same cells painted again change nothing.
const cells = brushCells(0, 0, 2);
assert.ok(s.paint(cells, REGION_CODES.path, 'Paint path'));
assert.equal(decodeRegions(s.edits.regions)[cells[0]], REGION_CODES.path);
const steps = s.undoLabel(); assert.equal(s.paint(cells, REGION_CODES.path), false); assert.equal(s.undoLabel(), steps);

// Levels: add, rename, reorder, delete; undo brings back the level in view.
s.addLevel('BBBB-2222-CCCC'); assert.equal(s.state.levelIndex, 1); assert.equal(s.edits.entities.length, 0, 'a new level starts empty');
s.addEntity('enemy', 0, 0);
s.renameLevel(1, '  Mill run  '); assert.equal(s.level.name, 'Mill run');
s.moveLevel(1, 0); assert.equal(s.state.levelIndex, 0); assert.equal(s.game.levels[0].name, 'Mill run');
s.removeLevel(0); assert.equal(s.game.levels.length, 1); assert.equal(s.level.name, 'Level 1');
s.undo(); assert.equal(s.game.levels.length, 2); assert.equal(s.level.name, 'Mill run', 'undo returns to the level it happened in');
s.selectLevel(1); assert.equal(s.state.selection.length, 0, 'switching level clears the selection');
// Flat patches split between the game and the level.
s.patch({ lighting: 'dawn', difficulty: 'hard' });
assert.equal(s.level.lighting, 'dawn'); assert.equal(s.game.levels[0].lighting, game0.levels[0].lighting); assert.equal(s.game.difficulty, 'hard');
s.setPublish({ adBreaks: true }); assert.deepEqual(s.game.publish, { adBreaks: true, rewardedContinue: false, showCredits: true });
{ const before = s.undoLabel(), undoable = s.canUndo(); assert.equal(s.setPublish({ adBreaks: true }), false, 'setting a switch to what it is makes no step'); assert.equal(s.undoLabel(), before); assert.equal(s.canUndo(), undoable); }
// Limits are notices, not throws.
const doors = s.edits.entities.filter(e => e.type === 'door').length, many = [];
for (let i = 0; i < 13; i++) many.push(s.addEntity('door', i, -10));
assert.equal(many.filter(Boolean).length, 12 - doors); assert.match(notices.at(-1), /12 door/);
// The whole history reopens: the saved game resolves.
s.flush(); assert.equal(resolveGame(JSON.parse(saves.at(-1)[1])).levels.length, 2);
assert.equal(label({ type: 'pickup', props: { kind: 'ammo' } }), 'pebble pouch');
// Opening another game saves the first where it was, then saves the new one under its own key.
s.addEntity('lever', 1, 1);
const other = resolveGame(quickMission('arcade', 'CCCC-3333-DDDD', 'collect'));
s.open(other, { key: 'test.other' });
assert.equal(saves.at(-1)[0], 'test.game', 'the pending change lands in the old game');
assert.equal(s.canUndo(), false, 'a fresh history');
s.addEntity('collectible', 2, 2); s.flush();
assert.equal(saves.at(-1)[0], 'test.other');
s.persist(); assert.equal(saves.at(-1)[0], 'test.other', 'persist writes at once, pending or not');
console.log('Level store: named steps, drags as one step, an untouched game, overrides, wires, duplicates, painting, levels, autosave');
