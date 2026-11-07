import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, LightingModel, Mesh, SkinnedMesh, Color, BackSide, BufferAttribute, Vector2 } from 'three/webgpu';
import { attribute, diffuseColor, float, luminance, materialReference, mix, normalLocal, normalView, positionLocal, positionViewDirection, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { markUnlit } from './Environment.js';

/**
 * ARCADE TOON: the engine half of the Blender look-dev kit (tools/blender/v2/arcade/kit.py).
 *
 * The GLBs ship plain colour (palette x the baked 'Col' gradient); this file puts back what the
 * kit's EEVEE-only toon branch drew in Blender, for every quality tier including mobile, because
 * none of it is a post pass:
 *
 *   - a soft two-tone terminator driven by how much SUN a point receives, shadow included, so
 *     cast shadows fall into the same cool shade tone as the unlit side;
 *   - a per-material shade tint (cool lilac, never grey) and a gentle lift on faces square to the sun;
 *   - a warm rim along silhouettes, strongest on the sunny side;
 *   - distance haze, which is the scene's own fog (every NodeMaterial takes it);
 *   - inverted-hull outlines: a back-face shell pushed out along smoothed normals by the width
 *     each node carries in `extras.arc_outline` (metres at the authored scale). A skinned mesh (the
 *     first-person arms, the rigged hero) gets a skinned shell on its own skeleton, so the line
 *     follows the pose.
 *
 * The sky probe and hemisphere do not light a toon surface: its shade side is a designed tint,
 * as in the kit. Point lights (muzzle flashes, beacons) still brighten what they reach.
 */

const SHADE = '#c9bedf';
/** Shade tint and rim per ARC_ material where they differ from the kit default (sRGB). */
export const TOON_MATERIALS = {
  Roof: { shade: '#bd9ec6' }, Grass: { shade: '#a9bfd0', rim: 0 }, Leaf: { shade: '#9bb6cc' }, Sand: { rim: 0 },
  Glass: { rim: 0.7 }, Cloud: { shade: '#d5d8f0', rim: 0 }, Crystal: { shade: '#a893e0', rim: 0.8 }, Hay: { shade: '#cdb9c9' },
  Slime: { shade: '#76b6c9', rim: 0.7 }, SlimeKing: { shade: '#9c86d8', rim: 0.7 }, Ink: { rim: 0 }, Wing: { shade: '#b3c6e8', rim: 0.8 },
  Water: { shade: '#8ea9d8', rim: 0.2 },
  // the snow village: cold blue shade on the snow and the ice, a cool lilac on the slate rocks
  Snow: { shade: '#b1c2ea', rim: 0.25 }, Frost: { shade: '#9fb3de', rim: 0.3 }, Slate: { shade: '#a09ac2' }, SlateDark: { shade: '#9690bb' }, Pine: { shade: '#9bb6cc' },
};

/**
 * Scene-wide dials, set from the look's `toon` block (config/looks.js). The terminator band is
 * in units of sun received (0 = none, 1 = full sun square on): the kit's luminance band
 * (0.42..0.62 under its sun and fill) lands at 0.02..0.18.
 */
export const TOON = {
  termLo: uniform(0.02), termHi: uniform(0.18),
  sunTint: uniform(new Color(1, 1, 1)), shadeTint: uniform(new Color(1, 1, 1)),
  rimColor: uniform(new Color('#fff3df')), outline: uniform(new Color('#4e3129')),
  gain: uniform(1), pointGain: uniform(0.35),
  /**
   * One wind for the whole scene: a direction on the ground, a strength (metres of sway at full weight), a speed
   * and a gust share. `windTime` is advanced by the session every frame; nothing else moves.
   */
  windDir: uniform(new Vector2(0.8, 0.6)), windStrength: uniform(0.06), windSpeed: uniform(1.6), windGust: uniform(0.45), windTime: uniform(0),
};
export function setToonLook(t = {}) {
  if (t.terminator) { TOON.termLo.value = t.terminator[0]; TOON.termHi.value = t.terminator[1]; }
  for (const k of ['sunTint', 'shadeTint', 'rimColor', 'outline']) if (t[k] !== undefined) TOON[k].value.set(t[k]);
  for (const k of ['gain', 'pointGain']) if (t[k] !== undefined) TOON[k].value = t[k];
  const w = t.wind;
  if (w) {
    if (w.dir) { const l = Math.hypot(w.dir[0], w.dir[1]) || 1; TOON.windDir.value.set(w.dir[0] / l, w.dir[1] / l); }
    for (const [k, u] of [['strength', 'windStrength'], ['speed', 'windSpeed'], ['gust', 'windGust']]) if (w[k] !== undefined) TOON[u].value = w[k];
  }
}

/**
 * WIND SWAY: the vertex offset of a swaying surface (canopy clumps, grass tufts, reeds). The geometry carries a
 * `sway` attribute baked by its batch: x the weight (0 at the anchored base, 1 at the free tip), y a phase per
 * plant. Batches are merged in world space, so positionLocal is the world position: two sines along the wind,
 * a slow gust travelling across the meadow, and nothing across it. Six multiplies and three sines per vertex,
 * only on the vertices that sway, and the outline hull adds the same offset so the ink line moves with the leaf.
 */
export function swayOffset() {
  const s = attribute('sway', 'vec2'), p = positionLocal, d = TOON.windDir;
  const t = TOON.windTime.mul(TOON.windSpeed), along = p.x.mul(d.x).add(p.z.mul(d.y));
  const phase = s.y.add(along.mul(0.35));
  const wave = sin(t.add(phase)).mul(0.7).add(sin(t.mul(2.3).add(phase.mul(1.9))).mul(0.3));
  const gust = sin(t.mul(0.37).sub(along.mul(0.08))).mul(0.5).add(0.5).mul(TOON.windGust);
  const amp = TOON.windStrength.mul(s.x).mul(wave.mul(0.6).add(gust));
  return vec3(d.x.mul(amp), amp.abs().mul(-0.12), d.y.mul(amp));
}

class ToonLightingModel extends LightingModel {
  start(builder) {
    this.sun = float(0).toVar('arcToonSun');
    this.glow = vec3(0).toVar('arcToonGlow');
    super.start(builder);
  }
  direct({ lightDirection, lightColor, lightNode }) {
    const ndl = normalView.dot(lightDirection).clamp();
    if (lightNode?.light?.isDirectionalLight) {
      // The light's colour already carries its shadow: divide out the unshadowed intensity.
      const full = luminance(lightNode.baseColorNode ?? lightNode.colorNode).max(1e-4);
      this.sun.assign(this.sun.max(ndl.mul(luminance(lightColor)).div(full)));
    } else this.glow.addAssign(ndl.mul(lightColor));
  }
  finish({ context }) {
    const albedo = diffuseColor.rgb, k = this.sun;
    const lit = smoothstep(TOON.termLo, TOON.termHi, k);
    // Inside the lit tone, faces square to the sun read a touch brighter: form without a third band.
    const lift = k.sub(TOON.termHi).div(float(0.93).sub(TOON.termHi)).clamp().mul(0.1).add(0.9);
    const shade = albedo.mul(materialReference('toonShade', 'color')).mul(TOON.shadeTint);
    let c = mix(shade, albedo.mul(lift).mul(TOON.sunTint), lit).add(albedo.mul(this.glow).mul(TOON.pointGain));
    // Blender's Layer Weight 'Facing' at blend 0.45, remapped 0.62..0.95, as the kit's rim.
    const facing = float(1).sub(normalView.dot(positionViewDirection).abs().pow(0.9));
    const rim = facing.sub(0.62).div(0.33).clamp().mul(materialReference('toonRim', 'float')).mul(lit.mul(0.65).add(0.35));
    c = mix(c, TOON.rimColor, rim);
    context.outgoingLight.rgb.assign(c.mul(TOON.gain));
  }
}

/** A MeshStandardNodeMaterial lit by the toon model. Roughness 1: SSR reads it as matte. */
export class ArcadeToonMaterial extends MeshStandardNodeMaterial {
  static get type() { return 'ArcadeToonMaterial'; }
  constructor(parameters) {
    super();
    this.isArcadeToon = true;
    this.toonShade = new Color(SHADE);
    this.toonRim = 0.3;
    this.roughness = 1; this.metalness = 0;
    if (parameters) this.setValues(parameters);
  }
  setupLightingModel() { return new ToonLightingModel(); }
  copy(source) {
    super.copy(source);
    if (source.isArcadeToon) { this.toonShade.copy(source.toonShade); this.toonRim = source.toonRim; }
    return this;
  }
}

/**
 * The inverted hull: back faces only, pushed out along `outlineNormal`, flat outline colour under the fog.
 * `skinned`: the shell of a SkinnedMesh, whose geometry carries the averaged outline normal AS its `normal`.
 * NodeMaterial skins positionLocal and normalLocal before it reads positionNode, so pushing along normalLocal
 * pushes along the posed normal and the line stays the same width whatever the arm is doing.
 */
export class ArcadeOutlineMaterial extends MeshBasicNodeMaterial {
  static get type() { return 'ArcadeOutlineMaterial'; }
  constructor(width = 0.03, sway = false, skinned = false) {
    super();
    this.isArcadeOutline = true;
    this.isSkinnedOutline = skinned;
    this.outlineWidth = width;
    this.side = BackSide;
    this.colorNode = TOON.outline;
    // A swaying surface's hull sways with it, so the ink line never slides off the leaf.
    const base = sway ? positionLocal.add(swayOffset()) : positionLocal;
    const push = skinned ? normalLocal : attribute('outlineNormal', 'vec3');
    this.positionNode = base.add(push.mul(materialReference('outlineWidth', 'float')));
  }
}

/**
 * The skinned shell's geometry: the source's positions, index and skin attributes, with the averaged outline
 * normal in `normal` (what the skinning node transforms). A copy, because the source's own normals still light it.
 */
export function skinnedHullGeometry(geometry) {
  const g = geometry.clone();
  addOutlineNormals(g);
  g.setAttribute('normal', g.attributes.outlineNormal);
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(name)) g.deleteAttribute(name);
  g.morphAttributes = {};
  return g;
}

