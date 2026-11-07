/**
 * KERNEL GROUND: an Arcade level on a site of its seed's Visigenesis world (src/world/kernelGround.js), and that
 * level played (src/game/Game.js fromWorld) with par from the kernel's own walker (src/world/levelPar.js).
 *
 *   1. the fixture's grounds are what the kernel gives today, height for height (tools/build/kernel-ground-fixtures.mjs
 *      wrote them; the world fixtures lay villages out on them in both ports);
 *   2. the ground IS the world: every height is the conditioned sampler's on the plate, rebuilt here from the seed
 *      and the reported statements alone, through the documented map h = (H(site + 8·x) − floor) / 8;
 *   3. the site is dry ground on the canonical lattice, and the mission is met: pads and points at the floor, every
 *      corridor within its grade;
 *   4. a world with no site, and one where the mission costs too much at every site, say so and build nothing;
 *   5. projects: absent means the village (every saved project keeps its world), `world` stands on the kernel,
 *      anything else is refused; the compiled level reports the very ground kernelGround gives;
 *   6. the world around the level (worldAround, render/ArcadeGround.js `beyond`): the same ground past the rim, its sea,
 *      a seam that cannot open, the triangle budgets;
 *   7. every genre's template mission on two seeds, played: the kernel's walker reaches every place the mission
 *      stands at that the game's nav grid reaches (and the nav grid reaches all of them), each leg has a par, and the
 *      real PlayerController, walked at the fixed step along the nav grid's path, gets from the start to the first
 *      objective in a time par bounds.
 *
 * Run:  node --import ./tools/lib/_three-real-hook.mjs tools/test/test-kernel-ground.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kernelGround, groundInputs, rankSites, findSite, worldAround, SITE_SCALE, SITE_GRID, SITE_DRY, SITE_NATS, SITE_MET, SITE_TRIES } from '../../src/world/kernelGround.js';
import { buildGroundGeometry, buildSeaGeometry, WORLD_BEYOND } from '../../src/render/ArcadeGround.js';
import { levelPar } from '../../src/world/levelPar.js';
import { compileShooterProject, resolveProject, GROUNDS, NEW_PROJECT_GROUND } from '../../src/world/shooterProject.js';
import { quickMission } from '../../src/world/missionCard.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { r4, gridHash } from '../../src/world/layoutCore.js';
import { GENRE_IDS } from '../../src/genres/registry.js';
import { Game } from '../../src/game/Game.js';
import { FIXED_STEP, PLAYER } from '../../src/config/gameplay.js';
import { makeParams } from '../../src/kernel/presets.js';
import { createHeightSampler } from '../../src/kernel/terrain/heightfield.js';
import { polylineSamples, CORRIDOR_STEP } from '../../src/kernel/terrain/condition.js';
import { canonicalStep } from '../../src/kernel/terrain/canonical.js';
import { hex } from '../../src/kernel/terrain/fingerprint.js';

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json')), rules = source.world;
const pack = resolvePack(source, CATALOG.arcade.measurements);
const V = rules.terrain.traversal;
const ok = msg => console.log(`  ok   ${msg}`);

// ── 1. the fixture is the kernel's ground today ─────────────────────────────
const grounds = JSON.parse(fs.readFileSync('tools/test/fixtures/kernel-ground.json'));
assert(grounds.length >= 3);
for (const f of grounds) {
  const g = kernelGround(f.inputs);
  assert(g.ok, `${f.case}: has a site`);
  assert.equal(g.heightHash, f.heightHash, `${f.case}: the same ground (run node tools/build/kernel-ground-fixtures.mjs, then the world fixtures, when the kernel's ground changes on purpose)`);
  assert.deepEqual(g.heights, f.heights, `${f.case}: height for height`);
  assert.deepEqual(JSON.parse(JSON.stringify([g.site, g.frame])), [f.site, f.frame], `${f.case}: the same site and frame`);
  assert.deepEqual(kernelGround(f.inputs), g, `${f.case}: the same inputs, the same ground`);
}
ok(`${grounds.length} fixture grounds are the kernel's, height for height`);

// ── 2 & 3. the ground is the world, on a dry site, and the mission is met ───
for (const f of grounds) {
  const g = kernelGround(f.inputs), { site, frame } = g;
  const params = makeParams({ seed: f.inputs.seed }), plain = createHeightSampler(params);
  const H = createHeightSampler({ ...params, terrain: { ...params.terrain, intent: g.intent.records } });
  assert.equal(frame.scale, SITE_SCALE); assert.equal(SITE_SCALE, canonicalStep(params.terrain.size), 'a level metre is one canonical lattice step');
  assert(site.x % SITE_GRID === 0 && site.z % SITE_GRID === 0, 'the site is on the survey lattice');
  assert((site.x + params.terrain.size / 2) % canonicalStep(params.terrain.size) === 0 && (site.z + params.terrain.size / 2) % canonicalStep(params.terrain.size) === 0, 'and on the canonical lattice');
  const toPlate = (x, z) => [site.x + x * SITE_SCALE, site.z + z * SITE_SCALE];
  let worst = 0, dryLo = Infinity;
  for (let j = 0; j < g.res; j++) for (let i = 0; i < g.res; i++) {
    const x = -g.size / 2 + i * g.cell, z = -g.size / 2 + j * g.cell;
    if ((i * 7 + j * 3) % 5 === 0) worst = Math.max(worst, Math.abs(g.heights[j * g.res + i] - r4((H(...toPlate(x, z)) - frame.h) / SITE_SCALE)));
    dryLo = Math.min(dryLo, plain(...toPlate(x, z)));
  }
  assert.equal(worst, 0, `${f.case}: every height is the conditioned world's on the plate`);
  assert.equal(g.heightHash, hex(gridHash(g.heights)));
  assert(dryLo > 0, `${f.case}: the whole site is above the sea on the level's own lattice (lowest ${dryLo.toFixed(2)} m)`);
  assert(site.lo > SITE_DRY, `${f.case}: and ${SITE_DRY} m clear of it on the survey`);
  assert(g.conditioning.converged && g.conditioning.nats <= SITE_NATS && g.conditioning.miss <= SITE_MET, `${f.case}: the solve converged, cheaply, and met`);
  for (const [k, rec] of g.intent.records.entries()) {
    if (rec.type === 'pad' || rec.type === 'point') {
      assert(Math.abs(H(rec.x, rec.z) - rec.h) <= SITE_MET, `${f.case}: ${g.intent.sources[k].objective} ${rec.type} stands at the floor`);
      const lx = (rec.x - site.x) / SITE_SCALE, lz = (rec.z - site.z) / SITE_SCALE;
      if (Number.isInteger(lx) && Number.isInteger(lz)) assert(Math.abs(g.heights[(lz + g.size / 2) * g.res + lx + g.size / 2]) <= SITE_MET / SITE_SCALE + 1e-4, `${f.case}: and at the level's zero`);
    }
    if (rec.type === 'corridor') {
      const pts = polylineSamples(rec.points, CORRIDOR_STEP);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], d = Math.hypot(b.x - a.x, b.z - a.z);
        assert(Math.abs(H(b.x, b.z) - H(a.x, a.z)) <= rec.maxGrade * d + 1e-3, `${f.case}: a corridor keeps its grade`);
      }
    }
  }
}
ok('every height is the conditioned world on a dry site of the canonical lattice; pads at the floor, corridors in grade');

// ── 4. no site, or none the mission is cheap on ────────────────────────────
{
  const steps = grounds[0].inputs.steps, base = { size: 80, cell: 1, steps, spawn: { x: 0, z: 28 }, maxSlope: V.maxSlope };
  const sea = kernelGround({ ...base, seed: 'TEST-1234-ABCD' });
  assert.equal(sea.ok, false); assert.match(sea.reason, /no 640 m site/);
  const plain = createHeightSampler(makeParams({ seed: 'TEST-1234-ABCD' }));
  assert.equal(findSite(plain, makeParams({ seed: 'TEST-1234-ABCD' }).terrain, 640), null);
  assert.deepEqual(rankSites(plain, makeParams({ seed: 'TEST-1234-ABCD' }).terrain, 640).sites, []);
  // AAAA-BBBB-CCCC's few dry sites all sit against the plate's coastal falloff, where four stations cost thousands of nats.
  const level = compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'AAAA-BBBB-CCCC', cover: 'light', objectives: 4, ground: 'world' }), pack);
  const dear = level.ground;
  assert.equal(dear.kind, 'village', 'a world whose sites all cost the mission too much keeps the village');
  assert.equal(dear.asked, 'world'); assert.match(dear.reason, /costs more than 150 nats/);
  assert.equal(dear.tried.length, SITE_TRIES); assert(dear.tried.every(t => !t.converged || t.nats > SITE_NATS || t.miss > SITE_MET), JSON.stringify(dear.tried));
}
ok('a world that is all sea has no site; one where the mission is too dear at every site it tries says so');

// ── 5. projects ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(GROUNDS, ['village', 'world']); assert.equal(NEW_PROJECT_GROUND, 'world');
  assert.equal(resolveProject({}).ground, 'village', 'a project that says nothing keeps the village');
  assert.deepEqual(resolveProject({ ground: 'village' }), resolveProject({}));
  assert.throws(() => resolveProject({ ground: 'moon' }), /Unsupported ground: moon/);
  assert.equal(quickMission('arcade', 'K7QN-3F2A-9XBD', 'shooter').ground, 'world', 'the mission cards stand on the world');
  const project = quickMission('arcade', 'K7QN-3F2A-9XBD', 'shooter'), level = compileShooterProject(project, pack);
  assert.equal(level.ground.kind, 'world');
  const direct = kernelGround(groundInputs(level.project, level.blueprint, compileShooterProject({ ...project, ground: 'village' }, pack).placements.filter(p => p.stepId), rules));
  assert.equal(level.ground.heightHash, direct.heightHash, 'the level reports the very ground kernelGround gives');
  assert.deepEqual(level.ground.site, direct.site);
  assert.deepEqual(compileShooterProject({ ...project, ground: 'village' }, pack).ground, { kind: 'village' });
  // The village shapes the world's ground the way it shaped its own hills (lanes cut in, lots and pads levelled, water
  // carved), and leaves the rest exactly as the kernel gave it: measured on K7QN, a quarter of the vertices untouched
  // and the others moved by a few tens of centimetres on average.
  const raw = direct.heights, fin = level.world.terrain.heights;
  let same = 0, moved = 0;
  for (let i = 0; i < raw.length; i++) { if (raw[i] === fin[i]) same++; moved += Math.abs(raw[i] - fin[i]); }
  const share = same / raw.length, mean = moved / raw.length;
  assert(share > 0.15 && mean < 0.5, `the village reshapes the world's ground, it does not replace it (${(100 * share).toFixed(0)}% untouched, mean change ${mean.toFixed(3)} m)`);
  console.log(`  ok   projects: absent is the village, 'world' stands on the kernel; K7QN's level keeps ${(100 * share).toFixed(0)}% of the world's heights exactly and moves it ${mean.toFixed(2)} m on average`);
}

// ── 6. the world around the level ───────────────────────────────────────────
{
  const level = compileShooterProject(quickMission('arcade', 'K7QN-3F2A-9XBD', 'shooter'), pack), G = level.ground;
  assert(Array.isArray(G.intent.records) && G.intent.records.length >= 2, 'the level carries the statements its ground was solved for');
  const W = worldAround(G), direct = kernelGround(groundInputs(level.project, level.blueprint, compileShooterProject({ ...quickMission('arcade', 'K7QN-3F2A-9XBD', 'shooter'), ground: 'village' }, pack).placements.filter(p => p.stepId), rules));
  let worst = 0;
  for (let j = 0; j < direct.res; j++) for (let i = 0; i < direct.res; i++) worst = Math.max(worst, Math.abs(r4(W.height(-40 + i, -40 + j)) - direct.heights[j * direct.res + i]));
  assert.equal(worst, 0, 'the world around the level is the ground the level was cut from, at every vertex of it');
  assert(Math.abs(W.sea - (0 - G.frame.h) / SITE_SCALE) < 1e-12 && W.sea < direct.min, 'its sea is the world\'s, below the whole level');
  assert(W.plate.x0 < -40 && W.plate.x1 > 40 && W.plate.z0 < -40 && W.plate.z1 > 40, 'the level lies inside the plate');
  // The plate's edge sinks into open sea (src/kernel/terrain/heightfield.js edgeDrop), and so does the world around a level.
  for (const [x, z] of [[W.plate.x1 + 30, 0], [0, W.plate.z1 + 30], [W.plate.x0 - 30, 0], [0, W.plate.z0 - 30]]) assert(W.height(x, z) < W.sea, `past the plate's edge at (${x}, ${z}), open sea`);
  const T = level.world.terrain, tint = () => [0.4, 0.6, 0.3];
  for (const lite of [false, true]) {
    const g = buildGroundGeometry(T, rules.terrain.skirt, { lite, beyond: { height: W.height, tint } }), P = g.attributes.position.array, F = g.attributes.far.array;
    let rim = 0, seam = 0, inside = 0;
    for (let v = 0, k = 0; v < P.length; v += 3, k += 4) {
      const x = P[v], z = P[v + 2], out = Math.max(Math.abs(x) - 40, Math.abs(z) - 40, 0);
      // The rim's grid vertices are the level's own heights. (A lite cell refined to 1 m puts its rim midpoint on the
      // coarse edge, so it meets the coarse cell outside: that vertex is on the edge by construction, not a grid vertex.)
      const onAxis = g.userData.axis.includes(x) && g.userData.axis.includes(z);
      if (out === 0) { inside = Math.max(inside, F[k + 3]); if ((Math.abs(x) === 40 || Math.abs(z) === 40) && onAxis) { rim++; seam = Math.max(seam, Math.abs(P[v + 1] - T.heights[Math.round(z + 40) * T.res + Math.round(x + 40)])); } }
      else assert(F[k + 3] <= 1 - WORLD_BEYOND.keep + 1e-6 && Math.abs(P[v + 1] - W.height(x, z)) < 1e-4, 'past the rim, the world\'s ground, tinted');
    }
    assert(rim >= (lite ? 80 : 320) && seam < 1e-6, `${lite ? 'lite' : 'full'}: the rim is the level's own ground, so the seam cannot open (${rim} vertices, worst ${seam})`);
    assert.equal(inside, 0, 'the meadow keeps its lawn');
    const { total } = g.userData.tris, sea = buildSeaGeometry(g.userData.axis, 40, W.sea, W.height);
    assert(total <= (lite ? 13000 : 28000) && sea.userData.tris <= (lite ? 3500 : 5000), `${lite ? 'lite' : 'full'}: ground ${total} and sea ${sea.userData.tris} triangles inside the budgets`);
    const SP = sea.attributes.position.array, idx = sea.index.array;
    for (let v = 1; v < SP.length; v += 3) assert.equal(SP[v], Math.fround(W.sea));
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map(q => [SP[q * 3], SP[q * 3 + 2]]);
      assert((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0, 'every sea triangle faces the sky');
    }
  }
  ok(`the world around the level: the ground it was cut from, its sea ${(-W.sea).toFixed(1)} m below the floor, a seamless rim, inside the triangle budgets`);
}

// ── 7. played: par, two walkers, a real walk ────────────────────────────────
let played = 0, legs = 0, walks = 0;
for (const seed of ['K7QN-3F2A-9XBD', 'HOUS-E5AR-EFUN']) for (const genre of GENRE_IDS) {
  const project = quickMission('arcade', seed, genre);
  const game = Game.fromWorld(project, { pack });
  const level = game.level, tag = `${seed}/${genre}`;
  assert.equal(level.ground.kind, 'world', `${tag}: on its world`);
  const par = levelPar(level, V);
  assert(par, `${tag}: a par`);
  // A fight in the square (an arena's waves) stands nowhere: there is nothing to walk to, and par says so.
  if (!par.legs.length) {
    assert(level.blueprint.mission.every(s => ['waves', 'eliminate', 'boss', 'survive', 'extract'].includes(s.objective)), `${tag}: only a mission that stands nowhere has no legs`);
    assert.equal(par.seconds, 0); game.dispose(); played++; continue;
  }
  for (const leg of par.legs) {
    const nav = game.collision.findPath(level.spawn.position.x, level.spawn.position.z, leg.to[0], leg.to[1], 1);
    assert(nav, `${tag}: the nav grid reaches ${leg.objective} at ${leg.to}`);
    assert(leg.seconds !== null && leg.verdict !== 'error', `${tag}: so does the kernel's walker, with a par (${leg.objective} ${leg.verdict})`);
    legs++;
  }
  assert(par.seconds > 0 && Number.isFinite(par.seconds), `${tag}: the mission has a par`);
  // The real body at the fixed step, along the nav grid's path to the first place the mission stands at. It cannot be
  // hurt (the walk is about the ground), and it is steered, not teleported: whatever stops it stops a player too.
  const first = par.legs[0];
  game.player.damage = () => {};
  game.start();
  const path = game.collision.findPath(level.spawn.position.x, level.spawn.position.z, first.to[0], first.to[1], 1).map(p => ({ ...p }));
  let w = 0, ticks = 0;
  const limit = Math.ceil((first.seconds * 3 + 10) / FIXED_STEP);
  while (ticks < limit) {
    const p = game.player.position;
    while (w < path.length - 1 && Math.hypot(path[w].x - p.x, path[w].z - p.z) < 0.6) w++;
    if (Math.hypot(first.to[0] - p.x, first.to[1] - p.z) < 1.6) break;
    const dx = path[w].x - p.x, dz = path[w].z - p.z, l = Math.hypot(dx, dz) || 1;
    const yaw = game.player.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    game.step({ move: { x: (dx * -fz + dz * fx) / l, y: (dx * fx + dz * fz) / l } });
    ticks++;
  }
  const seconds = ticks * FIXED_STEP, arrived = Math.hypot(first.to[0] - game.player.position.x, first.to[1] - game.player.position.z) < 1.6;
  assert(arrived, `${tag}: the body walks to ${first.objective} (${seconds.toFixed(1)} s, par ${first.seconds} s)`);
  assert(seconds <= first.seconds * 3 + 10, `${tag}: within three times par`);
  assert(seconds >= first.seconds * 0.5 - 1, `${tag}: and no faster than half of it (${seconds.toFixed(1)} s against ${first.seconds} s)`);
  walks++; played++;
  game.dispose();
}
assert.equal(PLAYER.walkSpeed, levelPar(compileShooterProject(quickMission('arcade', 'K7QN-3F2A-9XBD', 'shooter'), pack), V).body.walk, 'par walks at the player\'s pace');
ok(`${played} template missions on their worlds: ${legs} legs, every one reached by both walkers with a par; the body walked ${walks} first legs inside their par band`);
console.log('Kernel ground: OK');
