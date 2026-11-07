// Water: one animated plane at sea level. The material is depth-aware — it
// samples the world's own heightfield (as a texture) so shallows are CLEAR
// (you see the bottom through them), depth builds toward the body colour,
// and the shoreline gets an animated foam band. The same texture carries the
// SEA-CONNECTED MASK (water/flood.js): a hollow the sea cannot reach is
// discarded outright, so digging a pit in a mountain gives you a pit, not a
// pond, and digging a channel to the shore lets the water run in along an
// animated front driven by a single uniform. Reflection is an analytic
// model of the same procedural sky the dome renders, capped so grazing
// angles never collapse into a solid mirror. Wave detail comes from a
// tiling normal map (three.js ocean's waternormals.jpg) with a procedural
// fallback, faded to flat with distance so it can never alias into static.
// The plane is double-sided: from below it renders as the underwater
// ceiling (dim body colour + a Snell-window glow toward the sun).

import * as THREE from "three";
import {
  Fn, If, Discard, uniform, texture, vec2, vec3, vec4, float, positionLocal, positionWorld, modelWorldMatrix, cameraPosition,
  frontFacing, fwidth, dFdx, dFdy, length, normalize, reflect, max, min, pow, exp, sin, abs, mix, clamp, dot, smoothstep, step, select,
} from "three/tsl";
import { Atmosphere, atmApply } from "../render/atmosphere.js";
import { wgNoise } from "../render/nodes.js";
import { floodFromSea, wetAt } from "../../kernel/water/flood.js";
import { gridTexMapping } from "../terrain/texmap.js";
import { lerpHex } from "../style/palettes.js";
import { WATER_PRESETS } from "./presets.js";

// Re-exported: this was the presets' home before the export contract layer
// needed them without three.js attached (see water/presets.js).
export { WATER_PRESETS };

// How fast a new flood front travels, in metres of reveal distance per
// second, and the bounds that stop a one-cell notch from filling in a blink
// or a channel across the map from dragging. The front itself is normalized
// 0..1, so this becomes 1/duration at bake time.
const FLOOD_SPEED = 70;
const FLOOD_MIN_S = 0.45;
const FLOOD_MAX_S = 2.2;

/* The colour the sea is where it meets the land, when the palette does not
   say. A palette states `water.shallow` and `water.deep`, and shallow is what
   the open shelf looks like — not what the last metre against a beach looks
   like, which carries the beach: the bottom is close enough to read through
   and the water is a glaze over it rather than a colour of its own.

   Derived rather than required so every existing palette, and any a buyer
   writes, gets a shoreline without editing anything: the shallow colour
   carried toward the biome's OWN sand, which is the material the low splat
   slot is floored with. `water.shore` overrides it for a palette that means
   something specific — a black-sand volcanic beach is a real thing and no
   derivation will guess it. */
const SHORE_TOWARD_SAND = 0.42;
const shoreColorFor = (palette) =>
  palette.water.shore ?? lerpHex(palette.water.shallow, palette.sand ?? 0xcabf9c, SHORE_TOWARD_SAND);

/* The sea as a node graph: term for term the GLSL it replaced (kept in the
   file's history at the commit that brought the engine in), minus its tone
   map, which the renderer now applies to every node material alike. The
   reasoning behind each term is the GLSL's and is kept with it below. */
function fbmW(p) {
  return wgNoise(p).mul(0.6).add(wgNoise(p.mul(2.13).add(7.7)).mul(0.28)).add(wgNoise(p.mul(4.41).sub(3.1)).mul(0.12));
}

/* ── one pixel, in metres of world ──
   Every procedural term on this surface has a feature size; once a pixel
   covers more than about half of one, the term has stopped being detail and
   become flicker. fwidth is the real measure, so each term fades on its OWN
   feature size against it, correct at any zoom without a constant to re-tune. */
const nyquist = (feature, wpx) => float(1).sub(smoothstep(feature * 0.30, feature * 0.85, wpx));

