// node --import ./tools/lib/_three-real-hook.mjs tools/test/test-arcade-fp.mjs
//
// Arcade's first-person arms: the hero's arms holding each Arcade weapon, cut to the Arcade sounds.
//   - the skinned outline shell (render/ArcadeToon.js): a SkinnedMesh on the source's own skeleton and bind matrix whose
//     `normal` is the averaged outline normal, on a hull material of its own; an unskinned mesh keeps its old shell
//   - every Arcade weapon names its viewmodel, and each reload timeline runs in order and ends where its clip ends
//   - every Arcade sound override is an R2 key both manifests list, on the slot its archetype plays
//   - with the art (assets/ present): each GLB's clip names and prefix, clip lengths against the pack's times, bones,
//     Muzzle/Sight (extras.eye), Round where the weapon has one, and the arc_outline extras the engine's shells read
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bone, Skeleton, SkinnedMesh, Mesh, Group, BoxGeometry, MeshStandardMaterial, Uint16BufferAttribute, Float32BufferAttribute, Vector3 } from 'three/webgpu';
import { createArcadeToon, addOutlineNormals } from '../../src/render/ArcadeToon.js';
import { resolvePack } from '../../src/world/pack.js';
import { WEAPONS } from '../../src/config/gameplay.js';
import { DEFAULT_SOUNDS } from '../../src/config/defaultSounds.js';
import { CombatAudio } from '../../src/audio/CombatAudio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

/* ── the skinned outline shell ─────────────────────────────────────────── */

console.log('skinned outline shells');
// A two-bone box: the lower half on bone 0, the upper on bone 1; BoxGeometry splits its normals at every corner.
const skinnedBox = () => {
  const g = new BoxGeometry(0.1, 0.4, 0.1, 1, 2, 1), n = g.attributes.position.count;
  const index = new Uint16Array(n * 4), weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { index[i * 4] = g.attributes.position.getY(i) > 0.01 ? 1 : 0; weight[i * 4] = 1; }
  g.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4)); g.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4));
  return g;
};
const rigged = (geometry, material) => {
  const b0 = new Bone(), b1 = new Bone(); b1.position.y = 0.2; b0.add(b1);
  const m = new SkinnedMesh(geometry, material); m.add(b0); m.bind(new Skeleton([b0, b1]));
  return m;
};
const skin = new MeshStandardMaterial(); skin.name = 'ARC_Plaster';
const wood = new MeshStandardMaterial(); wood.name = 'ARC_Wood';
const armsGeo = skinnedBox(), arms = rigged(armsGeo, skin);
const armsNode = new Group(); armsNode.userData.arc_outline = 0.012; armsNode.add(arms);   // the GLB node carries the width
const stock = new Mesh(new BoxGeometry(0.05, 0.3, 0.05), wood); stock.userData.arc_outline = 0.006;
const root = new Group(); root.add(armsNode, stock);
const owned = new Set(), toon = createArcadeToon(owned, {});
toon.apply(root, { outline: 0.4, world: false });
const hull = arms.children.find((c) => c.userData.arcOutlineHull), stockHull = stock.children.find((c) => c.userData.arcOutlineHull);
check('a skinned mesh gets an outline shell', !!hull);
check('the shell is skinned on the same skeleton and bind matrix',
  hull?.isSkinnedMesh && hull.skeleton === arms.skeleton && hull.bindMatrix.equals(arms.bindMatrix) && hull.bindMode === arms.bindMode);
const expected = addOutlineNormals(armsGeo.clone()).attributes.outlineNormal;
const normals = hull?.geometry.attributes.normal;
check('its own geometry carries the averaged outline normal as `normal`',
  hull && hull.geometry !== armsGeo && normals.count === expected.count && [...normals.array].every((v, i) => Math.abs(v - expected.array[i]) < 1e-6)
  && [...armsGeo.attributes.normal.array].some((v, i) => Math.abs(v - expected.array[i]) > 1e-3));
check('the shell keeps the skin attributes and drops what it never draws',
  hull && hull.geometry.attributes.skinIndex.array.join() === armsGeo.attributes.skinIndex.array.join() && !hull.geometry.attributes.uv && !hull.geometry.attributes.outlineNormal);
check('the shell material pushes along the skinned normal, at the authored width x the view-model multiplier',
  hull?.material.isArcadeOutline && hull.material.isSkinnedOutline === true && Math.abs(hull.material.outlineWidth - 0.012 * 0.4) < 1e-6);
check('skinned shells have their own material, apart from an unskinned shell of the same width',
  stockHull && !stockHull.isSkinnedMesh && stockHull.material.isSkinnedOutline === false && stockHull.material !== hull.material);
