// Aerial perspective: the single scattering model every surface shares, so
// terrain, grass, props and water all recede into the same air. Distance
// extinction is height-aware (the haze pools in valleys and thins with
// altitude) and the inscattered colour warms toward the sun, which is what
// makes a far ridge read as far rather than merely grey.
//
// Applied before tone mapping — this is scene radiance, not a post effect —
// so the values live in linear space alongside the lighting.
//
// This module is also the engine's MATERIAL CONDITION hub: the same pass
// that adds haze to every lit material adds the surface responses that make
// the world feel physical — wetness below and beside the waterline (dark,
// glossy), rain film on upward faces, settling snow, sun caustics on
// submerged ground, and window/lamp emissives that come alive at night.
// One set of shared uniforms, zero per-material bookkeeping.
//
// ── ON THE NODE RENDERER ──
// Under WebGLRenderer this was a string patch spliced into every lit
// material's GLSL. Under WebGPURenderer it is two things, and the split
// follows what each part is:
//   - the HAZE is the scene's fog node (worldFog below): one node every
//     fog-enabled material passes through, which is what "every surface
//     recedes into the same air" always meant, now without patching anything;
//   - the SURFACE CONDITIONS are node properties on the material (apply):
//     colour (wet, snow, caustics), roughness (wet gloss, snow), ambient
//     occlusion (the sky-visibility bake and the roof over a room), and
//     emissive (lamps by the clock, the ground's bounce, the room's light).
// The arithmetic is the GLSL's, term for term; where the node pipeline has no
// seam at the exact place the patch cut in (the room's light REPLACED the sky
// reflection indoors), the difference is said where it is made.
//
// Mobile note: no loops, no derivatives. A handful of multiplies, two pows
// and two texture-free noise taps per pixel for the caustics.

import * as THREE from "three";
import {
  Fn, uniform, texture, vec2, vec3, vec4, float, positionWorld, normalWorld, cameraPosition, positionView, output,
  dot, max, min, pow, mix, clamp, exp, length, smoothstep, abs, select, step,
  materialColor, materialRoughness, materialEmissive,
} from "three/tsl";
import { wgNoise } from "./nodes.js";
import { worldTexScale } from "../terrain/texmap.js";

/* A 1×1 stand-in for a bake that has not landed: a node needs a texture to
   sample, and the `…On` uniforms keep it from being read as data. */
const blank = (() => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); t.needsUpdate = true; return t; })();

/**
 * The aerial perspective as a colour transform, for a surface that applies it
 * itself (the scene fog node below, and anything that wants the same air).
 * Term for term the GLSL atmApply this replaced.
 */
export function atmApply(u, color, worldPos = positionWorld, camPos = cameraPosition) {
  const toFrag = worldPos.sub(camPos), dist = length(toFrag), V = toFrag.div(max(dist, 0.0001));
  // Forward scattering: air near the sun glows, away from it stays cool.
  const sunAmt = max(dot(V, u.uAtmSun), 0);
  const mie = pow(sunAmt, 7).mul(0.55).add(pow(sunAmt, 2).mul(0.16));
  const haze = mix(u.uAtmHaze, u.uAtmSunTint, clamp(mie, 0, 1));
  // Air thins with height: sample midway up the view ray so a mountain top
  // hazes less than the valley floor in front of it.
  const h = max(worldPos.y.add(camPos.y).mul(0.5), 0);
  const density = u.uAtmDensity.mul(exp(h.negate().mul(u.uAtmHeightK)));
  const f = float(1).sub(exp(dist.negate().mul(density)));
  return mix(color, haze, clamp(f.mul(u.uAtmStrength), 0, 1));
}

/**
 * The scene's fog node: the aerial perspective, then the thin ground fog
 * (scene.fog, a FogExp2 the engine retunes for altitude and swaps for the
 * murk underwater), in that order, as the patched materials applied them.
 * Reads the fog object's colour and density every frame, so the engine's
 * writes to scene.fog keep driving it.
 */
