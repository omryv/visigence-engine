/**
 * The world grammar (src/world/worldGrammar.js): seed-reproducible, identical to the Blender preview's Python
 * port (through fixtures), and, in a compiled Arcade level, a village that keeps every place the mission
 * claimed clear and reachable, never overlaps its own solids, and stays inside the mobile budgets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layoutWorld, worldDigest, validateWorldRules, worldFields, unreachable, hash3, vnoise } from '../../src/world/worldGrammar.js';
import { NATURE_PARTS } from '../../src/world/natureParts.js';
import { TREE_PARTS } from '../../src/world/treeParts.js';
import { treeDigest } from '../../src/world/treeGrammar.js';
import { compileShooterProject, resolveProject } from '../../src/world/shooterProject.js';
import { resolvePack, applyBiome, biomePack } from '../../src/world/pack.js';
import { DESERT_NATURE_PARTS, DESERT_TREE_PARTS } from '../../src/world/desertParts.js';
import { SNOW_NATURE_PARTS, SNOW_LANDMARK_PARTS } from '../../src/world/snowParts.js';
import { validateLandmarkRules } from '../../src/world/worldLandmarks.js';
import { CATALOG } from '../../src/world/catalog.js';
import { DIRS64 } from '../../src/world/houseGrammar.js';
import { buildGroundGeometry, buildWaterGeometry } from '../../src/render/ArcadeGround.js';

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json')), rules = source.world;
assert.deepEqual(validateWorldRules(rules, NATURE_PARTS, source.trees), [], 'the rules name only library parts and tree species, and are complete');

// The lattice hash and the noise are the same on both sides of the fixture: spot values pinned here.
assert(hash3(0, 0, 1) >= 0 && hash3(0, 0, 1) < 1 && hash3(3, -7, 99) !== hash3(-7, 3, 99), 'the hash is asymmetric and in range');
for (const [x, z] of [[0.5, 0.5], [-12.25, 7.75], [33.9, -33.9]]) { const n = vnoise(x, z, 12345); assert(n >= 0 && n <= 1); }
const F = worldFields(rules, 'K7QN-3F2A-9XBD');
assert(F.village(0, rules.paths.square.z) > F.village(35, -35), 'the village is densest at its square');

// Parity with tools/blender/v2/arcade/world_grammar.py: what Blender previews is what the game compiles. The last
// cases stand on the kernel's ground (src/world/kernelGround.js): their relief is data both ports read, by index into
// kernel-ground.json, which tools/test/test-kernel-ground.mjs holds to the kernel itself.
const grounds = JSON.parse(fs.readFileSync('tools/test/fixtures/kernel-ground.json'));
const reliefOf = request => request.reliefRef === undefined ? {} : { relief: { res: grounds[request.reliefRef].res, heights: grounds[request.reliefRef].heights } };
const fixtures = JSON.parse(fs.readFileSync('tools/test/fixtures/world-layouts.json'));
assert(fixtures.length >= 16);
for (const sfxName of ['', '-desert', '-snow'])
  assert.equal(JSON.parse(fs.readFileSync(`tools/test/fixtures/world-layouts${sfxName}.json`)).filter(f => f.request.reliefRef !== undefined).length, grounds.length, `world-layouts${sfxName}: a village on every kernel ground`);
for (const { request, digest } of fixtures) {
  const layout = layoutWorld(rules, { ...request, ...reliefOf(request), houseRules: source.houses, treeRules: source.trees });
  assert.deepEqual(JSON.parse(JSON.stringify(worldDigest(layout))), digest, `layout parity ${request.seed}`);
}
const first = fixtures[0].request;
assert.deepEqual(worldDigest(layoutWorld(rules, { ...first, houseRules: source.houses, treeRules: source.trees })), worldDigest(layoutWorld(rules, { ...first, houseRules: source.houses, treeRules: source.trees })), 'a layout is reproducible');
assert.notDeepEqual(worldDigest(layoutWorld(rules, { ...first, seed: 'other', houseRules: source.houses, treeRules: source.trees })).scatter, fixtures[0].digest.scatter, 'another seed is another village');

// Compiled levels: every reserved place clear and reachable, solids apart, budgets kept, tiers identical.
const pack = resolvePack(source, CATALOG.arcade.measurements);
const solid = p => p.collision && p.collision !== 'none';
const hx = p => { const c = Math.abs(Math.cos(p.yaw ?? 0)), s = Math.abs(Math.sin(p.yaw ?? 0)); return p.collision === 'circle' ? [p.radius, p.radius] : [p.halfX * c + p.halfZ * s, p.halfX * s + p.halfZ * c]; };
let levels = 0, houses = 0, trees = 0, flora = 0, worst = { trees: 0, houses: 0, fences: 0, rocks: 0, treeTrisFull: 0, treeTrisLite: 0 };
const T = rules.terrain, V = T.traversal;
let ponds = 0, brooks = 0, bridges = 0, leaning = 0, relief = { min: Infinity, max: -Infinity };
/**
 * The relief (world/worldTerrain.js) in a compiled level: everything stands on it, pads and lots are level, lanes
 * keep their grade, the water keeps off the places the mission claimed and the lots, its surface only descends,
 * and the engine's Terrain (the nav grid's source) refuses a pond's deep centre but lets the brook be waded.
 */
