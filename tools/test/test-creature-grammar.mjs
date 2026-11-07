/**
 * The creature grammar (src/world/creatureGrammar.js): seed-reproducible, constraint-respecting,
 * every weighted option reachable, and identical to the Blender preview's Python port.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateCreature, validateCreatureRules, creatureRng } from '../../src/world/creatureGrammar.js';
import { CREATURE_PARTS } from '../../src/world/creatureParts.js';

const rules = JSON.parse(fs.readFileSync('packs/arcade/pack.json')).creatures;
assert.deepEqual(validateCreatureRules(rules, CREATURE_PARTS), [], 'rules name only library parts and existing sockets');

// The same key is the same creature; a different key is (almost always) a different one.
const a = generateCreature(rules, { family: 'shroom', key: 'K7QN|3' }), b = generateCreature(rules, { family: 'shroom', key: 'K7QN|3' });
assert.deepEqual(a, b);
assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'a blueprint is plain data');
assert.notDeepEqual(generateCreature(rules, { family: 'shroom', key: 'K7QN|4' }).dna, a.dna);
assert.equal(creatureRng('x')(), creatureRng('x')());

// Parity with tools/blender/v2/arcade/creature_grammar.py: what Blender previews is what the game spawns.
const fixtures = JSON.parse(fs.readFileSync('tools/test/fixtures/creature-blueprints.json'));
assert(fixtures.length >= Object.keys(rules.families).length * 2);
for (const { request, blueprint } of fixtures) assert.deepEqual(generateCreature(rules, request), blueprint, `parity ${JSON.stringify(request)}`);

// Sweep: constraints hold, bosses carry their required parts, moods match the role, and every
// option with weight can actually be reached.
const reached = new Set();
let creatures = 0;
for (const [family, F] of Object.entries(rules.families)) for (const role of ['hostile', 'friendly']) for (let i = 0; i < 1500; i++) {
  const bp = generateCreature(rules, { family, key: `sweep|${i}`, role });
  creatures++;
  assert.equal(bp.parts[0].slot, 'body');
  assert(Object.keys(F.moods?.[role] ?? rules.moods[role]).includes(bp.face.expression), `${family}: ${role} mood`);
  const chosen = new Map(bp.parts.map(p => [p.slot, p.part]));
  for (const step of F.plan) {
    const pick = step.kind === 'pattern' ? bp.patterns.find(p => p.slot === step.slot)?.pattern : chosen.get(step.slot);
    if (step.chance === undefined && step.kind !== 'pattern') assert(pick, `${family}: required slot ${step.slot}`);
    if (!pick) continue;
    reached.add(`${family}/${step.slot}/${pick}`);
    const option = step.options.find(o => (o.part ?? o.pattern) === pick);
    const tags = new Set(bp.parts.flatMap(p => F.plan.find(s => s.slot === p.slot).options.find(o => o.part === p.part).tags ?? []));
    for (const t of option.clash ?? []) assert(!tags.has(t), `${family}: ${pick} clashes with ${t}`);
    assert(!option.rank || option.rank.includes('minion'), `${family}: ${pick} is reserved for ${option.rank}`);
  }
  for (const p of bp.patterns) { assert(Number.isInteger(p.count) && p.count > 0); assert(p.size > 0); }
  for (const hex of Object.values(bp.palette)) assert.match(hex, /^#[0-9a-f]{6}$/);
  assert(bp.face.eye >= 1 && bp.face.eye <= 1.35);
}
for (const [family, F] of Object.entries(rules.families)) for (const step of F.plan) for (const o of step.options)
  if ((o.w ?? 1) > 0 && !o.rank) assert(reached.has(`${family}/${step.slot}/${o.part ?? o.pattern}`) || o.pattern === 'none', `${family}/${step.slot}: "${o.part ?? o.pattern}" is never generated`);
for (const r of rules.roster.filter(r => r.rank === 'boss')) {
  const boss = generateCreature(rules, { family: r.family, key: 'boss', rank: 'boss' }), F = rules.families[r.family];
  for (const req of F.boss.require) assert(boss.parts.some(p => p.part === req), `${r.id}: boss wears ${req}`);
  assert.equal(boss.face.expression, F.boss.expression);
}
assert.throws(() => generateCreature(rules, { family: 'dragon', key: 1 }), /Unknown creature family/);
assert(validateCreatureRules({ ...rules, families: { x: { palettes: [{}], plan: [{ slot: 'top', options: [] }] } } }).length > 0, 'a plan without a body is refused');
console.log(`Creature grammar: ${fixtures.length} Python-parity blueprints, ${creatures} swept creatures, ${reached.size} options reached.`);