check('an unskinned mesh keeps its shell: a Mesh on the shared geometry, which gains outlineNormal',
  stockHull?.geometry === stock.geometry && !!stock.geometry.attributes.outlineNormal);
check('the arms themselves are toon-shaded', arms.material.isArcadeToon === true);
check('the shell geometry is owned, so the session disposes it', owned.has(hull?.geometry));
// The shell follows the pose: bend the upper bone and the same vertex lands on the same posed point in both.
arms.skeleton.bones[1].rotation.z = 0.8; root.updateMatrixWorld(true); arms.skeleton.update();
const top = [...Array(armsGeo.attributes.position.count).keys()].find((i) => armsGeo.attributes.position.getY(i) > 0.19);
const a = arms.applyBoneTransform(top, new Vector3().fromBufferAttribute(armsGeo.attributes.position, top));
const b = hull.applyBoneTransform(top, new Vector3().fromBufferAttribute(hull.geometry.attributes.position, top));
check('the shell poses with the skeleton', a.distanceTo(b) < 1e-6 && a.distanceTo(new Vector3().fromBufferAttribute(armsGeo.attributes.position, top)) > 0.01);
const children = arms.children.length; toon.apply(root, { outline: 0.4, world: false });
check('applying again adds no second shell', arms.children.length === children);
const twin = rigged(armsGeo, skin), twinNode = new Group(); twinNode.userData.arc_outline = 0.012; twinNode.add(twin);
toon.apply(twinNode, { outline: 0.4, world: false });
check('a second rig on the same geometry reuses the shell geometry', twin.children.find((c) => c.userData.arcOutlineHull)?.geometry === hull.geometry);
for (const r of owned) r.dispose?.();

/* ── the viewmodels and their timelines ────────────────────────────────── */

console.log('\nArcade viewmodels');
const pack = read('packs/arcade/pack.json'), resolved = resolvePack(pack);
// pack id: viewmodel file, clip prefix, archetype, its Round, its own moving bones (the slingshot has no trigger)
const VIEWMODELS = {
  sidearm: ['slingshot', 'Sling', 'pistol', true, ['Pouch', 'Pebble', 'Hand_Pouch_R']],
  assault: ['repeater', 'Repeater', 'smgGun', false, ['Lever', 'Mag', 'String', 'Trigger', 'Hand_Mag_L']],
  shotgun: ['blunderbuss', 'Blunderbuss', 'shotgun', false, ['Hammer', 'Horn', 'Ramrod', 'Trigger', 'Hand_Horn_L', 'Hand_Ramrod_L', 'Hand_Barrel_R']],
  marksman: ['arbalest', 'Arbalest', 'sniper', true, ['String', 'Limb_L', 'Limb_R', 'Crank', 'Bolt', 'Trigger', 'Hand_Crank_R', 'Hand_Bolt_L']],
  launcher: ['cannon', 'Cannon', 'rpg', true, ['Fuse', 'Spark', 'Ball', 'Trigger', 'Hand_Ball_L']],
};
const onFrame = (t) => Math.abs(t * 30 - Math.round(t * 30)) < 0.02;
for (const [id, [file, prefix, archetype]] of Object.entries(VIEWMODELS)) {
  const w = pack.weapons[id], o = w?.overrides ?? {}, r = o.reload;
  check(`${id} is the ${file} and holds it with the hero's arms`, w?.archetype === archetype && w.viewmodel === `assets/v2/arcade/fp/${file}.glb`
    && resolved.weapons[id].viewmodel === w.viewmodel, w?.viewmodel);
  check(`${id} times its equip, unequip and inspect to whole 30 fps frames`,
    [o.equipTime, o.unequipTime, o.inspectTime].every((t) => t > 0 && onFrame(t)), JSON.stringify([o.equipTime, o.unequipTime, o.inspectTime]));
  for (const [name, tl, total] of [['reload', r?.timeline, r?.time], ['empty reload', r?.emptyTimeline, r?.emptyTime]]) {
    const inOrder = tl && 0 < tl.magOut && tl.magOut < tl.magIn && tl.magIn < tl.commitAmmo && tl.commitAmmo < tl.complete && tl.complete === total
      && (tl.bolt === undefined || (tl.commitAmmo < tl.bolt && tl.bolt < tl.complete));
    check(`${id} ${name}: magOut < magIn < commitAmmo < (bolt) < complete = its time, on clip frames`,
      inOrder && Object.values(tl).every(onFrame), JSON.stringify(tl));
  }
  check(`${id}'s empty reload shares the load beats (one reload sound plays for both)`,
    ['magOut', 'magIn', 'commitAmmo'].every((k) => r.emptyTimeline[k] === r.timeline[k]));
}
// The Blender clips and the pack are one timing: fp_clips.py keeps each weapon's lengths and reload markers in frames.
const clipsPy = fs.readFileSync(path.join(ROOT, 'tools/blender/v2/arcade/fp_clips.py'), 'utf8');
for (const [id, [, prefix]] of Object.entries(VIEWMODELS)) {
  const start = clipsPy.indexOf(`    '${prefix}': dict(`), end = clipsPy.indexOf('\n    ),', start), block = clipsPy.slice(start, end);
  const frame = (k) => +(block.match(new RegExp(`\\b${k}=(\\d+)`)) ?? [])[1];
  const marks = Object.fromEntries([...(block.match(/timeline=dict\(([^)]*)\)/)?.[1] ?? '').matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], +m[2]]));
  const o = pack.weapons[id].overrides, r = o.reload, s = (t) => Math.round(t * 30);
  const same = start >= 0 && s(o.equipTime) === frame('equip_frames') && s(o.unequipTime) === frame('unequip_frames') && s(o.inspectTime) === frame('inspect')
    && s(r.time) === frame('reload') && s(r.emptyTime) === (frame('reload_empty') || frame('reload'))
    && ['magOut', 'magIn', 'commitAmmo'].every((k) => s(r.timeline[k]) === marks[k]) && (r.emptyTimeline.bolt === undefined ? marks.bolt === undefined : s(r.emptyTimeline.bolt) === marks.bolt);
  check(`${id}'s pack times are ${prefix}'s frames in tools/blender/v2/arcade/fp_clips.py`, same, JSON.stringify(marks));
}
check('the cannon has no empty reload: its reload is its empty reload', pack.weapons.launcher.overrides.reload.emptyTime === pack.weapons.launcher.overrides.reload.time
  && pack.weapons.launcher.overrides.reload.emptyTimeline.bolt === undefined);

