/**
 * The house assembler (src/render/HouseAssembler.js) against a library shaped like the parts GLB as GLTFLoader
 * delivers it (sanitised node names, the part id in userData.name, sockets as children, multi-material parts as
 * groups), and generated houses in a compiled Arcade project: pieces mesh outward-facing, parts land on their
 * sockets, the result merges to a handful of meshes inside the lot, `lite` is lighter, the toon kit outlines it,
 * and every block of every house collides.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group, Mesh, Object3D, BoxGeometry, MeshStandardMaterial, Vector3 } from 'three/webgpu';
import { generateHouse, buildHouse } from '../../src/world/houseGrammar.js';
import { HOUSE_PARTS } from '../../src/world/houseParts.js';
import { createHouseAssembler, meshPrism, THIN } from '../../src/render/HouseAssembler.js';
import { createArcadeToon } from '../../src/render/ArcadeToon.js';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json')), rules = source.houses;
const SOCKET_AT = { lamp: [0.95, 1.25, 0], canopy: [0, 2.1, 0], sign: [-0.95, 1.9, 0], shutter: [0.62, 0.1, 0.05], sill: [0, 0.05, 0.12] };
function library() {
  const scene = new Group();
  for (const [id, info] of Object.entries(HOUSE_PARTS)) {
    const mat = name => new MeshStandardMaterial({ name });
    const geo = new BoxGeometry(0.4, 0.4, 0.1).translate(0.2, 0.2, 0.05);   // off-centre, so a mirror shows
    let node;
    if (id.startsWith('door.')) {                         // a two-material part arrives as a group of meshes
      node = new Group(); node.add(new Mesh(geo, mat('HSE_TimberDark')), new Mesh(geo.clone().translate(0, 0.5, 0), mat('HSE_Accent')));
    } else node = new Mesh(geo, mat(id.startsWith('roof.') ? 'HSE_Roof' : id.startsWith('shutter') ? 'HSE_Accent' : 'HSE_Timber'));
    node.name = id.replace(/[.:]/g, ''); node.userData.name = id; node.userData.arc_outline = 0.025;
    for (const s of info.sockets) {
      assert(SOCKET_AT[s], `socket "${s}" needs a test position`);
      const e = new Object3D(); e.name = `${node.name}${s}`; e.userData.socket = s; e.position.set(...SOCKET_AT[s]); node.add(e);
    }
    scene.add(node);
  }
  return scene;
}
const requested = [];
const assembler = createHouseAssembler({ library: library(), material: (slot, hex) => { requested.push([slot, hex]); return new MeshStandardMaterial({ name: `${slot}:${hex}` }); } });
assert.equal(assembler.parts.size, Object.keys(HOUSE_PARTS).length, 'every library node is indexed by its part id, not its sanitised name');

// The mesher: a bevelled box closes, faces out, and a thin piece skips the chamfer on its short edges.
const tris = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
function facing(g) {
  const p = g.attributes.position, n = g.attributes.normal, i = g.index, a = new Vector3(), b = new Vector3(), c = new Vector3(), vn = new Vector3();
  let good = 0, all = 0;
  for (let t = 0; t < i.count; t += 3) {
    a.fromBufferAttribute(p, i.getX(t)); b.fromBufferAttribute(p, i.getX(t + 1)); c.fromBufferAttribute(p, i.getX(t + 2));
    const gn = b.clone().sub(a).cross(c.clone().sub(a));
    if (gn.lengthSq() < 1e-14) continue;
    vn.set(0, 0, 0); for (const k of [0, 1, 2]) vn.add(new Vector3().fromBufferAttribute(n, i.getX(t + k)));
    all++; if (gn.dot(vn) > 0) good++;
  }
  return good / Math.max(1, all);
}
{
  const box = { k: 'prism', s: 'Wall', o: 0.02, f: [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1], p: [[-1, -1], [1, -1], [1, 1], [-1, 1]], w: [-1, 1], b: 0.1, g: [0, 2], r: 0 };
  const house = createHouseAssembler({ library: new Group(), material: () => new MeshStandardMaterial() });
  const one = house.build({ family: 'cottage', key: 'box', palette: { wall: '#ffffff' }, colors: {}, blocks: [{ roof: { covering: 'tiles' } }] }, { pieces: [box], parts: [] });
  const g = one.children[0].geometry;
  assert.equal(tris(g), 60, 'a chamfered box: 8-sided caps and three bands of 8 quads');
  assert.equal(facing(g), 1, 'every face of a box points out');
  g.computeBoundingBox();
  assert(g.boundingBox.min.distanceTo(new Vector3(-1, 0, -1)) < 1e-6 && g.boundingBox.max.distanceTo(new Vector3(1, 2, 1)) < 1e-6, 'Blender z-up becomes glTF y-up, -y becomes +z');
  const thin = house.build({ family: 'cottage', key: 'thin', palette: { wall: '#ffffff' }, colors: {}, blocks: [{ roof: { covering: 'tiles' } }] }, { pieces: [{ ...box, w: [0, THIN - 0.01] }], parts: [] });
  assert.equal(tris(thin.children[0].geometry), 28, 'a thin piece keeps its face chamfer only');
  const lite = house.build({ family: 'cottage', key: 'lite', palette: { wall: '#ffffff' }, colors: {}, blocks: [{ roof: { covering: 'tiles' } }] }, { pieces: [{ ...box, w: [0, THIN - 0.01] }], parts: [] }, { lite: true });
  assert.equal(tris(lite.children[0].geometry), 12, 'lite: no chamfer on thin pieces');
  assert.equal(typeof meshPrism, 'function');
}

// Generated houses of every family, full and lite.
const owned = new Set(), toon = createArcadeToon(owned, {});
let built = 0;
for (const family of Object.keys(rules.families)) for (const key of ['asm|0', 'asm|1', 'asm|2']) {
  const plan = generateHouse(rules, { family, key }), exp = buildHouse(rules, plan);
  requested.length = 0;
  const full = assembler.build(plan, exp), lite = assembler.build(plan, exp, { lite: true });
  built++;
  const count = m => m.children.reduce((s, c) => s + tris(c.geometry), 0);
  assert(full.children.length >= 4 && full.children.length <= 18, `${family}/${key}: merged to ${full.children.length} meshes`);
  assert(count(lite) < count(full), `${family}/${key}: lite is lighter`);
  assert(requested.some(([slot, hex]) => slot === 'Roof' && hex === (plan.blocks[0].roof.covering === 'thatch' ? plan.colors.thatch : plan.palette.roof)), 'the roof takes the plan colour');
  const [x0, x1, y0, y1, top] = plan.bounds;
  for (const m of full.children) {
    const g = m.geometry;
    assert.equal(typeof m.userData.arc_outline, 'number');
    for (const name of ['position', 'normal', 'color']) assert.equal(g.attributes[name].itemSize, 3, `${name} is xyz/rgb`);
    assert(g.attributes.position.array.every(Number.isFinite), 'no NaN');
    assert(facing(g) > 0.97, `${family}/${key} ${m.material.name}: faces point out (${facing(g).toFixed(3)})`);
    g.computeBoundingBox();
    const { min, max } = g.boundingBox;
    assert(min.x > x0 - 1.2 && max.x < x1 + 1.2 && min.z > -y1 - 1.8 && max.z < -y0 + 1.8 && min.y > -0.1 && max.y < top + 2, `${family}/${key} ${m.material.name}: inside its lot`);
  }
  toon.apply(full);
  for (const m of full.children) if (m.userData.arc_outline > 0) assert(m.children.some(c => c.userData.arcOutlineHull), 'outlined');
}

// A paired socket mirrors: every shutter lands twice, once each side of its window.
{
  let plan, key = 0;
  do plan = generateHouse(rules, { family: 'townhouse', key: `shutters|${key++}` }); while (!plan.style.shutters);
  const exp = buildHouse(rules, plan), pairs = exp.parts.filter(p => p.pair).length;
  assert(pairs > 0);
  const lib = library(), only = createHouseAssembler({ library: lib, material: slot => new MeshStandardMaterial({ name: slot }) });
  const house = only.build(plan, { pieces: [], parts: exp.parts.map(p => (p.m || p.pair ? p : { ...p, id: p.id })) });
  const accent = house.children.find(m => m.material.name === 'Accent');
  const doors = exp.parts.filter(p => p.id.startsWith('door.')).length;
  assert.equal(tris(accent.geometry), (pairs * 2 + doors) * 12, 'each shutter is placed right and mirrored left');
}

// In a compiled Arcade project: houses stand on the village's lots (world/worldGrammar.js), each block collides,
// the front faces the lane the lot was walked from, and the lot is the family's own size.
const pack = resolvePack(source, CATALOG.arcade.measurements);
let villages = 0;
for (const seed of ['K7QN-3F2A-9XBD', 'TEST-1234-ABCD', 'AAAA-BBBB-CCCC', 'HOUS-E5AR-EFUN']) {
  const level = compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed }), pack);
  assert.deepEqual(level.placements, compileShooterProject(resolveProject({ theme: 'arcade', genre: 'shooter', seed }), pack).placements, 'a village is reproducible');
  const houses = level.placements.filter(p => p.house), blocks = level.placements.filter(p => p.id === 'house-block');
  villages += houses.length;
  assert.equal(blocks.length, houses.reduce((s, h) => s + h.house.colliders.length, 0), 'one collision box per block');
  for (const h of houses) {
    assert.equal(h.collision, 'none', 'the house itself is visual; its blocks collide');
    assert.equal(h.model, rules.library, 'the parts library is preloaded with the level');
    const lane = level.world.lanes.find(l => l.pts.some(([x, z]) => Math.abs(h.x - x) < 14 && Math.abs(h.z - z) < 14));
    assert(lane, 'a house stands by a lane');
    const [lw, ld] = source.world.houses.lots[h.house.family];
    assert.deepEqual(h.house.lot, { w: lw, d: ld }, `${h.house.family} gets its own lot size`);
    assert(Math.abs(h.x) > 14 || lane.id !== 'spine', 'the avenue stays a green: spine lots start behind the tree line');
    const [fx, fz] = [Math.sin(h.yaw), Math.cos(h.yaw)];
    assert(Math.abs(Math.abs(fx) - 1) < 1e-9 || Math.abs(Math.abs(fz) - 1) < 1e-9, 'a lot faces along an axis');
  }
  for (const b of blocks) assert(Math.abs(b.x) < 37 && Math.abs(b.z) < 37 && b.height > 2, 'blocks stay inside the meadow');
}
assert(villages > 0, 'the seeds above build at least one house');
const saved = resolveProject({ theme: 'arcade' }).blueprint;
for (const n of saved.nodes) if (n.kind === 'props') n.items = n.items.map(id => (id === 'house' ? 'cottage' : id));
assert(resolveProject({ theme: 'arcade', blueprint: saved }).blueprint.nodes.find(n => n.kind === 'props').items.includes('house'), 'a saved cottage becomes a generated house');
console.log(`House assembly: ${built} houses meshed full and lite, ${villages} houses placed across 4 villages.`);
