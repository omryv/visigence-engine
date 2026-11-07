/**
 * Builds the first-person rigs from the loaded GLBs and the MEASURED landmarks in
 * config/assets.js. Nothing about a model's internal structure is assumed: the loader binds
 * whatever animation clips exist to semantic names (core/AssetInspector.js resolveClips).
 *
 * Every socket below (grip, muzzle, ejection port, sight line, trigger) is an empty placed
 * at a measured point. The mixer path is built whenever a GLB ships clips, so a rigged
 * weapon needs no code change - only clip names that CLIP_PATTERNS can match.
 *
 * Rig layout for a weapon:
 *     WeaponMount            origin IS the grip point (HandsRoot puts it where the hands are)
 *       ├── pivot            translated by -gripPoint * scale
 *       │     └── model      the GLB with its corrective quaternion and scale
 *       ├── muzzle           empty at (muzzlePoint - gripPoint) * scale
 *       ├── ejection         empty at (ejectionPoint - gripPoint) * scale
 *       ├── sight            empty at (sightPoint - gripPoint) * scale, looking down -Z
 *       └── trigger          empty at triggerRig (already rig space)
 */

import { Group, Object3D, AnimationMixer, LoopOnce, LoopRepeat } from 'three/webgpu';
import { VIEWMODEL_MATERIAL_FIX } from '../config/assets.js';
import { CLIP_PATTERNS } from '../config/viewmodel.js';
import { resolveClips } from '../core/AssetInspector.js';
import { buildMagazineRig } from './MagazineRig.js';
import { createWeaponMaterial } from './WeaponMaterial.js';
import { isAuthoredGLTF, buildAuthoredRig } from './AuthoredRig.js';

/**
 * The ONE place a first-person material is specified. Both guns and both hands go through
 * it, so the view model is a single surface family rather than four GLBs' worth of Tripo
 * defaults. See VIEWMODEL_MATERIAL_FIX in config/assets.js for why.
 */
export function tuneViewModelMaterial(mat, fix) {
  if (!mat) return;
  mat.roughness = fix.roughness;
  mat.metalness = fix.metalness;
  mat.envMapIntensity = VIEWMODEL_MATERIAL_FIX.envMapIntensity;
  // Tripo declares KHR_materials_volume, so GLTFLoader hands back a transmissive
  // MeshPhysicalMaterial. Nothing on a weapon or a glove is glass, and transmission costs
  // a whole extra pass.
  if (mat.transmission !== undefined) mat.transmission = 0;
  if (mat.thickness !== undefined) mat.thickness = 0;
  mat.needsUpdate = true;
}

/** Marks a first-person mesh: never culled, never shadowing the world, drawn late. */
export function markViewModelMesh(o) {
  o.castShadow = false;
  o.receiveShadow = false;
  o.frustumCulled = false;
  o.renderOrder = 10;
}

/**
 * @typedef {object} WeaponRig
 * @property {string} id
 * @property {Group} mount        WeaponMount; its origin is the grip point
 * @property {Object3D} model     the GLB scene, corrected and scaled
 * @property {Object3D} muzzle    empty at the muzzle
 * @property {Object3D} ejection  empty at the ejection port
 * @property {Object3D} sight     empty on the sight line, -Z along it
 * @property {number} scale
 * @property {AnimationMixer|null} mixer   null when the GLB carries no clips
 * @property {Record<string, import('three').AnimationClip|null>} clips  semantic -> clip
 * @property {Record<string, import('three').AnimationAction>} actions  cached, by semantic name
 */

/**
 * Build one weapon rig. `gltf` is the loader result (scene + animations); the semantic
 * clip map is resolved here against `gltf.animations` and cached actions are created
 * once, so the animator never rebuilds them.
 *
 * @returns {WeaponRig}
 */