/**
 * Normals averaged over every vertex sharing a position, so a shell over hard-edged, split-normal
 * geometry stays closed at the edges instead of cracking open. Added once to the geometry itself
 * (the base mesh never reads it).
 */
export function addOutlineNormals(geometry) {
  if (geometry.attributes.outlineNormal) return geometry;
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal, n = pos.count;
  if (!nrm) geometry.computeVertexNormals();
  const normal = geometry.attributes.normal, keys = new Array(n), sums = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    keys[i] = key;
    const s = sums.get(key) ?? [0, 0, 0];
    s[0] += normal.getX(i); s[1] += normal.getY(i); s[2] += normal.getZ(i); sums.set(key, s);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = sums.get(keys[i]), l = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
  }
  geometry.setAttribute('outlineNormal', new BufferAttribute(out, 3));
  return geometry;
}

/** The nearest `arc_outline` on the mesh or its ancestors below `root`; undefined when none is authored. */
function outlineWidth(mesh, root) {
  for (let o = mesh; o; o = o === root ? null : o.parent) if (typeof o.userData?.arc_outline === 'number') return o.userData.arc_outline;
  return undefined;
}

/**
 * One per session. `apply(root)` swaps every ARC_ material under `root` for its toon twin and adds
 * the outline shells, on a CLONE the caller owns: the loader's cached scenes and materials are never
 * touched (only the shared geometry gains its `outlineNormal` attribute), so the next build starts
 * clean. Emissive ARC_ materials (glows, catchlights) keep their own material.
 */