export function worldFog(atmos, fog) {
  const fogColor = uniform(fog.color), fogDensity = uniform(fog.density);
  fogDensity.onRenderUpdate(() => fog.density);
  return Fn(() => {
    const c = atmApply(atmos.uniforms, output.rgb);
    const z = positionView.z.negate();
    const k = float(1).sub(exp(fogDensity.mul(fogDensity).mul(z).mul(z).negate()));
    return vec4(mix(c, fogColor, k), output.a);
  })();
}

export class Atmosphere {
  constructor(params) {
    this._baseDensity = (params.fog.density * 6) / params.terrain.size;
    this.altitudeFactor = 1;
    const u = this.uniforms = {
      uAtmSun: { value: new THREE.Vector3(0, 1, 0) },
      uAtmHaze: { value: new THREE.Color(0x9fb6cc) },
      uAtmSunTint: { value: new THREE.Color(0xffd7a8) },
      // Tuned against world size: a 4km world hazes out around its far edge.
      uAtmDensity: { value: 2.1 / params.terrain.size },
      uAtmHeightK: { value: 1 / Math.max(params.terrain.height * 1.15, 60) },
      uAtmStrength: { value: 1 },
      /* ── surface conditions (see apply()) ── */
      // The live waterline in world y. -1e8 = water disabled: every surface
      // test against it fails without a branch.
      uWfWaterY: { value: -1e8 },
      uWfRain: { value: 0 },   // 0..1 rain film on upward faces
      uWfSnow: { value: 0 },   // 0..1 settled snow cover
      uWfNight: { value: 0 },  // sky rig's night factor — drives emissives
      uWfTime: { value: 0 },   // caustic clock (ambient-animation ticked)
      uWfCaustic: { value: new THREE.Color(0x9fe8d8) },
      /* ── indirect light (terrain/skyvis.js) ──
         RGB = the bent normal (the direction the visible sky lies in),
         A = the fraction of the dome this patch of ground can see. Sampled
         by world XZ, so it reaches EVERY surface the atmosphere patch
         touches — ground, grass, trees, placed blocks — from one texture.
         uSkyVisOn stays 0 until the bake lands, and the world is lit exactly
         as it was before until then. */
      uSkyVis: { value: null },
      uSkyVisOn: { value: 0 },
      uSkyVisScale: { value: 1 / 4096 },   // world metres → texture UV
      uSkyBounce: { value: new THREE.Color(0x2a2a1e) },
      /* ── shelter (js/shelter.js) ──
         A window on the world that follows the viewer, carrying the underside
         of the roof over each column. It is what makes a building part of the
         weather instead of a thing standing in it: rain wets what the rain
         can reach, snow settles where the sky is, and a room is lit by as
         much sky as it can actually see. Off until a world is built. */
      uShelter: { value: null },
      uShelterOn: { value: 0 },
      uShelterOrigin: { value: new THREE.Vector2() },
      uShelterScale: { value: 1 / 160 },
      uShelterBase: { value: 0 },
      uShelterRange: { value: 64 },
      /* ── the room you are standing in (core/room-probe.js) ──
         Interiors used to be lit by the sky, dimmed: the shelter factor
         scaled the ambient down and nothing else changed, so a room with one
         small window was lit exactly like a room with four, from every
         direction equally, in the colour of the dome. And because
         scene.environment IS the dome, anything glossy indoors reflected open
         sky through the ceiling — dimming that only makes it a darker sky.

         These carry the irradiance of the ONE room the camera is in, eased
         between rooms by the engine. One room rather than a field of them is
         a deliberate limit and the same shape lamps.js already uses: the
         room you are standing in is the one whose light you can judge, and a
         probe per fragment wants a volume texture this does not have. */
      uRoomOn: { value: 0 },
      uRoomAmbient: { value: new THREE.Color(0, 0, 0) },
      uRoomDir: { value: new THREE.Vector3(0, 1, 0) },
      uRoomOpen: { value: 0 },
    };
    // Every `{ value }` above becomes a TSL uniform node with the same `.value`
    // (and, for vectors and colours, the same object), so the engine's writes
    // reach every material that reads them. The two bakes are texture nodes.
    for (const k of Object.keys(u)) {
      if (k === "uSkyVis" || k === "uShelter") u[k] = texture(blank);
      else u[k] = uniform(u[k].value);
    }
  }

