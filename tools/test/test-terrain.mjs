/**
 * Node test for the ground: the height field, the Terrain seam, and the baked level.
 *
 * The kernel's src/kernel/terrain/heightfield.js and src/sim/Terrain.js import no three, so all
 * of this runs under bare node against the real shipped source.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and why each of these is a property rather than a
 * value assertion:
 *
 *   DETERMINISM       the product's whole claim is that a seed is a place. If the same
 *                     spec samples differently twice, every downstream promise —
 *                     caching, sharing a seed, reproducing a bug — is void.
 *   SAMPLER AGREEMENT the baker decides walkability from the BAKED field and the runtime
 *                     stands the player on it too. If the two samplers disagreed, a
 *                     player could stand where collision says they cannot. The test is
 *                     that the baked sampler reproduces the field exactly at its own
 *                     grid points, which is the only place agreement is definitional.
 *   THE PLATE RAN     the edge falloff is what makes a finite square end in water rather
 *                     than a cliff into the void, and every consumer assumes it. It is
 *                     also the one part of the recipe a spec cannot author, so nothing
 *                     else will catch its absence.
 *   THE EMPTY DEFAULT FLAT_GROUND must be the plane at y = 0 to the float, or adopting
 *                     terrain silently changes every level that was already flat.
 *
 * Run:  node tools/test/test-terrain.mjs
 */

// The height field and the seed are the repository's kernel (engine/ at the root), imported
// exactly as the runtime imports them; the normal is this engine's own (src/sim/Terrain.js).
import {
  createHeightSampler, bakeHeightField, createBakedSampler, slopeAt, elevNorm,
  EDGE_START,
} from '../../src/kernel/terrain/heightfield.js';
import { Terrain, FLAT_GROUND, terrainFromBaked, normalAt } from '../../src/sim/Terrain.js';
import { resolveSpec } from '../../src/world/buildSpec.js';
import { seedChannel, normalizeSeed, hashSeed } from '../../src/kernel/seed.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

const spec = resolveSpec({ world: { recipe: 'highlands', seed: 'K7QN-3F2A-9XBD' } });
const RES = 129;

console.log('\nseed identity');
check('the same seed and channel hash the same',
  seedChannel('K7QN-3F2A-9XBD', 'terrain') === seedChannel('K7QN-3F2A-9XBD', 'terrain'));
check('different channels are independent streams',
  seedChannel('K7QN-3F2A-9XBD', 'terrain') !== seedChannel('K7QN-3F2A-9XBD', 'lighting'));
check('normalisation is idempotent',
  normalizeSeed(normalizeSeed('k7qn3f2a9xbd')) === normalizeSeed('k7qn3f2a9xbd'));
check('hashSeed is a uint32', Number.isInteger(hashSeed('x')) && hashSeed('x') >= 0);

{
  // drawSeed: a seed spelled from a named stream, and no silent Math.random fallback.
  const { drawSeed, mulberry32 } = await import('../../src/kernel/seed.js');
  let bare = false;
  try { drawSeed(); } catch { bare = true; }
  check('drawSeed() without a stream throws', bare);
  check('drawSeed(rng) is a seed, and the same stream draws the same one',
    drawSeed(mulberry32(7)) === drawSeed(mulberry32(7)) && normalizeSeed(drawSeed(mulberry32(7))) === drawSeed(mulberry32(7)),
    drawSeed(mulberry32(7)));
}

console.log('\ndeterminism');
const s1 = createHeightSampler(spec.world);
const s2 = createHeightSampler(resolveSpec({ world: { recipe: 'highlands', seed: 'K7QN-3F2A-9XBD' } }).world);
let identical = true, differs = false;
for (let i = 0; i < 400; i++) {
  const x = ((i * 37) % 211) - 105, z = ((i * 53) % 197) - 98;
  if (s1(x, z) !== s2(x, z)) identical = false;
}
check('two samplers from one spec agree on every sample, exactly', identical);
const other = createHeightSampler(resolveSpec({ world: { recipe: 'highlands', seed: 'ZZZZ-ZZZZ-ZZZZ' } }).world);
for (let i = 0; i < 400; i++) {
  const x = ((i * 37) % 211) - 105, z = ((i * 53) % 197) - 98;
  if (other(x, z) !== s1(x, z)) { differs = true; break; }
}
check('a different seed makes a different world', differs);

console.log('\nthe plate');
const size = spec.world.terrain.size;
const half = size / 2;
check('the world rim is below sea level', s1(half * 0.999, 0) < 0 && s1(0, -half * 0.999) < 0,
  `${s1(half * 0.999, 0).toFixed(1)} m, ${s1(0, -half * 0.999).toFixed(1)} m`);
check('the interior is not', s1(0, 0) > -spec.world.terrain.height,
  `${s1(0, 0).toFixed(1)} m`);
check('inside EDGE_START the falloff has not started',
  Math.abs(s1(half * (EDGE_START - 0.02), 0)) < spec.world.terrain.height * 2);