function waterNodes(u) {
  const tex = (n, uv) => n.sample(uv).rgb.mul(2).sub(1);
  // The vertex swell: two sines over world XZ, added to height.
  const wxz = modelWorldMatrix.mul(vec4(positionLocal, 1)).xz;
  const ph = wxz.x.mul(0.012).mul(u.uFreq).add(wxz.y.mul(0.017).mul(u.uFreq));
  const swell = sin(ph.add(u.uTime.mul(0.9))).add(sin(ph.mul(2.31).sub(u.uTime.mul(1.3))).mul(0.4)).mul(u.uAmp);
  const positionNode = positionLocal.add(vec3(0, swell, 0));

  const fragment = Fn(() => {
    const W = positionWorld;
    const dist = length(cameraPosition.sub(W));
    const wpx = max(fwidth(W.x), fwidth(W.z)).toVar();
    const detail = exp(dist.negate().mul(0.0016));
    const V = normalize(cameraPosition.sub(W));

    // Depth AND reachability from one RG8 sample of the world's own height
    // field: R = depth/50 m, G = 0 where the sea cannot reach, else the order
    // the flood front sweeps in. Outside the world it reads as open deep water.
    const tuv = W.xz.div(u.uWorldSize).mul(u.uFieldK).add(0.5);
    const fld = u.uTerrainTex.sample(tuv).rg;
    const onField = u.uHasTerrain.mul(step(0, tuv.x)).mul(step(0, tuv.y)).mul(step(tuv.x, 1)).mul(step(tuv.y, 1));
    const depth = mix(float(40), fld.r.mul(50), onField).toVar();
    const order = fld.g.mul(255).sub(1).div(254);
    // Asymmetric on purpose: a cell AT the front is already wet and the
    // feather trails ahead of it, so standing water cannot flicker.
    const edge = mix(float(1), float(1).sub(smoothstep(u.uFloodFront, u.uFloodFront.add(0.12), order)), onField).toVar();
    // Derivatives in uniform control flow, before any discard.
    const depthPerMetre = length(vec2(dFdx(depth), dFdy(depth))).div(max(wpx, 1e-4));
    // Discard, not a fade: a landlocked hollow must stay out of the depth
    // buffer too, or its dry ground would read through a film of water.
    If(onField.greaterThan(0.5).and(fld.g.lessThan(0.5 / 255).or(edge.lessThan(0.004))), () => { Discard(); });

    const waveLod = nyquist(3.0, wpx);
    // How far the shore is in metres of GROUND: a shelving bay is hundreds of
    // metres of shallows for a metre of depth.
    const toShore = min(depth.div(max(depthPerMetre, 1e-3)), 4000);
    const shoreT = smoothstep(0, u.uShoreBlend, toShore);

    // Waves: three scrolling taps of the tiling normal map and a fourth close
    // one faded in on the pixel footprint, or procedural noise without a map.
    const xz = W.xz, t = u.uTime;
    const close = float(1).sub(smoothstep(0.05, 0.28, wpx));
    const nm = tex(u.uNormalMap, xz.mul(0.0105).add(vec2(t.mul(0.021), t.mul(0.0161)))).mul(0.55)
      .add(tex(u.uNormalMap, xz.mul(0.0301).sub(vec2(t.mul(0.0292), t.mul(0.0244)))).mul(0.30))
      .add(tex(u.uNormalMap, xz.mul(0.0862).add(vec2(t.mul(0.0442), t.mul(-0.0341)))).mul(0.15))
      .add(tex(u.uNormalMap, xz.mul(0.285).add(vec2(t.mul(-0.0614), t.mul(0.0487)))).mul(0.24).mul(close));
    const fromMap = normalize(vec3(nm.x, 2.4, nm.y));
    const puv = xz.mul(0.05).mul(u.uFreq);
    const n1 = wgNoise(puv.mul(1.6).add(vec2(t.mul(0.30), t.mul(0.22))));
    const n2 = wgNoise(puv.mul(4.3).add(vec2(t.mul(-0.43), t.mul(0.31))));
    const n3 = wgNoise(puv.mul(9.1).add(vec2(t.mul(0.60), t.mul(-0.52))));
    const fromNoise = normalize(vec3(
      n1.sub(0.5).mul(0.42).add(n2.sub(0.5).mul(0.26)).add(n3.sub(0.5).mul(0.12)), 1.0,
      n2.sub(0.5).mul(0.42).add(n3.sub(0.5).mul(0.26)).add(n1.sub(0.5).mul(0.12))));
    const wave = mix(fromNoise, fromMap, step(0.5, u.uHasNormal));
    const N = normalize(mix(vec3(0, 1, 0), wave, detail.mul(waveLod))).toVar();

    // ── underside: the underwater ceiling ──
    const under = mix(u.uDeep.mul(0.55), u.uShallow.mul(0.9), pow(max(dot(V, u.uSunDir), 0), 6).mul(max(u.uSunDir.y, 0)))
      .add(u.uShallow.mul(wgNoise(W.xz.mul(0.24).add(t.mul(0.35)))).mul(0.18).mul(max(u.uSunDir.y, 0)).mul(detail).mul(nyquist(4.2, wpx)));

    const fres = float(0.04).add(pow(float(1).sub(max(dot(V, N), 0)), 3).mul(0.96)).toVar();
    const R = reflect(V.negate(), N).toVar();
    R.y.assign(abs(R.y));

    // Analytic reflection of the SAME sky the dome renders; the cloud term is
    // gated to steep rays, because the projection divides by R.y.
    const skyR = mix(u.uSkyColor, u.uZenith, pow(clamp(R.y, 0, 1), 0.55)).toVar();
    const sd = max(dot(R, u.uSunDir), 0);
    skyR.addAssign(vec3(1.0, 0.92, 0.78).mul(pow(sd, 320).mul(3).add(pow(sd, 32).mul(0.35))).mul(max(u.uSunDir.y, 0.05)));
    const cloudGate = smoothstep(0.22, 0.45, R.y).mul(step(0.01, u.uCloudCover));
    const cp = R.xz.div(R.y.add(0.22)).mul(1.7).add(vec2(t.mul(0.008), t.mul(0.003)));
    const cov = smoothstep(float(1).sub(u.uCloudCover), float(1).sub(u.uCloudCover).add(0.32), fbmW(cp));
    skyR.assign(mix(skyR, vec3(0.98, 0.97, 0.95), cov.mul(0.5).mul(cloudGate)));

    // The real mirrored scene where the tier affords the second render;
    // perturb the WORLD point along the wave normal, then project.
    const rp = u.uReflMatrix.mul(vec4(W.add(vec3(N.x, 0, N.z).mul(2.4)), 1));
    const ruv = rp.xy.div(rp.w);
    const inMirror = u.uHasRefl.mul(step(0, rp.w)).mul(step(0, ruv.x)).mul(step(0, ruv.y)).mul(step(ruv.x, 1)).mul(step(ruv.y, 1));
    const refl = mix(skyR, u.uReflMap.sample(ruv).rgb, inMirror);

    // Body colour: extinction per channel (reds go first, blue last), from
    // the shore's sand-carried colour through the shallows to the deep.
    const near = mix(u.uShore, u.uShallow, shoreT);
    const trans = exp(max(depth, 0).negate().mul(u.uAbsorb).mul(vec3(1.0, 0.62, 0.45)));
    const body = mix(u.uDeep, near, trans);
    const col = mix(body, refl, min(fres, u.uMirror)).toVar();

    // Sun glints only where the waves are resolved: no waves, no glint.
    const H = normalize(V.add(u.uSunDir));
    col.addAssign(vec3(1.0, 0.95, 0.8).mul(pow(max(dot(N, H), 0), 240)).mul(2.2).mul(u.uGlint).mul(max(u.uSunDir.y, 0)).mul(waveLod));
    const sunFace = max(dot(V, u.uSunDir), 0).mul(0.6).add(0.4);
    col.addAssign(vec3(0.25).mul(u.uGlint).mul(step(0.997, wgNoise(W.xz.mul(1.2).add(t.mul(0.4))))).mul(max(u.uSunDir.y, 0))
      .mul(detail).mul(detail).mul(sunFace).mul(nyquist(0.9, wpx)));

    // Shoreline foam: a thin animated band a fixed distance from the waterline.
    const foamFade = exp(dist.negate().mul(0.0005)).mul(nyquist(4.5, wpx));
    const band = smoothstep(1.4, 0, depth).mul(float(1).sub(smoothstep(9, 26, toShore)));
    const fn = fbmW(W.xz.mul(0.22).add(vec2(t.mul(0.22), t.mul(-0.17))));
    const foamOn = u.uHasTerrain.mul(step(depth, 1.4)).mul(step(0.02, foamFade));
    const foam = smoothstep(0.55, 0.8, fn.mul(band).mul(1.4).add(band.mul(0.18))).mul(foamFade).mul(foamOn);
    col.assign(mix(col, vec3(0.93, 0.96, 0.95), foam.mul(0.85)));
    // The advancing front carries its own white line, peaking mid-feather.
    const front = clamp(float(1).sub(edge).mul(edge).mul(4), 0, 1);
    col.assign(mix(col, vec3(0.93, 0.96, 0.95), front.mul(0.6)));

    // Clarity: shallows genuinely transparent, deep water opaque; the last
    // metres of ground before the waterline feathered, not cut.
    const alpha = mix(0.30, 0.94, smoothstep(0.4, 16, depth)).toVar();
    const lip = float(1).sub(smoothstep(0, 1.8, toShore)).mul(float(1).sub(smoothstep(0.6, 2.5, depth)));
    alpha.mulAssign(float(1).sub(lip.mul(0.5)));
    alpha.assign(max(alpha, fres.mul(0.9)));
    alpha.assign(max(alpha, foam.mul(0.95)));
    alpha.assign(max(alpha, front.mul(0.85)));
    alpha.mulAssign(mix(1, 0.86, u.uClarity.mul(float(1).sub(fres))));

    // Same air as the land; the haze closes the alpha up with it. The flood
    // edge is applied after: whether water is here at all is a fact about the
    // world, and distance must not close the leading edge back up.
    const hazed = atmApply(u, col, W, cameraPosition);
    const hazeAmt = clamp(length(hazed.sub(col)).mul(2.5), 0, 1);
    const top = vec4(hazed, mix(alpha, 1, hazeAmt.mul(0.9)).mul(edge));
    return select(frontFacing, top, vec4(under, edge.mul(0.82)));
  })();
  return { positionNode, fragment };
}

