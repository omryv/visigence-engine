/**
 * The AUTHORED weapon assemblies: a Blender-exported GLB that already contains the weapon
 * cut into its moving parts, both hands skinned to their sixteen-bone skeletons, and the
 * clips that drive all of it. Five ship: art-source/smg/ (assets/smg-gun-animated.glb),
 * art-source/shotgun/ (assets/shotgun-animated.glb), art-source/pistol/
 * (assets/pistol-animated.glb), art-source/sniper/ (assets/sniper-animated.glb) and
 * art-source/rpg/ (assets/rpg-animated.glb). See WEAPON_RIGS[*].authored.
 *
 * Everything the procedural path has to build - a skeleton for each hand, a grip solve, a
 * magazine cut out of the receiver, a reload choreographed over anchors - the file brings
 * with it, so this loader does deliberately little:
 *
 *   1. RESTORE THE REST PLACEMENTS the export dropped. Blender wrote every node it never
 *      keyed at identity: the right-hand armature, the seated magazine, the charging handle,
 *      the fore-end, the power cell. Left there, the fore-end renders at the grip point and
 *      the firing hand lies flat along the magazine well. Each such node's rest transform is
 *      taken from the first keyframe of the first clip that moves it (every clip that keys a
 *      node starts it at home), and a never-keyed hand that the export also left at identity
 *      from WEAPONS[id].hands, which is the same placement the Blender scene was built from
 *      (its left-hand keys are that file's numbers to four decimals). The later pistol,
 *      sniper and RPG exports write every node's rest transform into the file itself, so
 *      there is nothing to restore on those and the file's own placement is kept. Because
 *      the AnimationMixer captures a node's "original" value the first time an action binds
 *      it, doing this BEFORE any action plays is what makes a finished reload hand the
 *      magazines back to the right places.
 *
 *   2. Hang the assembly root under a WeaponMount at IDENTITY. The assembly is in rig space
 *      already (see the config comment), so the corrective quaternion and the scale that
 *      buildWeaponRig applies to a raw Tripo export would here be applied a second time.
 *
 *   3. Place the sockets (muzzle, ejection port, sight line, trigger, fore-end, pistol grip)
 *      from the same measured landmarks as the procedural rig, but under the ASSEMBLY ROOT
 *      rather than the mount: the clips translate and rotate that root (the idle breathe, the
 *      equip drop, the recoil), and a muzzle that stayed on the mount would flash beside the
 *      barrel instead of at it.
 *
 *   4. Bind the clips: semantic names through CLIP_PATTERNS, one cached action each. The
 *      AimIn clip loses its root track first (AUTHORED_ANIM.adsHandsOnly) - the sight
 *      picture is solved by the game, and the clip's guess at it would be added on top.
 */

import { Group, Object3D, AnimationMixer, AnimationClip, LoopOnce, LoopRepeat, Euler } from 'three/webgpu';
import { HAND_RIGS, VIEWMODEL_MATERIAL_FIX } from '../config/assets.js';
import { CLIP_PATTERNS, AUTHORED_ANIM } from '../config/viewmodel.js';
import { resolveClips } from '../core/AssetInspector.js';
import { createWeaponMaterial } from './WeaponMaterial.js';
import { tuneViewModelMaterial, markViewModelMesh } from './ViewmodelLoader.js';

const _e = new Euler(0, 0, 0, 'XYZ');

/** Semantic clips that loop. Everything else is a one-shot held on its last frame. */
export const LOOPING_CLIPS = new Set(['idle', 'sprint', 'walk']);

/** True when this weapon's config names an assembly AND the loaded file actually carries clips. */
export function isAuthoredGLTF(rigCfg, gltf) {
  return !!rigCfg?.authored && (gltf?.animations?.length ?? 0) > 0;
}

/** The node a mixer track drives, by the track's `NodeName.property` name. */
function trackTarget(root, track) {
  const dot = track.name.lastIndexOf('.');
  if (dot < 0) return null;
  const nodeName = track.name.slice(0, dot);
  const prop = track.name.slice(dot + 1);
  const node = root.getObjectByName(nodeName);
  return node ? { node, prop } : null;
}

