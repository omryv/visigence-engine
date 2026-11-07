// The editor's live checks (world/level/checks.js) on real compiled levels: a room walled in with painted no-go
// ground and a door in its one gap proves reachability opens doors the way a player could, and nothing more.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { quickMission } from '../../src/world/missionCard.js';
import { GENRES } from '../../src/genres/registry.js';
import { normalizeEdits } from '../../src/world/level/edits.js';
import { encodeRegions, emptyRegions, REGION_CODES, regionIndex } from '../../src/world/level/regions.js';
import { checkLevel, issueCounts, BUDGETS } from '../../src/world/level/checks.js';
import { CollisionSystem } from '../../src/sim/CollisionSystem.js';
import { registerPlacementBlockers } from '../../src/sim/placementBlockers.js';

const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), CATALOG.arcade.measurements);
const base = resolveProject(quickMission('arcade'));
const compile = (edits, patch = {}) => compileShooterProject({ ...base, ...patch, edits: normalizeEdits(edits) }, pack);
const check = (edits, patch) => checkLevel(compile(edits, patch), { genre: GENRES[patch?.genre ?? base.genre] });
const codes = r => r.issues.map(i => i.code);
const has = (r, code, ref) => r.issues.some(i => i.code === code && (ref === undefined || i.ref === ref));

// A generated mission is clean: every pad, the extraction and the start are fine.
const plain = check({});
assert.deepEqual(plain.issues.filter(i => i.severity === 'error'), [], `a generated mission has no errors: ${codes(plain)}`);
assert.ok(plain.stats.reached > plain.stats.walkable * 0.5, 'most of the meadow is reachable from the start');
assert.ok(plain.issues.every(i => i.at === null || (Number.isFinite(i.at.x) && Number.isFinite(i.at.z))), 'every located issue has a place to jump to');

// ---------------------------------------------------------------- a walled room with one gap
// Find ten metres of open ground, away from the start, the pads and the gates (the village changes with the seed).
const level0 = compile({}), probe = new CollisionSystem(level0.grid);
registerPlacementBlockers(probe, level0.placements, level0.terrain); probe.rebuildDynamicMask();
const open = (x, z) => { const k = probe.cellZ(z) * probe.n + probe.cellX(x); return probe.walkable[k] && probe.dynamicClearance[k] > 2; };
let room = null;
for (let cz = -30; cz <= 20 && !room; cz += 2) for (let cx = -30; cx <= 26 && !room; cx += 2) {
  if (Math.hypot(cx - 0, cz - 28) < 14) continue;
  let ok = true;
  for (let z = cz - 6; z <= cz + 7 && ok; z += 0.5) for (let x = cx - 6; x <= cx + 6 && ok; x += 0.5) ok = open(x, z);
  if (ok) room = { x: cx, z: cz };
}
assert.ok(room, 'the seed leaves ten open metres somewhere');
const walls = emptyRegions();
for (let d = -5; d <= 5; d++) {
  for (const [x, z] of [[room.x + d, room.z - 5], [room.x - 5, room.z + d], [room.x + 5, room.z + d]]) walls[regionIndex(x, z)] = REGION_CODES.nogo;
  if (Math.abs(d) > 1) walls[regionIndex(room.x + d, room.z + 5)] = REGION_CODES.nogo;
}
const regions = encodeRegions(walls);
const door = { id: 'd1', type: 'door', x: room.x + 0.5, z: room.z + 5.5, yaw: 0 };
const inside = { id: 'p1', type: 'pickup', x: room.x, z: room.z, props: { kind: 'health' } };
const outsideKey = { id: 'k1', type: 'key', x: room.x, z: room.z + 10, props: { color: 'amber' } };

// A hold door opens once reached, so the room is reachable.
assert.ok(!has(check({ regions, entities: [{ ...door, props: { lock: 'hold' } }, inside] }), 'pickup-unreachable'), 'a hold door opens');
// Sealed shut (no door in the gap is still a gap): prove the walls hold by filling the gap with no-go too.
{ const sealed = walls.slice(); for (let d = -1; d <= 1; d++) sealed[regionIndex(room.x + d, room.z + 5)] = REGION_CODES.nogo;
  const r = check({ regions: encodeRegions(sealed), entities: [inside, { id: 't1', type: 'trigger', x: room.x, z: room.z, props: { w: 2, d: 2 } }, { ...door, id: 'd2', x: room.x + 14, z: room.z, props: { lock: 'wired' } }], wires: [{ from: 't1', to: 'd2' }] });
  assert.ok(has(r, 'pickup-unreachable', 'p1'), 'painted no-go walls hold');
  assert.ok(has(r, 'zone-unreachable', 't1'), 'a zone nobody walks into is flagged'); }
