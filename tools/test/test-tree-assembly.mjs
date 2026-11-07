/**
 * The tree assembler (src/render/TreeAssembler.js): a plan becomes tubes and library clumps, merged into one mesh
 * per colour slot and outline width for the whole level; lite halves the skeleton and swaps in the lite clumps.
 * Runs on the CPU with a stand-in library (no GLB): the library's contract is what the assembler reads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group, Mesh, Object3D, SphereGeometry, MeshStandardMaterial, Box3, Vector3 } from 'three/webgpu';
import { generateTree } from '../../src/world/treeGrammar.js';
import { TREE_PARTS } from '../../src/world/treeParts.js';
import { createTreeAssembler, meshSkeleton } from '../../src/render/TreeAssembler.js';

const rules = JSON.parse(fs.readFileSync('packs/arcade/pack.json')).trees;
const tris = g => (g.index ? g.index.count : g.attributes.position.count) / 3;

// A stand-in library: one sphere per part id, sized like the index says, named the way GLTFLoader leaves it.
const library = new Group();
for (const [id, ext] of Object.entries(TREE_PARTS)) {
  const node = new Object3D(); node.name = id.replace(/\./g, ''); node.userData.name = id;
  const mesh = new Mesh(new SphereGeometry(ext.r, 8, 6), new MeshStandardMaterial({ name: id.startsWith('blossom') ? 'TRE_Blossom' : 'TRE_Leaf' }));
  mesh.position.y = (ext.top + ext.bot) / 2; node.add(mesh); library.add(node);
}
const materials = new Map();
const assembler = createTreeAssembler({ library, material: (slot, hex) => { const k = `${slot}|${hex}`; if (!materials.has(k)) materials.set(k, new MeshStandardMaterial({ name: k })); return materials.get(k); } });
assert.equal(assembler.parts.size, Object.keys(TREE_PARTS).length, 'every library part is indexed by its id');

// The skeleton alone: a tube per segment (two rings, 8 sides), a fan on every tip, the root flare on the trunk foot.
const plan = generateTree(rules, { species: 'broadleaf', key: 'asm|1' });
{
  const sink = { pos: [], nrm: [], col: [], idx: [], get count() { return this.pos.length / 3; }, vert(p, n, c) { this.pos.push(p[0], p[2], -p[1]); this.nrm.push(...n); this.col.push(...c); return this.count - 1; }, tri(a, b, c) { this.idx.push(a, b, c); } };
  const tips = plan.segments.filter((g, i) => !plan.segments.some(h => h.i === i)).length;
  const n = meshSkeleton(plan, sink, false);
  assert.equal(n, (plan.segments.length + 2) * 16 + tips * 8, 'full: a 16-triangle tube per segment, two extra root rings on the trunk foot, an 8-fan per tip');
  const lite = { pos: [], nrm: [], col: [], idx: [], get count() { return this.pos.length / 3; }, vert(p, n, c) { this.pos.push(p[0], p[2], -p[1]); this.nrm.push(...n); this.col.push(...c); return this.count - 1; }, tri(a, b, c) { this.idx.push(a, b, c); } };
  assert.equal(meshSkeleton(plan, lite, true), plan.segments.length * 12 + tips * 6, 'lite: 12-triangle tubes, no flare, 6-fans');
  // vertex colours are bark multipliers in 0..1, darkest at the foot
  const foot = sink.col.slice(0, 3), high = sink.col.slice(-3);
  assert(foot.every(c => c >= 0 && c <= 1) && high.every(c => c >= 0 && c <= 1));
  // the trunk foot starts under the lawn (glTF y)
  let minY = Infinity; for (let i = 1; i < sink.pos.length; i += 3) minY = Math.min(minY, sink.pos[i]);
  assert(minY < 0 && minY > -0.1, 'the foot dips just under the ground');
}

// A batch: one mesh per (slot, colour, outline); clumps at their sockets; lite is smaller.
const items = ['broadleaf', 'conifer', 'sapling', 'blossom', 'willow'].map((species, i) => ({ plan: generateTree(rules, { species, key: `asm|${i}` }), x: i * 8, z: 0, yaw: i * 0.7, scale: 1 + i * 0.05 }));
const batch = assembler.build(items), liteBatch = assembler.build(items, { lite: true });
assert.equal(batch.userData.missingParts, 0); assert.equal(batch.userData.trees, 5);
const slots = new Set(batch.children.map(m => m.name));
assert(slots.has('trees_Bark') && slots.has('trees_Leaf') && slots.has('trees_Blossom'), `bark, leaf and blossom meshes (${[...slots]})`);
for (const m of batch.children) assert(typeof m.userData.arc_outline === 'number' && m.userData.arc_outline > 0, 'every mesh carries its outline width for the toon pass');
const count = b => b.children.reduce((s, m) => s + tris(m.geometry), 0);
const expectFull = items.reduce((s, it) => s + it.plan.sockets.reduce((t, q) => t + tris(new SphereGeometry(1, 8, 6)), 0), 0);
assert(count(batch) > expectFull, 'the batch holds every clump plus the skeletons');
assert(count(liteBatch) < count(batch), `lite is lighter (${count(liteBatch)} < ${count(batch)})`);
// the tallest tree's bounds land where its placement is; the willow's fronds hang under its sockets but above the lawn
const box = new Box3().setFromObject(batch), size = box.getSize(new Vector3());
assert(box.min.y > -0.1 && box.max.y > 4 && size.x > 30, `the batch spans the placements (${JSON.stringify(box)})`);
for (const [i, it] of items.entries()) assert(box.min.x <= it.x + 0.5 && box.max.x >= it.x - 0.5 && box.max.y >= it.plan.clear * it.scale, `tree ${i} is inside the batch`);
// one material per (slot, colour): five trees of five palettes share nothing but the slots
assert(materials.size <= 15 && materials.size >= 6);
// Wind (render/ArcadeToon.js): canopy meshes carry a sway weight (rising up each clump) and a phase; bark never sways.
for (const m of batch.children) {
  const s = m.geometry.attributes.sway;
  if (m.name === 'trees_Bark') { assert(!s, 'bark stays still'); continue; }
  assert(s && s.itemSize === 2 && s.count === m.geometry.attributes.position.count, `${m.name} sways`);
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < s.count; i++) { lo = Math.min(lo, s.getX(i)); hi = Math.max(hi, s.getX(i)); }
  assert(lo >= 0 && hi <= 1 && hi > lo, `${m.name}: sway weights in 0..1 and varying (${lo}..${hi})`);
}
// A lean (world/worldTerrain.js: a willow over water) tips the whole tree toward its water, pivoting at the foot.
const willow = items[4], upright = new Box3().setFromObject(assembler.build([{ ...willow, x: 0, z: 0, yaw: 0 }]));
const leant = new Box3().setFromObject(assembler.build([{ ...willow, x: 0, z: 0, yaw: 0, lean: [1, 0, 0.16] }]));
assert(leant.getCenter(new Vector3()).x > upright.getCenter(new Vector3()).x + 0.3, 'a leaning willow leans toward +x');
assert(Math.abs(leant.min.y - upright.min.y) < 0.2, 'its foot stays on the ground');
console.log(`Tree assembly: 5 trees -> ${batch.children.length} meshes, ${count(batch)} triangles full / ${count(liteBatch)} lite (${batch.userData.skeletonTris} skeleton).`);