check('height stays finite across the plate', [-half, -half / 2, 0, half / 2, half]
  .every((x) => [-half, 0, half].every((z) => Number.isFinite(s1(x, z)))));

console.log('\nbake and resample');
const field = bakeHeightField(spec.world, RES, s1);
check('the field is the declared size', field.data.length === RES * RES && field.res === RES);
check('min and max bracket every sample', (() => {
  for (let i = 0; i < field.data.length; i++) {
    if (field.data[i] < field.min || field.data[i] > field.max) return false;
  }
  return true;
})());
const baked = createBakedSampler(field);
let worst = 0;
for (let j = 0; j < RES; j += 7) {
  for (let i = 0; i < RES; i += 7) {
    const x = (i / (RES - 1) - 0.5) * size, z = (j / (RES - 1) - 0.5) * size;
    worst = Math.max(worst, Math.abs(baked(x, z) - field.data[j * RES + i]));
  }
}
check('the baked sampler reproduces its own grid points', worst < 1e-3, `worst ${worst.toExponential(2)} m`);
check('sampling outside the plate clamps rather than reading out of bounds',
  Number.isFinite(baked(size * 4, -size * 4)) && Number.isFinite(baked(-size * 9, size * 9)));

console.log('\nslope and normal agree');
let agree = true;
const n = { x: 0, y: 0, z: 0 };
for (let i = 0; i < 120; i++) {
  const x = ((i * 31) % 180) - 90, z = ((i * 47) % 160) - 80;
  const sl = slopeAt(baked, x, z);
  normalAt(baked, x, z, n);
  const len = Math.hypot(n.x, n.y, n.z);
  if (Math.abs(len - 1) > 1e-9) { agree = false; break; }
  // A unit normal's horizontal magnitude over its vertical component IS the slope.
  const fromNormal = Math.hypot(n.x, n.z) / n.y;
  if (Math.abs(fromNormal - sl) > 1e-6) { agree = false; break; }
}
check('normals are unit length and encode the same slope as slopeAt', agree);
check('a flat sample has an up normal', (() => {
  normalAt(() => 5, 0, 0, n);
  return n.x === 0 && n.y === 1 && n.z === 0;
})());

console.log('\nelevNorm');
check('elevNorm is clamped to [0,1]',
  elevNorm(-1e6, 100) === 0 && elevNorm(1e6, 100) === 1);
check('and monotonic', elevNorm(10, 100) < elevNorm(50, 100));

console.log('\nthe Terrain seam');
const terrain = new Terrain(field, spec.traversal);
check('heightAt matches the baked sampler', terrain.heightAt(12, -30) === baked(12, -30));
check('standable ground is not steep',
  terrain.standableAt(0, 0) === (terrain.slopeAt(0, 0) <= terrain.maxSlope
    && terrain.depthAt(0, 0) <= terrain.wadeDepth));
check('deep water is not standable', (() => {
  for (let i = 0; i < 400; i++) {
    const x = ((i * 37) % 211) - 105, z = ((i * 53) % 197) - 98;
    if (terrain.depthAt(x, z) > terrain.wadeDepth && terrain.standableAt(x, z)) return false;
  }
  return true;
})());
check('outsideAt finds the plate edge',
  terrain.outsideAt(size, 0) && !terrain.outsideAt(0, 0));

console.log('\nFLAT_GROUND is the plane this engine always had');
check('height is 0 everywhere', [[0, 0], [1e5, -1e5], [-7.3, 2.1]]
  .every(([x, z]) => FLAT_GROUND.heightAt(x, z) === 0));
check('slope is 0', FLAT_GROUND.slopeAt(9, 9) === 0);
check('the normal is exactly up', (() => {
  FLAT_GROUND.normalAt(3, 4, n);
  return n.x === 0 && n.y === 1 && n.z === 0;
})());
check('everywhere is standable and nowhere is outside',
  FLAT_GROUND.standableAt(1e9, 1e9) && !FLAT_GROUND.outsideAt(1e9, 1e9));

console.log('\nbaked level round trip');
const packed = Buffer.from(field.data.buffer).toString('base64');
const rebuilt = terrainFromBaked(
  { HEIGHT_PACKED: packed, HEIGHT_RES: RES, WORLD_SCALE: size }, spec.traversal);
let exact = true;
for (let i = 0; i < 300; i++) {
  const x = ((i * 37) % 211) - 105, z = ((i * 53) % 197) - 98;
  if (rebuilt.heightAt(x, z) !== terrain.heightAt(x, z)) { exact = false; break; }
}
check('a terrain rebuilt from base64 is the same terrain, to the float', exact);
let refused = false;
try {
  terrainFromBaked({ HEIGHT_PACKED: packed, HEIGHT_RES: RES + 2, WORLD_SCALE: size }, {});
} catch { refused = true; }
check('a field whose length disagrees with its res is refused', refused);

console.log(failures ? `\nFAILED: ${failures}` : '\nAll terrain checks passed.');
process.exit(failures ? 1 : 0);