/* ── the sounds ────────────────────────────────────────────────────────── */

console.log('\nArcade sounds');
const r2 = read('tools/assets/arcade-r2-upload-manifest.json'), runtime = read('tools/assets/runtime-manifest.json');
const inR2 = new Map(r2.files.map((f) => [f.path, f])), inRuntime = new Map(runtime.files.map((f) => [f.path, f]));
const listed = (m, p) => { const f = m.get(p); return !!f && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256) && (!('key' in f) || (f.key === p && f.remotePath === p)); };
const slots = new Set();
for (const [id, [, , archetype]] of Object.entries(VIEWMODELS)) {
  for (const [kind, slot] of [['shot', WEAPONS[archetype].sound.fire], ['reload', WEAPONS[archetype].sound.reload]]) {
    slots.add(slot);
    const file = resolved.sounds[slot]?.file ?? '';
    check(`${id} plays its own ${kind} (${slot})`, new RegExp(`^assets/v2/arcade-sounds/weapon-sounds/${kind}-arcade-mode/[a-z-]+-${kind}-arcade-mode\\.mp3$`).test(file), file);
    check(`  ${file.split('/').pop()} is in the Arcade R2 manifest and the runtime manifest`, listed(inR2, file) && listed(inRuntime, file)
      && inR2.get(file).sha256 === inRuntime.get(file).sha256 && inR2.get(file).bytes === inRuntime.get(file).bytes);
  }
}
check('the pack overrides exactly the ten weapon slots, each a default slot', Object.keys(pack.sounds).length === 10
  && Object.keys(pack.sounds).every((k) => slots.has(k) && DEFAULT_SOUNDS[k]), Object.keys(pack.sounds).join(', '));
const audio = new CombatAudio({ theme: 'arcade', sounds: resolved.sounds });
const fire = audio.sounds.weapon1Fire, interval = 60 / WEAPONS.smgGun.rpm;
check('the repeater keeps one looping fire voice, its window one 600 rpm interval long, starting where it loops',
  WEAPONS.smgGun.sound.continuousFire && fire.loop === true && Math.abs(fire.loopEnd - fire.loopStart - interval) < 1e-9 && fire.offset === fire.loopStart
  && fire.minAudible < interval, JSON.stringify(fire));
check('the repeater reload plays past the default trim to the end of its reload',
  audio.sounds.weapon1Reload.duration >= pack.weapons.assault.overrides.reload.time);
check('every override keeps its slot\'s bus and gain', [...slots].every((k) => audio.sounds[k].bus === DEFAULT_SOUNDS[k].bus && audio.sounds[k].gain === DEFAULT_SOUNDS[k].gain));
audio.dispose();
check('the viewmodels are in both manifests too',
  Object.values(VIEWMODELS).every(([file]) => listed(inR2, `assets/v2/arcade/fp/${file}.glb`) && listed(inRuntime, `assets/v2/arcade/fp/${file}.glb`)));
