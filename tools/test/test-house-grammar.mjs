/**
 * The house grammar (src/world/houseGrammar.js): seed-reproducible, identical to the Blender preview's Python
 * port (plans and expansions), constraint-respecting over a sweep, and every weighted option reachable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateHouse, buildHouse, houseDigest, validateHouseRules, houseSlotColor, DIRS64 } from '../../src/world/houseGrammar.js';
import { HOUSE_PARTS } from '../../src/world/houseParts.js';
import { DESERT_HOUSE_PARTS } from '../../src/world/desertParts.js';
import { SNOW_HOUSE_PARTS } from '../../src/world/snowParts.js';
import { applyBiome } from '../../src/world/pack.js';

const rules = JSON.parse(fs.readFileSync('packs/arcade/pack.json')).houses;
assert.deepEqual(validateHouseRules(rules, HOUSE_PARTS), [], 'rules name only library parts, sockets that exist, and complete families');

// The same key is the same house; a different key is (almost always) a different one.
const a = generateHouse(rules, { family: 'cottage', key: 'K7QN|3' }), b = generateHouse(rules, { family: 'cottage', key: 'K7QN|3' });
assert.deepEqual(a, b);
assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'a plan is plain data');
assert.notDeepEqual(generateHouse(rules, { family: 'cottage', key: 'K7QN|4' }).dna, a.dna);
assert.deepEqual(houseDigest(buildHouse(rules, a)), houseDigest(buildHouse(rules, b)), 'the expansion is reproducible too');
for (const d of DIRS64) assert(Math.abs(Math.hypot(d[0], d[1]) - 1) < 1e-12, 'the direction table is unit length');

// Parity with tools/blender/v2/arcade/house_grammar.py: what Blender previews is what the game builds.
const fixtures = JSON.parse(fs.readFileSync('tools/test/fixtures/house-plans.json'));
assert(fixtures.length >= Object.keys(rules.families).length * 10);
for (const { request, plan, built } of fixtures) {
  const p = generateHouse(rules, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(houseDigest(buildHouse(rules, p)), built, `expansion parity ${JSON.stringify(request)}`);
}

// Sweep: every house fits its lot, has exactly one door on its front, never cuts an opening into a covered wall
// or into its neighbour, hangs parts only on sockets that exist, and stays inside the triangle budget.
const NORMAL = { '-y': [0, -1], '+x': [1, 0], '+y': [0, 1], '-x': [-1, 0] };
const inside = (x, y, blocks, skip) => blocks.some((b, i) => i !== skip && x > b.x0 + 0.01 && x < b.x1 - 0.01 && y > b.y0 + 0.01 && y < b.y1 - 0.01);
const point = (b, face, u) => (face === '-y' ? [u, b.y0] : face === '+y' ? [u, b.y1] : face === '-x' ? [b.x0, u] : [b.x1, u]);
const reached = new Set(), annexes = new Set();
let houses = 0, maxPieces = 0, maxParts = 0;
for (const [family, F] of Object.entries(rules.families)) for (let i = 0; i < 400; i++) {
  const plan = generateHouse(rules, { family, key: `sweep|${i}` }), built = buildHouse(rules, plan);
  houses++;
  const [x0, x1, y0, y1, top] = plan.bounds;
  assert(x1 - x0 <= plan.lot.w + 1e-6 && y1 - y0 <= plan.lot.d + 1e-6, `${family}/${i}: fits its lot`);
  assert(Math.abs(x0 + x1) < 0.06 && Math.abs(y0 + y1) < 0.06, `${family}/${i}: centred on its lot`);
  assert.equal(plan.colliders.length, plan.blocks.length, 'one collider per block');
  for (const b of plan.blocks) {
    assert(b.x1 - b.x0 > 1.5 && b.y1 - b.y0 > 1.5, `${family}/${i}: ${b.id} has room`);
    assert(b.roof.zr >= b.zTop, `${family}/${i}: ${b.id}'s roof sits on its walls`);
    if (b.id === 'wing') assert(b.roof.zr < plan.blocks[0].roof.zr, `${family}/${i}: the wing's ridge stays under the main one`);
  }
  if (plan.blocks[1]) annexes.add(`${family}/${plan.blocks[1].id}`);
  if (plan.chimney) assert(plan.chimney.top > plan.blocks[0].roof.zr, `${family}/${i}: the chimney clears the ridge`);
  // exactly one door, on the front
  const doors = plan.walls.flatMap(w => w.cells.filter(c => c.kind === 'door').map(() => w)).concat(plan.rings.flatMap(r => r.cells.filter(c => c.kind === 'door')));
  assert.equal(doors.length, 1, `${family}/${i}: one door`);
  if (doors[0].face) assert.equal(doors[0].face, '-y', `${family}/${i}: the door is on the front`); else assert.equal(doors[0].k, 48);
  for (const w of plan.walls) {
    const blk = plan.blocks[w.b], cells = w.cells.filter(c => c.kind !== 'blank');
    for (const c of w.cells) {
      assert(c.u > w.a && c.u < w.z, 'a bay lies inside its stretch of wall');
      const [px, py] = point(blk, w.face, c.u), [nx, ny] = NORMAL[w.face];
      assert(!inside(px + nx * 0.05, py + ny * 0.05, plan.blocks, w.b), `${family}/${i}: no opening on a covered wall`);
    }
    for (let k = 1; k < cells.length; k++) {
      const p = rules.parts[cells[k - 1].part].w, q = rules.parts[cells[k].part].w;
      assert(cells[k].u - cells[k - 1].u >= (p + q) / 2 + 0.05, `${family}/${i}: openings never overlap`);
    }
  }
  assert(top > 0 && top < 16, 'a sensible height');
  maxPieces = Math.max(maxPieces, built.pieces.length); maxParts = Math.max(maxParts, built.parts.length);
  for (const p of built.parts) {
    assert(HOUSE_PARTS[p.id], `${family}/${i}: part ${p.id} is in the library`);
    if (!p.m) assert(HOUSE_PARTS[built.parts[p.on].id].sockets.includes(p.socket), `${family}/${i}: ${built.parts[p.on].id} has a ${p.socket} socket`);
    else assert(p.m.every(Number.isFinite));
  }
  for (const pc of built.pieces) {
    assert(['prism', 'lathe'].includes(pc.k) && pc.g[1] >= pc.g[0]);
    if (pc.k === 'prism') assert(pc.p.length >= 3 && pc.w[1] > pc.w[0] && pc.f.every(Number.isFinite), `${family}/${i}: a well-formed prism`);
    assert.match(houseSlotColor(plan, pc.s), /^#[0-9a-f]{6}$/, `${family}/${i}: slot ${pc.s} has a colour`);
  }
  for (const [slot, id] of Object.entries(plan.style)) reached.add(`${family}/${slot}/${id}`);
}
assert(maxPieces < 400 && maxParts < 100, `within budget: ${maxPieces} pieces, ${maxParts} parts at most`);
for (const [family, F] of Object.entries(rules.families)) for (const step of F.plan) for (const o of step.options)
  if ((o.w ?? 1) > 0) assert(reached.has(`${family}/${step.slot}/${o.id}`), `${family}/${step.slot}: "${o.id}" is never chosen`);
for (const [family, F] of Object.entries(rules.families)) for (const o of F.plan.find(s => s.slot === 'annex')?.options ?? [])
  assert(annexes.has(`${family}/${o.id === 'tower' ? 'tower' : o.id}`), `${family}: a ${o.id} annex is never built`);

assert.throws(() => generateHouse(rules, { family: 'castle', key: 1 }), /Unknown house family/);
assert(validateHouseRules({ ...rules, families: { x: { palettes: [{}], mass: rules.families.cottage.mass, plan: [{ slot: 'door', options: [{ id: 'door.nope' }] }] } } }).length > 0, 'a family without windows, naming a missing door, is refused');
assert(validateHouseRules({ ...rules, mix: { castle: 1 } }).some(e => /unknown family/.test(e)));
console.log(`House grammar: ${fixtures.length} Python-parity houses, ${houses} swept (at most ${maxPieces} pieces, ${maxParts} parts), ${reached.size} options reached.`);

// ---------------------------------------------------------------- the desert village's flat-roofed families
// packs/arcade/pack.json biomes.desert.houses: courtyard homes, merchant houses, inns and lookout towers, on the
// same kit sizes and openings as the meadow's houses, built from the desert parts library.
const desertPack = applyBiome(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), 'desert');
const desert = desertPack.houses, lots = desertPack.world.houses.lots;
assert.deepEqual(validateHouseRules(desert, DESERT_HOUSE_PARTS), [], 'the desert rules name only desert library parts and sockets');
assert.deepEqual(desert.kit, rules.kit, 'the desert builds on the meadow houses\' kit: storey, plinth and sill heights match');
for (const [id, dims] of Object.entries(desert.parts)) if (/^(door|win)\./.test(id)) assert(dims.h >= 1.0 && dims.h <= 2.6 && dims.w >= 0.5 && dims.w <= 2.1, `${id}: openings at the meadow's scale`);
const dfx = JSON.parse(fs.readFileSync('tools/test/fixtures/house-plans-desert.json'));
for (const { request, plan, built } of dfx) {
  const p = generateHouse(desert, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `desert plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(houseDigest(buildHouse(desert, p)), built, `desert expansion parity ${JSON.stringify(request)}`);
}
const flatReached = new Set(), flatShapes = new Set();
let flatHouses = 0, flatPieces = 0;
for (const [family, F] of Object.entries(desert.families)) for (let i = 0; i < 300; i++) {
  const lot = { w: lots[family][0], d: lots[family][1] }, plan = generateHouse(desert, { family, key: `dsweep|${i}`, lot }), built = buildHouse(desert, plan);
  flatHouses++; flatPieces = Math.max(flatPieces, built.pieces.length);
  assert.equal(plan.form, 'flat');
  const [x0, x1, y0, y1, top] = plan.bounds;
  assert(x1 - x0 <= lot.w + 1e-6 && y1 - y0 <= lot.d + 1e-6, `${family}/${i}: fits its lot`);
  assert(Math.abs(x0 + x1) < 0.06 && Math.abs(y0 + y1) < 0.06, `${family}/${i}: centred on its lot`);
  assert(top > 2.5 && top < 16, `${family}/${i}: a sensible height (${top})`);
  const main = plan.blocks[0];
  for (const b of plan.blocks) {
    assert(b.x1 - b.x0 > 1.5 && b.y1 - b.y0 > 1.5 && b.roof.type === 'flat' && b.roof.zr > b.zTop, `${family}/${i}: ${b.id} is a flat-roofed block with a parapet`);
    if (b.id === 'loft') assert(b.z0 === main.zTop && b.x0 >= main.x0 && b.x1 <= main.x1 && b.y0 >= main.y0 && b.y1 <= main.y1, `${family}/${i}: the roof room stands on the main roof`);
    if (b.id === 'wing') assert(b.zTop <= main.zTop && b.roof.zr <= main.roof.zr + 1e-9, `${family}/${i}: the wing steps down from the house`);
  }
  // Every ground block collides; so do the courtyard's walls and the stair; the main block's box is as tall as the house.
  assert.equal(plan.colliders[0].h, top, `${family}/${i}: the main block's collider reaches the top`);
  const solid = plan.blocks.filter(b => b.z0 < 1).length + (plan.stair ? 1 : 0);
  assert(plan.colliders.length >= solid + (plan.court ? 2 : 0) && plan.colliders.length <= solid + (plan.court ? 4 : 0), `${family}/${i}: one box per ground block, the stair and each courtyard wall`);
  if (plan.court) {
    const C = plan.court;
    assert(C.gate && C.gate.u > C.x0 + 1 && C.gate.u < C.x1 - 1 && C.y1 === main.y0, `${family}/${i}: the courtyard lies before the door, its gateway on the door's line`);
    assert(plan.colliders.length >= 3, `${family}/${i}: the courtyard walls collide`);
    flatShapes.add(`${family}/court`);
  }
  if (plan.stair) { assert(plan.stair.top === plan.blocks[1].zTop && plan.stair.x1 - plan.stair.x0 > 2.4, `${family}/${i}: the stair climbs to the terrace`); flatShapes.add(`${family}/stair`); }
  if (plan.dome) { assert(plan.dome.r >= desert.flat.dome.r[0] && plan.dome.top > main.roof.zr, `${family}/${i}: the dome rises over the parapet`); flatShapes.add(`${family}/dome`); }
  for (const b of plan.blocks) flatShapes.add(`${family}/${b.id}`);
  const doors = plan.walls.flatMap(w => w.cells.filter(c => c.kind === 'door').map(c => ({ w, c })));
  assert.equal(doors.filter(d => d.w.b === 0).length, 1, `${family}/${i}: one front door`);
  assert(doors.every(d => d.w.face === '-y'), `${family}/${i}: every door (the roof room's too) faces the front`);
  for (const w of plan.walls) {
    const cells = w.cells.filter(c => c.kind !== 'blank');
    for (let k = 1; k < cells.length; k++) assert(cells[k].u - cells[k - 1].u >= (desert.parts[cells[k - 1].part].w + desert.parts[cells[k].part].w) / 2 + 0.05, `${family}/${i}: openings never overlap`);
  }
  for (const p of built.parts) {
    assert(DESERT_HOUSE_PARTS[p.id], `${family}/${i}: part ${p.id} is in the desert library`);
    if (!p.m) assert(DESERT_HOUSE_PARTS[built.parts[p.on].id].sockets.includes(p.socket), `${family}/${i}: ${built.parts[p.on].id} has a ${p.socket} socket`);
  }
  for (const pc of built.pieces) assert.match(houseSlotColor(plan, pc.s), /^#[0-9a-f]{6}$/, `${family}/${i}: slot ${pc.s} has a colour`);
  for (const [slot, id] of Object.entries(plan.style)) flatReached.add(`${family}/${slot}/${id}`);
}
assert(flatPieces < 400, `desert houses within budget: ${flatPieces} pieces at most`);
for (const [family, F] of Object.entries(desert.families)) for (const step of F.plan) for (const o of step.options)
  if ((o.w ?? 1) > 0) assert(flatReached.has(`${family}/${step.slot}/${o.id}`), `${family}/${step.slot}: "${o.id}" is never chosen`);
for (const shape of ['courtyard/court', 'courtyard/stair', 'courtyard/loft', 'merchant/dome', 'merchant/wing', 'merchant/stair', 'inn/wing', 'inn/stair', 'inn/loft', 'tower/wing'])
  assert(flatShapes.has(shape), `${shape} is never built`);
assert(validateHouseRules({ ...desert, flat: undefined }).some(e => /flat kit/.test(e)), 'flat families without the flat kit are refused');
console.log(`Desert houses: ${dfx.length} Python-parity houses, ${flatHouses} swept (at most ${flatPieces} pieces), ${flatReached.size} options reached.`);

// ---------------------------------------------------------------- the snow village's alpine families
// packs/arcade/pack.json biomes.snow.houses: log cabins, lodges, workshops and belfry watchtowers on the pitched grammar,
// every roof under the snow covering, built from the snow parts library.
const snowPack = applyBiome(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), 'snow');
const snow = snowPack.houses, slots = snowPack.world.houses.lots;
assert.deepEqual(validateHouseRules(snow, SNOW_HOUSE_PARTS), [], 'the snow rules name only snow library parts and sockets');
assert.deepEqual(snow.kit, rules.kit, 'the snow village builds on the meadow houses\' kit');
const sfx = JSON.parse(fs.readFileSync('tools/test/fixtures/house-plans-snow.json'));
assert(sfx.length >= Object.keys(snow.families).length * 10);
for (const { request, plan, built } of sfx) {
  const p = generateHouse(snow, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `snow plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(houseDigest(buildHouse(snow, p)), built, `snow expansion parity ${JSON.stringify(request)}`);
}
const snowReached = new Set(), snowWalls = new Set();
let snowHouses = 0, snowPieces = 0, snowParts = 0;
for (const [family, F] of Object.entries(snow.families)) for (let i = 0; i < 300; i++) {
  const lot = { w: slots[family][0], d: slots[family][1] }, plan = generateHouse(snow, { family, key: `ssweep|${i}`, lot }), built = buildHouse(snow, plan);
  snowHouses++; snowPieces = Math.max(snowPieces, built.pieces.length); snowParts = Math.max(snowParts, built.parts.length);
  const [x0, x1, y0, y1, top] = plan.bounds;
  assert(x1 - x0 <= lot.w + 1e-6 && y1 - y0 <= lot.d + 1e-6, `${family}/${i}: fits its lot`);
  assert(top > 3 && top < 16, `${family}/${i}: a sensible height (${top})`);
  const main = plan.blocks[0];
  snowWalls.add(`${family}/${main.walls}`);
  assert(plan.blocks.every(b => b.roof.covering === 'snow'), `${family}/${i}: every roof is under snow`);
  // Snow lies on every roof: a blanket per slope (or a cap on a cone), the ridges and hips under snow bolsters.
  assert(built.pieces.some(pc => pc.s === 'Snow'), `${family}/${i}: snow on the roof`);
  assert(!built.parts.some(p => p.id === 'roof.ridge' || p.id === 'roof.ridge.thatch'), `${family}/${i}: no bare ridge caps under snow`);
  if (plan.chimney) assert(built.pieces.filter(pc => pc.s === 'Snow').length >= 2, `${family}/${i}: the chimney wears a snow cap`);
  // A belfry's top storey is open: no openings cut into it, a bell hangs in it, a plank deck under it.
  if (main.walls === 'belfry') {
    assert(!plan.walls.some(w => w.b === 0 && w.s === main.storeys - 1), `${family}/${i}: the belfry has no walls to cut`);
    assert.equal(built.parts.filter(p => p.id === 'bell.hang').length, 1, `${family}/${i}: one bell in the belfry`);
    if (plan.style.upper) assert(plan.walls.some(w => w.cells.some(c => c.kind === 'banner')), `${family}/${i}: the banner hangs on the front`);
  }
  // Log walls: round courses, and the openings stand out on them.
  if (main.walls === 'log') assert(built.pieces.filter(pc => pc.s === 'Log').length >= 12, `${family}/${i}: log courses`);
  const doors = plan.walls.flatMap(w => w.cells.filter(c => c.kind === 'door').map(() => w));
  assert.equal(doors.length, 1, `${family}/${i}: one door`);
  assert.equal(doors[0].face, '-y', `${family}/${i}: the door is on the front`);
  for (const w of plan.walls) {
    const cells = w.cells.filter(c => c.kind !== 'blank');
    for (let k = 1; k < cells.length; k++) assert(cells[k].u - cells[k - 1].u >= (snow.parts[cells[k - 1].part].w + snow.parts[cells[k].part].w) / 2 + 0.05, `${family}/${i}: openings never overlap`);
  }
  for (const p of built.parts) {
    assert(SNOW_HOUSE_PARTS[p.id], `${family}/${i}: part ${p.id} is in the snow library`);
    if (!p.m) assert(SNOW_HOUSE_PARTS[built.parts[p.on].id].sockets.includes(p.socket), `${family}/${i}: ${built.parts[p.on].id} has a ${p.socket} socket`);
  }
  for (const pc of built.pieces) assert.match(houseSlotColor(plan, pc.s), /^#[0-9a-f]{6}$/, `${family}/${i}: slot ${pc.s} has a colour`);
  for (const [slot, id] of Object.entries(plan.style)) snowReached.add(`${family}/${slot}/${id}`);
}
assert(snowPieces < 400 && snowParts < 100, `snow houses within budget: ${snowPieces} pieces, ${snowParts} parts at most`);
for (const [family, F] of Object.entries(snow.families)) for (const step of F.plan) for (const o of step.options)
  if ((o.w ?? 1) > 0) assert(snowReached.has(`${family}/${step.slot}/${o.id}`), `${family}/${step.slot}: "${o.id}" is never chosen`);
for (const w of ['cabin/log', 'lodge/mixed', 'workshop/plank', 'watchtower/belfry']) assert(snowWalls.has(w), `${w} is never built`);
console.log(`Snow houses: ${sfx.length} Python-parity houses, ${snowHouses} swept (at most ${snowPieces} pieces, ${snowParts} parts), ${snowReached.size} options reached.`);
