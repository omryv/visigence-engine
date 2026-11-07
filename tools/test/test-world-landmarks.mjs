/**
 * The village's landmarks (src/world/worldLandmarks.js) and the route graph (src/world/routeGraph.js): every kind
 * finds the site its rule names (the windmill on a rim hill, the watermill on the brook with its wheel over the
 * water, the well and the stalls on the square, the lookout across the village, the orchard and the farm at the
 * fringe), each claims a level pad and a spur to a lane, every hook point is reachable over the relief with every
 * blocker stamped, the route chains them deterministically with deliveries resolved, the checkpoints follow it, and
 * the parts stay inside the mobile budget per tier. The assembler is exercised on a stand-in library (no GLB).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group, Mesh, Object3D, BoxGeometry, MeshStandardMaterial } from 'three/webgpu';
import { layoutWorld, unreachable } from '../../src/world/worldGrammar.js';
import { validateLandmarkRules } from '../../src/world/worldLandmarks.js';
import { chainRoute, routeNodes } from '../../src/world/routeGraph.js';
import { LANDMARK_PARTS } from '../../src/world/landmarkParts.js';
import { createLandmarkAssembler, landmarkTris } from '../../src/render/LandmarkAssembler.js';
import { compileShooterProject, resolveProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { LOOKS } from '../../src/config/looks.js';
import { DIRS64 } from '../../src/world/houseGrammar.js';

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json')), rules = source.world, R = rules.landmarks, K = R.kinds;
assert.deepEqual(validateLandmarkRules(R, LANDMARK_PARTS, source.trees), [], 'the landmark rules name library parts and a tree species');
assert.deepEqual(validateLandmarkRules({ ...R, kinds: { ...K, windmill: { ...K.windmill, part: 'nope' } } }, LANDMARK_PARTS, source.trees).length, 1, 'an unknown part is refused');
for (const id of Object.keys(LANDMARK_PARTS)) if (!id.endsWith('.lite')) assert(LANDMARK_PARTS[`${id}.lite`], `${id} has a lite twin`);
// The sails face into the toon wind: the rules' `face` is the look's wind direction reversed.
for (const look of Object.values(LOOKS.arcade)) {
  const [wx, wz] = look.toon.wind.dir, l = Math.hypot(wx, wz);
  assert(Math.abs(K.windmill.face[0] + wx / l) < 0.02 && Math.abs(K.windmill.face[1] + wz / l) < 0.02, 'the windmill faces into the look\'s wind');
}

// The route graph on its own: readiness, deliveries, degradation, determinism.
{
  const pois = [
    { id: 'market', kind: 'market', x: 0, z: 0, hook: { type: 'deliver', label: 'Trade', visitLabel: 'Browse', takes: ['flour', 'apples'] } },
    { id: 'mill', kind: 'windmill', x: 0, z: -10, hook: { type: 'interact', label: 'Grind', gives: 'flour' }, life: ['bee'] },
    { id: 'look', kind: 'lookout', x: 30, z: 30, hook: { type: 'visit', label: 'Lookout' } },
    { id: 'orchard', kind: 'orchard', x: 0, z: -18, hook: { type: 'interact', label: 'Pick', gives: 'apples' } },
    { id: 'stall2', kind: 'market', x: 1, z: 1, hook: { type: 'deliver', label: 'Trade', visitLabel: 'Browse', takes: ['flour', 'apples'] }, keeper: 'acorn' },
  ];
  const route = chainRoute(pois, { x: 0, z: 5 });
  assert.deepEqual(route.nodes.map(n => n.id), ['mill', 'orchard', 'market', 'stall2', 'look'], 'nearest ready node first: the stalls wait for something to deliver');
  assert.deepEqual(route.nodes.map(n => n.hook.item ?? null), [null, null, 'flour', 'apples', null], 'two stalls trade different goods');
  assert.equal(route.nodes[2].hook.from, 0); assert.equal(route.nodes[3].hook.from, 1);
  assert.deepEqual(route.nodes[1].life, undefined); assert.deepEqual(route.nodes[0].life, ['bee']); assert.equal(route.nodes[3].keeper, 'acorn');
  assert.equal(route.edges.length, 5); assert.equal(route.edges[0].a, -1); assert.equal(route.edges[4].b, 4);
  assert.deepEqual(chainRoute(pois, { x: 0, z: 5 }), route, 'deterministic');
  const lonely = chainRoute([pois[0]], { x: 0, z: 5 });
  assert.equal(lonely.nodes[0].hook.type, 'visit'); assert.equal(lonely.nodes[0].hook.label, 'Browse', 'a stall with nothing to receive is a place to visit');
  assert.equal(routeNodes(route, 'visit').length, 1); assert.equal(routeNodes(null, 'visit').length, 0);
}

// Layouts: every kind on the site its rule names.
const fixtures = JSON.parse(fs.readFileSync('tools/test/fixtures/world-layouts.json'));
// The kernel-ground cases take their relief from kernel-ground.json, as tools/test/test-world-placement.mjs says.
const grounds = JSON.parse(fs.readFileSync('tools/test/fixtures/kernel-ground.json'));
const counts = {};
let withWheel = 0;
for (const { request } of fixtures) {
  const given = request.reliefRef === undefined ? null : { res: grounds[request.reliefRef].res, heights: grounds[request.reliefRef].heights };
  const layout = layoutWorld(rules, { ...request, relief: given, houseRules: source.houses, treeRules: source.trees });
  const L = layout.landmarks, T = layout.terrain;
  // The ground as the engine reads it: bilinear between the grid's vertices.
  const sample = (x, z) => {
    const s = (T.res - 1) / T.size, fx = Math.min(Math.max((x + T.size / 2) * s, 0), T.res - 1.001), fz = Math.min(Math.max((z + T.size / 2) * s, 0), T.res - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, H = T.heights, a = H[iz * T.res + ix], b = H[iz * T.res + ix + 1], c = H[(iz + 1) * T.res + ix], d = H[(iz + 1) * T.res + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
  const depth = (x, z) => T.depth[Math.round((z + rules.size / 2) / T.cell) * T.res + Math.round((x + rules.size / 2) / T.cell)];
  for (const l of L) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
  const byKind = k => L.filter(l => l.kind === k), S = layout.square;
  const wm = byKind('windmill')[0], lo = byKind('lookout')[0], mill = byKind('watermill')[0];
  assert(wm && lo, `${request.seed}: a windmill and a lookout`);
  for (const h of [wm, lo]) {
    const far = Math.max(Math.abs(h.x), Math.abs(h.z));
    assert(far >= R.rim[0] && far <= R.rim[1], `${request.seed}: ${h.kind} in the rim band`);
    assert(h.spur && h.spur.pts.length === 2 && h.pad > 0 && h.y === h.h, `${request.seed}: ${h.kind} has a pad and a spur`);
    const [a, b] = h.spur.pts, d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert(Math.abs(sample(a[0], a[1]) - sample(b[0], b[1])) / d <= R.grade + 0.05, `${request.seed}: ${h.kind}'s spur keeps its grade`);
    const lane = layout.lanes.find(q => q.id === h.spur.lane);
    assert(lane && Math.min(...lane.pts.map(p => Math.hypot(p[0] - b[0], p[1] - b[1]))) < rules.paths.step, `${request.seed}: the spur ends on its lane`);
  }
  // The windmill stands on a hill: the highest lattice point its rule allows (clear of everything, with a walkable
  // spur), which puts it above most of the meadow.
  const sorted = Array.from(T.heights).sort((a, b) => a - b);
  assert(wm.y >= sorted[Math.floor(sorted.length * 0.4)], `${request.seed}: the windmill is up on a hill (${wm.y} m)`);
  assert(Math.hypot(wm.x - lo.x, wm.z - lo.z) >= R.apart && (wm.x - S.x) * (lo.x - S.x) + (wm.z - S.z) * (lo.z - S.z) <= 0, `${request.seed}: the lookout is across the village from the windmill`);
  assert(Math.abs(Math.hypot(wm.front[0], wm.front[1]) - 1) < 1e-3 && DIRS64[wm.k][0] * wm.front[0] + DIRS64[wm.k][1] * wm.front[1] > 0.995, `${request.seed}: the sails face the wind`);
  if (mill) {
    withWheel++;
    const B = layout.water.brook, near = Math.min(...B.pts.map(p => Math.hypot(p[0] - mill.x, p[1] - mill.z)));
    assert(near < rules.terrain.brook.w / 2 + K.watermill.set + K.watermill.collision.box[1] + 0.6 && near > rules.terrain.brook.w / 2 + K.watermill.collision.box[1] - 0.6, `${request.seed}: the mill house stands on the bank (${near.toFixed(2)} m from the brook)`);
    assert(depth(mill.x, mill.z) === 0 && depth(mill.wheel.x, mill.wheel.z) > 0, `${request.seed}: the house is dry, the wheel is over the water`);
    assert(mill.wheel.y > 0 && mill.wheel.y < K.watermill.wheel.r + 0.5, `${request.seed}: the wheel's axle is just above the water (${mill.wheel.y})`);
    assert(B.bridges.every(b => Math.hypot(b.x - mill.x, b.z - mill.z) > b.reach + 2), `${request.seed}: the mill keeps off the bridges`);
    // The brook still runs under the wheel: the water surface is continuous past the mill.
    const at = mill.at;
    assert(B.surface[at + 2] <= B.surface[at - 2] && depth(B.pts[at][0], B.pts[at][1]) > 0, `${request.seed}: the brook flows under the wheel`);
  }
  for (const w of byKind('well')) assert(Math.hypot(w.x - S.x, w.z - S.z) <= S.r + rules.paths.verge + 1.5 && w.keeper, `${request.seed}: the well is on the square with its keeper`);
  const stalls = byKind('market');
  assert(stalls.length >= K.market.min || stalls.length === 0, `${request.seed}: at least ${K.market.min} stalls when there is a market`);
  for (const s of stalls) {
    assert(Math.hypot(s.x - S.x, s.z - S.z) <= S.r + rules.paths.verge + K.market.off + 2 && s.colors.Awning && K.market.awnings.includes(s.colors.Awning) && K.market.parts.includes(s.part) && s.keeper, `${request.seed}: a stall rings the square`);
    for (const l of layout.lanes) { let d = Infinity; for (let i = 1; i < l.pts.length; i++) { const a = l.pts[i - 1], b = l.pts[i], t = Math.max(0, Math.min(1, ((s.x - a[0]) * (b[0] - a[0]) + (s.z - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2))); d = Math.min(d, Math.hypot(s.x - a[0] - (b[0] - a[0]) * t, s.z - a[1] - (b[1] - a[1]) * t)); } assert(d >= l.w / 2 + K.market.collision.box[0] - 0.05, `${request.seed}: a stall keeps off the lane ${l.id}`); }
  }
  for (const o of byKind('orchard')) {
    assert.equal(o.trees.length, K.orchard.grid[0] * K.orchard.grid[1]);
    for (const t of o.trees) assert(t.tree.species === K.orchard.tree && t.s === K.orchard.scale && t.trunk > 0 && Math.abs(t.y - sample(t.x, t.z)) < 0.6, `${request.seed}: an orchard tree on the ground`);
    assert(layout.lots.some(l => l.slot === o.lot), `${request.seed}: the orchard is beside a lot`);
  }
  for (const f of byKind('farm')) {
    const Rr = f.rect, hs = [[Rr.x0 + 1, Rr.z0 + 1], [Rr.x1 - 1, Rr.z0 + 1], [Rr.x0 + 1, Rr.z1 - 1], [Rr.x1 - 1, Rr.z1 - 1], [(Rr.x0 + Rr.x1) / 2, (Rr.z0 + Rr.z1) / 2]].map(([x, z]) => sample(x, z));
    assert(Math.max(...hs) - Math.min(...hs) < 0.08 && f.plot && Math.abs(f.plot.y - f.level) < 1e-9 && Math.abs(f.y - sample(f.x, f.z)) < 0.05, `${request.seed}: the farm plot is a level slab and its hook stands on its pad`);
  }
  // The route: every landmark once, hooks typed, deliveries from earlier givers, keepers and life carried.
  const route = layout.route;
  assert.equal(route.nodes.length, L.length);
  assert.deepEqual(route.nodes.map(n => n.id).sort(), L.map(l => l.id).sort());
  for (const [i, n] of route.nodes.entries()) {
    assert.equal(n.index, i);
    assert(['visit', 'interact', 'deliver'].includes(n.hook.type) && n.hook.label);
    if (n.hook.type === 'deliver') assert(n.hook.from < i && route.nodes[n.hook.from].hook.gives === n.hook.item, `${request.seed}: a delivery comes from an earlier giver`);
    if (n.kind === 'market' || n.kind === 'well') assert(R.keepers.includes(n.keeper));
  }
  assert.equal(route.edges[0].a, -1);
  assert.deepEqual(route.start, { x: 0, z: request.reserved.find(c => c.id === 'spawn').z });
}
assert(counts.windmill === fixtures.length && counts.lookout === fixtures.length && counts.well >= fixtures.length * 0.8 && counts.market >= fixtures.length && withWheel >= fixtures.length * 0.45 && counts.orchard >= 4 && counts.farm >= 4,
  `every kind is found often enough ${JSON.stringify(counts)}`);

// Compiled levels: placements, collision, the ground, reachability with every blocker stamped, checkpoints, budgets.
const pack = resolvePack(source, CATALOG.arcade.measurements);
const budget = { full: 0, lite: 0 }, perKind = {};
let levels = 0, checkpoints = 0;
for (const genre of ['shooter', 'exploration']) for (const seed of ['K7QN-3F2A-9XBD', 'TEST-1234-ABCD', 'AAAA-BBBB-CCCC', 'WRLD-0001', 'WRLD-0002', 'WRLD-0003']) {
  // A mission with a `reach` step after the activation: its checkpoint should follow the route.
  const base = resolveProject({ theme: 'arcade', genre, seed, objectives: 3 }), graph = structuredClone(base.blueprint);
  graph.nodes.push({ id: 'reach', kind: 'objective', objective: 'reach', count: 1, duration: 0.5, x: 560, y: 170 });
  graph.edges = graph.edges.filter(e => !(e.from === 'activate' && e.to === 'extract'));
  graph.edges.push({ from: 'activate', out: 'complete', to: 'reach', input: 'start' }, { from: 'reach', out: 'complete', to: 'extract', input: 'start' });
  const request = { theme: 'arcade', genre, seed, objectives: 3, blueprint: graph };
  const level = compileShooterProject(resolveProject(request), pack), P = level.placements, G = level.terrain, W = level.world;
  levels++;
  const lm = P.filter(p => p.landmark && !p.collisionOnly), blocks = P.filter(p => p.id === 'landmark-block');
  assert(lm.length >= 4 && W.landmarks.length >= lm.length && W.route, `${seed}/${genre}: landmarks compiled with the route`);
  let full = 0, lite = 0;
  for (const p of lm) {
    assert(p.village && p.collision === 'none' && p.scale === 1 && LANDMARK_PARTS[p.landmark.part] && p.model === source.world.landmarks.library, `${seed}/${genre}: a landmark is a library part with no collision of its own`);
    assert(Math.abs(p.y - G.heightAt(p.x, p.z)) < 0.05, `${seed}/${genre}: ${p.landmark.kind} stands on its pad (y ${p.y}, ground ${G.heightAt(p.x, p.z).toFixed(3)})`);
    const k = K[p.landmark.kind];
    if (k.collision) assert(blocks.some(b => b.landmarkOf === p.landmark.kind && Math.hypot(b.x - p.x, b.z - p.z) < 1e-6 && b.height === k.collision.height), `${seed}/${genre}: ${p.landmark.kind} has its blocker`);
    // A pad is level (the mill's under its house floor: past its wall the bank drops into the channel, and the
    // bilinear ground reads a metre past a probe).
    const padR = p.landmark.kind === 'watermill' ? Math.max(0.6, Math.min(...k.collision.box) - 0.9) : k.pad;
    if (padR) { let lo = Infinity, hi = -Infinity; for (let q = 0; q < 64; q += 8) for (const f of [0.4, 0.8]) { const h = G.heightAt(p.x + DIRS64[q][0] * padR * f, p.z + DIRS64[q][1] * padR * f); lo = Math.min(lo, h); hi = Math.max(hi, h); } assert(hi - lo < 0.03, `${seed}/${genre}: ${p.landmark.kind}'s pad is level`); }
    full += landmarkTris(LANDMARK_PARTS, p.landmark.part); lite += landmarkTris(LANDMARK_PARTS, p.landmark.part, true);
    perKind[p.landmark.kind] = [landmarkTris(LANDMARK_PARTS, p.landmark.part), landmarkTris(LANDMARK_PARTS, p.landmark.part, true)];
  }
  const orchard = P.filter(p => p.tree && p.landmarkOf === 'orchard');
  for (const t of orchard) assert(P.some(q => q.id === 'tree-trunk' && q.x === t.x && q.z === t.z), `${seed}/${genre}: an orchard tree has its trunk`);
  // Reachability: every hook point, over the relief, with every blocker stamped.
  const targets = W.landmarks.map(l => ({ id: l.kind, x: l.x, z: l.z, r: 2.6 }));
  assert.deepEqual(unreachable(P, level.spawn.position, targets, { terrain: G }), [], `${seed}/${genre}: every landmark is reachable`);
  // The checkpoint of a `reach` step follows the route's visit nodes.
  const visits = W.route.nodes.filter(n => n.hook.type === 'visit');
  for (const c of P.filter(p => p.role === 'checkpoint')) {
    checkpoints++;
    assert(visits.some(n => (n.stand ?? [n.x, n.z])[0] === c.x && (n.stand ?? [n.x, n.z])[1] === c.z) && c.route !== undefined, `${seed}/${genre}: the checkpoint stands at a route node`);
    // clear of every landmark blocker: a box measured in its own frame, a circle by its radius
    const inBox = q => { const cs = Math.cos(q.yaw ?? 0), sn = Math.sin(q.yaw ?? 0), dx = c.x - q.x, dz = c.z - q.z, lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; return Math.abs(lx) < q.halfX + 0.35 && Math.abs(lz) < q.halfZ + 0.35; };
    assert(!P.some(q => q.id === 'landmark-block' && (q.collision === 'box' ? inBox(q) : Math.hypot(q.x - c.x, q.z - c.z) < q.radius + 0.35)), `${seed}/${genre}: the checkpoint stands clear of the landmark's blocker`);
    // the compiler stands a mission placement on the lowest ground under its footprint
    assert(c.y <= G.heightAt(c.x, c.z) + 0.02 && c.y >= G.heightAt(c.x, c.z) - 0.4, `${seed}/${genre}: the checkpoint is on the ground`);
  }
  budget.full = Math.max(budget.full, full); budget.lite = Math.max(budget.lite, lite);
  // Tiers see one world.
  assert.deepEqual(P, compileShooterProject(resolveProject(request), pack).placements);
}
assert(checkpoints > 0, 'some level had a reach step');
assert(budget.full <= 9500 && budget.lite <= 4200, `landmarks inside the budget (${budget.full} full, ${budget.lite} lite)`);
// A creator who disconnects the landmark prop gets a village without landmarks, not an error.
{
  const bare = resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'BARE' });
  for (const n of bare.blueprint.nodes) if (n.kind === 'props') n.items = n.items.filter(id => id !== 'landmark');
  const level = compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed: 'BARE', blueprint: bare.blueprint }), pack);
  assert(!level.placements.some(p => p.landmark) && level.world.route === null && level.world.landmarks.length === 0, 'no landmarks, no route');
}

// The assembler on a stand-in library: still meshes merged, moving nodes kept apart with their spin, lite twins,
// the wheel's axle where the grammar put it, a stall's awning taking the landmark's colour.
{
  const library = new Group();
  for (const [id, ext] of Object.entries(LANDMARK_PARTS)) {
    const node = new Object3D(); node.name = id.replace(/\./g, ''); node.userData.name = id; node.userData.arc_outline = 0.03;
    node.add(new Mesh(new BoxGeometry(1, ext.top, 1), new MeshStandardMaterial({ name: 'ARC_Wood' })), new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial({ name: id.startsWith('stall') ? 'LMK_Awning' : 'ARC_Stone' })));
    for (const [name, spin] of Object.entries(ext.spin ?? {})) {
      const mv = new Object3D(); mv.name = name; mv.userData.name = name; mv.userData.arc_spin = spin; mv.position.set(2, 1.2, 0);
      mv.add(new Mesh(new BoxGeometry(0.2, 2.5, 2.5), new MeshStandardMaterial({ name: 'ARC_WoodDark' }))); node.add(mv);
    }
    library.add(node);
  }
  const asked = [];
  const asm = createLandmarkAssembler({ library, material: (slot, hex) => { asked.push([slot, hex]); return new MeshStandardMaterial({ name: `${slot}|${hex}` }); } });
  assert.equal(asm.parts.size, Object.keys(LANDMARK_PARTS).length);
  const mill = asm.build({ kind: 'windmill', part: 'windmill' });
  assert.equal(mill.userData.spinners.length, 1); assert.deepEqual(mill.userData.spinners[0].userData.spin, { axis: 'z', rate: 0.55, wind: true });
  assert.equal(mill.children.length, 3, 'wood and stone merged apart, the sails their own mesh');
  assert(mill.children.every(m => m.userData.arc_outline === 0.03));
  const wheel = asm.build({ kind: 'watermill', part: 'watermill', wheel: { y: 0.77 } }, { lite: true }).userData.spinners[0];
  assert.equal(wheel.position.y, 0.77, 'the wheel sits where the grammar put it'); assert.equal(wheel.position.x, 2);
  assert.equal(wheel.userData.spin.axis, 'x');
  const stall = asm.build({ kind: 'market', part: 'stall.a', colors: { Awning: '#69c9fd' } });
  assert.deepEqual(asked.at(-1), ['Awning', '#69c9fd'], 'the awning takes the landmark\'s colour');
  assert(stall.children.some(m => m.material.name === 'Awning|#69c9fd'));
  const placed = asm.place({ kind: 'well', part: 'well' }, 3, 0.5, -4, 1.2);
  assert.equal(placed.position.x, 3); assert(Math.abs(placed.rotation.y - 1.2) < 1e-6);
  assert.equal(asm.build({ kind: 'well', part: 'missing' }).userData.missing, 'missing');
}
console.log(`Landmarks: ${fixtures.length} layouts ${JSON.stringify(counts)} (${withWheel} watermills), ${levels} compiled levels, ${checkpoints} checkpoints on the route; worst level ${budget.full} tris full / ${budget.lite} lite; per kind ${JSON.stringify(perKind)}.`);
