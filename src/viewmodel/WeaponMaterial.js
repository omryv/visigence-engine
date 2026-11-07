/**
 * THE WEAPON'S MATERIAL, DERIVED FROM ITS OWN TEXTURE.
 *
 * ============ THE PROBLEM ============
 *
 * `assets/smg-gun.glb` is a Tripo export: ONE fused mesh, ONE primitive, ONE material, one
 * baked base-colour JPEG. src/viewmodel/ViewmodelLoader.js
 * then set a single roughness (0.54) and a single metalness (0.34) over the whole thing.
 * So the barrel, the polymer grip, the rubber cheek, the optic's glass, the cyan screens
 * and the painted markings were all the same substance, and the substance was slightly
 * shiny plastic. That is the brief's item 11 in one sentence: the weapon reads as one
 * moulding because, materially, it IS one moulding.
 *
 * Splitting the mesh is not available - there are no material groups, no UV islands worth
 * anything, and no way to know which triangle is which part.
 *
 * ============ THE ANSWER ============
 *
 * The information is already in the texture. A Tripo bake is a painted model: the grip IS
 * painted near-black, the receiver IS painted olive, the raw metal IS painted grey, the
 * screens ARE painted saturated cyan. So this classifies every texel by hue, saturation and
 * value and gives each family the PBR response it should have had:
 *
 *   EMISSIVE SCREEN   saturated cyan and bright   emissive, smooth, non-metal
 *   RAW METAL         desaturated, mid value      rough 0.30, metal 0.88 - the read the
 *                                                 weapon had none of
 *   COATED METAL      the saturated shell colour  rough 0.55, metal 0.14 - paint OVER metal
 *   POLYMER / RUBBER  dark and desaturated        rough 0.86, metal 0
 *   PAINTED MARKING   very bright, desaturated    rough 0.72, metal 0
 *
 * Every boundary is a smoothstep, never a threshold, or the weapon comes out posterised.
 *
 * ============ WEAR, WHERE IT IS EARNED ============
 *
 * The brief is specific: grip contact, magazine insertion, the charging mechanism, exposed
 * corners, moving components - and nowhere else. Those are not guesses here: the measured
 * anatomy in config/assets.js WEAPON_RIGS already names the grip, the fore-end, the
 * ejection port and the muzzle in the model's own space, and createWeaponMaterial takes
 * them. Wear is the union of small spheres around those points, modulated by a procedural
 * noise so it is patchy rather than a gradient, and it does exactly what paint wearing off
 * metal does: roughness DOWN, metalness UP, and a slight lift in value.
 *
 * Nothing here changes geometry, scale, the corrective quaternion, the sockets, the
 * magazine cut or any measurement. If the source material has no map - a replacement model,
 * a failed decode - the caller falls back to the flat tune this replaces, so the weapon can
 * never fail to render.
 */

import { MeshStandardNodeMaterial, Vector3, Quaternion } from 'three/webgpu';
import {
  texture, uv, positionLocal, float, vec3, mix, smoothstep, clamp, max, min, Fn, sin, length, uniform, abs, cross,
} from 'three/tsl';

/**
 * The five material families. Roughness and metalness only - the colour stays the artist's.
 *
 * The spread is the point. Two stops of roughness between the rubber and the raw metal is
 * visible across a room; a metalness difference of the same size is not, which is why
 * roughness carries the read here exactly as it does for the architecture
 * (config/assets.js SURFACE_MATERIALS says the same thing about the level).
 */
const FAMILY = {
  screen: { roughness: 0.14, metalness: 0.00 },
  rawMetal: { roughness: 0.30, metalness: 0.88 },
  coated: { roughness: 0.55, metalness: 0.14 },
  polymer: { roughness: 0.86, metalness: 0.00 },
  marking: { roughness: 0.72, metalness: 0.00 },
};

/**
 * How hard the screens glow.
 *
 * RESTRAINED, because the brief says so twice: "emissive cyan elements must remain
 * restrained", "they should not glow across the entire weapon". 0.9 puts the brightest
 * screen texels just over render/PostFX.js's 0.82 bloom threshold, so a screen has a halo
 * and the pale cyan trim on the shell - which is the same hue and half the saturation -
 * has none at all. That gap is the whole effect.
 */
const EMISSIVE_STRENGTH = 0.9;

/** Radii, in model-local units, of the wear zones around each measured landmark. */
const WEAR_ZONES = [
  { key: 'grip', radius: 0.085, weight: 1.00 },      // the palm, every shot of the run
  { key: 'fore', radius: 0.075, weight: 0.75 },      // the support hand
  { key: 'ejection', radius: 0.060, weight: 0.90 },  // the charging mechanism's travel
  { key: 'muzzle', radius: 0.045, weight: 0.55 },    // the one exposed corner that gets knocked
];