function checkTerrain(level, tag) {
  const G = level.terrain, W = level.world.water, L = level.world.terrain, P = level.placements;
  assert(G.field?.res === L.res && G.size === rules.size, `${tag}: the level's ground is the layout's grid`);
  relief.min = Math.min(relief.min, L.min); relief.max = Math.max(relief.max, L.max);
  // The village's own hills keep to its rules; a world's ground keeps to the range the kernel gave it, the village only
  // levelling within it and carving its water below it.
  const top = level.ground.kind === 'world' ? level.ground.max : T.relief.height + T.relief.swell, floor = level.ground.kind === 'world' ? level.ground.min : 0;
  assert(L.max <= top + 0.01 && L.min > floor - T.ponds.depth - 0.5, `${tag}: heights within the rules (${L.min}..${L.max})`);
  // Everything stands on the ground: never above it, never buried (a footprint takes its lowest point).
  for (const p of P) {
    if (p.collisionOnly && p.id !== 'house-block' && p.id !== 'tree-trunk') continue;
    const h = G.heightAt(p.x, p.z);
    if (['lily.pad', 'lily.bloom'].includes(p.part)) { assert(p.y >= h - 1e-3, `${tag}: a lily floats`); continue; }
    if (p.part === 'stone.step' && G.depthAt(p.x, p.z) > 0) {
      // a ford's stepping stone stands in the brook, its top just out of the water
      assert(p.y >= h - 0.05 && p.y <= h + G.depthAt(p.x, p.z) + 0.02, `${tag}: a ford stone stands in the brook`);
      continue;
    }
    if (p.part === T.basin.part) {
      // the pool's kerb stands on the ground round its rim; its middle is the carved bowl the water fills
      // (the brook's channel comes in on one side, its banks a quarter of the way round: five of the eight probes
      // round the kerb are on uncut ground)
      let on = 0;
      for (let k = 0; k < 64; k += 8) if (Math.abs(G.heightAt(p.x + DIRS64[k][0] * (T.basin.r + 0.15), p.z + DIRS64[k][1] * (T.basin.r + 0.15)) - p.y) < 0.2) on++;
      assert(on >= 5, `${tag}: the pool's kerb sits on the ground (${on}/8)`);
      assert(h < p.y, `${tag}: the pool is a bowl`);
      continue;
    }
    assert(p.y <= h + 0.02 && p.y >= h - 0.9, `${tag}: ${p.id}${p.part ? '/' + p.part : ''} at ${p.x},${p.z} stands on the ground (y ${p.y}, ground ${h.toFixed(3)})`);
  }
  // Pads and lots are level: the spawn, every mission place and every house block.
  const flat = (x, z, r) => { let lo = Infinity, hi = -Infinity; for (let k = 0; k < 64; k += 8) for (const f of [0.35, 0.7]) { const h = G.heightAt(x + DIRS64[k][0] * r * f, z + DIRS64[k][1] * r * f); lo = Math.min(lo, h); hi = Math.max(hi, h); } return hi - lo; };
  const padR = r => r * T.pads.flat * 0.9;
  assert(flat(0, 28, padR(rules.clear.spawn)) < 0.03, `${tag}: the spawn is level`);
  // A checkpoint moved onto the route (world/routeGraph.js) stands at a landmark's foot: level where it stands, on that landmark's pad.
  for (const p of P.filter(q => q.stepId || q.interaction)) assert(flat(p.x, p.z, p.route !== undefined ? 0.6 : padR(p.role === 'gate' ? rules.clear.gate : rules.clear.site)) < 0.03, `${tag}: ${p.id} stands on a level pad`);
  for (const b of P.filter(q => q.id === 'house-block')) {
    for (const [dx, dz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) assert(Math.abs(G.heightAt(b.x + dx * b.halfX * 0.8, b.z + dz * b.halfZ * 0.8) - b.y) < 0.03, `${tag}: a house block sits on its levelled lot`);
  }
  // Lanes keep an easy grade (their profile, and the ground along their centre where nothing else claimed it).
  for (const l of level.world.lanes) for (let i = 1; i < l.pts.length; i++) {
    const d = Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]);
    assert(Math.abs(l.h[i] - l.h[i - 1]) <= T.lanes.grade * d + 2e-4, `${tag}: ${l.id} keeps its grade`);
  }
  // The water.
  ponds += W.ponds.length;
  for (const p of W.ponds) {
    assert(!G.standableAt(p.x, p.z) && G.depthAt(p.x, p.z) > V.wade, `${tag}: a pond's centre is too deep to wade`);
    for (const q of P.filter(q => q.stepId || q.interaction || q.house)) assert(Math.hypot(q.x - p.x, q.z - p.z) > p.reach + 2, `${tag}: a pond keeps off ${q.id}`);
  }
  const B = W.brook;
  if (B) {
    brooks++; bridges += B.bridges.length;
    for (let i = 1; i < B.surface.length; i++) assert(B.surface[i] <= B.surface[i - 1] + 1e-9, `${tag}: the brook only runs downhill`);
    const S = level.world.square, bs = B.basin;
    assert(Math.hypot(bs.x - S.x, bs.z - S.z) < S.r + rules.paths.verge + T.basin.r + T.basin.gap + 4.1, `${tag}: the brook ends in the pool at the square`);
    assert.deepEqual(B.pts.at(-1), [bs.x, bs.z]);
    for (let i = 0; i < B.pts.length; i++) {
      const [x, z] = B.pts[i];
      if (B.bridges.some(b => Math.hypot(b.x - x, b.z - z) < b.reach + 0.6)) continue;
      assert(G.depthAt(x, z) <= V.wade + 1e-6, `${tag}: the brook is waded (depth ${G.depthAt(x, z).toFixed(3)})`);
      for (const q of P.filter(q => q.stepId || q.interaction)) assert(Math.hypot(q.x - x, q.z - z) > 1.2, `${tag}: the brook keeps off ${q.id}'s pad`);
      for (const h of P.filter(q => q.house)) { const r = h.house.lot; assert(Math.abs(h.x - x) > 1 || Math.abs(h.z - z) > 1 || !r, `${tag}: the brook keeps off a lot`); }
    }
    // Every bridge stands on its lane, over the water.
    for (const b of B.bridges) {
      const lane = level.world.lanes.find(l => l.id === b.lane);
      assert(lane && P.some(p => p.part === T.bridge.part && Math.hypot(p.x - b.x, p.z - b.z) < 1e-6), `${tag}: a footbridge where the brook crosses ${b.lane}`);
    }
  }
  leaning += P.filter(p => p.lean).length;
  for (const p of P.filter(p => p.lean)) assert(p.tree.species === 'willow' && p.lean[2] > 0 && p.lean[2] <= T.lean.max + 1e-9, `${tag}: only willows lean, and not far`);
  // The wildlife zones sit on dry, gentle ground.
  for (const z of level.world.zones) assert(G.depthAt(z.x, z.z) === 0 && G.slopeAt(z.x, z.z) <= rules.wildlife.slope + 0.05, `${tag}: a wildlife clearing on dry, gentle ground`);
}
const treeTris = (plan, lite) => plan.sockets.reduce((s, q) => s + TREE_PARTS[lite ? `${q.part}.lite` : q.part].tris, 0) + plan.segments.length * (lite ? 12 : 16) + (lite ? 0 : 48);
// Every check below runs on both grounds: the village's own hills, and its seed's Visigenesis world (world/kernelGround.js).
// TEST-1234-ABCD's world is nearly all sea and AAAA-BBBB-CCCC's has no site the mission is cheap on, so asked for their
// worlds both keep the village's ground and say why.
const onWorld = { world: 0, fellBack: 0 }, waterOn = { village: { levels: 0, brooks: 0, ponds: 0 }, world: { levels: 0, brooks: 0, ponds: 0 } };
for (const ground of ['village', 'world']) for (const genre of ['shooter', 'exploration']) for (const seed of ['K7QN-3F2A-9XBD', 'TEST-1234-ABCD', 'AAAA-BBBB-CCCC', 'HOUS-E5AR-EFUN', 'WRLD-0001', 'WRLD-0002', 'WRLD-0003', 'WRLD-0004', 'WRLD-0005', 'WRLD-0006']) {
  for (const cover of ['light', 'dense']) {
    const project = resolveProject({ theme: 'arcade', genre, seed, cover, objectives: 4, ground }), level = compileShooterProject(project, pack);
    levels++;
    if (ground === 'world') {
      if (level.ground.kind === 'world') onWorld.world++;
      else { onWorld.fellBack++; assert(level.ground.asked === 'world' && /no 640 m site|costs more than/.test(level.ground.reason), `${seed}: a world with no site, or none the mission can be solved on, says so (${level.ground.reason})`); }
    } else assert.deepEqual(level.ground, { kind: 'village' }, 'a project that says nothing stands on the village');
    assert(level.world && level.world.lanes.length >= 2 && level.world.square, 'the level carries its layout for the ground overlay');
    const P = level.placements, C = rules.clear;
    // 1. The places the mission claimed: spawn, pads, gates and cover stand clear of every village solid.
    const claimed = [{ x: 0, z: 28, r: C.spawn, id: 'spawn' }, ...P.filter(p => p.stepId || p.interaction).map(p => ({ x: p.x, z: p.z, r: p.role === 'gate' ? C.gate : C.site, id: p.id })), ...P.filter(p => ['cover', 'barricade'].includes(p.role) && !p.village).map(p => ({ x: p.x, z: p.z, r: C.cover, id: p.id }))];
    const village = P.filter(p => p.village);
    assert(village.length > 20 && village.every(p => p.house || ['house-block', 'tree-trunk', 'fence', 'tree', 'rocks', 'nature', 'landmark', 'landmark-block'].includes(p.id) || p.pickup), 'the village marks what it placed');
    for (const c of claimed) for (const v of village) {
      if (!solid(v)) continue;
      const [ax, az] = hx(v);
      const nx = Math.max(v.x - ax, Math.min(c.x, v.x + ax)), nz = Math.max(v.z - az, Math.min(c.z, v.z + az));
      assert(Math.hypot(nx - c.x, nz - c.z) >= c.r - 0.05, `${seed}/${genre}/${cover}: ${v.id} keeps ${c.id} clear`);
    }
    // 2. Reachability: with every blocker stamped, the spawn reaches every pad, gate and cover, over the relief
    //    (steep banks and a pond's deep centre block, no step rises more than the terrain lets a body climb).
    const targets = claimed.map(c => ({ ...c, r: c.r + 0.5 }));
    assert.deepEqual(unreachable(P, level.spawn.position, targets, { terrain: level.terrain }), [], `${seed}/${genre}/${cover}: every place is reachable`);
    const was = { brooks, ponds };
    checkTerrain(level, `${seed}/${genre}/${cover}`);
    const W = waterOn[level.ground.kind]; W.levels++; W.brooks += brooks - was.brooks; W.ponds += ponds - was.ponds;
    // 3. Solids never overlap each other (the trunk sits inside its own tree, blocks inside their own house).
    const solids = P.filter(p => solid(p) && p.village && p.id !== 'tree-trunk' && p.id !== 'house-block');
    for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i], b = solids[j], [ax, az] = hx(a), [bx, bz] = hx(b);
      const apart = Math.abs(a.x - b.x) >= ax + bx - 0.01 || Math.abs(a.z - b.z) >= az + bz - 0.01;
      assert(apart, `${seed}/${genre}/${cover}: ${a.id}@${a.x},${a.z} and ${b.id}@${b.x},${b.z} overlap`);
    }
    // 4. Every house has its blocks, its lot, and stands inside the meadow; fences stay near their lots.
    const hs = P.filter(p => p.house), blocks = P.filter(p => p.id === 'house-block');
    houses += hs.length;
    assert.equal(blocks.length, hs.reduce((s, h) => s + h.house.colliders.length, 0));
    for (const h of hs) assert(Math.abs(h.x) < 37 && Math.abs(h.z) < 37 && rules.houses.lots[h.house.family][0] === h.house.lot.w);
    for (const f of P.filter(p => p.id === 'fence' && p.village)) assert(hs.some(h => Math.hypot(h.x - f.x, h.z - f.z) < 12), 'a fence belongs to a lot');
    // 5. Budgets: what collides is capped for phones; flora carries a lod for the renderer to thin.
    const count = id => P.filter(p => p.id === id).length, T = P.filter(p => p.id === 'tree'), tr = T.length;
    trees += tr; flora += count('nature');
    // Every tree carries its own plan (world/treeGrammar.js); its trunk blocker is the plan's real trunk, scaled.
    const full = T.reduce((s, p) => s + treeTris(p.tree, false), 0), lite = T.reduce((s, p) => s + treeTris(p.tree, true), 0);
    for (const t of T) {
      assert(t.tree && rules.classes.some(c => c.tree === t.tree.species) && t.crown > 0 && t.scale > (t.landmarkOf ? 0.5 : 0.8) && t.collision === 'none', 'a tree is a plan with a crown');
      const trunk = P.find(p => p.id === 'tree-trunk' && p.x === t.x && p.z === t.z);
      assert(trunk && Math.abs(trunk.radius - t.tree.trunk * t.scale) < 1e-3 && Math.abs(trunk.height - t.tree.clear * t.scale) < 1e-3, 'the blocker is the plan\'s trunk');
      assert.deepEqual(treeDigest(t.tree), treeDigest(t.tree));
    }
    worst = { trees: Math.max(worst.trees, tr), houses: Math.max(worst.houses, hs.length), fences: Math.max(worst.fences, count('fence')), rocks: Math.max(worst.rocks, count('rocks')), treeTrisFull: Math.max(worst.treeTrisFull, full), treeTrisLite: Math.max(worst.treeTrisLite, lite) };
    assert(hs.length <= rules.houses.max && count('fence') <= rules.fences.max, 'house and fence caps');
    for (const cls of rules.classes) if (cls.prop) assert(count(cls.prop) <= cls.max, `${cls.id} cap`);
    for (const cls of rules.classes) if (cls.tree) assert(T.filter(p => p.tree.species === cls.tree && !p.landmarkOf).length <= cls.max, `${cls.id} cap`);
    assert.equal(count('tree-trunk'), tr, 'every tree has a trunk blocker');
    // Crowns keep their distance: two trees stand at least crownFoot times the smaller crown apart... (the canopy footprint)
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) { const a = T[i], b = T[j]; if (a.landmarkOf || b.landmarkOf) continue; assert(Math.hypot(a.x - b.x, a.z - b.z) >= Math.min(a.crown, b.crown) * rules.crownFoot - 0.01, 'crowns keep the canopy footprint apart'); }
    for (const p of P.filter(p => p.id === 'nature')) assert(NATURE_PARTS[p.part] && [0, 1, 2].includes(p.lod) && p.collision === 'none', 'flora is a library part with a lod');
    for (const p of P.filter(p => p.pickup)) assert(!P.some(q => q.house && Math.abs(q.x - p.x) < q.house.lot.d / 2 && Math.abs(q.z - p.z) < q.house.lot.d / 2), 'a pickup never sits in a house');
    // 6. Tiers: the compiled level is the same whatever the device (the renderer thins flora by lod only).
    assert.deepEqual(P, compileShooterProject(resolveProject({ theme: 'arcade', genre, seed, cover, objectives: 4, ground }), pack).placements);
  }
}
assert(houses > 0 && trees > 0 && flora > 0);
// A creator who disconnects the flora, the fence or the house gets a village without them, not an error.
const bare = resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'BARE' });
for (const n of bare.blueprint.nodes) if (n.kind === 'props') n.items = n.items.filter(id => !['nature', 'fence', 'house', 'tree'].includes(id));
const bareLevel = compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'BARE', blueprint: bare.blueprint }), pack);
assert(!bareLevel.placements.some(p => ['nature', 'fence', 'house-block', 'tree', 'tree-trunk'].includes(p.id) || p.house || p.tree), 'disconnected classes stay out');
assert(bareLevel.placements.some(p => p.id === 'rocks'), 'the rest of the village still stands');
// The retired fixed trees resolve to the generated one.
const old = resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'OLD' });
for (const n of old.blueprint.nodes) if (n.kind === 'props') n.items = [...n.items.filter(id => id !== 'tree'), 'oak', 'pine'];
assert(compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'OLD', blueprint: old.blueprint }), pack).placements.some(p => p.tree), 'oak and pine are retired into tree');
assert(worst.treeTrisFull <= 110000 && worst.treeTrisLite <= 45000, `the worst level's trees stay inside the budget (${worst.treeTrisFull} full, ${worst.treeTrisLite} lite)`);
// Water on (nearly) every level, and the relief within the rules.
// On a world's ground the brook needs a spring standing over the pool (worldTerrain.js planBrook), and these projects
// stand four stations across the village, so the kernel holds most of its core at one floor (world/kernelGround.js
// says why a mission flattens a site) and few springs keep their fall; the ponds share the meadow with more lots.
// Measured here: 8 brooks and 16 ponds over 24 levels (the mission cards, one station each, keep a brook on 24 of 35).
const V0 = waterOn.village, W0 = waterOn.world;
assert(V0.brooks >= V0.levels * 0.9 && V0.ponds >= V0.levels * 0.6 && bridges > 0, `water on the village's levels (${V0.brooks} brooks, ${V0.ponds} ponds over ${V0.levels})`);
assert(W0.levels >= 20 && W0.brooks >= W0.levels * 0.25 && W0.ponds >= W0.levels * 0.5, `water on the world's levels (${W0.brooks} brooks, ${W0.ponds} ponds over ${W0.levels})`);
console.log(`Ground: ${onWorld.world} levels on their seed's world, ${onWorld.fellBack} kept the village's (no site the mission is met on); water ${V0.brooks}/${V0.levels} brooks on the village, ${W0.brooks}/${W0.levels} on worlds.`);
// The ground's mesh per tier (render/ArcadeGround.js): the meadow's own grid plus the skirt, inside the mobile
// budget; the lite (2 m) mesh stays close to the 1 m ground the player stands on.
const show = compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'K7QN-3F2A-9XBD', objectives: 3 }), pack).world;
const full = buildGroundGeometry(show.terrain, T.skirt), lite = buildGroundGeometry(show.terrain, T.skirt, { lite: true }), water = buildWaterGeometry(show.water, DIRS64);
assert.equal(full.userData.tris.meadow, 2 * 80 * 80, 'the full ground is the 1 m grid');
assert(lite.userData.tris.meadow >= 2 * 40 * 40 && lite.userData.tris.meadow < full.userData.tris.meadow / 2, 'the lite ground is the 2 m grid, refined only where it must be');
assert(full.userData.tris.total <= 18000 && lite.userData.tris.total <= 7000 && water.userData.tris <= 1200, `ground and water inside the budgets (${JSON.stringify(lite.userData.tris)})`);
let liteErr = 0;
{
  const pos = lite.attributes.position.array, idx = lite.index.array, H = show.terrain.heights, res = show.terrain.res, half = rules.size / 2;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3, xs = [pos[a], pos[b], pos[c]], zs = [pos[a + 2], pos[b + 2], pos[c + 2]];
    if (Math.min(...xs) < -half || Math.max(...xs) > half || Math.min(...zs) < -half || Math.max(...zs) > half) continue;
    const det = (zs[1] - zs[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (zs[0] - zs[2]);
    for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x++) for (let z = Math.ceil(Math.min(...zs)); z <= Math.max(...zs); z++) {
      const l0 = ((zs[1] - zs[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (z - zs[2])) / det, l1 = ((zs[2] - zs[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (z - zs[2])) / det, l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      const y = l0 * pos[a + 1] + l1 * pos[b + 1] + l2 * pos[c + 1], h = H[(z + half) * res + (x + half)];
      liteErr = Math.max(liteErr, Math.abs(y - h));
    }
  }
}
assert(liteErr <= 0.121, `the lite ground stays within its tolerance of the physics ground (worst ${liteErr.toFixed(3)} m)`);
console.log(`World placement: ${fixtures.length} Python-parity layouts, ${levels} compiled villages (${houses} houses, ${trees} trees, ${flora} flora), worst level ${JSON.stringify(worst)}.`);
console.log(`Relief and water: heights ${relief.min.toFixed(2)}..${relief.max.toFixed(2)} m, ${ponds} ponds, ${brooks} brooks, ${bridges} footbridges, ${leaning} leaning willows; ground tris full ${JSON.stringify(full.userData.tris)}, lite ${JSON.stringify(lite.userData.tris)}, water ${water.userData.tris}; lite ground worst deviation ${liteErr.toFixed(3)} m.`);

// ---------------------------------------------------------------- the desert oasis (packs/arcade/pack.json biomes.desert)
// Its own houses, palms and cacti, flora and landmarks on the same layout grammar: identical to the Python port, and in
// a compiled level a village with no picket fences, an oasis pond and no brook, every place still reachable.
const dsource = applyBiome(source, 'desert'), drules = dsource.world;
assert.deepEqual(validateWorldRules(drules, DESERT_NATURE_PARTS, dsource.trees), [], 'the desert world rules name only desert parts');
const dfx = JSON.parse(fs.readFileSync('tools/test/fixtures/world-layouts-desert.json'));
for (const { request, digest } of dfx)
  assert.deepEqual(JSON.parse(JSON.stringify(worldDigest(layoutWorld(drules, { ...request, ...reliefOf(request), houseRules: dsource.houses, treeRules: dsource.trees })))), digest, `desert layout parity ${request.seed}`);
const dpack = biomePack(pack, 'desert');
assert.equal(dpack.biome, 'desert');
assert.equal(dpack.props.find(p => p.id === 'rocks').model, 'assets/v2/arcade/arcade-desert-rocks.glb', 'the desert patches its cover rocks');
assert.equal(biomePack(pack, null), pack, 'the meadow is the pack itself');
assert.deepEqual(CATALOG.arcade.world.map(w => [w.id, w.biome ?? null]), [['meadow', null], ['desert', 'desert'], ['snow', 'snow']], 'the desert and the snow village are environments next to the meadow');
{
  const meadow = compileShooterProject(resolveProject({ theme: 'arcade', seed: 'K7QN-3F2A-9XBD' }), pack);
  assert(meadow.worldKit.id === 'meadow' && meadow.pack === pack, 'a new project stays in the meadow');
}
let dlevels = 0, dhouses = 0, dpalms = 0;
const families = new Set(), kinds = new Set();
for (const seed of ['K7QN-3F2A-9XBD', 'DUNE-0001', 'DUNE-0002', 'DUNE-0003', 'DUNE-0004', 'OASIS-777']) for (const genre of ['shooter', 'exploration']) {
  // The desert is an environment: the project's world pool names it (the studio's Environments category).
  const project = resolveProject({ theme: 'arcade', genre, seed, cover: 'dense', objectives: 4 });
  project.blueprint.nodes.find(n => n.kind === 'world').items = ['desert'];
  const level = compileShooterProject(project, pack);
  dlevels++;
  const P = level.placements, W = level.world;
  assert(level.worldKit.id === 'desert' && level.pack.biome === 'desert', `${seed}/${genre}: built from the desert biome`);
  assert(!P.some(p => p.id === 'fence' && p.village), `${seed}/${genre}: no picket fences in the desert`);
  assert(W.water.ponds.length >= 1 && !W.water.brook, `${seed}/${genre}: an oasis pond, no brook`);
  for (const h of P.filter(p => p.house)) { dhouses++; families.add(h.house.family); assert.equal(h.house.form, 'flat'); }
  for (const t of P.filter(p => p.tree)) { if (t.tree.species === 'palm') dpalms++; assert(['palm', 'saguaro'].includes(t.tree.species)); }
  for (const p of P.filter(p => p.part)) assert(DESERT_NATURE_PARTS[p.part], `${seed}/${genre}: flora ${p.part} is a desert part`);
  for (const L of W.landmarks) { kinds.add(L.kind); assert(['well', 'market', 'lookout'].includes(L.kind), `${seed}/${genre}: ${L.kind} is a desert landmark`); }
  for (const k of ['well', 'market']) assert(W.landmarks.some(L => L.kind === k), `${seed}/${genre}: the square has its ${k}`);
  const claimed = [{ x: 0, z: 28, r: rules.clear.spawn + 0.5 }, ...P.filter(p => p.stepId || p.interaction).map(p => ({ x: p.x, z: p.z, r: (p.role === 'gate' ? rules.clear.gate : rules.clear.site) + 0.5, id: p.id }))];
  assert.deepEqual(unreachable(P, level.spawn.position, claimed, { terrain: level.terrain }), [], `${seed}/${genre}: every place is reachable in the desert`);
}
assert(dhouses >= dlevels * 3 && dpalms >= dlevels * 3, `a desert village has houses and palms (${dhouses} houses, ${dpalms} palms in ${dlevels} levels)`);
for (const f of ['courtyard', 'merchant', 'inn']) assert(families.has(f), `the desert builds ${f} houses`);
for (const k of ['well', 'market', 'lookout']) assert(kinds.has(k), `the desert has its ${k}`);
console.log(`Desert oasis: ${dfx.length} Python-parity layouts, ${dlevels} levels compiled (${dhouses} houses, ${dpalms} palms, families ${[...families]}).`);

// ---------------------------------------------------------------- the snow village (packs/arcade/pack.json biomes.snow)
// Alpine houses, snowy conifers and bare trees, winter flora, a bell tower by the square, a frozen pond and no brook:
// identical to the Python port, and in a compiled level the ice is walked on, not waded or refused, and every place
// the mission claimed is still reachable.
const ssource = applyBiome(source, 'snow'), srules = ssource.world;
assert.deepEqual(validateWorldRules(srules, SNOW_NATURE_PARTS, ssource.trees), [], 'the snow world rules name only snow parts');
assert.deepEqual(validateLandmarkRules(srules.landmarks, SNOW_LANDMARK_PARTS, ssource.trees), [], 'the snow landmarks name only snow parts');
const sfx = JSON.parse(fs.readFileSync('tools/test/fixtures/world-layouts-snow.json'));
for (const { request, digest } of sfx)
  assert.deepEqual(JSON.parse(JSON.stringify(worldDigest(layoutWorld(srules, { ...request, ...reliefOf(request), houseRules: ssource.houses, treeRules: ssource.trees })))), digest, `snow layout parity ${request.seed}`);
const spack = biomePack(pack, 'snow');
assert.equal(spack.biome, 'snow');
for (const [id, model] of [['rocks', 'arcade-snow-rocks.glb'], ['fence', 'arcade-snow-fence.glb'], ['hayBarricade', 'arcade-snow-barricade.glb'], ['barrel', 'arcade-snow-barrel.glb']])
  assert.equal(spack.props.find(p => p.id === id).model, `assets/v2/arcade/${model}`, `the snow village patches its ${id}`);
let slevels = 0, shouses = 0, spines = 0, sbare = 0, towers = 0, iceWalked = 0;
const towerDist = [];
const sfamilies = new Set(), skinds = new Set();
for (const seed of ['K7QN-3F2A-9XBD', 'SNOW-0001', 'SNOW-0002', 'SNOW-0003', 'SNOW-0004', 'ALPS-4242']) for (const genre of ['shooter', 'exploration']) {
  const project = resolveProject({ theme: 'arcade', genre, seed, cover: 'dense', objectives: 4 });
  project.blueprint.nodes.find(n => n.kind === 'world').items = ['snow'];
  const level = compileShooterProject(project, pack);
  slevels++;
  const P = level.placements, W = level.world, tag = `${seed}/${genre}`;
  assert(level.worldKit.id === 'snow' && level.pack.biome === 'snow', `${tag}: built from the snow biome`);
  assert(W.water.ponds.length >= 1 && !W.water.brook, `${tag}: a frozen pond, no brook`);
  // The ice is ground: level with the pond's surface, no water over it, walkable in the nav grid.
  for (const p of W.water.ponds) {
    assert.equal(level.terrain.depthAt(p.x, p.z), 0, `${tag}: no water over the ice`);
    assert(Math.abs(level.terrain.heightAt(p.x, p.z) - (p.level - srules.terrain.ponds.frozen)) < 0.02, `${tag}: the ice lies just under its surface`);
    assert(level.terrain.standableAt(p.x, p.z), `${tag}: the ice is walked on`);
    iceWalked++;
  }
  for (const h of P.filter(p => p.house)) { shouses++; sfamilies.add(h.house.family); assert(h.house.blocks.every(b => b.roof.covering === 'snow'), `${tag}: snowy roofs`); }
  for (const t of P.filter(p => p.tree)) { if (t.tree.species === 'snowpine') spines++; else if (t.tree.species === 'bare') sbare++; else assert.fail(`${tag}: ${t.tree.species} is not a snow species`); }
  for (const p of P.filter(p => p.part)) assert(SNOW_NATURE_PARTS[p.part], `${tag}: flora ${p.part} is a snow part`);
  for (const L of W.landmarks) { skinds.add(L.kind); assert(['well', 'market', 'belltower'].includes(L.kind), `${tag}: ${L.kind} is a snow landmark`); }
  // The bell tower stands just outside the square, looking over it, its collider clear of the lanes.
  const bell = W.landmarks.find(L => L.kind === 'belltower');
  if (bell) {
    towers++;
    const S = W.square, d = Math.hypot(bell.x - S.x, bell.z - S.z);
    towerDist.push(d);
    // It takes the lot nearest the square (the avenue keeps every lot 14 m off the spine): no house lot is nearer.
    assert(d > S.r && d < 28, `${tag}: the bell tower stands by the square (${d.toFixed(1)} m from its centre)`);
    assert(!P.some(p => p.house && Math.hypot(p.x - S.x, p.z - S.z) < d - 0.01), `${tag}: the bell tower has the lot nearest the square`);
    assert(bell.front[0] * (S.x - bell.x) + bell.front[1] * (S.z - bell.z) > 0, `${tag}: the bell tower faces the square`);
    assert(P.some(p => p.id === 'landmark-block' && p.landmarkOf === 'belltower'), `${tag}: the bell tower collides`);
  }
  for (const k of ['well', 'market']) assert(W.landmarks.some(L => L.kind === k), `${tag}: the square has its ${k}`);
  const claimed = [{ x: 0, z: 28, r: rules.clear.spawn + 0.5 }, ...P.filter(p => p.stepId || p.interaction).map(p => ({ x: p.x, z: p.z, r: (p.role === 'gate' ? rules.clear.gate : rules.clear.site) + 0.5, id: p.id }))];
  assert.deepEqual(unreachable(P, level.spawn.position, claimed, { terrain: level.terrain }), [], `${tag}: every place is reachable in the snow`);
}
assert(shouses >= slevels * 3 && spines >= slevels * 5 && sbare >= slevels, `a snow village has houses, snowy pines and bare trees (${shouses} houses, ${spines} pines, ${sbare} bare trees in ${slevels} levels)`);
assert(towers >= slevels - 2, `the bell tower finds its place by the square (${towers} of ${slevels} levels)`);
for (const f of ['cabin', 'lodge', 'workshop']) assert(sfamilies.has(f), `the snow village builds ${f} houses`);
for (const k of ['well', 'market', 'belltower']) assert(skinds.has(k), `the snow village has its ${k}`);
console.log(`Snow village: ${sfx.length} Python-parity layouts, ${slevels} levels compiled (${shouses} houses, ${spines} snowy pines, ${sbare} bare trees, ${towers} bell towers at ${towerDist.map(d => d.toFixed(1)).join('/')} m from the square's centre, ${iceWalked} frozen ponds walked, families ${[...sfamilies]}).`);