/**
 * Put every un-keyed node where the clips expect it. Idempotent: the scene is marked, and
 * the loadout preview and the rig both run this against the one loaded scene.
 *
 * @param {object} gltf        GLTFLoader result
 * @param {object} rigCfg      WEAPON_RIGS[id]
 * @param {object} def         WEAPONS[id] - for the never-keyed hand placement
 */
export function prepareAuthoredScene(gltf, rigCfg, def) {
  const scene = gltf.scene;
  // The root is remembered on the scene rather than looked up again: buildAuthoredRig moves
  // it under the WeaponMount, and a display piece asked for after that would not find it.
  if (scene.userData.authoredPrepared) return scene.userData.authoredRoot;
  const a = rigCfg.authored;
  const root = scene.getObjectByName(a.root);
  if (!root) throw new Error(`Authored rig: no node "${a.root}" in the ${rigCfg.authored.root} assembly`);
  scene.userData.authoredRoot = root;

  // 1. rest transforms from the first keyframe of the first clip that keys each property.
  const restored = new Set();
  for (const clip of gltf.animations || []) {
    for (const track of clip.tracks) {
      const t = trackTarget(root, track);
      if (!t || t.node === root || t.node.isBone) continue;
      const key = `${t.node.uuid}.${t.prop}`;
      if (restored.has(key)) continue;
      restored.add(key);
      const v = track.values;
      if (t.prop === 'position') t.node.position.set(v[0], v[1], v[2]);
      else if (t.prop === 'quaternion') t.node.quaternion.set(v[0], v[1], v[2], v[3]);
      else if (t.prop === 'scale') t.node.scale.set(v[0], v[1], v[2]);
    }
  }

  // Unkeyed component translations that this export omitted cannot be recovered from
  // animation tracks. These explicit fallbacks come from the editable source scene.
  for (const [name, position] of Object.entries(a.restPositions || {})) {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`Authored rig: no component "${name}"`);
    if (!restored.has(`${node.uuid}.position`) && node.position.lengthSq() === 0) node.position.fromArray(position);
  }

  // 2. a hand nothing keys AND the export left at identity (the firing hand on the SMG and
  //    shotgun assemblies): the authored placement. A file that carries the hand's rest
  //    transform itself is trusted over the config.
  for (const side of ['right', 'left']) {
    const node = root.getObjectByName(a.hands[side]);
    if (!node) throw new Error(`Authored rig: no hand node "${a.hands[side]}"`);
    const keyedPos = restored.has(`${node.uuid}.position`);
    const keyedRot = restored.has(`${node.uuid}.quaternion`);
    const atIdentity = node.position.lengthSq() === 0 && node.quaternion.w === 1;
    const pose = def?.hands?.[side];
    if (pose && !keyedPos && atIdentity) node.position.fromArray(pose.pos);
    if (pose && !keyedRot && atIdentity) node.quaternion.setFromEuler(_e.set(pose.rot[0], pose.rot[1], pose.rot[2], 'XYZ'));
    node.userData.home = { pos: node.position.clone(), quat: node.quaternion.clone() };
  }

  for (const name of a.hidden || []) {
    const n = root.getObjectByName(name);
    if (n) n.visible = false;
  }
  root.updateMatrixWorld(true);
  scene.userData.authoredPrepared = true;
  return root;
}

/**
 * A copy of a clip without the tracks that drive `nodeName`. Used to take the AimIn clip's
 * root motion away; the clip keeps its name so the report still says what it was.
 */