  /* Hand over a finished sky-visibility bake. `texture` is the packed RGBA
     from packSkyVisibility, `size` the world edge it covers. The scale is the
     fence-post-corrected one (terrain/texmap.js): the bake samples the plate
     corner to corner while texels are centred, and a bare 1/size read the
     whole indirect-light field half a cell off the ground it describes. */
  setSkyVisibility(texture, size) {
    this.uniforms.uSkyVis.value = texture || blank;
    this.uniforms.uSkyVisOn.value = texture ? 1 : 0;
    if (texture && size) {
      this.uniforms.uSkyVisScale.value = worldTexScale(texture.image?.width || 1, size);
    }
  }

  /* Hand over the live shelter window. `field` is a js/shelter.js
     ShelterField and `texture` the DataTexture over its bytes; the caller
     flags the texture dirty after each redraw. */
  setShelter(texture, field) {
    this.uniforms.uShelter.value = texture || blank;
    this.uniforms.uShelterOn.value = texture && field ? 1 : 0;
    if (!field) return;
    const u = field.uniforms();
    this.uniforms.uShelterOrigin.value.set(u.origin[0], u.origin[1]);
    this.uniforms.uShelterScale.value = u.scale;
    this.uniforms.uShelterBase.value = u.baseY;
    this.uniforms.uShelterRange.value = u.range;
  }

  // The colour the ground throws back up. Derived from the biome so a desert
  // bounces warm sand and a tundra bounces cold stone.
  setBounceColor(hex) { this.uniforms.uSkyBounce.value.setHex(hex); }

  /* The room the viewer is in, from core/room-probe.js. `null` steps back
     outdoors, which is not the same as a dark room — outdoors the sky path
     below takes over completely. */
  setRoomProbe(probe) {
    const u = this.uniforms;
    if (!probe) { u.uRoomOn.value = 0; return; }
    u.uRoomOn.value = 1;
    u.uRoomAmbient.value.setRGB(probe.ambient[0], probe.ambient[1], probe.ambient[2]);
    u.uRoomDir.value.set(probe.dir[0], probe.dir[1], probe.dir[2]);
    u.uRoomOpen.value = probe.openness;
  }

  // params.fog.density is the author's dial: 0 = crystal clear, 0.35 the
  // default, 1 = soup. Scaled by world size so the same number means the
  // same look whether the map is 2km or 8km across.
  setWorld(params) {
    this._baseDensity = (params.fog.density * 6) / params.terrain.size;
    this.uniforms.uAtmDensity.value = this._baseDensity * this.altitudeFactor;
    this.uniforms.uAtmHeightK.value = 1 / Math.max(params.terrain.height * 1.15, 60);
  }

  // Standing on the ground you look through kilometres of dense low air, so
  // haze sells distance. From an orbit view the same haze just bleaches the
  // whole world (it is ALL distant), so thin it out as the camera climbs.
  // Returns true when the value actually moved, so the engine can skip work.
  setAltitude(alt) {
    const t = Math.min(Math.max((alt - 300) / 2200, 0), 1);
    const f = 1 - t * t * (3 - 2 * t) * 0.72;   // 1.0 on foot → 0.28 from orbit
    if (Math.abs(f - this.altitudeFactor) < 0.005) return false;
    this.altitudeFactor = f;
    this.uniforms.uAtmDensity.value = (this._baseDensity || this.uniforms.uAtmDensity.value) * f;
    return true;
  }

  // Fed from the Sky rig: haze takes the fog colour (already time-of-day
  // graded), the tint takes the sun's own colour so dusk turns the air amber.
  // Both arrive in three's working (linear) space — which is the space this
  // injection runs in, ahead of tone mapping — so they are copied as-is.
  setSun(dir, color) {
    this.uniforms.uAtmSun.value.copy(dir);
    this.uniforms.uAtmSunTint.value.copy(color).multiplyScalar(1.2);
  }
  setHaze(color) {
    this.uniforms.uAtmHaze.value.copy(color);
  }
  // Under the surface the water's own murk takes over completely.
  setUnderwater(on) { this.uniforms.uAtmStrength.value = on ? 0 : 1; }