export function createArcadeToon(owned, look = {}) {
  setToonLook(look);
  // `wind: false` (the ?wind=off kill switch) builds no sway at all: swaying geometry keeps the still materials.
  const windOn = look.wind !== false;
  const materials = new Map(), hulls = new Map(), swaying = new Map();
  const track = r => { owned?.add(r); return r; };
  /** The swaying twin of a toon material: the same surface, its vertices offset by the wind. */
  const swayTwin = m => {
    let t = swaying.get(m);
    if (!t) { t = track(new ArcadeToonMaterial().copy(m)); t.name = m.name; t.positionNode = positionLocal.add(swayOffset()); swaying.set(m, t); }
    return t;
  };
  const toonOf = (source, sway = false) => {
    if (sway && source?.isArcadeToon) return swayTwin(source);
    if (!source?.isMeshStandardMaterial || source.isArcadeToon || !/^ARC_/.test(source.name ?? '')) return source;
    if (source.emissive && source.emissiveIntensity > 0 && source.emissive.getHex() !== 0) return source;
    let m = materials.get(source);
    if (!m) {
      m = track(new ArcadeToonMaterial().copy(source));
      const p = TOON_MATERIALS[source.name.slice(4).replace(/\.\d+$/, '')] ?? {};
      m.toonShade.set(p.shade ?? SHADE); m.toonRim = p.rim ?? 0.3; m.roughness = 1; m.metalness = 0; m.name = source.name;
      materials.set(source, m);
    }
    return sway ? swayTwin(m) : m;
  };
  const hullOf = (width, unlit, sway = false, skinned = false) => {
    const key = `${+width.toFixed(5)}|${unlit}|${sway}|${skinned}`;
    let m = hulls.get(key);
    if (!m) { m = track(new ArcadeOutlineMaterial(+width.toFixed(5), sway, skinned)); if (unlit) markUnlit(m); hulls.set(key, m); }
    return m;
  };
  /** One shell geometry per source geometry: every clone of a rig (cloneSkeleton shares geometry) reuses it. */
  const skinnedGeometry = new Map();
  const skinnedHullOf = g => { let h = skinnedGeometry.get(g); if (!h) { h = track(skinnedHullGeometry(g)); skinnedGeometry.set(g, h); } return h; };
  return {
    windOn,
    /** A toon material for code-built surfaces (the painted lawn): `name` picks the kit entry. */
    material(parameters, name = 'ARC_Grass') {
      const m = track(new ArcadeToonMaterial(parameters)), p = TOON_MATERIALS[name.slice(4)] ?? {};
      m.name = name; m.toonShade.set(p.shade ?? SHADE); m.toonRim = p.rim ?? 0.3;
      return m;
    },
    /**
     * The village's water (render/ArcadeGround.js buildWaterGeometry): a flat toon surface, no reflections. Its
     * colour runs from the open-water tone to the shallow tone along the mesh's `shore` attribute, it takes the
     * sun's two tones and shadows like the lawn beside it (a tree's shadow falls on a pond in the shade tint),
     * and the toon rim brightens it at grazing angles.
     */
    water({ deep = '#4aa6c8', shallow = '#86d3dc' } = {}) {
      const m = this.material({ color: 0xffffff }, 'ARC_Water');
      const s = attribute('shore', 'float');
      m.colorNode = mix(uniform(new Color(deep)), uniform(new Color(shallow)), s.mul(s).mul(0.85).add(s.mul(0.15)));
      return m;
    },
    /**
     * @param {import('three').Object3D} root
     * @param {{outline?: number, fallback?: number, world?: boolean}} [options]  outline: multiplier on
     *   every authored width (the first-person weapon wants thinner lines than the world); fallback: the
     *   width for ARC_ meshes whose file carries none; world: false for the view-model scene, whose pass
     *   has no MRT targets, so its shells must not declare the world pass's unlit outputs.
     */
    apply(root, { outline = 1, fallback = 0.03, world = true } = {}) {
      const meshes = [];
      root.traverse(o => { if (o.isMesh && !o.userData.arcOutlineHull) meshes.push(o); });
      for (const o of meshes) {
        const source = o.material, sway = windOn && !!o.geometry?.attributes?.sway;
        o.material = Array.isArray(source) ? source.map(m => toonOf(m, sway)) : toonOf(source, sway);
        const toon = Array.isArray(o.material) ? o.material.some(m => m?.isArcadeToon) : o.material?.isArcadeToon;
        const width = (outlineWidth(o, root) ?? (toon ? fallback : 0)) * outline;
        if (!(width > 0) || !o.geometry?.attributes.position || o.children.some(c => c.userData.arcOutlineHull)) continue;
        let hull;
        if (o.isSkinnedMesh) {
          // The shell rides the mesh's own skeleton and bind matrix; as a child at identity it shares the mesh's
          // matrixWorld, so the attached-mode bindMatrixInverse the two recompute every frame is the same.
          if (!o.skeleton || !o.geometry.attributes.skinIndex) continue;
          hull = new SkinnedMesh(skinnedHullOf(o.geometry), hullOf(width, world, false, true));
          hull.bindMode = o.bindMode; hull.bind(o.skeleton, o.bindMatrix);
        } else hull = new Mesh(addOutlineNormals(o.geometry), hullOf(width, world, sway));
        hull.name = `${o.name}_outline`; hull.userData.arcOutlineHull = true;
        hull.castShadow = false; hull.receiveShadow = false; hull.frustumCulled = o.frustumCulled;
        o.add(hull);
      }
      return root;
    },
  };
}