function withoutNode(clip, nodeName) {
  const tracks = clip.tracks.filter((t) => t.name.slice(0, t.name.lastIndexOf('.')) !== nodeName);
  if (tracks.length === clip.tracks.length) return clip;
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Build one authored weapon rig. Returns the same shape buildWeaponRig does, plus:
 *   authored   the config block, so every consumer can branch on it
 *   root       the assembly root the clips move (sockets live under it)
 *   handNodes  {right, left}: the armature nodes, for the throw and the reach
 *   roundNode  the loaded-round mesh (WEAPON_RIGS[*].authored.round), or null
 *   clipDurations  semantic -> authored seconds, for the fit
 *
 * @returns {import('./ViewmodelLoader.js').WeaponRig}
 */
export function buildAuthoredRig(id, rigCfg, gltf, def) {
  const a = rigCfg.authored;
  const root = prepareAuthoredScene(gltf, rigCfg, def);
  const scale = rigCfg.targetLength / rigCfg.correctedLength;

  const mount = new Group();
  mount.name = `WeaponMount:${id}`;
  mount.add(root);
  root.name = a.root;

  // --- materials: gloves get the glove fix, effect helpers keep what Blender gave them,
  //     everything else the weapon's derived family ---
  const handMeshes = new Set(a.handMeshes || []);
  const effects = a.effects || [];
  const swapped = new Map();
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    markViewModelMesh(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (handMeshes.has(o.name)) {
      for (const m of mats) if (m && !seen.has(m)) { seen.add(m); tuneViewModelMaterial(m, HAND_RIGS.materialFix); }
      return;
    }
    // The sniper's plasma core and pipe-flow spheres: authored emissives with no wear
    // zones to classify. The derived material would read them as painted shell.
    if (effects.some((p) => p.test(o.name))) return;
    const out = [];
    for (const m of mats) {
      if (!m) { out.push(m); continue; }
      if (swapped.has(m)) { out.push(swapped.get(m)); continue; }
      // The assembly's vertices are in RIG space; the wear zones and the energy axis are
      // measured in the source model's space, so the material is told to convert.
      const derived = createWeaponMaterial(m, { id, rig: rigCfg, space: 'rig', scale });
      if (derived) { swapped.set(m, derived); out.push(derived); continue; }
      swapped.set(m, m);
      if (!seen.has(m)) { seen.add(m); tuneViewModelMaterial(m, VIEWMODEL_MATERIAL_FIX.weapon); }
      out.push(m);
    }
    o.material = Array.isArray(o.material) ? out : out[0];
  });

  // --- sockets, from the measured landmarks, riding the animated root ---
  const socket = (name, point) => {
    const o = new Object3D();
    o.name = `${name}:${id}`;
    o.position.set(
      (point[0] - rigCfg.gripPoint[0]) * scale,
      (point[1] - rigCfg.gripPoint[1]) * scale,
      (point[2] - rigCfg.gripPoint[2]) * scale
    );
    root.add(o);
    return o;
  };
  const muzzle = socket('muzzle', rigCfg.muzzlePoint);
  const ejection = socket('ejection', rigCfg.ejectionPoint || rigCfg.gripPoint);
  const sight = socket('sight', rigCfg.sightPoint || rigCfg.muzzlePoint);
  const rigSocket = (name, point) => {
    const o = new Object3D();
    o.name = `${name}:${id}`;
    if (point) o.position.fromArray(point);
    root.add(o);
    return o;
  };
  const trigger = rigSocket('trigger', rigCfg.triggerRig);
  const fore = rigSocket('fore', rigCfg.foreRig);
  const handGrip = rigSocket('handGrip', rigCfg.handGripRig);

  const handNodes = {
    right: root.getObjectByName(a.hands.right),
    left: root.getObjectByName(a.hands.left),
  };
  /**
   * The loaded round, when the assembly has one (the RPG's rocket): shown by
   * AuthoredAnimator only while a round is chambered or a reload is bringing one in.
   */
  const roundNode = a.round ? root.getObjectByName(a.round) || null : null;

  // --- the clips ---
  const clipsIn = gltf.animations || [];
  const clips = resolveClips(clipsIn, CLIP_PATTERNS);
  if (clips.ads && AUTHORED_ANIM.adsHandsOnly) clips.ads = withoutNode(clips.ads, a.root);
  const mixer = new AnimationMixer(root);
  const actions = {};
  const clipDurations = {};
  for (const [semantic, clip] of Object.entries(clips)) {
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    const looping = LOOPING_CLIPS.has(semantic);
    action.setLoop(looping ? LoopRepeat : LoopOnce, looping ? Infinity : 1);
    action.clampWhenFinished = !looping;
    actions[semantic] = action;
    clipDurations[semantic] = clip.duration;
  }

  return {
    id, mount, model: root, root, muzzle, ejection, sight, trigger, fore, handGrip,
    rightGripAnchor: handGrip,
    leftSupportAnchor: fore,
    handNodes,
    roundNode,
    /** No cut magazine: the assembly ships its own two and the reload clips move them. */
    magazine: null,
    collisionRoot: mount,
    cfg: rigCfg,
    authored: a,
    scale, mixer, clips, actions, clipDurations, rawClips: clipsIn,
  };
}