check('the runtime manifest total still adds up', runtime.totalBytes === runtime.files.reduce((s, f) => s + f.bytes, 0));

/* ── the GLBs (only where the art is present) ──────────────────────────── */

const hasArt = fs.existsSync(path.join(ROOT, 'assets/v2/arcade/fp/slingshot.glb'));
if (!hasArt) console.log('\nSKIP: no assets/v2/arcade/fp/ in this checkout, so the viewmodel files themselves are not checked.');
else {
  console.log('\nArcade viewmodel files');
  const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) => [1, 2, 3].map((k) => `${f}${k}`));
  const ARM = ['Shoulder', 'Arm', 'ForeArm', 'ForeArmTwist', 'Hand', ...FINGERS.map((f) => `Hand${f}`)];
  const SHARED = ['Root', 'Camera', 'Shoulders', 'Weapon', 'Grip_R', 'Grip_L', 'IK_Hand_R', 'IK_Hand_L', 'Pole_R', 'Pole_L',
    ...['Left', 'Right'].flatMap((s) => ARM.map((b) => s + b))];
  for (const [id, [file, prefix, , round, own]] of Object.entries(VIEWMODELS)) {
    const bytes = fs.readFileSync(path.join(ROOT, `assets/v2/arcade/fp/${file}.glb`));
    const j = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    const clips = Object.fromEntries((j.animations ?? []).map((an) => [an.name, Math.max(...an.samplers.map((s) => j.accessors[s.input].max[0]))]));
    const want = ['Idle', 'Walk', 'Run', 'Equip', 'Unequip', 'Shoot', 'Shoot_B', 'Shoot_C', 'Reload', ...(id === 'launcher' ? [] : ['ReloadEmpty']), 'Inspect'];
    check(`${file}.glb carries ${prefix}_${want.join('/_')} and nothing else`,
      want.every((n) => `${prefix}_${n}` in clips) && Object.keys(clips).length === want.length, Object.keys(clips).join(', '));
    const o = pack.weapons[id].overrides, near = (a, b) => Math.abs(a - b) < 1 / 60;
    check(`  its state clips are the pack's times (so they play at 1x)`, near(clips[`${prefix}_Equip`], o.equipTime) && near(clips[`${prefix}_Unequip`], o.unequipTime)
      && near(clips[`${prefix}_Inspect`], o.inspectTime) && near(clips[`${prefix}_Reload`], o.reload.time)
      && (id === 'launcher' || near(clips[`${prefix}_ReloadEmpty`], o.reload.emptyTime)), JSON.stringify(clips));
    check('  every clip is whole 30 fps frames', Object.values(clips).every(onFrame));
    const interval = 60 / WEAPONS[VIEWMODELS[id][2]].rpm;
    check(`  the shot clip covers the fire interval (${interval.toFixed(3)} s)`, clips[`${prefix}_Shoot`] >= interval - 1e-6);
    const joints = new Set((j.skins?.[0]?.joints ?? []).map((i) => j.nodes[i].name));
    const missing = [...SHARED, ...own].filter((n) => !joints.has(n));
    check(`  the bones: the shared arm rig and ${own.join(', ')}`, missing.length === 0, missing.join(', '));
    const nodes = Object.fromEntries(j.nodes.map((n) => [n.name, n]));
    check('  Muzzle and Sight (with its eye relief)', !!nodes.Muzzle && nodes.Sight?.extras?.eye > 0);
    check(`  ${round ? 'a' : 'no'} Round`, !!nodes.Round === round);
    const meshes = j.nodes.filter((n) => n.mesh !== undefined);
    check('  every mesh node carries arc_outline (arms and weapon 0.006, strings 0) and is skinned',
      meshes.every((n) => typeof n.extras?.arc_outline === 'number' && n.skin !== undefined)
      && meshes.filter((n) => n.name.endsWith('_Arms')).every((n) => n.extras.arc_outline === 0.006)
      && meshes.filter((n) => n.name.endsWith('_String')).every((n) => n.extras.arc_outline === 0), meshes.map((n) => `${n.name}:${n.extras?.arc_outline}`).join(' '));
    check('  only the kit\'s ARC_ materials, no baked outline shell, no textures',
      j.materials.every((m) => /^ARC_/.test(m.name) && m.name !== 'ARC_Outline') && !(j.images?.length), j.materials.map((m) => m.name).join(', '));
  }
}

console.log(failures ? `\nFAILED: ${failures}` : '\nAll Arcade first-person checks passed.');
process.exit(failures ? 1 : 0);