const _q = new Quaternion();
const _v = new Vector3();

/**
 * A landmark measured in CORRECTED space, expressed in the model's own local space.
 *
 * ViewmodelLoader puts the GLB under a node carrying `correctiveQuat`, so every measured
 * point in config/assets.js is post-rotation and a shader sampling `positionLocal` is
 * pre-rotation. One inverse quaternion reconciles them, and doing it here on the CPU costs
 * nothing and keeps the shader free of a constant rotation.
 */
function toLocal(correctiveQuat, point) {
  _q.fromArray(correctiveQuat).invert();
  _v.fromArray(point).applyQuaternion(_q);
  return _v.clone();
}

/**
 * Smooth, tileable-enough procedural noise from three sine octaves.
 *
 * Deterministic - no textures, no randomness, the same weapon on every machine - and about
 * as cheap as a noise gets. It never has to resolve as a shape, only to break a wear mask
 * up so it reads as chipping rather than as an airbrushed gradient.
 */
const wearNoise = /*#__PURE__*/ Fn(([p]) => {
  const a = sin(p.x.mul(9.1).add(p.y.mul(4.7)).add(p.z.mul(6.3)));
  const b = sin(p.x.mul(23.3).sub(p.z.mul(17.9)).add(p.y.mul(11.1)));
  const c = sin(p.y.mul(41.7).add(p.x.mul(31.1)).sub(p.z.mul(7.3)));
  return a.mul(0.50).add(b.mul(0.32)).add(c.mul(0.18)).mul(0.5).add(0.5);
});

/**
 * @param {import('three').Material} source  the material GLTFLoader produced
 * @param {object} o
 * @param {string} o.id                      the weapon id, for naming
 * @param {object} o.rig                     the WEAPON_RIGS entry (measured anatomy)
 * @param {'model'|'rig'} [o.space]          which space the mesh's vertices are in. 'model'
 *   (default) is a raw export under the corrective node; 'rig' is an authored assembly whose
 *   vertices are already corrected, translated to the grip point and scaled - the shader
 *   then maps each vertex BACK into source space, so the wear zones and the energy axis,
 *   both measured there, apply unchanged.
 * @param {number} [o.scale]                 the rig scale, required for space 'rig'
 * @returns {MeshStandardNodeMaterial|null}  null when the source has nothing to classify
 */