export function buildWeaponRig(id, rigCfg, gltf, def = null) {
  /**
   * An AUTHORED ASSEMBLY - the weapon in parts, skinned hands and clips, straight from
   * Blender - takes the other loader entirely: nothing below (the corrective transform, the
   * material swap per fused mesh, the magazine cut) applies to a file that has already had
   * all of it done. Decided on what the FILE contains, not on config alone, so the offline
   * harness, which reads the static GLB through tools/lib/_glb.mjs with no clips, still gets
   * the procedural rig it measures.
   */
  if (isAuthoredGLTF(rigCfg, gltf)) return buildAuthoredRig(id, rigCfg, gltf, def);
  const scene = gltf.scene;
  const scale = rigCfg.targetLength / rigCfg.correctedLength;

  const mount = new Group();
  mount.name = `WeaponMount:${id}`;

  const pivot = new Group();
  pivot.name = `weaponPivot:${id}`;
  pivot.position.set(
    -rigCfg.gripPoint[0] * scale,
    -rigCfg.gripPoint[1] * scale,
    -rigCfg.gripPoint[2] * scale
  );
  mount.add(pivot);

  const model = scene;
  model.name = `weaponModel:${id}`;
  model.quaternion.set(...rigCfg.correctiveQuat);
  model.scale.setScalar(scale);
  /**
   * THE WEAPON'S MATERIAL FAMILIES (brief item 11).
   *
   * Both weapon GLBs ship one fused material for the whole gun, so a single roughness and
   * metalness had to stand for the barrel, the grip, the rubber, the optic and the screens
   * - which is exactly why the weapon read as one piece of shiny plastic. src/viewmodel/
   * WeaponMaterial.js replaces it with a node material that classifies the baked texture
   * into five material families and wears the paint where the measured anatomy says a hand
   * actually touches it.
   *
   * Replaced per MESH, not per material, because the derived material is per weapon: the
   * substitution is cached on `swapped` so a model with several meshes sharing one source
   * material still gets exactly one derived material. If the derivation cannot run - a
   * source with no base-colour map - the original flat tune is used and nothing is lost but
   * the upgrade.
   */
  const seen = new Set();
  const swapped = new Map();
  model.traverse((o) => {
    if (!o.isMesh) return;
    markViewModelMesh(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = [];
    for (const m of mats) {
      if (!m) { out.push(m); continue; }
      if (swapped.has(m)) { out.push(swapped.get(m)); continue; }
      const derived = createWeaponMaterial(m, { id, rig: rigCfg });
      if (derived) {
        swapped.set(m, derived);
        out.push(derived);
        continue;
      }
      swapped.set(m, m);
      if (!seen.has(m)) {
        seen.add(m);
        tuneViewModelMaterial(m, VIEWMODEL_MATERIAL_FIX.weapon);
      }
      out.push(m);
    }
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  pivot.add(model);

  const socket = (name, point) => {
    const o = new Object3D();
    o.name = `${name}:${id}`;
    o.position.set(
      (point[0] - rigCfg.gripPoint[0]) * scale,
      (point[1] - rigCfg.gripPoint[1]) * scale,
      (point[2] - rigCfg.gripPoint[2]) * scale
    );
    mount.add(o);
    return o;
  };
  const muzzle = socket('muzzle', rigCfg.muzzlePoint);
  const ejection = socket('ejection', rigCfg.ejectionPoint || rigCfg.gripPoint);
  const sight = socket('sight', rigCfg.sightPoint || rigCfg.muzzlePoint);
  // The trigger is measured in RIG space already (see triggerRig in config/assets.js), so it
  // is placed directly rather than through the corrected-space socket() above.
  const trigger = new Object3D();
  trigger.name = `trigger:${id}`;
  if (rigCfg.triggerRig) trigger.position.fromArray(rigCfg.triggerRig);
  mount.add(trigger);
  const fore = new Object3D();
  fore.name = `fore:${id}`;
  if (rigCfg.foreRig) fore.position.fromArray(rigCfg.foreRig);
  mount.add(fore);
  const handGrip = new Object3D();
  handGrip.name = `handGrip:${id}`;
  if (rigCfg.handGripRig) handGrip.position.fromArray(rigCfg.handGripRig);
  mount.add(handGrip);

  /**
   * THE MAGAZINE, cut out of the weapon's own triangles.
   *
   * Neither GLB ships a separate magazine object - one mesh, one primitive, one material -
   * so there is nothing to reparent until this runs. It splits the fused shell into a body
   * and a magazine, instances the magazine twice (the one being removed and the one going
   * in), and places the surface anchors a reload is animated against. See MagazineRig.
   */
  const magazine = buildMagazineRig(id, mount, model, scale);

  // --- animation: only what the GLB actually contains ---
  const clipsIn = gltf.animations || [];
  const clips = resolveClips(clipsIn, CLIP_PATTERNS);
  let mixer = null;
  const actions = {};
  if (clipsIn.length > 0) {
    mixer = new AnimationMixer(model);
    for (const [semantic, clip] of Object.entries(clips)) {
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      const looping = semantic === 'idle' || semantic === 'sprint' || semantic === 'ads';
      action.setLoop(looping ? LoopRepeat : LoopOnce, looping ? Infinity : 1);
      action.clampWhenFinished = !looping;
      actions[semantic] = action;
    }
  }

  return {
    id, mount, model, muzzle, ejection, sight, trigger, fore, handGrip,
    magazine,
    scale, mixer, clips, actions,
  };
}