// An amber door with its key outside opens; with the key locked inside its own room it never does.
assert.ok(!has(check({ regions, entities: [{ ...door, props: { lock: 'amber' } }, inside, outsideKey] }), 'pickup-unreachable'), 'a key opens its door');
{ const r = check({ regions, entities: [{ ...door, props: { lock: 'amber' } }, inside, { ...outsideKey, x: room.x + 2, z: room.z }] });
  assert.ok(has(r, 'key-unreachable', 'k1') && has(r, 'pickup-unreachable', 'p1'), 'a key behind its own door is an error');
  assert.equal(r.issues.find(i => i.code === 'key-unreachable').severity, 'error'); }
// Keys and locks agree by colour.
{ const r = check({ regions, entities: [{ ...door, props: { lock: 'ice' } }, inside, outsideKey] });
  assert.ok(has(r, 'lock-no-key', 'd1') && has(r, 'key-no-lock', 'k1') && has(r, 'pickup-unreachable', 'p1'), 'an ice door and an amber key do not meet'); }
// A wired door opens when the zone wired to it is walked into; unwired, it is an error.
const zone = { id: 't1', type: 'trigger', x: room.x, z: room.z + 12, props: { w: 4, d: 4 } };
assert.ok(!has(check({ regions, entities: [{ ...door, props: { lock: 'wired' } }, inside, zone], wires: [{ from: 't1', to: 'd1' }] }), 'pickup-unreachable'), 'a trigger zone opens its wired door');
{ const r = check({ regions, entities: [{ ...door, props: { lock: 'wired' } }, inside, zone] });
  assert.ok(has(r, 'door-unwired', 'd1') && has(r, 'drives-nothing', 't1') && has(r, 'pickup-unreachable', 'p1')); }

// ---------------------------------------------------------------- the start
{ const house = level0.placements.find(p => p.house && p.village);
  assert.ok(has(check({ start: { x: house.x, z: house.z } }), 'start-blocked'), 'a start inside a house is flagged');
  assert.ok(has(check({ start: { x: room.x, z: room.z }, regions: encodeRegions(walls.map((c, k) => k === regionIndex(room.x, room.z) ? REGION_CODES.nogo : c)) }), 'start-off-ground'), 'a start on no-go ground is flagged');
  const moved = check({ start: { x: room.x, z: room.z + 12 } });
  assert.deepEqual(moved.issues.filter(i => i.severity === 'error'), [], 'a start moved to open ground is fine');
  // A placed thing inside a house is named.
  assert.ok(has(check({ entities: [{ id: 'b1', type: 'prop', x: house.x, z: house.z, props: { prop: 'barrel' } }] }), 'inside-building', 'b1')); }

// ---------------------------------------------------------------- budgets and edits
{ const crowd = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, type: 'enemy', x: room.x - 4 + i * 2, z: room.z, props: { kind: 'slime', count: 5 } }));
  const r = check({ entities: crowd }, { enemyCount: 1 });
  assert.equal(r.stats.critters, 26); assert.ok(has(r, 'critters-over'), `past ${BUDGETS.crittersDesktop} awake is an error`);
  const woken = check({ entities: [...crowd, zone], wires: crowd.map(c => ({ from: 't1', to: c.id })) }, { enemyCount: 1 });
  assert.equal(woken.stats.critters, 1); assert.equal(woken.stats.sleeping, 25); assert.ok(!has(woken, 'critters-over') && !has(woken, 'critters-phone'), 'wired critters sleep until their zone fires');
  const phone = check({ entities: crowd.slice(0, 2) }, { enemyCount: 3 });
  assert.equal(phone.stats.critters, 13); assert.ok(has(phone, 'critters-phone') && !has(phone, 'critters-over')); }
{ const tree = level0.placements.find(p => p.tree && p.village && !p.landmarkOf);
  const r = check({ overrides: { [tree.key]: { removed: true } } }, { seed: 'ZZZZ-4444-QQQQ' });
  const orphan = r.issues.find(i => i.code === 'orphan');
  assert.ok(orphan && orphan.ref === tree.key && /generated tree/.test(orphan.message), 'an orphaned village edit is reported by what it was'); }
{ const r = check({ entities: [{ id: 'e1', type: 'enemy', x: level0.placements.find(p => p.house).x, z: level0.placements.find(p => p.house).z }] });
  assert.ok(has(r, 'enemy-blocked', 'e1'), 'a critter inside a house would never appear'); }
assert.ok(has(check({ entities: [{ id: 'a1', type: 'pickup', x: room.x, z: room.z + 12, props: { kind: 'ammo' } }] }, { genre: 'exploration', enemyCount: 2, blueprint: undefined }), 'supply-unused'), 'ammo in a genre without weapons is a tip');

const counts = issueCounts(check({ regions, entities: [{ ...door, props: { lock: 'ice' } }, inside, outsideKey] }).issues);
assert.deepEqual([counts.error, counts.warning], [1, 2], "one lock with no key; the key with no lock and the room behind it");
console.log('Live checks: start, reachability through hold, key and wired doors, locks and keys, wires, critter and prop budgets, orphaned edits, buildings');