export function createWeaponMaterial(source, { id, rig, space = 'model', scale = 1 }) {
  const map = source?.map;
  if (!map) return null;

  /**
   * The vertex in the SOURCE model's space. For a raw export that is positionLocal itself;
   * for an assembly it is rig -> corrected (divide by the scale, add the grip point) ->
   * source (the inverse corrective quaternion, as v + 2 q x (q x v + w v)).
   */
  let localPos = positionLocal;
  if (space === 'rig') {
    const gp = rig.gripPoint || [0, 0, 0];
    const corrected = positionLocal.div(float(scale)).add(vec3(gp[0], gp[1], gp[2]));
    const [qx, qy, qz, qw] = rig.correctiveQuat;
    const qv = vec3(-qx, -qy, -qz);
    localPos = corrected.add(cross(qv, cross(qv, corrected).add(corrected.mul(qw))).mul(2));
  }

  const mat = new MeshStandardNodeMaterial();
  mat.name = `Weapon:${id}`;

  mat.side = source.side;
  mat.transparent = false;

  const uvNode = uv();
  const base = texture(map, uvNode).rgb;

  // --- hue, saturation and value, cheaply, from the linear base colour ---
  const v = max(max(base.r, base.g), base.b);
  const mn = min(min(base.r, base.g), base.b);
  // HSV saturation. The guard on the divisor is what keeps a near-black texel - of which
  // this weapon has a great many - from producing a NaN and a black hole in the shell.
  const sat = v.sub(mn).div(max(v, float(0.0015)));
  /**
   * How cyan a texel is: how far the SMALLER of green and blue rises above red. A screen
   * scores near 1, the pale cyan trim on the shell scores about 0.3, and the olive body
   * scores 0. Doubling and clamping is what separates the first from the second.
   */
  const cyan = clamp(min(base.g, base.b).sub(base.r).mul(2.4), 0, 1);

  // --- the five family masks. Every one a smoothstep pair, so nothing posterises. ---
  const screen = cyan.mul(smoothstep(0.16, 0.42, v)).mul(smoothstep(0.30, 0.62, sat));
  const dark = smoothstep(0.13, 0.030, v);
  const desat = smoothstep(0.34, 0.13, sat);
  const bright = smoothstep(0.55, 0.86, v);
  const marking = bright.mul(desat).mul(cyan.oneMinus());
  const rawMetal = desat.mul(smoothstep(0.055, 0.20, v)).mul(bright.oneMinus()).mul(cyan.oneMinus());
  const polymer = dark.mul(cyan.oneMinus());
  // Whatever is left is the painted shell, which is most of the weapon by area.
  const coated = clamp(float(1).sub(screen).sub(marking).sub(rawMetal).sub(polymer), 0, 1);

  const blend = (field) => screen.mul(FAMILY.screen[field])
    .add(marking.mul(FAMILY.marking[field]))
    .add(rawMetal.mul(FAMILY.rawMetal[field]))
    .add(polymer.mul(FAMILY.polymer[field]))
    .add(coated.mul(FAMILY.coated[field]))
    .div(max(screen.add(marking).add(rawMetal).add(polymer).add(coated), float(0.001)));

  let roughness = blend('roughness');
  let metalness = blend('metalness');

  /**
   * --- WEAR ---
   *
   * The union of the measured contact zones, softened, multiplied by the noise, and then
   * gated to the painted shell: paint wears off metal, and there is nothing to wear off a
   * screen, a rubber grip or a bare barrel. A hand that has held this weapon for a mission
   * has polished the shell where it gripped it, and that is all this says.
   */
  let contact = float(0);
  for (const zone of WEAR_ZONES) {
    const pt = rig?.[zone.key === 'grip' ? 'gripPoint'
      : zone.key === 'fore' ? 'foreRig'
        : zone.key === 'ejection' ? 'ejectionPoint' : 'muzzlePoint'];
    if (!pt) continue;
    // foreRig is measured in RIG space, which is corrected space translated by the grip.
    const corrected = zone.key === 'fore' && rig.gripPoint
      ? [pt[0] + rig.gripPoint[0], pt[1] + rig.gripPoint[1], pt[2] + rig.gripPoint[2]]
      : pt;
    const local = toLocal(rig.correctiveQuat, corrected);
    const d = length(localPos.sub(vec3(local.x, local.y, local.z)));
    contact = contact.add(smoothstep(zone.radius, zone.radius * 0.35, d).mul(zone.weight));
  }
  const grain = wearNoise(localPos.mul(28));
  // Thresholded high: wear is patches, not a wash. Roughly a fifth of a contact zone.
  const wear = clamp(contact, 0, 1).mul(smoothstep(0.52, 0.86, grain)).mul(coated);

  roughness = mix(roughness, float(0.26), wear.mul(0.85));
  metalness = mix(metalness, float(0.80), wear.mul(0.75));

  /**
   * The colour is the artist's, with two edits: worn patches lift toward the pale substrate
   * underneath, and everything else is left exactly as painted. The brief says to keep the
   * weapon's design - so the design is kept, and only its RESPONSE changes.
   */
  mat.colorNode = base.mul(mix(float(1), float(1.28), wear))
    // A screen's own diffuse goes dark: it is a lit panel, not a painted one, and its
    // brightness has to come from the emissive term or it cannot read as switched on.
    .mul(mix(float(1), float(0.30), screen));
  mat.roughnessNode = clamp(roughness, float(0.06), float(1));
  mat.metalnessNode = clamp(metalness, float(0), float(1));
  mat.emissiveNode = base.mul(screen).mul(EMISSIVE_STRENGTH);

  if (id === 'rpg' || id === 'shotgun' || id === 'sniper') {
    // Classify the original blue pipe texels, including blue that is not cyan.
    // No extra geometry or replacement texture: the illumination follows the baked design.
    const charge = uniform(1), flow = uniform(0), phase = uniform(0);
    mat.userData.energy = { charge, flow, phase };
    const blue = smoothstep(0.08, 0.30, base.b.sub(base.r))
      .mul(smoothstep(0.18, 0.48, v)).mul(smoothstep(0.18, 0.45, sat));
    // The muzzle end of each SOURCE mesh: +Z on the launcher, +X on the shotgun, -X on the
    // sniper (its corrective quaternion is the shotgun's mirrored). Filling travels back
    // along the actual barrel from there.
    const axis = id === 'shotgun' ? localPos.x : id === 'sniper' ? localPos.x.negate() : localPos.z;
    const fill = smoothstep(axis.negate().add(.48), axis.negate().add(.55), charge.mul(1.15));
    const pulse = sin(axis.mul(42).add(phase.mul(16))).mul(.5).add(.5).pow(6).mul(flow);
    const front = float(1).sub(smoothstep(0, .1, abs(axis.sub(float(.5).sub(charge))))).mul(flow);
    mat.colorNode = mat.colorNode.mul(mix(1, fill.mul(.65).add(.12), blue));
    mat.emissiveNode = base.mul(blue).mul(fill.mul(1.4).add(pulse.mul(3)).add(front.mul(2)).add(.035));
  }

  return mat;
}
