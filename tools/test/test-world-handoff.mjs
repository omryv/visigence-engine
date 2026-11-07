/**
 * PLAY HERE: A LEVEL CUT FROM THE WORLD THE WORLD EDITOR SHOWS.
 *
 * World mode is the world engine's editor (world.html). Its world is not only a seed: a named world (Farshore,
 * Lonepalm) carries its own grammar, its own intent and the author's sculpt strokes. "Play here" hands that world to
 * Play as the project's `worldParams` (its terrain and water), and the level's ground is cut from it
 * (world/kernelGround.js worldParamsFor + worldSampler). This holds:
 *
 *   1. a project without worldParams stands on the seed's own world, exactly as before (the plain-seed fixtures in
 *      test-kernel-ground hold the heights; here, the world is makeParams({ seed }) and nothing is carried);
 *   2. a project carrying a named world's params stands on THAT world: its parameter hash is the named world's, and
 *      the world drawn around the level is the named world's sampler with its own statements and the mission's;
 *   3. the world's own statements survive the mission's: the solve meets both, and the mission is charged only its
 *      share of the cost;
 *   4. a sculpt stroke in the world is in the level's ground;
 *   5. the project format carries worldParams (terrain and water only, bounded), and it reaches the level's
 *      `ground.world.params`, which is what worldAround draws the world past the rim from;
 *   6. the link World mode hands over (src/world/worldLink.js, in the fragment: the editor stores nothing) carries
 *      the world exactly, and a link that cannot be read says why instead of playing somewhere else silently.
 *
 * Run:  node tools/test/test-world-handoff.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileShooterProject, resolveProject, normalizeWorldParams, WORLD_PARAMS_MAX_BYTES } from '../../src/world/shooterProject.js';
import { worldParamsFor, worldAround, SITE_SCALE } from '../../src/world/kernelGround.js';
import { quickMission } from '../../src/world/missionCard.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { makeParams } from '../../src/kernel/presets.js';
import { createHeightSampler } from '../../src/kernel/terrain/heightfield.js';
import { terrainParameterHash, hex } from '../../src/kernel/terrain/fingerprint.js';
import { fullParams, WORLDS } from '../../src/genesis/world/worlds.js';
import { encodeWorldLink, decodeWorldLink, worldFromLocation, WORLD_LINK_VERSION } from '../../src/world/worldLink.js';

const ok = msg => console.log(`  ok   ${msg}`);
const SEED = 'K7QN-3F2A-9XBD';
const pack = resolvePack(JSON.parse(fs.readFileSync(new URL('../../packs/arcade/pack.json', import.meta.url))), CATALOG.arcade.measurements);
const carry = (p) => ({ terrain: p.terrain, water: p.water });

// ── 1. the seed's own world ───────────────────────────────────────────────────
const plain = compileShooterProject(quickMission('arcade', SEED, 'shooter'), pack);
assert.equal(plain.ground.kind, 'world');
assert.equal(plain.ground.world.params, undefined, 'nothing is carried for the seed\'s own world');
assert.equal(plain.ground.world.parameterHash, hex(terrainParameterHash(makeParams({ seed: SEED }))));
ok(`without worldParams a level stands on the seed's own world (${plain.ground.world.parameterHash}), as before`);

// ── 2. a named world ──────────────────────────────────────────────────────────
const farshore = fullParams(WORLDS.farshore, SEED);
const project = { ...quickMission('arcade', SEED, 'shooter'), worldParams: carry(farshore) };
const level = compileShooterProject(project, pack), G = level.ground;
assert.equal(G.kind, 'world', `the mission stands on Farshore (${G.reason ?? ''})`);
const merged = worldParamsFor(SEED, carry(farshore));
assert.equal(G.world.parameterHash, hex(terrainParameterHash(merged)), 'the level\'s world is Farshore\'s params');
assert.notEqual(G.world.parameterHash, plain.ground.world.parameterHash, 'and not the plain seed\'s');
// The world the level is drawn in (worldAround) is Farshore's ground with its own statements and the mission's
// together, to the last bit. (Not "Farshore untouched far from the site": the solve's correction is a field over the
// whole lattice and reaches kilometres, measured 5.4 m at level scale 1.3 km out, so no such claim is made.)
const f = G.frame, around = worldAround(G);
const bent = createHeightSampler({ ...merged, terrain: { ...merged.terrain, intent: [...merged.terrain.intent, ...G.intent.records] } });
const at = (S, x, z) => (S(f.originX + x * SITE_SCALE, f.originZ + z * SITE_SCALE) - f.h) / SITE_SCALE;
let worst = 0;
for (const [x, z] of [[0, 0], [20, -15], [-38, 38], [100, 0], [-160, 40]]) worst = Math.max(worst, Math.abs(around.height(x, z) - at(bent, x, z)));
assert(worst < 1e-9, `the world past the rim is Farshore with both sets of statements (worst ${worst})`);
ok(`with Farshore's params the level stands on Farshore (${G.world.parameterHash}): its ground is Farshore's own statements and the mission's, exactly`);

// ── 3. the world's own statements survive ─────────────────────────────────────
assert(Array.isArray(merged.terrain.intent) && merged.terrain.intent.length > 0, 'Farshore states its own ground');
const own = createHeightSampler(merged).conditioning;
assert(G.conditioning, 'the mission bent the ground');
assert.equal(G.conditioning.worldNats, own.nats, 'the world\'s own cost is reported apart');
assert(G.conditioning.nats >= 0 && G.conditioning.nats <= 150, `the mission is charged its share (${G.conditioning.nats.toFixed(1)} nats; the world's own ${own.nats.toFixed(1)})`);
ok(`Farshore's own ${merged.terrain.intent.length} statement(s) are kept in the solve; the mission is charged ${G.conditioning.nats.toFixed(1)} nats, the world's ${own.nats.toFixed(1)} apart`);

// ── 4. sculpt ─────────────────────────────────────────────────────────────────
{
  // A raise inside the level's site, as the world editor's brush records it (a broad 24 m dome over Farshore's one
  // qualifying site disqualifies the site outright, which is the site rules working; this one keeps it).
  const strokes = [{ x: G.frame.originX, z: G.frame.originZ, r: 80, a: 4, m: 0 }];
  const sculpted = { ...carry(farshore), terrain: { ...farshore.terrain, sculpt: strokes } };
  const L2 = compileShooterProject({ ...quickMission('arcade', SEED, 'shooter'), worldParams: sculpted }, pack).ground;
  assert.equal(L2.kind, 'world', L2.reason);
  assert.equal(L2.site.x, G.site.x); assert.equal(L2.site.z, G.site.z);
  assert.notEqual(L2.heightHash, G.heightHash, 'the stroke changed the level\'s ground');
  assert.notEqual(L2.world.parameterHash, G.world.parameterHash);
  ok(`a sculpt stroke in the world is in the level's ground (${G.heightHash} → ${L2.heightHash})`);
}

// ── 5. the format ─────────────────────────────────────────────────────────────
{
  const p = resolveProject(project);
  assert.deepEqual(Object.keys(p.worldParams).sort(), ['terrain', 'water']);
  assert.equal(normalizeWorldParams(null), null);
  assert.equal(normalizeWorldParams({ water: { level: 0 } }), null, 'no terrain, no world');
  assert.deepEqual(Object.keys(normalizeWorldParams({ terrain: {}, sky: {}, props: {} })), ['terrain'], 'only terrain and water are carried');
  assert.throws(() => normalizeWorldParams([]), /object/);
  assert.throws(() => normalizeWorldParams({ terrain: { pad: 'x'.repeat(WORLD_PARAMS_MAX_BYTES) } }), /KB/);
  assert.deepEqual(G.world.params, p.worldParams, 'the level carries the world it was cut from');
  ok('the project carries worldParams (terrain and water, bounded); the level carries it on as ground.world.params');
}
// ── 6. the link ───────────────────────────────────────────────────────────────
{
  const value = encodeWorldLink({ seed: SEED, name: 'Farshore', worldParams: carry(farshore) });
  assert(/^[A-Za-z0-9_-]+$/.test(value), 'base64url: safe in a fragment as it stands');
  const back = decodeWorldLink(value);
  assert.equal(back.seed, SEED); assert.equal(back.name, 'Farshore');
  assert.deepEqual(back.worldParams, normalizeWorldParams(carry(farshore)), 'the world arrives exactly');
  const viaLink = compileShooterProject({ ...quickMission('arcade', back.seed, 'shooter'), worldParams: back.worldParams }, pack).ground;
  assert.equal(viaLink.heightHash, G.heightHash, 'and the level cut from it is the same level');
  assert.deepEqual(worldFromLocation({ hash: '#world=' + value }).world, back);
  assert.deepEqual(worldFromLocation({ hash: '' }), { world: null, error: null });
  assert.match(worldFromLocation({ hash: '#world=@@@' }).error, /cannot be read/);
  const future = btoa(JSON.stringify({ v: WORLD_LINK_VERSION + 1, seed: SEED, params: carry(farshore) }));
  assert.match(worldFromLocation({ hash: '#world=' + future }).error, /format/);
  assert.throws(() => encodeWorldLink({ seed: '', worldParams: carry(farshore) }), /seed/);
  ok(`the link carries the world exactly (${value.length} characters for Farshore) and refuses, by name, what it cannot read`);
}
console.log('World handoff: OK');
