/**
 * The creature assembler (src/render/CreatureAssembler.js) against a library shaped exactly like the parts
 * GLB as GLTFLoader delivers it (sanitised node names, the part id in userData.name, sockets as children):
 * parts land on their sockets, pairs mirror into correctly wound copies, faces and patterns project onto
 * the surface, the palette reaches every slot, and the result survives the rigid-body bake and the toon kit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Group, Mesh, Object3D, SphereGeometry, MeshStandardMaterial, Vector3 } from 'three/webgpu';
import { generateCreature } from '../../src/world/creatureGrammar.js';
import { CREATURE_PARTS } from '../../src/world/creatureParts.js';
import { createCreatureAssembler, scatterDirs, Skin, fdir } from '../../src/render/CreatureAssembler.js';
import { prepareRigidBody } from '../../src/anim/RigidBody.js';
import { createArcadeToon } from '../../src/render/ArcadeToon.js';

const rules = JSON.parse(fs.readFileSync('packs/arcade/pack.json')).creatures;
const SOCKET_AT = { top: [0, 1, 0], arm: [0.45, 0.45, 0], foot: [0.2, 0, 0.05], wing: [0.35, 0.8, -0.1], antenna: [0.1, 0.9, 0.25],
  ear: [0.25, 0.85, 0], horn: [0.28, 0.85, 0], shell: [0, 0.3, 0], neck: [0, 0.55, 0] };
const geo = new SphereGeometry(0.5, 12, 8).translate(0, 0.5, 0);
function library() {
  const scene = new Group();
  for (const [id, info] of Object.entries(CREATURE_PARTS)) {
    const node = new Mesh(geo, new MeshStandardMaterial({ name: /leaf|moss|cloak/.test(id) ? 'CRT_Leaf' : /cap|shell|horn|wing/.test(id) ? 'CRT_Accent' : 'CRT_Body' }));
    node.name = id.replace(/[.:]/g, ''); node.userData.name = id; node.userData.arc_outline = 0.02;
    if (info.face) node.userData.face = { c: [0, 0.5, 0], el: 10, az: 22, r: 0.1 };
    if (info.pattern) node.userData.pattern = { c: [0, 0.5, 0], el: [15, 85] };
    for (const s of info.sockets) {
      assert(SOCKET_AT[s], `socket "${s}" needs a test position`);
      const e = new Object3D(); e.name = `${node.name}${s}`; e.userData.socket = s; e.position.set(...SOCKET_AT[s]); e.rotation.z = 0.3; node.add(e);
    }
    scene.add(node);
  }
  return scene;
}
const calls = [];
const assembler = createCreatureAssembler({ library: library(), material: (slot, hex) => { calls.push([slot, hex]); return new MeshStandardMaterial({ name: `${slot}:${hex}` }); } });
assert.equal(assembler.parts.size, Object.keys(CREATURE_PARTS).length, 'every library node is indexed by its part id, not its sanitised name');

// Projection primitives.
const skin = new Skin(geo, new Vector3(0, 0.5, 0));
const up = skin.hit(fdir(0, 90)), front = skin.hit(fdir(0, 0));
assert(Math.abs(up.point.y - 1) < 0.02 && up.normal.y > 0.95, 'a ray from inside meets the surface with an outward normal');
assert(front.point.z > 0.45, '+Z is the front');
for (const kind of ['spots', 'dots', 'ring']) {
  const dirs = scatterDirs({ el: [15, 85] }, 9, 42, kind);
  assert(dirs.length > 0 && dirs.length <= 9);
  for (const d of dirs) { const el = Math.asin(d.y) * 180 / Math.PI; assert(el >= 14.9 && el <= 85.1, `${kind}: inside the zone`); }
  if (kind !== 'ring') for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) assert(dirs[i].angleTo(dirs[j]) > 0.2, 'Poisson-disc spacing');
}
assert.deepEqual(scatterDirs({ el: [15, 85] }, 9, 42, 'spots').map(d => d.toArray()), scatterDirs({ el: [15, 85] }, 9, 42, 'spots').map(d => d.toArray()), 'seeded');

const toon = createArcadeToon(new Set());
let built = 0;
for (const family of Object.keys(rules.families)) for (const role of ['hostile', 'friendly']) for (let i = 0; i < 12; i++) {
  const bp = generateCreature(rules, { family, key: `asm|${i}`, role });
  calls.length = 0;
  const model = assembler.build(bp, { merge: false });
  const meshes = model.children.filter(o => o.isMesh);
  const partMeshes = bp.parts.reduce((n, p) => n + (p.pair ? 2 : 1), 0);
  assert(meshes.length > partMeshes, `${family}: parts plus face features`);
  for (const m of meshes) { m.updateMatrix(); assert(m.matrix.elements.every(Number.isFinite)); assert(m.matrix.determinant() > 0, 'no negative-scale transforms reach the bake'); }
  assert(calls.some(([slot, hex]) => slot === 'Body' && hex === bp.palette.body), `${family}: the body takes the palette`);
  if (bp.face.eyes === 'round') assert(meshes.filter(m => m.material.name.startsWith('White')).length >= 2, 'two eye whites');
  for (const p of bp.parts.filter(p => p.pair)) {
    const xs = meshes.filter(m => m.material.name.startsWith('Body') || m.material.name.startsWith('Accent') || m.material.name.startsWith('Leaf')).map(m => m.position.x);
    assert(xs.some(x => x > 0.05) && xs.some(x => x < -0.05), `${family}: ${p.part} on both sides`);
  }
  // Merged: one mesh per material and outline width, every triangle kept, then the rigid bake and the toon kit
  // take it as they take an authored critter.
  const tri = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const merged = assembler.build(bp);
  assert(merged.children.length < meshes.length, 'fewer draw calls');
  assert.equal(merged.children.reduce((n, m) => n + tri(m.geometry), 0), meshes.reduce((n, m) => n + tri(m.geometry), 0), 'no triangle lost');
  for (const m of merged.children) assert(m.geometry.attributes.color && m.userData.arc_outline !== undefined);
  const report = prepareRigidBody(family, merged, 1.4);
  assert(Math.abs(report.height - 1.4) < 1e-3);
  toon.apply(merged, { outline: report.scale });
  assert(merged.children.some(m => m.children.some(c => c.userData.arcOutlineHull)), 'outline shells');
  built++;
}
// The same blueprint builds the same creature.
const bp = generateCreature(rules, { family: 'shroom', key: 'same' });
const p1 = assembler.build(bp, { merge: false }).children.map(m => m.position.toArray().map(v => v.toFixed(6)).join()), p2 = assembler.build(bp, { merge: false }).children.map(m => m.position.toArray().map(v => v.toFixed(6)).join());
assert.deepEqual(p1, p2);
assert.throws(() => assembler.build({ ...bp, parts: [{ slot: 'body', part: 'dragon.body', on: null }] }), /not in the library/);
console.log(`Creature assembly: ${built} creatures across ${Object.keys(rules.families).length} families built, mirrored, faced, baked and outlined.`);
