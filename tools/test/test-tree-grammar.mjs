/**
 * The tree grammar (src/world/treeGrammar.js): seed-reproducible, identical to the Blender preview's Python
 * port (plans and digests), constraint-respecting over a sweep, every production and part reachable, and
 * inside the canopy budget the parts index implies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateTree, treeDigest, validateTreeRules, treeSlotColor, TREE_SYMBOLS } from '../../src/world/treeGrammar.js';
import { TREE_PARTS } from '../../src/world/treeParts.js';
import { DESERT_TREE_PARTS } from '../../src/world/desertParts.js';
import { SNOW_TREE_PARTS } from '../../src/world/snowParts.js';
import { applyBiome } from '../../src/world/pack.js';
import { DIRS64 } from '../../src/world/houseGrammar.js';

const rules = JSON.parse(fs.readFileSync('packs/arcade/pack.json')).trees;
assert.deepEqual(validateTreeRules(rules, TREE_PARTS), [], 'rules name only library parts, balanced productions and complete species');
// The pack's part extents describe the library: within a few centimetres of what Blender measured.
for (const [id, ext] of Object.entries(rules.parts)) {
  const lib = TREE_PARTS[id];
  assert(lib && Math.abs(lib.r - ext.r) < 0.12 && Math.abs(lib.top - ext.top) < 0.12 && Math.abs(lib.bot - ext.bot) < 0.12, `${id}: the pack's extents match the library (${JSON.stringify(lib)} vs ${JSON.stringify(ext)})`);
  assert(TREE_PARTS[`${id}.lite`], `${id} has a lite twin`);
}
// Broken rules are named, not thrown.
assert(validateTreeRules({ ...rules, species: { x: { ...rules.species.broadleaf, axiom: 'Q' } } }).some(e => e.includes('"Q" has no production')));
assert(validateTreeRules({ ...rules, species: { x: { ...rules.species.broadleaf, rules: { T: [{ to: 'F[+B' }] } } } }).some(e => e.includes('unbalanced')));
assert(validateTreeRules({ ...rules, species: { x: { ...rules.species.broadleaf, leaf: { ...rules.species.broadleaf.leaf, parts: ['nope'] } } } }).some(e => e.includes('"nope"')));

// The same key is the same tree; a different key is (almost always) a different one.
const a = generateTree(rules, { species: 'broadleaf', key: 'K7QN|3' }), b = generateTree(rules, { species: 'broadleaf', key: 'K7QN|3' });
assert.deepEqual(a, b);
assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'a plan is plain data');
assert.notDeepEqual(generateTree(rules, { species: 'broadleaf', key: 'K7QN|4' }).dna, a.dna);
assert.notDeepEqual(treeDigest(generateTree(rules, { species: 'broadleaf', key: 'K7QN|4' })), treeDigest(a));
assert.equal(treeSlotColor(a, 'Leaf'), a.palette.leaf);
assert.equal(treeSlotColor(a, 'Bark'), a.palette.bark);

// Parity with tools/blender/v2/arcade/tree_grammar.py: what Blender previews is what the game grows.
const fixtures = JSON.parse(fs.readFileSync('tools/test/fixtures/tree-plans.json'));
assert(fixtures.length >= Object.keys(rules.species).length * 20);
for (const { request, plan, digest } of fixtures) {
  const p = generateTree(rules, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(treeDigest(p), digest, `digest parity ${JSON.stringify(request)}`);
}

// Sweep: every tree respects its species' limits, stands on the ground, keeps its clumps above the floor and
// inside the crown cap, chains its segments, and never hits the segment or socket caps (the rules are sized
// under them; the caps are guards).
const L = rules.limits, seen = { successors: new Set(), parts: new Set(), forms: new Set() };
const tris = { full: {}, lite: {} };
for (const [species, S] of Object.entries(rules.species)) {
  // the widest lean any form may set (a leaning oak raises the species' limit through `set`)
  const maxLean = Math.max(S.lean, ...(S.plan ?? []).flatMap(st => st.options.map(o => o.set?.lean ?? 0))), cosLean = DIRS64[maxLean][0];
  let worstFull = 0, worstLite = 0, pruned = 0;
  for (let i = 0; i < 400; i++) {
    const plan = generateTree(rules, { species, key: `sweep|${i}` });
    assert.equal(plan.species, species);
    assert(plan.segments.length > 0 && plan.segments.length <= Math.min(S.segments, L.segments), `${species}/${i}: segment cap`);
    assert(plan.sockets.length > 0 && plan.sockets.length <= Math.min(S.sockets, L.sockets) + (S.tip === 'P' || /P/.test(plan.string) ? 2 : 0), `${species}/${i}: socket cap`);
    if (plan.pruned) pruned++;
    assert(plan.trunk > 0.1 && plan.trunk < 0.8 && plan.clear >= L.clear, `${species}/${i}: a trunk to collide with (${plan.trunk}, clear ${plan.clear})`);
    assert(plan.crown >= plan.trunk * 2 && plan.top > plan.clear, `${species}/${i}: a crown above the trunk`);
    for (const ch of plan.string) assert(TREE_SYMBOLS.includes(ch), `${species}/${i}: only terminals survive rewriting`);
    // segments: the first stands on the origin, every other starts where its parent ends, none dips under the floor
    const first = plan.segments[0];
    assert.deepEqual(first.a, [0, 0, 0]);
    assert.equal(first.d, 0); assert.equal(first.i, -1);
    for (const g of plan.segments) {
      if (g.i >= 0) { const parent = plan.segments[g.i]; assert.deepEqual(g.a, parent.b, `${species}/${i}: segments chain`); assert(g.d >= parent.d); assert(g.r0 <= parent.r1 + 1e-9, 'a child is no thicker than its parent'); }
      assert((g.d === 0 ? g.b[2] > g.a[2] : g.b[2] >= L.floor - 1e-9) && g.r1 >= S.twig - 1e-9 && g.r1 <= g.r0 + 1e-9, `${species}/${i}: a tapered segment above the floor`);
      assert(Math.hypot(g.b[0], g.b[1]) <= plan.crown + 1e-6, `${species}/${i}: branches stay inside the crown`);
      // the trunk stays inside its lean cone
      if (g.d === 0) { const l = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]); assert((g.b[2] - g.a[2]) / l >= cosLean - 1e-6, `${species}/${i}: the trunk leans at most ${maxLean}/64 turn`); }
    }
    for (const q of plan.sockets) {
      const ext = rules.parts[q.part];
      assert(ext && rules.parts[q.part], `${species}/${i}: a known part`);
      assert(q.p[2] + ext.bot * q.s >= L.floor - 1e-3, `${species}/${i}: no clump under the floor`);
      assert(Math.hypot(q.p[0], q.p[1]) + ext.r * q.s <= plan.crown + 1e-4 && q.p[2] + ext.top * q.s <= plan.top + 1e-4, `${species}/${i}: the crown radius and top bound every clump`);
      assert(q.k >= 0 && q.k < 64 && Number.isInteger(q.k) && q.s > 0.4);
      seen.parts.add(q.part);
    }
    if (plan.style.form) seen.forms.add(`${species}/${plan.style.form}`);
    for (const c of plan.choices) seen.successors.add(`${species}/${c}`);
    // canopy budget (skeleton tubes come on top: about 16 triangles per segment full, 12 lite)
    const full = plan.sockets.reduce((s, q) => s + TREE_PARTS[q.part].tris, 0) + plan.segments.length * 16 + 48;
    const lite = plan.sockets.reduce((s, q) => s + TREE_PARTS[`${q.part}.lite`].tris, 0) + plan.segments.length * 12;
    worstFull = Math.max(worstFull, full); worstLite = Math.max(worstLite, lite);
  }
  assert(pruned <= 4, `${species}: the segment cap is a guard, not a shaper (${pruned}/400 plans pruned)`);
  tris.full[species] = worstFull; tris.lite[species] = worstLite;
  assert(worstFull <= 3400 && worstLite <= 1200, `${species}: worst tree ${worstFull} full / ${worstLite} lite triangles stays inside the mobile budget`);
}
for (const [species, S] of Object.entries(rules.species)) {
  for (const step of S.plan ?? []) for (const o of step.options) assert(seen.forms.has(`${species}/${o.id}`), `${species}: form "${o.id}" is reachable`);
  for (const pid of [...S.leaf.parts, ...(S.leaf.tips ?? [])]) assert(seen.parts.has(pid), `${species}: part "${pid}" is reachable`);
}
for (const [species, S] of Object.entries(rules.species)) for (const [ch, R] of Object.entries(S.rules)) R.forEach((o, i) => assert(seen.successors.has(`${species}/${ch}${i}`), `${species}: successor ${ch} -> "${o.to}" is reachable`));

console.log(`Tree grammar: ${fixtures.length} Python-parity plans, ${Object.keys(rules.species).length} species swept x400; worst tree triangles ${JSON.stringify(tris)}.`);

// The desert's palms and saguaros (packs/arcade/pack.json biomes.desert.trees): parity with the Python port, parts from
// the desert library, their trunk style carried to the mesher, every form and successor reachable.
const desert = applyBiome(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), 'desert').trees;
assert.deepEqual(validateTreeRules(desert, DESERT_TREE_PARTS), [], 'the desert tree rules name only desert library parts');
for (const [id, ext] of Object.entries(desert.parts)) assert(Math.abs(DESERT_TREE_PARTS[id].r - ext.r) < 0.12 && Math.abs(DESERT_TREE_PARTS[id].top - ext.top) < 0.12, `${id}: extents match the library`);
const dfx = JSON.parse(fs.readFileSync('tools/test/fixtures/tree-plans-desert.json'));
for (const { request, plan, digest } of dfx) {
  const p = generateTree(desert, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `desert plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(treeDigest(p), digest, `desert digest parity ${JSON.stringify(request)}`);
}
const dseen = new Set();
for (const [species, S] of Object.entries(desert.species)) for (let i = 0; i < 300; i++) {
  const p = generateTree(desert, { species, key: `dsweep|${i}` });
  assert.equal(p.bark, S.bark, `${species}: the trunk style reaches the mesher`);
  assert(p.top > 2 && p.top < 9 && p.sockets.length >= 1, `${species}/${i}: a crown on a trunk (${p.top} m)`);
  for (const [slot, id] of Object.entries(p.style)) dseen.add(`${species}/${id}`);
  for (const c of p.choices) dseen.add(`${species}/${c}`);
}
for (const [species, S] of Object.entries(desert.species)) {
  for (const step of S.plan ?? []) for (const o of step.options) assert(dseen.has(`${species}/${o.id}`), `${species}: "${o.id}" is reachable`);
  for (const [ch, R] of Object.entries(S.rules)) R.forEach((o, i) => assert(dseen.has(`${species}/${ch}${i}`), `${species}: successor ${ch} -> "${o.to}" is reachable`));
}
assert(!('bark' in generateTree(rules, { species: 'broadleaf', key: 'K7QN|3' })), 'meadow plans are unchanged: no trunk style');
console.log(`Desert trees: ${dfx.length} Python-parity plans, ${Object.keys(desert.species).length} species swept x300.`);

// The snow village's snowy conifers and bare trees (packs/arcade/pack.json biomes.snow.trees): parity with the Python
// port, parts from the snow library (their snow is its own colour slot), every form and successor reachable.
const snowT = applyBiome(JSON.parse(fs.readFileSync('packs/arcade/pack.json')), 'snow').trees;
assert.deepEqual(validateTreeRules(snowT, SNOW_TREE_PARTS), [], 'the snow tree rules name only snow library parts');
for (const [id, ext] of Object.entries(snowT.parts)) assert(Math.abs(SNOW_TREE_PARTS[id].r - ext.r) < 0.12 && Math.abs(SNOW_TREE_PARTS[id].top - ext.top) < 0.12, `${id}: extents match the library`);
const sfx = JSON.parse(fs.readFileSync('tools/test/fixtures/tree-plans-snow.json'));
for (const { request, plan, digest } of sfx) {
  const p = generateTree(snowT, request);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), plan, `snow plan parity ${JSON.stringify(request)}`);
  assert.deepEqual(treeDigest(p), digest, `snow digest parity ${JSON.stringify(request)}`);
}
const sseen = new Set();
for (const [species, S] of Object.entries(snowT.species)) for (let i = 0; i < 300; i++) {
  const p = generateTree(snowT, { species, key: `ssweep|${i}` });
  assert(p.top > 2 && p.top < 12 && p.sockets.length >= 1, `${species}/${i}: a crown on a trunk (${p.top} m)`);
  assert.match(treeSlotColor(p, 'Snow'), /^#[0-9a-f]{6}$/, `${species}/${i}: the snow slot has a colour`);
  for (const [slot, id] of Object.entries(p.style)) sseen.add(`${species}/${id}`);
  for (const c of p.choices) sseen.add(`${species}/${c}`);
}
for (const [species, S] of Object.entries(snowT.species)) {
  for (const step of S.plan ?? []) for (const o of step.options) assert(sseen.has(`${species}/${o.id}`), `${species}: "${o.id}" is reachable`);
  for (const [ch, R] of Object.entries(S.rules)) R.forEach((o, i) => assert(sseen.has(`${species}/${ch}${i}`), `${species}: successor ${ch} -> "${o.to}" is reachable`));
}
console.log(`Snow trees: ${sfx.length} Python-parity plans, ${Object.keys(snowT.species).length} species swept x300.`);
