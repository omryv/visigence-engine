/**
 * Node test for the build spec — the file the whole product compiles.
 *
 * None of src/world/buildSpec.js imports three, so it runs under bare node. What is
 * checked here is not "does it return an object": it is the four properties the product
 * promise rests on, each of which fails silently in a way a screenshot cannot show.
 *
 *   RESOLUTION IS TOTAL      a user who chose nothing still gets a complete, valid spec
 *   RESOLUTION IS IDEMPOTENT typing the defaults explicitly must build the same world as
 *                            typing nothing, or the cache splits in two
 *   THE HASH IS CANONICAL    two specs that differ only in key ORDER are one spec; if
 *                            they hash differently every cache hit becomes a rebuild and
 *                            "zero marginal cost" stops being true
 *   VERSIONS ARE HONEST      a spec from a newer generator is refused, not reinterpreted
 *
 * Run:  node tools/test/test-buildspec.mjs
 */

import {
  defaultSpec, resolveSpec, parseSpec, specHash, canonicalize,
  TERRAIN_RECIPES, TRAVERSAL_DEFAULTS, GENERATOR_VERSION, SPEC_KIND,
} from '../../src/world/buildSpec.js';
import { resolveProject } from '../../src/world/shooterProject.js';
import { createHeightSampler } from '../../src/kernel/terrain/heightfield.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

console.log('\ndefaults');
const d = resolveSpec();
check('the empty spec resolves', d.kind === SPEC_KIND);
check('it names a real recipe', !!TERRAIN_RECIPES[d.world.recipe]);
check('terrain params are complete', ['size', 'height', 'frequency', 'octaves', 'seaLevel']
  .every((k) => Number.isFinite(d.world.terrain[k])));
check('traversal is complete', Object.keys(TRAVERSAL_DEFAULTS)
  .every((k) => Number.isFinite(d.traversal[k])));
check('it carries a hash', /^[0-9a-f]{8}$/.test(d.specHash), d.specHash);

console.log('\nidempotence');
const twice = resolveSpec(d);
check('resolve(resolve(s)) is resolve(s)', canonicalize(twice) === canonicalize(d));
check('and hashes the same', twice.specHash === d.specHash);
const explicit = resolveSpec({
  world: { seed: defaultSpec().world.seed, recipe: 'highlands', terrain: {} },
  traversal: { ...TRAVERSAL_DEFAULTS },
});
check('typing the defaults == typing nothing', explicit.specHash === d.specHash,
  `${explicit.specHash} vs ${d.specHash}`);

console.log('\ncanonical hashing');
const a = resolveSpec({ world: { recipe: 'atoll', seed: 'AAAA-BBBB-CCCC' } });
// The same spec with its top-level keys built in a different order.
const shuffled = {};
for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
check('key order does not change the hash', specHash(shuffled) === a.specHash);
check('specHash excludes itself', specHash({ ...a, specHash: 'deadbeef' }) === a.specHash);
check('a different seed is a different build',
  resolveSpec({ world: { recipe: 'atoll', seed: 'ZZZZ-ZZZZ-ZZZZ' } }).specHash !== a.specHash);
check('a different recipe is a different build',
  resolveSpec({ world: { recipe: 'basin', seed: 'AAAA-BBBB-CCCC' } }).specHash !== a.specHash);
check('an override off a recipe is a different build',
  resolveSpec({ world: { recipe: 'atoll', seed: 'AAAA-BBBB-CCCC', terrain: { height: 99 } } })
    .specHash !== a.specHash);

console.log('\nseed normalisation');
check('lowercase and punctuation normalise to one seed',
  resolveSpec({ world: { seed: 'k7qn 3f2a:9xbd' } }).specHash
  === resolveSpec({ world: { seed: 'K7QN-3F2A-9XBD' } }).specHash);
check('an empty seed falls back rather than throwing',
  resolveSpec({ world: { seed: '' } }).world.seed === defaultSpec().world.seed);