  /* ── surface conditions ── */
  // The waterline every material wets against. Pass enabled=false and every
  // submersion test fails, branch-free.
  setWaterline(y, enabled = true) {
    this.uniforms.uWfWaterY.value = enabled ? y : -1e8;
  }
  // Caustic light colour follows the biome's shallow-water tint.
  setCausticColor(hex) { this.uniforms.uWfCaustic.value.setHex(hex); }
  setNight(n) { this.uniforms.uWfNight.value = n; }
  // Weather ramps — the engine eases these toward the active weather's
  // targets so rain soaks in and snow settles rather than snapping.
  setRainWet(f) { this.uniforms.uWfRain.value = f; }
  setSnowCover(f) { this.uniforms.uWfSnow.value = f; }
  // Caustics keep their own clock so they can pause with ambient animation.
  tick(dt) { this.uniforms.uWfTime.value += dt; }

  /* Give a lit material (standard/lambert/phong/basic, classic or node) the
     surface conditions. Composes with whatever nodes the material already
     has (the terrain's, the grass's) instead of replacing them, and keeps NO
     registry of what it has touched: every prop part goes through here, so a
     Set would hold every material the session ever built. The uniform nodes
     are shared, so updating them reaches every material without holding one.
     A classic material keeps being a classic material: WebGPURenderer copies
     its properties, these nodes included, into the node material it renders
     with (NodeLibrary.fromMaterial). */
  apply(material) {
    if (!material || material.userData.atmos) return material;
    material.userData.atmos = true;
    const u = this.uniforms;
    const unlit = !!material.isMeshBasicMaterial || !!material.isMeshBasicNodeMaterial;
    const lambert = !!material.isMeshLambertMaterial || !!material.isMeshLambertNodeMaterial;
    const P = positionWorld;
    // Unlit materials (KHR_materials_unlit GLBs land as MeshBasic) are treated as facing up.
    const N = unlit ? vec3(0, 1, 0) : normalWorld;

    /* 1 where a roof stands between this point and the sky. The texel carries
       the roof underside and the floor under it, so a fragment knows which side
       of the ceiling it is on — the roof of a house is shelter for the parlour
       and open sky for the chimney. */
    const shelterUv = P.xz.sub(u.uShelterOrigin).mul(u.uShelterScale);
    const t = u.uShelter.sample(shelterUv);
    const roofY = u.uShelterBase.add(t.r.add(t.g.div(255)).mul(u.uShelterRange));
    const floorY = u.uShelterBase.add(t.b.mul(u.uShelterRange));
    const inside = step(0, shelterUv.x).mul(step(0, shelterUv.y)).mul(step(shelterUv.x, 1)).mul(step(shelterUv.y, 1));
    const wfIn = u.uShelterOn.mul(inside).mul(step(0.5, t.a)).mul(step(P.y, roofY)).mul(step(floorY.sub(2.5), P.y));
    const wfOpen = float(1).sub(wfIn);

    // ── surface conditions ──
    const wfUp = clamp(N.y, 0, 1);
    // Wet: fully below the waterline, in the splash band just above it, or
    // filmed by rain where the rain can reach (a flooded cellar is wet
    // whatever is over it).
    const wfBelow = float(1).sub(smoothstep(u.uWfWaterY.sub(0.12), u.uWfWaterY.add(0.22), P.y));
    const wfBand = float(1).sub(smoothstep(u.uWfWaterY.add(0.1), u.uWfWaterY.add(1.2), P.y));
    const wfWet = max(max(wfBelow, wfBand.mul(0.75)),
      u.uWfRain.mul(wfOpen).mul(float(0.42).add(smoothstep(0.25, 0.85, wfUp).mul(0.58))));
    // Snow settles on faces that look up, broken up by world-space noise so it
    // reads as cover rather than white paint. Never below the waterline.
    const wfSnowK = u.uWfSnow.mul(wfOpen).mul(smoothstep(0.52, 0.86, wfUp))
      .mul(float(0.68).add(wgNoise(P.xz.mul(0.85)).mul(0.32))).mul(float(1).sub(wfBelow));
    // Caustics: refracted sun ripples on anything submerged and shallow. Two
    // ridged noise taps, multiplied, faded out by depth and sun elevation.
    const wfDepth = u.uWfWaterY.sub(P.y);
    const cuv = P.xz.mul(0.42);
    const ca = float(1).sub(abs(wgNoise(cuv.add(vec2(u.uWfTime.mul(0.14), u.uWfTime.mul(0.09)))).mul(2).sub(1)));
    const cb = float(1).sub(abs(wgNoise(cuv.mul(1.37).sub(vec2(u.uWfTime.mul(0.11), u.uWfTime.mul(0.16)))).mul(2).sub(1)));
    const cz = ca.mul(cb);
    const causticOn = step(1e-6, wfBelow).mul(step(wfDepth, 14)).mul(step(0.03, u.uAtmSun.y));
    const caustic = u.uWfCaustic.mul(cz.mul(cz).mul(cz)).mul(float(1).sub(wfDepth.div(14))).mul(wfBelow)
      .mul(clamp(u.uAtmSun.y.mul(1.6), 0, 1)).mul(1.5).mul(causticOn);

    const base = material.colorNode ?? materialColor;
    const conditioned = Fn(() => {
      const c = vec4(base).toVar();
      c.rgb.mulAssign(float(1).sub(wfWet.mul(0.42)));
      c.rgb.assign(mix(c.rgb, vec3(0.87, 0.91, 0.97), wfSnowK.mul(0.85)));
      c.rgb.addAssign(caustic);
      return c;
    })();
    material.colorNode = conditioned;
    if (unlit) { material.needsUpdate = true; return material; }

    if (!lambert) {
      // Water glosses a surface; snow flattens it back out.
      const r0 = material.roughnessNode ?? materialRoughness;
      material.roughnessNode = mix(mix(r0, 0.14, clamp(wfWet, 0, 1).mul(0.85)), 0.92, wfSnowK);
    }

    /* ── indirect light ──
       The bake (terrain/skyvis.js) says how much of the dome each patch of
       ground can see and which way the open sky lies; a surface is lit by the
       sky in proportion to how much its own normal agrees with that direction,
       and a roof is the most complete occluder there is (a little is left:
       light comes in at the windows). Ambient occlusion is exactly "how much
       of the indirect light arrives", so that is where it goes. */
    const sv = u.uSkyVis.sample(P.xz.mul(u.uSkyVisScale).add(0.5));
    const bent = sv.xyz.mul(2).sub(1).normalize();
    const vis = sv.a;
    const facing = clamp(dot(N, bent).mul(0.5).add(0.5), 0, 1);
    const sky = mix(vis.mul(0.55), vis, facing).mul(float(1).sub(wfIn.mul(0.82)));
    const skyAO = mix(float(1), sky, u.uSkyVisOn);
    material.aoNode = material.aoNode ? material.aoNode.mul(skyAO) : skyAO;

    /* What the sky loses to the terrain arrives as light thrown back off the
       ground, warm or cold with the biome, strongest on the downward-facing
       surfaces that see the least sky; and indoors, the room's own light,
       directional toward its openings. Both are light that does not depend on
       the sun or the lamps, so they are added where light that needs no
       lighting goes: the emissive term. (Indoors the GLSL also REPLACED the
       sky's reflection with the room's ambient; here the roof's occlusion
       above already takes 82% of it, and the room's light is added.) */
    const bounce = u.uSkyBounce.mul(conditioned.rgb).mul(float(1).sub(vis)).mul(float(1).sub(clamp(N.y, 0, 1).mul(0.65))).mul(u.uSkyVisOn);
    const roomFace = clamp(dot(N, u.uRoomDir).mul(0.5).add(0.5), 0, 1);
    const room = u.uRoomAmbient.mul(mix(0.45, 1.0, roomFace)).mul(conditioned.rgb).mul(wfIn).mul(u.uRoomOn);
    // Windows and lamps live by the clock: banked down in daylight, glowing
    // after dark. The night ceiling is 2.3, not higher (see lamps.js).
    const e0 = material.emissiveNode ?? materialEmissive;
    material.emissiveNode = e0.mul(mix(0.55, 2.3, u.uWfNight)).add(bounce).add(room);
    material.needsUpdate = true;
    return material;
  }
}