/* What a texture node samples before its texture exists; the `uHas…` uniforms
   keep it from being read as data. */
const BLANK = (() => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; })();
const BLANK_NORMAL = (() => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); t.needsUpdate = true; return t; })();

export class Water {
  constructor({ params, palette, atmos = null }) {
    this.params = params;
    const preset = WATER_PRESETS[params.water.preset] || WATER_PRESETS.ocean;
    // Shared aerial-perspective uniforms (live objects — the engine updates
    // them in place as the sun moves). Standalone use gets its own instance
    // so the shader always has them.
    this.atmos = atmos || new Atmosphere(params);
    this.uniforms = {
      ...this.atmos.uniforms,
      uTime: { value: 0 },
      uAmp: { value: preset.waveAmp * params.water.waveHeight },
      uFreq: { value: preset.waveFreq },
      uClarity: { value: preset.clarity },
      uMirror: { value: preset.mirror ?? 0.72 },
      uGlint: { value: preset.glint ?? 1.0 },
      uAbsorb: { value: preset.absorb ?? 0.11 },
      uShoreBlend: { value: preset.shoreBlend ?? 18 },
      uShallow: { value: new THREE.Color(palette.water.shallow) },
      uDeep: { value: new THREE.Color(palette.water.deep) },
      uShore: { value: new THREE.Color(shoreColorFor(palette)) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyColor: { value: new THREE.Color(palette.sky.horizon) },
      uZenith: { value: new THREE.Color(palette.sky.zenith) },
      uCloudCover: { value: params.sky.cloudCover },
      uNormalMap: { value: BLANK_NORMAL },
      uHasNormal: { value: 0 },
      uReflMap: { value: BLANK },
      uHasRefl: { value: 0 },
      uReflMatrix: { value: new THREE.Matrix4() },
      uTerrainTex: { value: BLANK },
      uHasTerrain: { value: 0 },
      uWorldSize: { value: params.terrain.size },
      uFieldK: { value: 1 },
      uFloodFront: { value: 1 },
    };
    // The water is a plate matching the world bounds exactly — the world
    // presents as a floating diorama, and its underside is closed by the
    // engine's pedestal. (An ocean extending past the plate was tried and
    // reverted: a 24km transparent plane with this fragment shader is pure
    // fill cost, and it let the player walk out over open water.)
    for (const k of Object.keys(this.uniforms)) {
      const v = this.uniforms[k];
      if (v && v.isNode) continue;                      // the shared air, already nodes
      this.uniforms[k] = v.value && v.value.isTexture ? texture(v.value) : uniform(v.value);
    }
    const nodes = waterNodes(this.uniforms);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, fog: false });
    material.positionNode = nodes.positionNode;
    material.fragmentNode = nodes.fragment;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(params.terrain.size, params.terrain.size, 32, 32).rotateX(-Math.PI / 2), material);
    this.mesh.name = "water";
    // The natural coastline is y=0 by heightfield construction; params.water
    // .level raises the whole plane above it to flood the land as it stands.
    this._level = params.water.level || 0;
    this.mesh.position.y = this._level;
    this.mesh.visible = !!params.water.enabled;
    this._depthTex = null;
    this._field = null;     // latest baked heightfield, so the level can move
                            // without asking the engine to bake again
    // Latest flood result: read by the minimap, and fed back into the next
    // bake as the "before" that decides what is new enough to animate.
    this._flood = null;
    this._floodFront = 1;   // 0..1 sweep of the reveal order; 1 = settled
    this._floodSpeed = 0;   // front units per second while a flood is running
  }

  // Latest sea-connected mask (water/flood.js), or null before the first
  // terrain field lands. The minimap reads this so its water agrees with the
  // viewport's rather than re-deciding from raw height.
  get flood() { return this._flood; }

  setPalette(palette) {
    this.uniforms.uShallow.value.setHex(palette.water.shallow);
    this.uniforms.uDeep.value.setHex(palette.water.deep);
    // Derived from the same palette, in the same call, so the shoreline can
    // never be left describing the biome before this one.
    this.uniforms.uShore.value.setHex(shoreColorFor(palette));
    this.uniforms.uSkyColor.value.setHex(palette.sky.horizon);
    this.uniforms.uZenith.value.setHex(palette.sky.zenith);
  }

  setPreset(name) {
    const p = WATER_PRESETS[name] || WATER_PRESETS.ocean;
    this.params.water.preset = name;
    this.uniforms.uAmp.value = p.waveAmp * this.params.water.waveHeight;
    this.uniforms.uFreq.value = p.waveFreq;
    this.uniforms.uClarity.value = p.clarity;
    this.uniforms.uMirror.value = p.mirror ?? 0.72;
    this.uniforms.uGlint.value = p.glint ?? 1.0;
    this.uniforms.uAbsorb.value = p.absorb ?? 0.11;
    this.uniforms.uShoreBlend.value = p.shoreBlend ?? 18;
  }

  // Tiling wave normal map (shared texture owned by the engine).
  setNormalMap(tex) {
    this.uniforms.uNormalMap.value = tex || BLANK_NORMAL;
    this.uniforms.uHasNormal.value = tex ? 1 : 0;
  }

  // Planar reflection feed (engine-owned WaterReflection). Pass null when
  // the mirror pass didn't run this frame — the shader falls back to the
  // analytic sky and nothing samples a stale image.
  setReflection(texture, matrix) {
    this.uniforms.uReflMap.value = texture || BLANK;
    this.uniforms.uHasRefl.value = texture ? 1 : 0;
    if (matrix) this.uniforms.uReflMatrix.value.copy(matrix);
  }

  // Feed the live heightfield so the shader knows real water depth AND which
  // of it the sea can actually reach. Encoded as plain RG8 bytes — R is
  // depth/50m, G is 0 for unreachable ground and otherwise the reveal order
  // — which are filterable everywhere, and with unpackAlignment=1 immune to
  // row-alignment garbage at odd resolutions like 513 (2ⁿ+1 grids are the
  // norm here).
  //
  // Linear filtering across the G channel is safe despite 0 being a sentinel:
  // the flood is 4-connected, so a wet cell is never edge-adjacent to a dry
  // cell that lies below sea level. Every dry neighbour it can blend with is
  // ground standing above the plane, which occludes the blend band anyway.
  //
  // `animate` belongs to the one caller that means it — the end of a sculpt
  // stroke. A world build, an undo or an erosion pass all want the settled
  // state on the next frame.
  setTerrainField(field, { animate = false } = {}) {
    this._field = field;
    this._encode(field, animate);
  }

  /* ── flood level ──
     Raise or lower the waterline over the terrain AS IT STANDS. Nothing is
     re-baked: the heightfield is read, never written, so the land keeps its
     exact shape and only the water moves. The sea-connected mask is redone at
     the new threshold, so raising the level floods inland along real valleys
     and still refuses to fill a hollow with no path to the sea.

     Not to be confused with params.terrain.seaLevel, which is a GENERATION
     input — it shifts the height field before the sea-floor curve is applied,
     so changing it rebuilds the world into different terrain. That one is the
     wrong knob for "what floods"; this is the right one.

     The caller owns params.water.level. Writing it here would be wrong:
     applyParams() returns a FRESH params object, so this.params is the one
     handed to the constructor and goes stale after the first panel change. */
  setLevel(y) {
    if (y === this._level) return;
    this._level = y;
    this.mesh.position.y = y;
    if (this._field) this._encode(this._field, true);
  }

  get level() { return this._level; }

  _encode(field, animate) {
    const { res, data } = field;
    const flood = floodFromSea(field, this._flood, this._level);
    const bytes = new Uint8Array(res * res * 2);
    const span = flood.maxSteps;
    for (let i = 0; i < data.length; i++) {
      const d = (this._level - data[i]) / 50; // depth below the waterline, /50m
      bytes[i * 2] = d <= 0 ? 0 : d >= 1 ? 255 : Math.round(d * 255);
      // 0 is reserved for "no path to the sea", so the order starts at 1.
      bytes[i * 2 + 1] = flood.wet[i] ? 1 + (span > 0 ? Math.round((flood.steps[i] / span) * 254) : 0) : 0;
    }
    const tex = new THREE.DataTexture(bytes, res, res, THREE.RGFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    if (this._depthTex) this._depthTex.dispose();
    this._depthTex = tex;
    this.uniforms.uTerrainTex.value = tex;
    this.uniforms.uHasTerrain.value = 1;
    this.uniforms.uWorldSize.value = field.size;
    this.uniforms.uFieldK.value = gridTexMapping(res).k;
    this._flood = flood;

    // Only a flood that actually GAINED ground is worth animating: raising
    // land to drain a bay, or any bake that reveals nothing new, just snaps.
    // span > 1 rather than > 0 on purpose — water one cell deep sits against
    // the old shoreline with nothing to reveal, and the one remaining grid
    // change (the quick 257² placeholder giving way to the canonical 513²)
    // leaves exactly that much resample fringe.
    if (animate && flood.newCount > 0 && span > 1) {
      const metres = span * (field.size / (res - 1));
      const secs = Math.min(Math.max(metres / FLOOD_SPEED, FLOOD_MIN_S), FLOOD_MAX_S);
      this._floodFront = 0;
      this._floodSpeed = 1 / secs;
    } else {
      this._floodFront = 1;
      this._floodSpeed = 0;
    }
    this.uniforms.uFloodFront.value = this._floodFront;
  }

  setSunDir(dir) { this.uniforms.uSunDir.value.copy(dir); }
  tick(dt) { this.uniforms.uTime.value += dt * (WATER_PRESETS[this.params.water.preset]?.speed ?? 1); }

  // Advance a running flood front; true while it is still moving. Kept off
  // the ambient-animation tick on purpose — that one is disabled entirely on
  // the low quality tier, and a flood must still be watchable there.
  tickFlood(dt) {
    if (this._floodFront >= 1) return false;
    this._floodFront = Math.min(1, this._floodFront + this._floodSpeed * dt);
    this.uniforms.uFloodFront.value = this._floodFront;
    return true;
  }

  // Underwater pass: returns true if the camera is below the surface AND in
  // water the sea can actually reach — the murk must not close in inside a
  // dry landlocked hollow the shader renders as ground (no mask yet = wet).
  underwater(pos) {
    return this.mesh.visible && pos.y < this.mesh.position.y
      && wetAt(this._flood, pos.x, pos.z) !== false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this._depthTex) this._depthTex.dispose();
  }
}