/* The number 0 is a seed, not "no seed". The port this engine carried read it as
   0222-2222-2222; the kernel's normalizeSeed reads any falsy input as absent, so resolveSpec and
   resolveProject hand it String(seed ?? ''). Without that wrapper every world saved with
   `seed: 0` moves silently to the default seed — which is why it is pinned here, with NaN (whose
   String is "NaN") beside it. Both values are what the deleted port's normalizeSeed returned. */
check('seed 0 is the seed 0222-2222-2222, not the default',
  resolveSpec({ world: { seed: 0 } }).world.seed === '0222-2222-2222',
  resolveSpec({ world: { seed: 0 } }).world.seed);
check('seed NaN is the seed NAN2-2222-2222',
  resolveSpec({ world: { seed: NaN } }).world.seed === 'NAN2-2222-2222',
  resolveSpec({ world: { seed: NaN } }).world.seed);
{
  const base = { name: 'seed zero', genre: 'action', theme: 'arcade' };
  const zero = resolveProject({ ...base, seed: 0 }).seed;
  check('a project saved with seed 0 keeps 0222-2222-2222', zero === '0222-2222-2222', zero);
  const nan = resolveProject({ ...base, seed: NaN }).seed;
  check('a project saved with seed NaN keeps NAN2-2222-2222', nan === 'NAN2-2222-2222', nan);
}

console.log('\nkernel-only terrain fields are stripped');
/* The kernel honours terrain.stack and terrain.intent; this spec format never did (buildSpec.js
   resolveSpec says why they are stripped). A spec carrying them must build the recipe's own world
   — the same terrain params, the same hash, the same heights. */
{
  const plain = resolveSpec({ world: { recipe: 'highlands', seed: 'K7QN-3F2A-9XBD' } });
  const carrying = resolveSpec({ world: { recipe: 'highlands', seed: 'K7QN-3F2A-9XBD', terrain: {
    intent: [{ type: 'pad', x: 0, z: 0, r: 60, h: 30 }], stack: { layers: [{ type: 'billow' }] } } } });
  check('stack and intent do not survive resolution',
    !('stack' in carrying.world.terrain) && !('intent' in carrying.world.terrain));
  check('a spec carrying them hashes as the spec without them', carrying.specHash === plain.specHash,
    `${carrying.specHash} vs ${plain.specHash}`);
  const hp = createHeightSampler(plain.world), hc = createHeightSampler(carrying.world);
  const probes = [[0, 0], [10, 10], [-80, 55], [130, -170]];
  check('and builds the recipe\'s world, height for height',
    hc.kind === 'analytic' && hc.conditioning === null && probes.every(([x, z]) => hc(x, z) === hp(x, z)),
    `kind ${hc.kind}, h(0,0) ${hc(0, 0)} vs ${hp(0, 0)}`);
}

console.log('\nrefusals');
let threw = false;
try { resolveSpec({ world: { recipe: 'no-such-recipe' } }); } catch { threw = true; }
check('an unknown recipe throws instead of falling back', threw);
threw = false;
try {
  parseSpec({ kind: SPEC_KIND, generatorVersion: GENERATOR_VERSION + 1, world: {} });
} catch { threw = true; }
check('a spec from a newer generator is refused', threw);
threw = false;
try { parseSpec({ kind: 'something.else' }); } catch { threw = true; }
check('a foreign file is refused', threw);

console.log('\nround trip');
const json = JSON.stringify(a);
check('a spec survives JSON', parseSpec(json).specHash === a.specHash);
check('it is small enough to be a URL-sized artefact', json.length < 4096, `${json.length} bytes`);

console.log('\nevery recipe is well formed');
for (const [name, r] of Object.entries(TERRAIN_RECIPES)) {
  const s = resolveSpec({ world: { recipe: name } });
  check(`${name} resolves and is shooter-scaled`,
    s.world.terrain.size >= 200 && s.world.terrain.size <= 800,
    `${r.size} m`);
}

console.log(failures ? `\nFAILED: ${failures}` : '\nAll build-spec checks passed.');
process.exit(failures ? 1 : 0);
